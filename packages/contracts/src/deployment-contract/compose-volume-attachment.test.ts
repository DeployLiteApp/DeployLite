import { describe, expect, it } from "vitest";
import { composeVolumeAttachmentAgentCommandSchema, composeVolumeAttachmentReceiptSchema, composeVolumeAttachmentReceiptQuerySchema } from "./compose-volume-attachment.js";

const digest = (value: string) => value.repeat(64);
const command = {
  schemaVersion: 1, action: "compose.volume.attachment", agentId: "agent-1", commandId: "command-1", projectId: "project-1",
  operation: "compose.resource.attachment", idempotencyKey: "replace-once", inputDigest: digest("a"), priorRevisionId: "revision-old", revisionId: "revision-new",
  priorConfigDigest: digest("b"), configDigest: digest("c"), stateDigest: digest("d"), secretDigest: digest("e"),
  priorCanonicalDocument: "{}", canonicalDocument: "{}", sealedEnvironment: "{\"schemaVersion\":1,\"algorithm\":\"A256GCM\"}",
  key: "data", runtimeName: `dl-${"f".repeat(32)}-vol-data`, service: "api", attachmentAction: "attach", containerId: digest("1"),
  requiredCapabilities: ["compose.volume.attachment.v1"],
  authority: { schemaVersion: 1, projectId: "project-1", commandId: "command-1", action: "project.update", inputDigest: digest("a"),
    projectLease: { projectId: "project-1", leaseId: "lease-1", fence: 1, expiresAt: 10_000 } },
  lease: { projectId: "project-1", leaseId: "lease-1", fence: 1, expiresAt: 10_000 },
  context: { requestId: "request-1", correlationId: "correlation-1" }, timeoutMs: 5_000, cancellationRequested: false
} as const;

describe("saved-revision Compose volume replacement protocol", () => {
  it("binds both saved revisions, secret digest, service, volume, exact prior container and project authority", () => {
    expect(composeVolumeAttachmentAgentCommandSchema.parse(command)).toEqual(command);
    expect(composeVolumeAttachmentAgentCommandSchema.safeParse({ ...command, revisionId: "other-revision" }).success).toBe(true);
    expect(composeVolumeAttachmentAgentCommandSchema.safeParse({ ...command, authority: { ...command.authority, projectId: "project-2" } }).success).toBe(false);
    expect(composeVolumeAttachmentAgentCommandSchema.safeParse({ ...command, runtimeName: "dl-foreign-volume" }).success).toBe(false);
  });

  it("keeps secret envelopes out of receipt-reconciliation queries", () => {
    const query = composeVolumeAttachmentReceiptQuerySchema.parse(Object.fromEntries(Object.entries(command).filter(([key]) => key !== "cancellationRequested" && key !== "sealedEnvironment")));
    expect(query).not.toHaveProperty("sealedEnvironment");
    expect(query).toHaveProperty("secretDigest", command.secretDigest);
  });

  it("requires terminal health and explicit recovery evidence in receipts", () => {
    const success = composeVolumeAttachmentReceiptSchema.parse({ schemaVersion: 1, action: command.action, agentId: command.agentId, commandId: command.commandId,
      projectId: command.projectId, inputDigest: command.inputDigest, correlationId: command.context.correlationId, key: command.key,
      runtimeName: command.runtimeName, service: command.service, attachmentAction: command.attachmentAction, priorContainerId: command.containerId,
      replacementContainerId: digest("2"), resourceCreatedAt: "2026-10-08T00:00:00.000Z", beforeStateDigest: command.stateDigest, afterStateDigest: digest("9"),
      observedAt: 100, status: "replaced", health: "passed", rollback: "not-required", reconciled: false, redacted: true, reason: null });
    expect(success.status).toBe("replaced");
    expect(composeVolumeAttachmentReceiptSchema.safeParse({ ...success, health: "failed" }).success).toBe(false);
    expect(composeVolumeAttachmentReceiptSchema.safeParse({ ...success, rollback: "failed" }).success).toBe(false);
  });
});
