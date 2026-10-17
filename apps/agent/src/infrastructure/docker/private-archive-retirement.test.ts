import {createHash} from "node:crypto";
import {constants, type Stats} from "node:fs";
import {join} from "node:path";
import {expect, it, vi} from "vitest";
import {composeVolumeBackupReceiptSchema, managedDatabaseBackupReceiptSchema} from "@deploylite/contracts";
import {backupRetirementInputDigest, composeRuntimeResourceName} from "@deploylite/domain";
import {createPrivateArchiveRetirementInspector} from "./private-archive-retirement.js";
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const formats = ["native", "p3"] as const;
type Kind = "file" | "directory" | "symlink" | "special";
function fixture(format: typeof formats[number] = "native", data = Buffer.from("private-fixture-bytes")) {
  const root = "/private-fixture-archives", projectId = "project-a", commandId = "backup-a", destinationId = "destination-a";
  const archiveId = "backup_" + createHash("sha256").update(projectId + "\0" + commandId + "\0" + destinationId).digest("hex").slice(0, 32);
  const archiveSha256 = digest(data), directory = join(root, archiveId);
  const common = {schemaVersion: 1, projectId, commandId, destinationId, agentId: "agent-a", correlationId: "backup-correlation", inputDigest: "a".repeat(64), archiveBytes: data.length, archiveSha256};
  const manifest: Record<string, unknown> = format === "native" ? {...common, sourceDigest: "b".repeat(64), format: "postgres-custom-gzip"}
    : {...common, volumeKey: "data", planDigest: "c".repeat(64), configDigest: "d".repeat(64), stateDigest: "e".repeat(64), entries: 2, consistency: "stopped"};
  const manifestBytes = Buffer.from(JSON.stringify(manifest)), manifestSha256 = digest(manifestBytes);
  const replay = {archiveId, manifestSha256, status: "created", idempotent: false, redacted: true};
  const receipt = format === "native" ? managedDatabaseBackupReceiptSchema.parse({...common, ...replay, action: "database.runtime.backup", databaseId: "orders", engine: "postgres", profileId: "profile-a",
    originalCommandId: "runtime-a", planDigest: "e".repeat(64), environmentFingerprint: "f".repeat(32), containerId: "c".repeat(64), imageId: "sha256:" + "d".repeat(64),
    volumeName: composeRuntimeResourceName(projectId, "volume", "db-orders"), networkName: composeRuntimeResourceName(projectId, "network", "db-orders"), networkId: "e".repeat(64),
    volumeCreatedAt: "2026-10-10T00:00:00Z", observedAt: 2000, storage: "verified", volumeKey: "db-orders", sourceDigest: manifest.sourceDigest, format: manifest.format, consistency: "native-snapshot"})
    : composeVolumeBackupReceiptSchema.parse({...common, ...replay, action: "compose.volume.backup", volumeKey: "data", entries: 2, consistency: "stopped"});
  const binding = {schemaVersion: 1, operation: "backup.retire", executionAllowed: false, receipt, inventoryDigest: "a".repeat(64), planDigest: "b".repeat(64)};
  let inode = 1, time = 3000, valid = true;
  const node = (kind: Kind, bytes = Buffer.alloc(0)) => ({kind, bytes, size: bytes.length, dev: 1, ino: inode++, uid: process.geteuid!(), gid: 1,
    mode: kind === "directory" ? 0o40700 : 0o100600, nlink: kind === "directory" ? 2 : 1, mtimeMs: 1, ctimeMs: 1});
  type Entry = ReturnType<typeof node>;
  const paths = {root, directory, manifest: join(directory, "manifest.json"), data: join(directory, format === "native" ? "archive.bin" : "archive.tar")};
  const entries = new Map<string, Entry>([[root, node("directory")], [directory, node("directory")], [paths.manifest, node("file", manifestBytes)], [paths.data, node("file", data)]]);
  const calls: Array<{name: string; path: string}> = [], handles: Array<{closed: number; settled: boolean; path: string; close: () => Promise<void>}> = [];
  let after: ((name: string, path: string, count: number) => unknown) | undefined;
  async function operation<T>(name: string, path: string, run: () => T) {const value = run(); calls.push({name, path}); await after?.(name, path, calls.length); return value;}
  const stats = (entry: Entry) => ({...entry, isFile: () => entry.kind === "file", isDirectory: () => entry.kind === "directory", isSymbolicLink: () => entry.kind === "symlink"}) as unknown as Stats;
  const filesystem = {
    lstat: (path: string) => operation("lstat", path, () => {const entry = entries.get(path); if (!entry) throw new Error("private missing path"); return stats(entry);}),
    realpath: (path: string) => operation("realpath", path, () => path),
    readdir: (path: string) => operation("readdir", path, () => [...entries.keys()].filter(key => key.startsWith(path + "/") && !key.slice(path.length + 1).includes("/")).map(key => key.slice(path.length + 1))),
    open: (path: string, flags: number) => operation("open", path, () => {
      expect(flags).toBe(constants.O_RDONLY | constants.O_NOFOLLOW); const entry = entries.get(path)!;
      const handle = {path, closed: 0, settled: false, stat: () => operation("fstat", path, () => stats(entry)),
        read: (buffer: Buffer, offset: number, length: number, position: number) => operation("read", path, () => {const bytes = entry.bytes.subarray(position, position + length); bytes.copy(buffer, offset); return {bytesRead: bytes.length};}),
        close: async () => {handle.closed++; await operation("close", path, () => undefined); handle.settled = true;}};
      handles.push(handle); return handle;
    }),
    unlink: vi.fn(), rm: vi.fn(), rename: vi.fn()
  };
  const authority = {projectId, commandId: "retirement-a", inputDigest: backupRetirementInputDigest(binding), expiresAt: 10000,
    assertValid: vi.fn(async () => {await operation("authority", "", () => undefined); if (!valid) throw new Error("private grant revoked");})};
  const options = {destinations: new Map([[destinationId, root]]), expectedAgentId: "agent-a", clock: {now: () => time}, maxBytes: 1024, maxDurationMs: 1000, filesystem};
  const controller = new AbortController(), inspect = () => createPrivateArchiveRetirementInspector(options).inspect(binding, authority, controller.signal);
  return {options, binding, authority, controller, inspect, paths, entries, handles, calls, manifest, data, node,
    after: (hook: typeof after) => {after = hook;}, now: (value: number) => {time = value;}, revoke: () => {valid = false;},
    rewriteManifest: (patch: Record<string, unknown>) => {const bytes = Buffer.from(JSON.stringify({...manifest, ...patch})); entries.get(paths.manifest)!.bytes = bytes; entries.get(paths.manifest)!.size = bytes.length; binding.receipt.manifestSha256 = digest(bytes); authority.inputDigest = backupRetirementInputDigest(binding);}};
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
it.each(formats)("inspects exact %s private archive without bytes, paths or effect permission", async format => {
  const f = fixture(format), inspector = createPrivateArchiveRetirementInspector(f.options), pending = inspector.inspect(f.binding, f.authority, f.controller.signal);
  await expect(pending).resolves.toEqual({archiveId: f.binding.receipt.archiveId, archiveBytes: f.data.length, archiveSha256: digest(f.data), manifestSha256: f.binding.receipt.manifestSha256, kind: format, format: format === "native" ? "postgres-custom-gzip" : "volume-tar", integrity: "verified", redacted: true});
  const result = await pending; expect(Object.isFrozen(result)).toBe(true); expect(JSON.stringify(result)).not.toContain(f.paths.root); expect(JSON.stringify(result)).not.toContain(f.data.toString());
  expect(f.handles).toHaveLength(2); expect(f.handles.every(handle => handle.closed === 1)).toBe(true); expect(inspector.executionAvailable()).toBe(false);
});
it("keeps the internal effect port unavailable without a public activation switch or any filesystem call", async () => {
  const f = fixture(), inspector = createPrivateArchiveRetirementInspector(f.options);
  expect(inspector.executionAvailable()).toBe(false); await expect(inspector.retire(f.binding, f.authority, f.controller.signal)).rejects.toThrow("unavailable");
  expect(f.calls).toHaveLength(0); for (const operation of [f.options.filesystem.unlink, f.options.filesystem.rm, f.options.filesystem.rename]) expect(operation).not.toHaveBeenCalled();
});
async function denied(f: ReturnType<typeof fixture>) {
  await expect(f.inspect()).rejects.toThrow(/^Private archive inspection is unavailable\.$/); await flush();
  expect(f.handles.every(handle => handle.closed === 1 && handle.settled)).toBe(true);
  for (const operation of [f.options.filesystem.unlink, f.options.filesystem.rm, f.options.filesystem.rename]) expect(operation).not.toHaveBeenCalled();
}
it.each(formats)("pins copied %s destination/options/read capabilities without enabling effects", async format => {
  const f = fixture(format), inspector = createPrivateArchiveRetirementInspector(f.options), replacement = vi.fn(async () => {throw new Error("foreign open");});
  f.options.destinations.clear(); f.options.expectedAgentId = "foreign"; f.options.maxBytes = 0; f.options.maxDurationMs = 0; f.options.filesystem.open = replacement;
  await expect(inspector.inspect(f.binding, f.authority, f.controller.signal)).resolves.toMatchObject({integrity: "verified"}); expect(replacement).not.toHaveBeenCalled();
  const calls = f.calls.length; await expect(inspector.retire(f.binding, f.authority, f.controller.signal)).rejects.toThrow("unavailable"); expect(f.calls).toHaveLength(calls);
});
const badReceipts = [{agentId: "foreign"}, {projectId: "foreign"}, {commandId: "foreign"}, {destinationId: "foreign"}, {archiveId: "loose-id"}, {archiveId: "../outside"}, {root: "/outside"}];
it.each(formats.flatMap(format => badReceipts.map(patch => [format, patch] as const)))("rejects %s foreign receipt scope/path $1 before filesystem access", async (format, patch) => {
  const f = fixture(format); Object.assign(f.binding.receipt, patch); try {f.authority.inputDigest = backupRetirementInputDigest(f.binding);} catch {} await denied(f); expect(f.calls).toHaveLength(0);
});
it.each([{root: "/outside"}, {path: "/outside"}, {batch: []}, {executionAllowed: true}, {operation: "database.runtime.delete"}])("rejects unknown or executable retirement binding %j", async patch => {
  const f = fixture(); Object.assign(f.binding, patch); await denied(f); expect(f.calls).toHaveLength(0);
});
it.each([{projectId: "foreign"}, {commandId: "backup-a"}, {commandId: "../outside"}, {commandId: undefined}, {commandId: 123}, {inputDigest: "0".repeat(64)}, {expiresAt: 3000}, {expiresAt: undefined}, {assertValid: undefined}])("requires current RETIREMENT command authority %j", async patch => {
  const f = fixture(); Object.assign(f.authority, patch); await denied(f); expect(f.calls).toHaveLength(0);
});
it.each([{maxBytes: 0}, {maxBytes: NaN}, {maxDurationMs: 0}, {maxDurationMs: 2147483648}, {expectedAgentId: "../agent"}, {expectedAgentId: undefined}])("refuses unsafe constructor limits/identity %j", patch => {
  const f = fixture(); Object.assign(f.options, patch); expect(() => createPrivateArchiveRetirementInspector(f.options)).toThrow("unavailable"); expect(f.calls).toHaveLength(0);
});
it.each(["relative", "/", "/private/../archives", "/private//archives", "/private/\0archives"])("refuses noncanonical or unbounded configured root %j", root => {
  const f = fixture(); f.options.destinations.set(f.binding.receipt.destinationId, root); expect(() => createPrivateArchiveRetirementInspector(f.options)).toThrow("unavailable");
});
it.each(formats)("refuses %s unknown destination, byte budget, cancelled signal and unsafe clock", async format => {
  for (const mode of ["destination", "budget", "abort", "clock", "future-receipt"]) {
    const f = fixture(format); if (mode === "destination") f.options.destinations.clear(); if (mode === "budget") f.options.maxBytes = 1;
    if (mode === "abort") f.controller.abort(); if (mode === "clock") f.now(NaN);
    if (mode === "future-receipt") Object.assign(f.binding.receipt, {observedAt: 4000});
    await denied(f); expect(f.calls).toHaveLength(0);
  }
});
const targets = ["root", "directory", "manifest", "data"] as const;
const metadataFaults = ["symlink", "special", "owner", "public", "special-mode", "unreadable", "inode", "time", "size"] as const;
it.each(formats.flatMap(format => targets.flatMap(target => metadataFaults.map(fault => [format, target, fault] as const))))("refuses %s %s metadata fault %s", async (format, target, fault) => {
  const f = fixture(format), entry = f.entries.get(f.paths[target])!;
  if (fault === "symlink" || fault === "special") entry.kind = fault;
  if (fault === "owner") entry.uid++; if (fault === "public") entry.mode |= 0o044; if (fault === "special-mode") entry.mode |= 0o4000;
  if (fault === "unreadable") entry.mode &= ~0o400; if (fault === "inode") entry.ino = NaN; if (fault === "time") entry.ctimeMs = NaN; if (fault === "size") entry.size = -1;
  await denied(f);
});
it.each(formats.flatMap(format => (["manifest", "data"] as const).map(target => [format, target] as const)))("refuses %s %s hardlinks and detached opened inode", async (format, target) => {
  const f = fixture(format); f.entries.get(f.paths[target])!.nlink = 2; await denied(f);
  const g = fixture(format), open = g.options.filesystem.open; g.options.filesystem.open = async (path, flags) => {const handle = await open(path, flags), stat = handle.stat;
    if (path === g.paths[target]) handle.stat = async () => {const value = await stat(); return {...value, ino: value.ino + 1} as Stats;}; return handle;}; await denied(g);
});
it.each(formats)("rejects %s symlink ancestors and unexpected/nested/special children without traversing them", async format => {
  const f = fixture(format); f.options.filesystem.realpath = async path => path === f.paths.root ? "/foreign-canonical-root" : path; await denied(f);
  for (const kind of ["file", "directory", "symlink", "special"] as const) {const g = fixture(format), extra = join(g.paths.directory, "extra"); g.entries.set(extra, g.node(kind));
    if (kind === "directory") g.entries.set(join(extra, "nested"), g.node("file", Buffer.from("nested"))); await denied(g); expect(g.calls.some(call => call.name === "open" && call.path.startsWith(extra))).toBe(false);}
});
const manifestFaults = {native: [{format: "mysql-sql-gzip"}, {sourceDigest: "c".repeat(64)}], p3: [{entries: 99}, {consistency: "running"}, {volumeKey: "foreign"}, {planDigest: "invalid"}, {configDigest: "invalid"}, {stateDigest: "invalid"}]};
it.each(formats)("binds strict %s manifest fields even with a recomputed manifest receipt hash", async format => {
  for (const patch of [...manifestFaults[format], {projectId: "foreign"}, {commandId: "foreign"}, {agentId: "foreign"}, {correlationId: "foreign"}, {destinationId: "foreign"},
    {inputDigest: "0".repeat(64)}, {archiveBytes: 1}, {archiveSha256: "0".repeat(64)}, {schemaVersion: 2}, {extra: true}]) {const f = fixture(format); f.rewriteManifest(patch); await denied(f);}
});
it.each(formats)("hashes exact bounded %s content and rejects bad manifest/hash/EOF/overflow/read counts", async format => {
  for (const mode of ["manifest-hash", "data-hash", "json", "manifest-limit", "truncated", "overflow", "negative-read", "oversized-read"]) {
    const f = fixture(format), data = f.entries.get(f.paths.data)!, manifest = f.entries.get(f.paths.manifest)!;
    if (mode === "manifest-hash") {manifest.bytes = Buffer.concat([manifest.bytes, Buffer.from(" ")]); manifest.size++;}
    if (mode === "data-hash") data.bytes = Buffer.alloc(data.size, 120);
    if (mode === "json" || mode === "manifest-limit") {manifest.bytes = Buffer.from(mode === "json" ? "{" : " ".repeat(8193)); manifest.size = manifest.bytes.length; f.binding.receipt.manifestSha256 = digest(manifest.bytes); f.authority.inputDigest = backupRetirementInputDigest(f.binding);}
    if (mode === "truncated") data.bytes = data.bytes.subarray(0, data.size - 1); if (mode === "overflow") data.bytes = Buffer.concat([data.bytes, Buffer.from("extra")]);
    if (mode.endsWith("read")) {const open = f.options.filesystem.open; f.options.filesystem.open = async (path, flags) => {const handle = await open(path, flags); handle.read = async () => ({bytesRead: mode === "negative-read" ? -1 : 999999}); return handle;};}
    await denied(f); if (mode === "data-hash") expect(f.calls.some(call => call.name === "read" && call.path === f.paths.data)).toBe(true);
  }
});
it.each(formats.flatMap(format => targets.map(target => [format, target] as const)))("rejects %s %s same-byte inode replacement during read", async (format, target) => {
  const f = fixture(format); let changed = false; f.after((name, path) => {if (!changed && name === "read" && path === f.paths.data) {changed = true; const entry = f.entries.get(f.paths[target])!; f.entries.set(f.paths[target], {...entry, ino: entry.ino + 100});}});
  await denied(f); expect(changed).toBe(true);
});
it.each(formats)("rejects %s content/size/mode/times and directory children changing during read", async format => {
  for (const key of ["size", "mode", "mtimeMs", "ctimeMs", "nlink", "gid", "children", "content", "ancestor"]) {const f = fixture(format); let changed = false; f.options.filesystem.realpath = async path => changed && key === "ancestor" ? "/foreign" + path : path;
    f.after((name, path) => {if (!changed && name === "read" && path === f.paths.data) {changed = true; const entry = f.entries.get(f.paths.data)!;
      if (key === "children") f.entries.set(join(f.paths.directory, "late"), f.node("file")); else if (key === "content") {entry.bytes = Buffer.alloc(entry.size, 120); entry.ctimeMs++;} else if (key !== "ancestor") entry[key as "size" | "mode" | "mtimeMs" | "ctimeMs" | "nlink" | "gid"]++;}}); await denied(f); expect(changed).toBe(true);}
});
it.each(formats.flatMap(format => ["abort", "expiry", "revocation", "rollback"].map(mode => [format, mode] as const)))("fences %s %s after EVERY observed awaited boundary including authority and close", async (format, mode) => {
  const baseline = fixture(format); await baseline.inspect(); const count = baseline.calls.length; expect(count).toBeGreaterThan(20);
  for (let boundary = 1; boundary <= count; boundary++) {const f = fixture(format); let reached = false;
    f.after((_name, _path, index) => {if (index === boundary) {reached = true; if (mode === "abort") f.controller.abort(); else if (mode === "expiry") f.now(10000); else if (mode === "rollback") f.now(2999); else f.revoke();}});
    await denied(f); expect(reached, `awaited boundary ${boundary}/${count}`).toBe(true);
  }
}, 10000);
it("pins original authority/clock methods and refuses close failure while settling every owned handle", async () => {
  for (const mode of ["authority", "clock", "close"]) {const f = fixture(); let changed = false; f.after((name, path) => {if (!changed && name === "read" && path === f.paths.data) {changed = true;
    if (mode === "authority") f.authority.assertValid = vi.fn(async () => {}); else if (mode === "clock") f.options.clock.now = () => 3000;
    else f.handles[0]!.close = async () => {f.handles[0]!.closed++; throw new Error("private close failure");};}});
    await denied(f); expect(changed).toBe(true);
  }
});
it.each(["read", "authority", "open", "close"])("bounds uncooperative %s and closes even a late opened handle without a success claim", async operation => {
  const f = fixture(), release: {run?: () => void} = {}; f.options.maxDurationMs = 10;
  let held = false; f.after((name) => {if (name === operation && !held) {held = true; return new Promise<void>(resolve => {release.run = resolve;});}});
  await expect(f.inspect()).rejects.toThrow(/^Private archive inspection is unavailable\.$/); expect(release.run).toBeTypeOf("function");
  if (operation === "open") expect(f.handles[0]!.closed).toBe(0);
  f.after(undefined); release.run!(); await flush(); expect(f.handles.every(handle => handle.closed === 1 && handle.settled)).toBe(true);
}, 2000);
it("never returns verified metadata on a genuine close failure and still settles the other handle", async () => {
  const f = fixture(), open = f.options.filesystem.open; f.options.filesystem.open = async (path, flags) => {const handle = await open(path, flags), close = handle.close;
    handle.close = async () => {await close(); if (path === f.paths.manifest) throw new Error("private close failure");}; return handle;};
  await denied(f); expect(f.handles).toHaveLength(2);
});
it.each(formats.flatMap(format => ["exact", "extra", "late", "hung", "close-failure"].map(mode => [format, mode] as const)))("bounds mocked Node %s directory enumeration and %s cleanup", async (format, mode) => {
  const f = fixture(format), names = [f.paths.data.split("/").at(-1)!, "manifest.json", ...(mode === "extra" ? ["extra", "must-not-read"] : [])];
  const directories: Array<{read: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>}> = []; let release!: () => void;
  const opendir = vi.fn(async (path: string, options: {bufferSize: number}) => {expect(path).toBe(f.paths.directory); expect(options).toEqual({bufferSize: 3}); let index = 0;
    const directory = {read: vi.fn(async () => mode === "hung" ? new Promise<never>(() => {}) : index < names.length ? {name: names[index++]!} : null),
      close: vi.fn(async () => {if (mode === "close-failure") throw new Error("private directory close");})}; directories.push(directory);
    if (mode === "late") await new Promise<void>(resolve => {release = resolve;}); return directory;});
  vi.resetModules(); vi.doMock("node:fs/promises", async () => ({...await vi.importActual("node:fs/promises"), lstat: f.options.filesystem.lstat, realpath: f.options.filesystem.realpath, open: f.options.filesystem.open, opendir}));
  try {const {filesystem: _filesystem, ...options} = f.options; options.maxDurationMs = mode === "late" || mode === "hung" ? 10 : 1000;
    const {createPrivateArchiveRetirementInspector: create} = await import("./private-archive-retirement.js"), pending = create(options).inspect(f.binding, f.authority, f.controller.signal);
    if (mode === "exact") await expect(pending).resolves.toMatchObject({integrity: "verified"}); else await expect(pending).rejects.toThrow(/^Private archive inspection is unavailable\.$/);
    if (mode === "late") {expect(directories[0]!.close).not.toHaveBeenCalled(); release(); await flush(); expect(directories[0]!.read).not.toHaveBeenCalled();}
    await flush(); for (const directory of directories) {expect(directory.close).toHaveBeenCalledOnce(); expect(directory.read.mock.calls.length).toBeLessThanOrEqual(3);}
    if (mode === "extra") expect(directories[0]!.read).toHaveBeenCalledTimes(3); if (mode === "exact") expect(directories).toHaveLength(2);
  } finally {vi.doUnmock("node:fs/promises"); vi.resetModules();}
}, 2000);
it.each([null, undefined, {}])("refuses malformed cancellation input %j without leaking a cleanup error", async signal => {
  const f = fixture(); await expect(createPrivateArchiveRetirementInspector(f.options).inspect(f.binding, f.authority, signal as AbortSignal)).rejects.toThrow(/^Private archive inspection is unavailable\.$/); expect(f.calls).toHaveLength(0);
});
it.each(formats)("streams multiple bounded chunks from an exact %s private read-only archive", async format => {
  const f = fixture(format, Buffer.alloc(70001, 7)); f.options.maxBytes = f.data.length;
  for (const target of targets) f.entries.get(f.paths[target])!.mode &= ~0o200;
  await expect(f.inspect()).resolves.toMatchObject({integrity: "verified", archiveBytes: f.data.length, archiveSha256: digest(f.data)});
  expect(f.calls.filter(call => call.name === "read" && call.path === f.paths.data)).toHaveLength(3); expect(f.handles.every(handle => handle.closed === 1 && handle.settled)).toBe(true);
});
