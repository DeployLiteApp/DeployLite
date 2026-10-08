import { describe, expect, it, vi } from "vitest";
import { COMPOSE_VOLUME_BACKUP_CAPABILITY, type ComposeVolumeBackupAgentCommandV1, type ComposeVolumeBackupReceiptV1,
  type ProjectControlAuthorityV1 } from "@deploylite/contracts";
import { signAgentTransport } from "@deploylite/config";
import { composeVolumeBackupExecutionDigest } from "@deploylite/domain";
import { AuthenticatedAgentCommandReceiver } from "./agent-transport.js";

const key = "backup_transport_test_key_123";
const digest = "a".repeat(64);
const plan = { schemaVersion: 1 as const, operation: "compose.volume.backup.plan" as const, status: "preview" as const,
  executionAllowed: false as const, archiveCreated: false as const, projectId: "project-1", volumeKey: "data",
  configDigest: digest, stateDigest: digest, profileId: "profile-1", destinationId: "destination-1",
  consistency: "offline-required" as const, verification: "integrity-and-completeness-required" as const,
  limits: { maxBytes: 1_000_000, maxEntries: 10, maxDurationMs: 10_000, planTtlMs: 60_000 }, planDigest: digest };
const commandBase = { schemaVersion: 1 as const, action: "compose.volume.backup" as const, agentId: "agent-1",
  commandId: "command-1", projectId: "project-1", operation: "compose.volume.backup.execute", idempotencyKey: "backup-once",
  inputDigest: digest, canonicalDocument: "{\"services\":{}}", plan };
const inputDigest = composeVolumeBackupExecutionDigest(commandBase);
const projectAuthority: ProjectControlAuthorityV1 = { schemaVersion: 1, projectId: "project-1", commandId: "command-1",
  action: "project.update", inputDigest, projectLease: { projectId: "project-1", leaseId: "lease-1", fence: 2, expiresAt: 50_000 } };
const command: ComposeVolumeBackupAgentCommandV1 = { ...commandBase, inputDigest, requiredCapabilities: [COMPOSE_VOLUME_BACKUP_CAPABILITY],
  authority: projectAuthority, lease: projectAuthority.projectLease, context: { requestId: "request-1", correlationId: "correlation-1" },
  timeoutMs: 5_000, cancellationRequested: false };
const receipt: ComposeVolumeBackupReceiptV1 = { schemaVersion: 1, action: "compose.volume.backup", agentId: "agent-1",
  commandId: "command-1", projectId: "project-1", inputDigest, correlationId: "correlation-1", volumeKey: "data",
  destinationId: "destination-1", archiveId: "backup_0123456789abcdef0123456789abcdef", status: "created",
  consistency: "stopped", archiveBytes: 2048, entries: 1, archiveSha256: digest, manifestSha256: digest, idempotent: false, redacted: true };

describe("authenticated agent backup replay", () => {
  it("executes once and returns the verified terminal receipt as an idempotent replay", async () => {
    const records = new Map<string, unknown>(), execute = vi.fn(async () => receipt);
    const replayStore = {
      lookup: async (id: string) => records.get(id) as never ?? null,
      claim: async (id: string) => records.has(id) ? { claimed: false, receipt: records.get(id) as never } : { claimed: true, claimToken: "claim-1" },
      wait: async (id: string) => records.get(id) as never,
      complete: async (id: string, value: { receipt: Record<string, unknown> }) => { records.set(id, structuredClone(value.receipt)); },
      release: async () => {}
    };
    const receiver = new AuthenticatedAgentCommandReceiver({ agentId: "agent-1", trustKey: key, capabilities: [COMPOSE_VOLUME_BACKUP_CAPABILITY],
      dispatcher: { dispatch: async () => { throw new Error("deployment dispatcher must not run"); } }, volumeBackup: { execute },
      authorityValidator: { validateProjectUpdateAuthority: vi.fn(async value => expect(value).toEqual(projectAuthority)), validateDeploymentAuthority: vi.fn(async () => {}) },
      replayStore, now: () => 1 });
    const signature = signAgentTransport(JSON.stringify(command), key);
    await expect(receiver.receive(command, signature)).resolves.toEqual(receipt);
    await expect(receiver.receive(command, signature)).resolves.toMatchObject({ status: "already-created", idempotent: true, archiveSha256: digest });
    expect(execute).toHaveBeenCalledOnce();
  });
});
