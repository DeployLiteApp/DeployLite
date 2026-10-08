import { describe, expect, it } from "vitest";
import { composeNetworkAttachmentAgentCommandSchema, composeNetworkAttachmentReceiptSchema } from "./compose-network-attachment.js";

const authority = {
  schemaVersion: 1 as const, projectId: "project-1", commandId: "command-1", action: "project.update" as const, inputDigest: "a".repeat(64),
  projectLease: { leaseId: "lease-1", projectId: "project-1", fence: 2, expiresAt: 50_000 }
};
const command = {
  schemaVersion: 1 as const, action: "compose.network.attachment" as const, agentId: "agent-1", commandId: "command-1", projectId: "project-1",
  operation: "compose.resource.attachment" as const, idempotencyKey: "attach-1", inputDigest: "a".repeat(64), canonicalDocument: "{}",
  configDigest: "b".repeat(64), stateDigest: "c".repeat(64), key: "backend", runtimeName: `dl-${"d".repeat(32)}-net-backend`,
  service: "api", attachmentAction: "attach" as const, containerId: "e".repeat(64), alreadySatisfied: false,
  requiredCapabilities: ["compose.network.attachment.v1"], authority, lease: authority.projectLease,
  context: { requestId: "req-1", correlationId: "corr-1" }, timeoutMs: 10_000, cancellationRequested: false as const
};
const receipt = {
  schemaVersion: 1 as const, action: "compose.network.attachment" as const, agentId: "agent-1", commandId: "command-1", projectId: "project-1",
  inputDigest: "a".repeat(64), correlationId: "corr-1", key: "backend", runtimeName: command.runtimeName, service: "api",
  attachmentAction: "attach" as const, containerId: command.containerId, resourceId: "f".repeat(64), beforeStateDigest: command.stateDigest,
  afterStateDigest: "0".repeat(64), observedAt: 20_000, status: "attached" as const, reconciled: false, redacted: true as const, reason: null
};

describe("authenticated network attachment envelopes", () => {
  it("binds network intent to the existing project.update authority and exact lease", () => {
    expect(composeNetworkAttachmentAgentCommandSchema.parse(command)).toEqual(command);
    expect(composeNetworkAttachmentReceiptSchema.parse(receipt)).toEqual(receipt);
  });
  it.each([
    ["changed lease", { ...command, lease: { ...authority.projectLease, fence: 3 } }],
    ["changed project", { ...command, projectId: "project-2" }],
    ["changed command", { ...command, commandId: "other" }],
    ["missing capability", { ...command, requiredCapabilities: [] }],
    ["volume action", { ...command, action: "compose.volume.attachment" }]
  ])("rejects %s", (_label, value) => {
    expect(composeNetworkAttachmentAgentCommandSchema.safeParse(value).success).toBe(false);
  });
  it("rejects success receipts whose terminal direction contradicts the command", () => {
    expect(composeNetworkAttachmentReceiptSchema.safeParse({ ...receipt, status: "detached" }).success).toBe(false);
  });
});
