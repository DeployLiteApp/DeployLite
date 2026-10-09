import { describe, expect, it } from "vitest";
import { COMPOSE_VOLUME_BACKUP_CAPABILITY, composeVolumeBackupAgentCommandSchema, composeVolumeBackupCachedReceiptSchema,
  composeVolumeBackupReceiptSchema } from "./compose-volume-backup.js";

const digest = "a".repeat(64);
const plan = { schemaVersion: 1 as const, operation: "compose.volume.backup.plan" as const, status: "preview" as const,
  executionAllowed: false as const, archiveCreated: false as const, projectId: "project-1", volumeKey: "data",
  configDigest: digest, stateDigest: digest, profileId: "profile-1", destinationId: "destination-1",
  consistency: "offline-required" as const, verification: "integrity-and-completeness-required" as const,
  limits: { maxBytes: 1_000_000, maxEntries: 10, maxDurationMs: 10_000, planTtlMs: 60_000 }, planDigest: digest };
const authority = { schemaVersion: 1 as const, projectId: "project-1", commandId: "command-1", action: "project.update" as const,
  inputDigest: digest, projectLease: { projectId: "project-1", leaseId: "lease-1", fence: 2, expiresAt: 50_000 } };
function command() {
  return { schemaVersion: 1 as const, action: "compose.volume.backup" as const, agentId: "agent-1", commandId: "command-1",
    projectId: "project-1", operation: "compose.volume.backup.execute" as const, idempotencyKey: "backup-once", inputDigest: digest,
    canonicalDocument: "{\"services\":{}}", plan, requiredCapabilities: [COMPOSE_VOLUME_BACKUP_CAPABILITY] as [typeof COMPOSE_VOLUME_BACKUP_CAPABILITY],
    authority, lease: authority.projectLease, context: { requestId: "request-1", correlationId: "correlation-1" },
    timeoutMs: 5_000, cancellationRequested: false as const };
}
const receipt = { schemaVersion: 1 as const, action: "compose.volume.backup" as const, agentId: "agent-1", commandId: "command-1",
  projectId: "project-1", inputDigest: digest, correlationId: "correlation-1", volumeKey: "data", destinationId: "destination-1",
  archiveId: "backup_0123456789abcdef0123456789abcdef", status: "created" as const, consistency: "stopped" as const,
  archiveBytes: 2048, entries: 1, archiveSha256: digest, manifestSha256: digest, idempotent: false, redacted: true as const };

describe("authenticated Compose volume backup contracts", () => {
  it("binds execution to plan, project authority, destination and bounded agent capability", () => {
    expect(composeVolumeBackupAgentCommandSchema.parse(command())).toMatchObject({
      action: "compose.volume.backup", projectId: "project-1", plan: { destinationId: "destination-1", executionAllowed: false },
      requiredCapabilities: [COMPOSE_VOLUME_BACKUP_CAPABILITY], authority, lease: authority.projectLease
    });
  });

  it.each(["project", "command", "digest", "lease"] as const)("rejects a mismatched %s authority binding", field => {
    const value = command();
    if (field === "project") value.authority.projectId = "foreign";
    if (field === "command") value.authority.commandId = "foreign";
    if (field === "digest") value.authority.inputDigest = "b".repeat(64);
    if (field === "lease") value.lease = { ...authority.projectLease, fence: 3 };
    expect(composeVolumeBackupAgentCommandSchema.safeParse(value).success).toBe(false);
  });

  it("accepts only path-free integrity and completeness receipts", () => {
    expect(composeVolumeBackupReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(composeVolumeBackupReceiptSchema.safeParse({ ...receipt, localPath: "/private/backup.tar" }).success).toBe(false);
    expect(composeVolumeBackupCachedReceiptSchema.safeParse({ schemaVersion: 1, action: "compose.volume.backup",
      agentId: "agent-1", commandId: "command-1", correlationId: "correlation-1", receipt }).success).toBe(true);
  });
});
