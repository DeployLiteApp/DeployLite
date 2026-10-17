import {createHash} from "node:crypto";
import {constants, type Stats} from "node:fs";
import {lstat, open, opendir, realpath} from "node:fs/promises";
import {isAbsolute, join, parse, resolve} from "node:path";
import {protocolPayloadFingerprint, type Clock} from "@deploylite/contracts";
import {awaitAbortable, backupRetirementBinding, backupRetirementInputDigest} from "@deploylite/domain";
import {nativeBackupArchiveManifestSchema} from "./docker-managed-database-backup-archive.js";
import {composeVolumeBackupArchiveManifestSchema, type ComposeVolumeBackupAuthority} from "./docker-compose-volume-backup.js";

type ReadHandle = {stat(): Promise<Stats>; read(buffer: Buffer, offset: number, length: number, position: number): Promise<{bytesRead: number}>; close(): Promise<void>};
export type PrivateArchiveInspectionFilesystem = {lstat(path: string): Promise<Stats>; realpath(path: string): Promise<string>;
  readdir(path: string, signal: AbortSignal): Promise<string[]>; open(path: string, flags: number): Promise<ReadHandle>};
type Options = {destinations: ReadonlyMap<string, string>; expectedAgentId: string; clock: Clock; maxBytes: number; maxDurationMs: number; filesystem?: PrivateArchiveInspectionFilesystem};
const identity = /^[A-Za-z0-9_-]{1,200}$/;
function isIdentity(value: unknown): value is string {return typeof value === "string" && identity.test(value);}
const fields = ["dev", "ino", "size", "mode", "uid", "gid", "nlink", "mtimeMs", "ctimeMs"] as const;
type Pinned = Readonly<Record<typeof fields[number], number>>;
function unavailable(): never {throw new Error("Private archive inspection is unavailable.");}
function same(left: Pinned, right: Pinned) {return fields.every(key => left[key] === right[key]);}
async function boundedNames(path: string, signal: AbortSignal) {
  const directory = await opendir(path, {bufferSize: 3});
  try {const names: string[] = []; for (let index = 0; index < 3; index++) {
    if (signal.aborted) unavailable(); const entry = await awaitAbortable(() => directory.read(), signal); if (!entry) break; names.push(entry.name);
  } return names;} finally {await directory.close();}
}

