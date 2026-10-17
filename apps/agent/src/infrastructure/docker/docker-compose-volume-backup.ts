import { createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, mkdtemp, open, realpath, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { COMPOSE_RESOURCE_INSPECTION_CAPABILITY, COMPOSE_VOLUME_BACKUP_CAPABILITY, composeResourceObservationSchema, composeVolumeBackupAgentCommandSchema, composeVolumeBackupReceiptSchema, composeVolumeBackupPlanSchema,
  type CapabilityRegistry, type ComposeResourceObservationV1, type ComposeVolumeBackupAgentCommandV1, type ComposeVolumeBackupPlanV1, type ComposeVolumeBackupReceiptV1, type ImageReferencePolicyV1 } from "@deploylite/contracts";
import { awaitAbortable, composeVolumeBackupExecutionDigest, createComposePreview, digestComposeResourceObservation, digestControlInput, type ComposeResourceInspector } from "@deploylite/domain";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const manifestSchema = z.object({ schemaVersion: z.literal(1), commandId: identity, agentId: identity, correlationId: identity, projectId: identity, volumeKey: identity, destinationId: identity,
  planDigest: digest, inputDigest: digest, configDigest: digest, stateDigest: digest, consistency: z.literal("stopped"), archiveBytes: z.number().int().positive(),
  entries: z.number().int().nonnegative(), archiveSha256: digest }).strict();
export {manifestSchema as composeVolumeBackupArchiveManifestSchema};

export type ComposeVolumeBackupEntry = Readonly<{
  path: string; kind: "file" | "directory" | "symlink" | "unsupported"; mode: number; modifiedAtSeconds: number; size: number;
  open?: () => AsyncIterable<Uint8Array>;
}>;
export type ComposeVolumeBackupSource = Readonly<{
  resolveVolume(runtimeName: string, signal: AbortSignal): Promise<Readonly<{ root: string; entries: () => AsyncIterable<ComposeVolumeBackupEntry> }>>;
}>;
export type ComposeVolumeBackupAuthority = Readonly<{ projectId: string; commandId: string; inputDigest: string; expiresAt?: number; assertValid(): Promise<void> }>;
export type ComposeVolumeBackupExecutorOptions = Readonly<{
  owner: string; agentId: string; imagePolicy: ImageReferencePolicyV1; capabilities: CapabilityRegistry; inspector: ComposeResourceInspector;
  source: ComposeVolumeBackupSource; destinations: ReadonlyMap<string, string>;
}>;
export type ComposeVolumeBackupExecutionInput = ComposeVolumeBackupAgentCommandV1;
export type ComposeVolumeBackupErrorCode = "COMPOSE_BACKUP_INVALID" | "COMPOSE_BACKUP_UNAVAILABLE" | "COMPOSE_BACKUP_STALE"
  | "COMPOSE_BACKUP_IN_USE" | "COMPOSE_BACKUP_UNSAFE_SOURCE" | "COMPOSE_BACKUP_UNSAFE_DESTINATION" | "COMPOSE_BACKUP_LIMIT"
  | "COMPOSE_BACKUP_CONFLICT" | "COMPOSE_BACKUP_FAILED";
export class ComposeVolumeBackupError extends Error {
  constructor(readonly code: ComposeVolumeBackupErrorCode) { super("Volume backup is unavailable or outside the supported policy."); this.name = "ComposeVolumeBackupError"; }
}
function fail(code: ComposeVolumeBackupErrorCode): never { throw new ComposeVolumeBackupError(code); }

function planFingerprint(plan: ComposeVolumeBackupPlanV1, owner: string, agentId: string): string {
  const { planDigest: _planDigest, ...intent } = plan;
  return digestControlInput({ ...intent, owner, agentId });
}
function isWithin(parent: string, child: string): boolean {
  const childRelative = relative(parent, child);
  return childRelative === "" || (childRelative !== ".." && !childRelative.startsWith(".." + sep) && !isAbsolute(childRelative));
}
type DirectoryInfo = Stats;
/** Identity snapshots are validation, not an atomic namespace lock. */
function sameDirectory(left: DirectoryInfo, right: DirectoryInfo) {
  return (["dev", "ino", "uid", "gid", "mode"] as const).every(key => left[key] === right[key]);
}
async function safeDirectory(path: string, destination: boolean): Promise<{path: string; info: DirectoryInfo}> {
  const code = destination ? "COMPOSE_BACKUP_UNSAFE_DESTINATION" : "COMPOSE_BACKUP_UNSAFE_SOURCE";
  if (!isAbsolute(path)) fail(code);
  const normalized = resolve(path);
  try {
    const owner = destination ? process.geteuid?.() : undefined;
    if (destination && (typeof owner !== "number" || !Number.isSafeInteger(owner) || owner <= 0)) fail(code);
    const valid = (value: DirectoryInfo) => !value.isSymbolicLink() && value.isDirectory() && (!destination || (
      process.geteuid?.() === owner && value.uid === owner && (["uid", "gid", "dev", "ino", "mode"] as const).every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)
      && value.ino > 0 && (value.mode & fsConstants.S_IFMT) === fsConstants.S_IFDIR && (value.mode & 0o7077) === 0 && (value.mode & 0o500) === 0o500));
    const info = await lstat(normalized); if (!valid(info)) fail(code);
    const canonical = await realpath(normalized); if (canonical !== normalized) fail(code);
    if (!destination) return {path: canonical, info}; // Source ownership/modes retain their existing independent contract.
    const after = await lstat(normalized); if (!valid(after) || !sameDirectory(info, after)) fail(code);
    return {path: canonical, info: after};
  } catch (error) {if (error instanceof ComposeVolumeBackupError) throw error; fail(code);}
}
function safeRelativePath(value: string): string {
  if (value.length < 1 || value.startsWith("/") || value.includes("\\") || value.includes(":") || /[\u0000-\u001f\u007f]/.test(value)) fail("COMPOSE_BACKUP_UNSAFE_SOURCE");
  const parts = value.split("/");
  if (parts.some(part => part.length === 0 || part === "." || part === "..")) fail("COMPOSE_BACKUP_UNSAFE_SOURCE");
  if (Buffer.byteLength(value, "utf8") > 255) fail("COMPOSE_BACKUP_UNSAFE_SOURCE");
  return value;
}
function splitTarPath(value: string): { name: Buffer; prefix: Buffer } {
  const raw = Buffer.from(value, "utf8");
  if (raw.length <= 100) return { name: raw, prefix: Buffer.alloc(0) };
  for (let index = value.lastIndexOf("/"); index > 0; index = value.lastIndexOf("/", index - 1)) {
    const prefix = Buffer.from(value.slice(0, index), "utf8"), name = Buffer.from(value.slice(index + 1), "utf8");
    if (name.length <= 100 && prefix.length <= 155) return { name, prefix };
  }
  fail("COMPOSE_BACKUP_UNSAFE_SOURCE");
}
function octal(header: Buffer, offset: number, width: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) fail("COMPOSE_BACKUP_UNSAFE_SOURCE");
  const text = value.toString(8);
  if (text.length > width - 1) fail("COMPOSE_BACKUP_LIMIT");
  header.fill(0, offset, offset + width);
  header.write(text.padStart(width - 1, "0"), offset, width - 1, "ascii");
}
function tarHeader(entry: ComposeVolumeBackupEntry): Buffer {
  const safePath = safeRelativePath(entry.path);
  if (!["file", "directory"].includes(entry.kind) || !Number.isSafeInteger(entry.mode) || entry.mode < 0
    || !Number.isSafeInteger(entry.modifiedAtSeconds) || entry.modifiedAtSeconds < 0 || !Number.isSafeInteger(entry.size) || entry.size < 0
    || (entry.kind === "directory" && entry.size !== 0) || (entry.kind === "file" && typeof entry.open !== "function")) fail("COMPOSE_BACKUP_UNSAFE_SOURCE");
  const path = entry.kind === "directory" ? safePath + "/" : safePath;
  const parts = splitTarPath(path), header = Buffer.alloc(512);
  parts.name.copy(header, 0); octal(header, 100, 8, entry.mode & 0o777); octal(header, 108, 8, 0); octal(header, 116, 8, 0);
  octal(header, 124, 12, entry.size); octal(header, 136, 12, entry.modifiedAtSeconds);
  header.fill(0x20, 148, 156); header[156] = entry.kind === "directory" ? 0x35 : 0x30;
  header.write("ustar\0", 257, 6, "binary"); header.write("00", 263, 2, "ascii");
  octal(header, 329, 8, 0); octal(header, 337, 8, 0); parts.prefix.copy(header, 345);
  let checksum = 0; for (const byte of header) checksum += byte;
  const checksumText = checksum.toString(8).padStart(6, "0");
  if (checksumText.length > 6) fail("COMPOSE_BACKUP_LIMIT");
  header.write(checksumText, 148, 6, "ascii"); header[154] = 0; header[155] = 0x20;
  return header;
}
function sameFile(left: Awaited<ReturnType<typeof stat>>, right: Awaited<ReturnType<typeof stat>>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}
async function* directoryEntries(root: string, directory: string, signal: AbortSignal): AsyncIterable<ComposeVolumeBackupEntry> {
  if (signal.aborted) fail("COMPOSE_BACKUP_FAILED");
  const before = await lstat(directory);
  if (before.isSymbolicLink() || !before.isDirectory()) fail("COMPOSE_BACKUP_UNSAFE_SOURCE");
  const names = await awaitAbortable(() => import("node:fs/promises").then(fs => fs.readdir(directory)), signal);
  names.sort((left, right) => left.localeCompare(right, "en"));
  for (const name of names) {
    if (signal.aborted) fail("COMPOSE_BACKUP_FAILED");
    const fullPath = join(directory, name), relPath = relative(root, fullPath).split(sep).join("/");
    safeRelativePath(relPath);
    const info = await lstat(fullPath);
    if (info.isSymbolicLink()) { yield { path: relPath, kind: "symlink", mode: 0, modifiedAtSeconds: 0, size: 0 }; continue; }
    if (info.isDirectory()) {
      yield { path: relPath, kind: "directory", mode: info.mode & 0o777, modifiedAtSeconds: Math.max(0, Math.floor(info.mtimeMs / 1000)), size: 0 };
      yield* directoryEntries(root, fullPath, signal);
      continue;
    }
    if (!info.isFile()) { yield { path: relPath, kind: "unsupported", mode: 0, modifiedAtSeconds: 0, size: 0 }; continue; }
    const captured = { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs };
    yield { path: relPath, kind: "file", mode: info.mode & 0o777, modifiedAtSeconds: Math.max(0, Math.floor(info.mtimeMs / 1000)), size: info.size,
      open: async function* () {
        const handle = await open(fullPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        try {
          const current = await handle.stat();
          if (!current.isFile() || !sameFile(captured as Awaited<ReturnType<typeof stat>>, current)) fail("COMPOSE_BACKUP_UNSAFE_SOURCE");
          const buffer = Buffer.alloc(64 * 1024); let position = 0;
          for (;;) {
            const result = await handle.read(buffer, 0, buffer.length, position);
            if (result.bytesRead === 0) break;
            position += result.bytesRead;
            yield Buffer.from(buffer.subarray(0, result.bytesRead));
          }
          const after = await handle.stat();
          if (!sameFile(current, after)) fail("COMPOSE_BACKUP_UNSAFE_SOURCE");
        } finally { await handle.close().catch(() => undefined); }
      } };
  }
  const after = await lstat(directory);
  if (!sameFile(before, after)) fail("COMPOSE_BACKUP_UNSAFE_SOURCE");
}

export function createLocalDirectoryComposeVolumeBackupSource(volumeRoots: ReadonlyMap<string, string>): ComposeVolumeBackupSource {
  return { async resolveVolume(runtimeName, signal) {
    if (signal.aborted) fail("COMPOSE_BACKUP_FAILED");
    const rootPath = volumeRoots.get(runtimeName);
    if (!rootPath) fail("COMPOSE_BACKUP_UNAVAILABLE");
    const root = await safeDirectory(rootPath, false);
    return { root: root.path, entries: () => directoryEntries(root.path, root.path, signal) };
  } };
}

function receipt(manifest: z.infer<typeof manifestSchema>, archiveId: string, manifestBytes: Buffer, status: "created" | "already-created"): ComposeVolumeBackupReceiptV1 {
  return composeVolumeBackupReceiptSchema.parse({ schemaVersion: 1, action: "compose.volume.backup", agentId: manifest.agentId, commandId: manifest.commandId,
    projectId: manifest.projectId, inputDigest: manifest.inputDigest, correlationId: manifest.correlationId, volumeKey: manifest.volumeKey,
    destinationId: manifest.destinationId, archiveId, status, consistency: manifest.consistency, archiveBytes: manifest.archiveBytes, entries: manifest.entries,
    archiveSha256: manifest.archiveSha256, manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"), idempotent: status === "already-created", redacted: true });
}
function archiveName(command: ComposeVolumeBackupExecutionInput): string {
  const key = createHash("sha256").update(command.projectId + "\0" + command.commandId + "\0" + command.plan.destinationId).digest("hex").slice(0, 32);
  return "backup_" + key;
}
async function hashFile(path: string, signal?: AbortSignal): Promise<{ bytes: number; sha256: string }> {
  const fileInfo = await lstat(path);
  if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) fail("COMPOSE_BACKUP_CONFLICT");
  const hasher = createHash("sha256"); let bytes = 0;
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(64 * 1024); let position = 0;
    for (;;) {
      if (signal?.aborted) fail("COMPOSE_BACKUP_FAILED");
      const result = await handle.read(buffer, 0, buffer.length, position);
      if (result.bytesRead === 0) break;
      const value = buffer.subarray(0, result.bytesRead); position += result.bytesRead; bytes += value.length; hasher.update(value);
    }
  } finally { await handle.close().catch(() => undefined); }
  return { bytes, sha256: hasher.digest("hex") };
}
async function existingReceipt(root: string, archiveId: string, command: ComposeVolumeBackupExecutionInput, expectedRoot: DirectoryInfo): Promise<ComposeVolumeBackupReceiptV1 | null> {
  const rootBefore = await safeDirectory(root, true); if (!sameDirectory(rootBefore.info, expectedRoot)) fail("COMPOSE_BACKUP_UNSAFE_DESTINATION");
  const finalDirectory = join(root, archiveId);
  let directoryInfo;
  try { directoryInfo = await lstat(finalDirectory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; fail("COMPOSE_BACKUP_FAILED"); }
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) fail("COMPOSE_BACKUP_CONFLICT");
  try {
    const directory = await safeDirectory(finalDirectory, true); if (!sameDirectory(directory.info, directoryInfo)) fail("COMPOSE_BACKUP_CONFLICT");
    const manifestPath = join(finalDirectory, "manifest.json"), manifestInfo = await lstat(manifestPath);
    if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) fail("COMPOSE_BACKUP_CONFLICT");
    const manifestHandle = await open(manifestPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let manifestBytes: Buffer;
    try { manifestBytes = await manifestHandle.readFile(); } finally { await manifestHandle.close(); }
    const parsed = manifestSchema.safeParse(JSON.parse(manifestBytes.toString("utf8")));
    if (!parsed.success) fail("COMPOSE_BACKUP_CONFLICT");
    const manifest = parsed.data;
    if (manifest.commandId !== command.commandId || manifest.agentId !== command.agentId || manifest.inputDigest !== command.inputDigest
      || manifest.correlationId !== command.context.correlationId || manifest.projectId !== command.projectId || manifest.volumeKey !== command.plan.volumeKey
      || manifest.destinationId !== command.plan.destinationId || manifest.planDigest !== command.plan.planDigest
      || manifest.configDigest !== command.plan.configDigest || manifest.stateDigest !== command.plan.stateDigest) fail("COMPOSE_BACKUP_CONFLICT");
    const archive = await hashFile(join(finalDirectory, "archive.tar"));
    if (archive.bytes !== manifest.archiveBytes || archive.sha256 !== manifest.archiveSha256 || archive.bytes > command.plan.limits.maxBytes
      || manifest.entries > command.plan.limits.maxEntries) fail("COMPOSE_BACKUP_CONFLICT");
    if (!sameDirectory((await safeDirectory(root, true)).info, expectedRoot) || !sameDirectory((await safeDirectory(finalDirectory, true)).info, directory.info)) fail("COMPOSE_BACKUP_UNSAFE_DESTINATION");
    return receipt(manifest, archiveId, manifestBytes, "already-created");
  } catch (error) { if (error instanceof ComposeVolumeBackupError) throw error; fail("COMPOSE_BACKUP_CONFLICT"); }
}
function validateEntrySet(entries: ComposeVolumeBackupEntry[], maxEntries: number): void {
  if (entries.length > maxEntries) fail("COMPOSE_BACKUP_LIMIT");
  const byPath = new Map<string, ComposeVolumeBackupEntry>();
  for (const entry of entries) {
    safeRelativePath(entry.path);
    if (entry.kind === "symlink" || entry.kind === "unsupported") fail("COMPOSE_BACKUP_UNSAFE_SOURCE");
    if (byPath.has(entry.path)) fail("COMPOSE_BACKUP_UNSAFE_SOURCE");
    byPath.set(entry.path, entry);
  }
  for (const entry of entries) {
    const parts = entry.path.split("/");
    for (let index = 1; index < parts.length; index++) {
      const parent = byPath.get(parts.slice(0, index).join("/"));
      if (parent && parent.kind !== "directory") fail("COMPOSE_BACKUP_UNSAFE_SOURCE");
    }
    if (entry.kind !== "directory" && entries.some(candidate => candidate.path.startsWith(entry.path + "/"))) fail("COMPOSE_BACKUP_UNSAFE_SOURCE");
  }
}
async function writeArchive(path: string | null, entries: ComposeVolumeBackupEntry[], maxBytes: number, signal: AbortSignal, assertCurrent: () => void, sink?: (bytes:Uint8Array)=>Promise<void>): Promise<{ archiveBytes: number; archiveSha256: string }> {
  const handle = path===null?null:await open(path, "wx", 0o600), hasher = createHash("sha256"); let archiveBytes = 0;
  const write = async (value: Buffer) => {
    assertCurrent();
    if (archiveBytes + value.length > maxBytes) fail("COMPOSE_BACKUP_LIMIT");
    hasher.update(value);
    if(handle){
    let offset = 0;
    while (offset < value.length) {
      const result = await handle.write(value, offset, value.length - offset, null);
      if (result.bytesWritten < 1) fail("COMPOSE_BACKUP_FAILED");
      offset += result.bytesWritten;
    }
    }else{if(!sink)fail("COMPOSE_BACKUP_FAILED");await sink(value);}
    assertCurrent();archiveBytes += value.length;
  };
  try {
    for (const entry of entries) {
      assertCurrent();
      await write(tarHeader(entry));
      if (entry.kind === "file") {
        const expected = entry.size; let written = 0;
        const iterable = entry.open!(), iterator = iterable[Symbol.asyncIterator]();
        try {
          for (;;) {
            const next = await awaitAbortable(() => Promise.resolve(iterator.next()), signal);
            assertCurrent();
            if (next.done) break;
            const chunk = Buffer.from(next.value);
            if (written + chunk.length > expected) fail("COMPOSE_BACKUP_UNSAFE_SOURCE");
            if (chunk.length) { await write(chunk); written += chunk.length; }
          }
        } finally {
          if (signal.aborted) await Promise.resolve(iterator.return?.()).catch(() => undefined);
        }
        if (written !== expected) fail("COMPOSE_BACKUP_UNSAFE_SOURCE");
        const padding = (512 - (written % 512)) % 512;
        if (padding) await write(Buffer.alloc(padding));
      }
    }
    await write(Buffer.alloc(1024));
    if(handle)await handle.sync();
    return { archiveBytes, archiveSha256: hasher.digest("hex") };
  } finally { if(handle)await handle.close().catch(() => undefined); }
}

export function createDockerComposeVolumeBackupExecutor(supplied: ComposeVolumeBackupExecutorOptions) {
  const options = { ...supplied, imagePolicy: structuredClone(supplied.imagePolicy), destinations: new Map(supplied.destinations) };
  const inFlight = new Map<string, Promise<ComposeVolumeBackupReceiptV1>>();
  async function executeOnce(raw: unknown, authority: ComposeVolumeBackupAuthority, external: AbortSignal): Promise<ComposeVolumeBackupReceiptV1> {
    let input: ComposeVolumeBackupExecutionInput;
    try { input = composeVolumeBackupAgentCommandSchema.parse(structuredClone(raw)); } catch { return fail("COMPOSE_BACKUP_INVALID"); }
    const plan = input.plan, destinationPath = options.destinations.get(plan.destinationId);
    if (!options.capabilities.has(COMPOSE_RESOURCE_INSPECTION_CAPABILITY) || input.agentId !== options.agentId || !destinationPath) fail("COMPOSE_BACKUP_UNAVAILABLE");
    if (input.projectId !== plan.projectId || input.inputDigest !== composeVolumeBackupExecutionDigest(input)
      || authority.projectId !== input.projectId || authority.commandId !== input.commandId || authority.inputDigest !== input.inputDigest
      || input.authority.projectId !== authority.projectId || input.authority.commandId !== authority.commandId || input.authority.inputDigest !== authority.inputDigest
      || !input.requiredCapabilities.includes(COMPOSE_VOLUME_BACKUP_CAPABILITY) || plan.planDigest !== planFingerprint(plan, options.owner, options.agentId)) fail("COMPOSE_BACKUP_INVALID");
    const controller = new AbortController(), cancel = () => controller.abort();
    external.addEventListener("abort", cancel, { once: true }); if (external.aborted) cancel();
    const started = performance.now(), durationMs = plan.limits.maxDurationMs;
    const timer = setTimeout(() => controller.abort(), durationMs);
    const signal = controller.signal;
    const assertCurrent = () => {
      if (external.aborted) fail("COMPOSE_BACKUP_FAILED");
      if (signal.aborted || performance.now() - started >= durationMs) fail("COMPOSE_BACKUP_LIMIT");
      if (!options.capabilities.has(COMPOSE_RESOURCE_INSPECTION_CAPABILITY)) fail("COMPOSE_BACKUP_UNAVAILABLE");
      if (authority.expiresAt !== undefined && (!Number.isSafeInteger(authority.expiresAt) || Date.now() >= authority.expiresAt)) fail("COMPOSE_BACKUP_FAILED");
    };
    let temporaryDirectory: string | undefined, temporaryInfo: DirectoryInfo | undefined, destinationSnapshot: Awaited<ReturnType<typeof safeDirectory>> | undefined;
    try {
      assertCurrent(); await awaitAbortable(() => authority.assertValid(), signal); assertCurrent();
      const destination = await safeDirectory(destinationPath, true), archiveId = archiveName(input); destinationSnapshot = destination;
      const already = await existingReceipt(destination.path, archiveId, input, destination.info);
      if (already) { assertCurrent(); return already; }
      const preview = createComposePreview(input.canonicalDocument, plan.projectId, options.imagePolicy);
      const plannedVolume = preview.volumes.find(value => value.key === plan.volumeKey);
      if (preview.configDigest !== plan.configDigest || !plannedVolume) fail("COMPOSE_BACKUP_STALE");
      const inspectCurrent = async () => {
        const value = composeResourceObservationSchema.parse(await awaitAbortable(
          () => options.inspector.inspect({ preview, kind: "volume", key: plan.volumeKey }, signal), signal)) as ComposeResourceObservationV1;
        if (digestComposeResourceObservation(value) !== value.stateDigest || value.owner !== options.owner || value.agentId !== options.agentId
          || value.projectId !== plan.projectId || value.kind !== "volume" || value.key !== plan.volumeKey
          || value.runtimeName !== plannedVolume.runtimeName || value.configDigest !== plan.configDigest) fail("COMPOSE_BACKUP_INVALID");
        if (value.containers.some(container => container.attached && container.running)) fail("COMPOSE_BACKUP_IN_USE");
        if (value.stateDigest !== plan.stateDigest) fail("COMPOSE_BACKUP_STALE");
        return value;
      };
      const observation = await inspectCurrent();
      assertCurrent(); await awaitAbortable(() => authority.assertValid(), signal); assertCurrent();
      const source = await awaitAbortable(() => options.source.resolveVolume(plannedVolume.runtimeName, signal), signal);
      const sourceRoot = await safeDirectory(source.root, false);
      if (isWithin(sourceRoot.path, destination.path) || isWithin(destination.path, sourceRoot.path)) fail("COMPOSE_BACKUP_UNSAFE_DESTINATION");
      const entries: ComposeVolumeBackupEntry[] = [], entryIterator = source.entries()[Symbol.asyncIterator]();
      try {
        for (;;) {
          const next = await awaitAbortable(() => Promise.resolve(entryIterator.next()), signal);
          assertCurrent(); if (next.done) break;
          entries.push(next.value); if (entries.length > plan.limits.maxEntries) fail("COMPOSE_BACKUP_LIMIT");
        }
      } finally { if (signal.aborted) await Promise.resolve(entryIterator.return?.()).catch(() => undefined); }
      validateEntrySet(entries, plan.limits.maxEntries);
      entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
      temporaryDirectory = await mkdtemp(join(destination.path, ".pending-" + archiveId + "-"));
      temporaryInfo = (await safeDirectory(temporaryDirectory, true)).info;
      const archivePath = join(temporaryDirectory, "archive.tar");
      const archive = await writeArchive(archivePath, entries, plan.limits.maxBytes, signal, assertCurrent);
      const manifest = manifestSchema.parse({ schemaVersion: 1, commandId: input.commandId, projectId: input.projectId, volumeKey: plan.volumeKey,
        destinationId: plan.destinationId, planDigest: plan.planDigest, inputDigest: input.inputDigest, agentId: input.agentId, correlationId: input.context.correlationId, configDigest: plan.configDigest, stateDigest: plan.stateDigest,
        consistency: "stopped", archiveBytes: archive.archiveBytes, entries: entries.length, archiveSha256: archive.archiveSha256 });
      const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
      const manifestPath = join(temporaryDirectory, "manifest.json");
      const manifestHandle = await open(manifestPath, "wx", 0o600);
      try { await manifestHandle.writeFile(manifestBytes); await manifestHandle.sync(); } finally { await manifestHandle.close(); }
      const sourceAfter = await safeDirectory(source.root, false), destinationAfter = await safeDirectory(destinationPath, true);
      if (sourceAfter.info.dev !== sourceRoot.info.dev || sourceAfter.info.ino !== sourceRoot.info.ino
        || !sameDirectory(destinationAfter.info, destination.info)) fail("COMPOSE_BACKUP_UNSAFE_DESTINATION");
      const afterObservation = await inspectCurrent();
      if (afterObservation.physicalIdentity !== observation.physicalIdentity || afterObservation.stateDigest !== observation.stateDigest) fail("COMPOSE_BACKUP_STALE");
      assertCurrent(); await awaitAbortable(() => authority.assertValid(), signal); assertCurrent();
      const publicationRoot = await safeDirectory(destinationPath, true); if (!sameDirectory(publicationRoot.info, destination.info)) fail("COMPOSE_BACKUP_UNSAFE_DESTINATION");
      assertCurrent();
      const finalDirectory = join(destination.path, archiveId);
      try { await rename(temporaryDirectory, finalDirectory); temporaryDirectory = undefined; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
        const concurrent = await existingReceipt(destination.path, archiveId, input, destination.info);
        if (!concurrent) fail("COMPOSE_BACKUP_CONFLICT");
        const pending = temporaryDirectory;
        if (!pending) fail("COMPOSE_BACKUP_CONFLICT");
        return concurrent; // The identity-checked finally owns pending cleanup.
      }
      const published = await existingReceipt(destination.path, archiveId, input, destination.info);
      if (!published) fail("COMPOSE_BACKUP_FAILED");
      return { ...published, status: "created", idempotent: false };
    } catch (error) {
      if (error instanceof ComposeVolumeBackupError) throw error;
      return fail("COMPOSE_BACKUP_FAILED");
    } finally {
      clearTimeout(timer); external.removeEventListener("abort", cancel);
      if (temporaryDirectory && temporaryInfo && destinationSnapshot) try {
        const root = await safeDirectory(destinationSnapshot.path, true), pending = await safeDirectory(temporaryDirectory, true);
        if (sameDirectory(root.info, destinationSnapshot.info) && sameDirectory(pending.info, temporaryInfo)) await rm(temporaryDirectory, {recursive: true, force: true});
      } catch {/* Preserve uncertain ownership/namespace evidence; never repair or remove an unrecognized path. */}
    }
  }
  return { async execute(raw: unknown, authority: ComposeVolumeBackupAuthority, signal: AbortSignal): Promise<ComposeVolumeBackupReceiptV1> {
    let parsed: ComposeVolumeBackupExecutionInput;
    try { parsed = composeVolumeBackupAgentCommandSchema.parse(structuredClone(raw)); } catch { fail("COMPOSE_BACKUP_INVALID"); }
    const key = archiveName(parsed), current = inFlight.get(key);
    if (current) {
      const replay = await current;
      return { ...replay, status: "already-created", idempotent: true };
    }
    const operation = executeOnce(parsed, authority, signal);
    inFlight.set(key, operation);
    try { return await operation; } finally { if (inFlight.get(key) === operation) inFlight.delete(key); }
  } };
}

/** Shared private filesystem guards; existing Compose behavior remains unchanged. */
export const composeBackupFilesystem = Object.freeze({safeDirectory,hashFile,sameDirectory});

/** Reuse the P3 safe tar writer for an already corroborated stopped native volume. */
export async function captureComposeVolumeBackupToSink(source:ComposeVolumeBackupSource,runtimeName:string,maxBytes:number,write:(bytes:Uint8Array)=>Promise<void>,signal:AbortSignal,current:()=>void):Promise<{bytes:number;sha256:string}>{
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1024)fail("COMPOSE_BACKUP_LIMIT");
 const check=()=>{if(signal.aborted)fail("COMPOSE_BACKUP_FAILED");current();};check();
 const resolved=await awaitAbortable(()=>source.resolveVolume(runtimeName,signal),signal);check();
 const root=await safeDirectory(resolved.root,false);check();
 const entries:ComposeVolumeBackupEntry[]=[],maximum=Math.floor((maxBytes-1024)/512),iterator=resolved.entries()[Symbol.asyncIterator]();
 try{for(;;){check();const next=await awaitAbortable(()=>Promise.resolve(iterator.next()),signal);check();if(next.done)break;if(entries.length>=maximum)fail("COMPOSE_BACKUP_LIMIT");entries.push(next.value);}}
 finally{if(signal.aborted)void Promise.resolve(iterator.return?.()).catch(()=>undefined);}
 validateEntrySet(entries,maximum);entries.sort((a,b)=>a.path.localeCompare(b.path,"en"));
 const result=await writeArchive(null,entries,maxBytes,signal,check,write);check();
 const rebound=await awaitAbortable(()=>source.resolveVolume(runtimeName,signal),signal),after=await safeDirectory(rebound.root,false);check();
 if(after.path!==root.path||after.info.dev!==root.info.dev||after.info.ino!==root.info.ino)fail("COMPOSE_BACKUP_UNSAFE_SOURCE");
 return {bytes:result.archiveBytes,sha256:result.archiveSha256};
}
