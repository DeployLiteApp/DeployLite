import { describe, expect, it } from "vitest";
import { agentCachedReceiptSchema, agentReceiptQuerySchema } from "./agent-transport.js";
const image = `registry.example.com/team/app@sha256:${"a".repeat(64)}`;
const fields = { schemaVersion: 1, agentId: "agent", commandId: "original-command", projectId: "project", deploymentId: "execution", correlationId: "original-correlation", authority: null, timeoutMs: 100 };
const execute = { ...fields, action: "deploy.execute", sourceDeploymentId: null, snapshot: { deploymentId: "execution" }, snapshotHash: "a".repeat(64), replacement: null };
const stop = { ...fields, action: "deployment.stop", candidateId: "original-candidate", effectiveImage: image, containerId: "1".repeat(64) };
const inner = { deploymentId: "execution", effectiveImage: image, runtimePort: 3000, terminalStatus: "failed", health: "failed", proven: false, rollback: { target: null, result: "not-required" } };
const receipt = { schemaVersion: 1, commandId: fields.commandId, deploymentId: fields.deploymentId, terminalStatus: "failed", health: "failed", redacted: true, receipt: inner };
describe("cache-only receipt wire", () => {
  it.each([execute, stop])("accepts immutable original scope for $action without a new lease", (query) => {
    expect(agentReceiptQuerySchema.safeParse(query).success).toBe(true);
  });
  it("accepts a validated cached execution receipt and an unresolved null response", () => {
    const response = { schemaVersion: 1, action: "deploy.execute", agentId: fields.agentId, commandId: fields.commandId, correlationId: fields.correlationId, receipt };
    expect(agentCachedReceiptSchema.safeParse(response).success).toBe(true);
    expect(agentCachedReceiptSchema.safeParse({ ...response, receipt: null }).success).toBe(true);
  });
});

it.each([execute, stop])("rejects execution lease/unknown effects on $action cache-only query", (query) => {
  expect(agentReceiptQuerySchema.safeParse({ ...query, lease: { leaseId: "fresh", deploymentId: "execution", fence: 99, expiresAt: 999999 } }).success).toBe(false);
});
it.each(["deploy.execute", "deployment.stop"])("rejects malformed cached receipt for %s", (action) => {
  expect(agentCachedReceiptSchema.safeParse({ schemaVersion: 1, action, agentId: "agent", commandId: "original-command", correlationId: "original-correlation", receipt: "invented" }).success).toBe(false);
});
it("rejects unknown response fields rather than accepting an effect-bearing extension", () => {
  expect(agentCachedReceiptSchema.safeParse({ schemaVersion: 1, action: "deploy.execute", agentId: "agent", commandId: fields.commandId, correlationId: fields.correlationId, receipt: null, executeAgain: true }).success).toBe(false);
});
it("reuses strict nested execution receipt validation for cached evidence", () => {
  expect(agentCachedReceiptSchema.safeParse({ schemaVersion: 1, action: "deploy.execute", agentId: "agent", commandId: fields.commandId, correlationId: fields.correlationId, receipt: { ...receipt, receipt: { ...inner, secret: "unexpected" } } }).success).toBe(false);
});
it("rejects execution evidence returned as a Stop cached receipt", () => {
  expect(agentCachedReceiptSchema.safeParse({ schemaVersion: 1, action: "deployment.stop", agentId: "agent", commandId: fields.commandId, correlationId: fields.correlationId, receipt }).success).toBe(false);
});

it.each([0, 300001])("rejects unbounded or empty read timeout %s", (timeoutMs) => {
  expect(agentReceiptQuerySchema.safeParse({ ...execute, timeoutMs }).success).toBe(false);
});