/** Read-only private integrity observation, NOT an effect grant, reusable inode token or atomic deletion guarantee. */
export function createPrivateArchiveRetirementInspector(supplied: Options) {
  let options: Options, filesystem: PrivateArchiveInspectionFilesystem, owner: number, now: Clock["now"];
  try {
    options = {...supplied, destinations: new Map(supplied.destinations)}; now = options.clock.now;
    const uid = process.geteuid?.(); if (typeof uid !== "number" || !Number.isSafeInteger(uid) || uid <= 0) unavailable(); owner = uid;
    if (!isIdentity(options.expectedAgentId) || typeof now !== "function" || !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1
      || !Number.isSafeInteger(options.maxDurationMs) || options.maxDurationMs < 1 || options.maxDurationMs > 2147483647) unavailable();
    for (const [key, path] of options.destinations) if (!isIdentity(key) || typeof path !== "string" || !isAbsolute(path) || path !== resolve(path)
      || path === parse(path).root || Buffer.byteLength(path) > 4096 || /[\u0000-\u001f\u007f]/.test(path)) unavailable();
    const source = options.filesystem ?? {lstat, realpath, open, readdir: boundedNames};
    filesystem = Object.freeze({lstat: source.lstat.bind(source), realpath: source.realpath.bind(source), open: source.open.bind(source), readdir: source.readdir.bind(source)});
  } catch {return unavailable();}
  function pin(info: Stats, kind: "file" | "directory", limit = Number.MAX_SAFE_INTEGER): Pinned {
    if (info.isSymbolicLink() || (kind === "file" ? !info.isFile() : !info.isDirectory()) || info.uid !== owner || (info.mode & 0o077) !== 0 || (info.mode & 0o7000) !== 0
      || (info.mode & constants.S_IFMT) !== (kind === "file" ? constants.S_IFREG : constants.S_IFDIR)
      || (kind === "file" ? (info.mode & 0o500) !== 0o400 || info.nlink !== 1 || info.size < 1 || info.size > limit : (info.mode & 0o500) !== 0o500)) unavailable();
    for (const key of fields) if (!Number.isFinite(info[key]) || info[key] < 0 || info[key] > Number.MAX_SAFE_INTEGER
      || (!key.endsWith("Ms") && !Number.isSafeInteger(info[key]))) unavailable();
    if (info.ino === 0 || info.nlink === 0) unavailable();
    return Object.freeze(Object.fromEntries(fields.map(key => [key, info[key]])) as Record<typeof fields[number], number>);
  }
  return {
    executionAvailable: () => false as const,
    async retire(_raw: unknown, _authority: ComposeVolumeBackupAuthority, _signal: AbortSignal): Promise<never> {throw new Error("Archive retirement execution is unavailable.");},
    async inspect(raw: unknown, authority: ComposeVolumeBackupAuthority, external: AbortSignal) {
      const controller = new AbortController(), cancel = () => controller.abort(), closes = new Map<ReadHandle, () => Promise<void>>();
      const methods: Array<{handle: ReadHandle; stat: ReadHandle["stat"]; read: ReadHandle["read"]; close: ReadHandle["close"]}> = [];
      let timer: ReturnType<typeof setTimeout> | undefined, validated = false, gate: (() => Promise<void>) | undefined;
      try {
        external.addEventListener("abort", cancel, {once: true}); if (external.aborted) cancel();
        const binding = structuredClone(backupRetirementBinding(raw)), receipt = binding.receipt, native = receipt.action === "database.runtime.backup";
        const expectedId = "backup_" + createHash("sha256").update(receipt.projectId + "\0" + receipt.commandId + "\0" + receipt.destinationId).digest("hex").slice(0, 32);
        const command = {projectId: authority.projectId, commandId: authority.commandId, inputDigest: authority.inputDigest, expiresAt: authority.expiresAt}, assertValid = authority.assertValid;
        const start = now.call(options.clock), deadline = Math.min(start + options.maxDurationMs, command.expiresAt ?? NaN); let lastNow = start;
        function current() {
          const value = now.call(options.clock);
          if (controller.signal.aborted || external.aborted || options.clock.now !== now || process.geteuid?.() !== owner || typeof assertValid !== "function"
            || authority.assertValid !== assertValid || Object.keys(command).some(key => authority[key as keyof typeof command] !== command[key as keyof typeof command])
            || !Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(value) || value < lastNow || !Number.isSafeInteger(deadline) || value >= deadline
            || !Number.isSafeInteger(command.expiresAt) || !isIdentity(command.commandId) || command.commandId === receipt.commandId
            || command.projectId !== receipt.projectId || command.inputDigest !== backupRetirementInputDigest(binding) || receipt.agentId !== options.expectedAgentId
            || receipt.archiveId !== expectedId || !Number.isSafeInteger(receipt.archiveBytes) || receipt.archiveBytes > options.maxBytes
            || (native && start < receipt.observedAt) || methods.some(item => item.handle.stat !== item.stat || item.handle.read !== item.read || item.handle.close !== item.close)) unavailable();
          lastNow = value;
        }
        gate = async () => {try {current(); await awaitAbortable(() => assertValid.call(authority), controller.signal); current();} catch {unavailable();}};
        async function step<T>(work: () => Promise<T>) {await gate!(); const value = await awaitAbortable(work, controller.signal); await gate!(); return value;}
        current(); const root = options.destinations.get(receipt.destinationId); if (!root) unavailable();
        timer = setTimeout(cancel, deadline - start); await gate(); const directory = join(root, receipt.archiveId), dataName = native ? "archive.bin" : "archive.tar";
        async function directoryInfo(path: string) {const info = pin(await step(() => filesystem.lstat(path)), "directory"); if (await step(() => filesystem.realpath(path)) !== path) unavailable(); return info;}
        const roots = [{path: root, info: await directoryInfo(root)}, {path: directory, info: await directoryInfo(directory)}];
        async function children() {const names = await step(() => filesystem.readdir(directory, controller.signal));
          if (!Array.isArray(names) || names.length !== 2 || new Set(names).size !== 2 || !names.includes("manifest.json") || !names.includes(dataName)) unavailable();}
        await children(); const files: Array<{path: string; info: Pinned; methods: typeof methods[number]}> = [];
        async function inspectFile(path: string, limit: number, collect: boolean) {
          const info = pin(await step(() => filesystem.lstat(path)), "file", limit); let adopted = false;
          const pending = filesystem.open(path, constants.O_RDONLY | constants.O_NOFOLLOW); let handle: ReadHandle;
          try {handle = await awaitAbortable(() => pending, controller.signal); adopted = true;
            if (typeof handle.close !== "function") unavailable(); closes.set(handle, handle.close.bind(handle));
          } catch (error) {if (!adopted) void pending.then(value => Promise.resolve().then(() => value.close()).catch(() => {}), () => {}); throw error;}
          if (typeof handle.stat !== "function" || typeof handle.read !== "function") unavailable();
          const owned = {handle, stat: handle.stat, read: handle.read, close: handle.close}; methods.push(owned); await gate!();
          if (!same(info, pin(await step(() => owned.stat.call(handle)), "file", limit))) unavailable(); files.push({path, info, methods: owned});
          const hash = createHash("sha256"), chunks: Buffer[] = [], buffer = Buffer.alloc(Math.min(65536, limit + 1)); let bytes = 0;
          for (;;) {const length = Math.min(buffer.length, limit - bytes + 1), result = await step(() => owned.read.call(handle, buffer, 0, length, bytes));
            if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead < 0 || result.bytesRead > length) unavailable(); if (result.bytesRead === 0) break;
            bytes += result.bytesRead; if (bytes > info.size || bytes > limit) unavailable(); const value = buffer.subarray(0, result.bytesRead); hash.update(value); if (collect) chunks.push(Buffer.from(value));}
          if (bytes !== info.size || !same(info, pin(await step(() => owned.stat.call(handle)), "file", limit))) unavailable();
          return {sha256: hash.digest("hex"), bytes, value: collect ? Buffer.concat(chunks) : undefined};
        }
        const manifest = await inspectFile(join(directory, "manifest.json"), 8192, true); if (manifest.sha256 !== receipt.manifestSha256) unavailable();
        const parsed = (native ? nativeBackupArchiveManifestSchema : composeVolumeBackupArchiveManifestSchema).parse(JSON.parse(manifest.value!.toString("utf8")));
        const expected = {schemaVersion: 1, projectId: receipt.projectId, commandId: receipt.commandId, inputDigest: receipt.inputDigest, agentId: receipt.agentId,
          correlationId: receipt.correlationId, destinationId: receipt.destinationId, archiveBytes: receipt.archiveBytes, archiveSha256: receipt.archiveSha256,
          ...(native ? {sourceDigest: receipt.sourceDigest, format: receipt.format} : {volumeKey: receipt.volumeKey, entries: receipt.entries, consistency: receipt.consistency})};
        const available = Object.fromEntries(Object.keys(expected).map(key => [key, parsed[key as keyof typeof parsed]]));
        if (protocolPayloadFingerprint(available) !== protocolPayloadFingerprint(expected)) unavailable();
        const data = await inspectFile(join(directory, dataName), receipt.archiveBytes, false); if (data.bytes !== receipt.archiveBytes || data.sha256 !== receipt.archiveSha256) unavailable();
        for (const file of files) if (!same(file.info, pin(await step(() => file.methods.stat.call(file.methods.handle)), "file"))
          || !same(file.info, pin(await step(() => filesystem.lstat(file.path)), "file"))) unavailable();
        for (const root of roots) if (!same(root.info, await directoryInfo(root.path))) unavailable(); await children(); await gate(); validated = true;
        return Object.freeze({archiveId: receipt.archiveId, archiveBytes: data.bytes, archiveSha256: data.sha256, manifestSha256: manifest.sha256,
          kind: native ? "native" as const : "p3" as const, format: native ? receipt.format : "volume-tar", integrity: "verified" as const, redacted: true as const});
      } catch {return unavailable();}
      finally {
        // No metadata is returned before owned closes settle. Timed-out work stays unavailable; late opens are closed when they resolve.
        const closing = Promise.allSettled([...closes.values()].map(close => Promise.resolve().then(close)));
        try {const results = await awaitAbortable(() => closing, controller.signal); if (results.some(result => result.status === "rejected")) unavailable(); if (validated) await gate!();}
        catch {unavailable();} finally {controller.abort(); if (timer) clearTimeout(timer); try {external?.removeEventListener?.("abort", cancel);} catch {unavailable();}}
      }
    }
  };
}
