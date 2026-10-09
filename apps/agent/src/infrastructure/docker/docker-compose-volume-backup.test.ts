import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPOSE_VOLUME_BACKUP_CAPABILITY, InMemoryCapabilityRegistry, type ComposeResourceObservationV1 } from "@deploylite/contracts";
import { composeVolumeBackupExecutionDigest, createComposePreview, digestComposeResourceObservation, digestControlInput, type ComposeResourceInspector } from "@deploylite/domain";
import { createDockerComposeVolumeBackupExecutor, createLocalDirectoryComposeVolumeBackupSource, type ComposeVolumeBackupEntry, type ComposeVolumeBackupSource } from "./docker-compose-volume-backup.js";

const policy = { policyVersion: "backup-test", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true };
const image = "registry.example.com/app@sha256:" + "a".repeat(64);
const document = JSON.stringify({ services: { app: { image, volumes: [{ type: "volume", source: "data", target: "/data" }] } }, volumes: { data: {} } });
const roots: string[] = [];
async function temporaryRoot() { const base = await realpath(tmpdir()); const root = await mkdtemp(join(base, "deploylite-backup-test-")); roots.push(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function entry(path: string, value = "hello"): ComposeVolumeBackupEntry {
  const bytes = Buffer.from(value);
  return { path, kind: "file", mode: 0o644, modifiedAtSeconds: 1, size: bytes.length,
    open: async function* () { yield bytes; } };
}
async function fixture(options: { destinationId?: string; sourceRoot?: string; destinationRoot?: string } = {}) {
  const sourceRoot = options.sourceRoot ?? await temporaryRoot();
  const destinationRoot = options.destinationRoot ?? await temporaryRoot();
  await mkdir(sourceRoot, { recursive: true }).catch(() => undefined);
  await mkdir(destinationRoot, { recursive: true }).catch(() => undefined);
  await mkdir(join(sourceRoot, "docs"), { recursive: true });
  await writeFile(join(sourceRoot, "docs", "readme.txt"), "hello");
  const preview = createComposePreview(document, "project-1", policy);
  const observation: ComposeResourceObservationV1 = { schemaVersion: 1, owner: "deploylite", agentId: "agent-1", projectId: "project-1",
    kind: "volume", key: "data", runtimeName: preview.volumes[0]!.runtimeName, physicalIdentity: "2026-10-08T00:00:00Z",
    configDigest: preview.configDigest, observedAt: 1, stateDigest: "0".repeat(64), containers: [] };
  observation.stateDigest = digestComposeResourceObservation(observation);
  const destinationId = options.destinationId ?? "destination-1";
  const plan = { schemaVersion: 1 as const, operation: "compose.volume.backup.plan" as const, status: "preview" as const,
    executionAllowed: false as const, archiveCreated: false as const, projectId: "project-1", volumeKey: "data",
    configDigest: preview.configDigest, stateDigest: observation.stateDigest, profileId: "profile-1", destinationId,
    consistency: "offline-required" as const, verification: "integrity-and-completeness-required" as const,
    limits: { maxBytes: 1_000_000, maxEntries: 20, maxDurationMs: 10_000, planTtlMs: 60_000 }, planDigest: "0".repeat(64) };
  const { planDigest: _unused, ...intent } = plan;
  plan.planDigest = digestControlInput({ ...intent, owner: "deploylite", agentId: "agent-1" });
  const inspector: ComposeResourceInspector = { inspect: vi.fn(async () => structuredClone(observation)) };
  const sourceBase = createLocalDirectoryComposeVolumeBackupSource(new Map([[preview.volumes[0]!.runtimeName, sourceRoot]]));
  const resolveVolume = vi.fn(sourceBase.resolveVolume);
  const source: ComposeVolumeBackupSource = { resolveVolume };
  const expiresAt = Date.now() + 50_000;
  const input = { schemaVersion: 1 as const, action: "compose.volume.backup" as const, agentId: "agent-1", commandId: "command-1",
    projectId: "project-1", operation: "compose.volume.backup.execute" as const, idempotencyKey: "backup-once",
    inputDigest: "0".repeat(64), canonicalDocument: preview.canonicalDocument, plan,
    requiredCapabilities: [COMPOSE_VOLUME_BACKUP_CAPABILITY] as [typeof COMPOSE_VOLUME_BACKUP_CAPABILITY],
    authority: { schemaVersion: 1 as const, projectId: "project-1", commandId: "command-1", action: "project.update" as const,
      inputDigest: "0".repeat(64), projectLease: { projectId: "project-1", leaseId: "lease-1", fence: 2, expiresAt } },
    lease: { projectId: "project-1", leaseId: "lease-1", fence: 2, expiresAt },
    context: { requestId: "request-1", correlationId: "correlation-1" }, timeoutMs: 5_000, cancellationRequested: false as const };
  input.inputDigest = composeVolumeBackupExecutionDigest(input);
  input.authority.inputDigest = input.inputDigest;
  const authority = { ...input.authority, expiresAt: input.lease.expiresAt, assertValid: vi.fn(async () => undefined) };
  const executor = createDockerComposeVolumeBackupExecutor({ owner: "deploylite", agentId: "agent-1", imagePolicy: policy,
    capabilities: new InMemoryCapabilityRegistry(["compose.resource.inspect.v1"]), inspector, source,
    destinations: new Map([["destination-1", destinationRoot]]) });
  return { sourceRoot, destinationRoot, preview, observation, plan, source, resolveVolume, inspector, input, authority, executor };
}

describe("simulated local Compose volume backup", () => {
  it("writes an uncompressed TAR and integrity/completeness manifest under the allowlisted root", async () => {
    const f = await fixture();
    const receipt = await f.executor.execute(f.input, f.authority, new AbortController().signal);
    expect(receipt).toMatchObject({ status: "created", destinationId: "destination-1", volumeKey: "data", entries: 2, consistency: "stopped", idempotent: false, redacted: true });
    const archive = await readFile(join(f.destinationRoot, receipt.archiveId, "archive.tar"));
    expect(archive.subarray(0, 100).toString().replace(/\0.*$/s, "")).toBe("docs/");
    expect(archive.subarray(512, 612).toString().replace(/\0.*$/s, "")).toBe("docs/readme.txt");
    expect(archive.includes(Buffer.from("hello"))).toBe(true);
    expect(receipt.archiveSha256).toBe(createHash("sha256").update(archive).digest("hex"));
    const manifest = JSON.parse(await readFile(join(f.destinationRoot, receipt.archiveId, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ commandId: "command-1", planDigest: f.plan.planDigest, archiveSha256: receipt.archiveSha256, entries: 2 });
    expect(JSON.stringify([receipt, manifest])).not.toContain(f.sourceRoot);
    expect(JSON.stringify([receipt, manifest])).not.toContain(f.destinationRoot);
  });

  it("returns a verified idempotent receipt without rereading source on retry", async () => {
    const f = await fixture();
    const first = await f.executor.execute(f.input, f.authority, new AbortController().signal);
    const second = await f.executor.execute(f.input, f.authority, new AbortController().signal);
    expect(second).toMatchObject({ archiveId: first.archiveId, archiveSha256: first.archiveSha256, manifestSha256: first.manifestSha256, idempotent: true });
    expect(f.source.resolveVolume).toHaveBeenCalledOnce();
  });

  it("fails closed for an unknown destination before opening the volume", async () => {
    const f = await fixture({ destinationId: "unconfigured" });
    await expect(f.executor.execute(f.input, f.authority, new AbortController().signal)).rejects.toMatchObject({ code: "COMPOSE_BACKUP_UNAVAILABLE" });
    expect(f.source.resolveVolume).not.toHaveBeenCalled();
  });

  it.each(["../escape", "unsafe-link"] as const)("rejects traversal and symlink entries without publishing %s", async unsafe => {
    const f = await fixture();
    f.resolveVolume.mockImplementation(async () => ({ root: f.sourceRoot,
      entries: async function* () { yield unsafe === "../escape" ? entry(unsafe) : { path: "linked", kind: "symlink" as const, mode: 0, modifiedAtSeconds: 0, size: 0, target: "/etc/passwd" }; } }));
    await expect(f.executor.execute(f.input, f.authority, new AbortController().signal)).rejects.toMatchObject({ code: "COMPOSE_BACKUP_UNSAFE_SOURCE" });
    expect(await readdir(f.destinationRoot)).toEqual([]);
  });

  it("rejects active consumers and overlapping source/destination roots", async () => {
    const f = await fixture();
    const running = structuredClone(f.observation); running.containers = [{ containerId: "b".repeat(64), service: "app", running: true, attached: true, mounts: [] }];
    running.stateDigest = digestComposeResourceObservation(running);
    (f.inspector.inspect as ReturnType<typeof vi.fn>).mockResolvedValue(running);
    await expect(f.executor.execute(f.input, f.authority, new AbortController().signal)).rejects.toMatchObject({ code: "COMPOSE_BACKUP_IN_USE" });
    const overlap = await fixture();
    overlap.executor = createDockerComposeVolumeBackupExecutor({ owner: "deploylite", agentId: "agent-1", imagePolicy: policy,
      capabilities: new InMemoryCapabilityRegistry(["compose.resource.inspect.v1"]), inspector: overlap.inspector, source: overlap.source,
      destinations: new Map([["destination-1", overlap.sourceRoot]]) });
    await expect(overlap.executor.execute(overlap.input, overlap.authority, new AbortController().signal)).rejects.toMatchObject({ code: "COMPOSE_BACKUP_UNSAFE_DESTINATION" });
  });
});
