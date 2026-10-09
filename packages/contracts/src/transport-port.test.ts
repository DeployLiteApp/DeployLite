import { describe, expect, it } from "vitest";
import { transportPortClaimSchema, transportPortIntentSchema, transportPortPreviewRequestSchema,
  transportPortProtocolSchema, transportPortRollbackRequestSchema, transportPortRevisionSchema, transportPortApplyReceiptSchema,
  transportPortRuntimeStateSchema } from "./transport-port.js";

const intent = { schemaVersion: 1, projectId: "project-1", deploymentId: "deployment-1", protocol: "tcp", publishedPort: 30_000, targetPort: 25565 } as const;

describe("transport port contracts", () => {
  it("accepts a scoped, versioned TCP or UDP publication", () => {
    expect(transportPortIntentSchema.parse(intent)).toEqual(intent);
    expect(transportPortIntentSchema.parse({ ...intent, protocol: "udp" })).toMatchObject({ protocol: "udp", publishedPort: 30_000 });
    expect(transportPortProtocolSchema.options).toEqual(["tcp", "udp"]);
  });

  it("accepts an unattached same-project port claim for a later deployment", () => {
    expect(transportPortClaimSchema.parse({ ...intent, deploymentId: null })).toMatchObject({ deploymentId: null, protocol: "tcp" });
  });

  it("bounds preview and rollback inputs to the protocol and port identity", () => {
    expect(transportPortPreviewRequestSchema.parse({ deploymentId: "deployment-1", protocol: "udp", publishedPort: 30_001, targetPort: 19132 }))
      .toMatchObject({ protocol: "udp", publishedPort: 30_001, targetPort: 19132 });
    expect(transportPortRollbackRequestSchema.parse({ protocol: "tcp", publishedPort: 30_001 })).toEqual({ protocol: "tcp", publishedPort: 30_001 });
  });

  it.each([0, -1, 65_536, 1.5])("rejects invalid published and target ports: %s", (value) => {
    expect(transportPortIntentSchema.safeParse({ ...intent, publishedPort: value }).success).toBe(false);
    expect(transportPortIntentSchema.safeParse({ ...intent, targetPort: value }).success).toBe(false);
  });

  it("rejects unknown protocols and unversioned fields", () => {
    expect(transportPortIntentSchema.safeParse({ ...intent, protocol: "sctp" }).success).toBe(false);
    expect(transportPortIntentSchema.safeParse({ ...intent, hostname: "game.example.com" }).success).toBe(false);
  });

  it("accepts redacted, revision-bound apply and rollback evidence", () => {
    const receipt = transportPortApplyReceiptSchema.parse({ schemaVersion: 1, action: "transport.port.apply", agentId: "agent-1",
      commandId: "command-1", projectId: "project-1", protocol: "udp", publishedPort: 19132, targetPort: 19132,
      deploymentId: "deployment-1", operation: "rollback", rollbackRevisionId: "revision-1", inputDigest: "a".repeat(64),
      correlationId: "correlation-1", containerId: "b".repeat(64), state: "updated", observedAt: 10, failureReason: null, redacted: true });
    expect(receipt).toMatchObject({ operation: "rollback", rollbackRevisionId: "revision-1", state: "updated" });
    const revision = transportPortRevisionSchema.parse({ schemaVersion: 1, id: "revision-2", projectId: "project-1", protocol: "udp",
      publishedPort: 19132, deploymentId: "deployment-1", targetPort: 19132, revisionNumber: 2, operation: "rollback",
      rollbackRevisionId: "revision-1", commandId: "command-1", correlationId: "correlation-1", createdAt: "2026-10-09T00:00:00.000Z",
      evidence: { state: "updated", observedAt: 10, redacted: true } });
    expect(revision.revisionNumber).toBe(2);
    expect(transportPortRevisionSchema.safeParse({ ...revision, evidence: { ...revision.evidence, rawCommand: "docker run" } }).success).toBe(false);
    expect(transportPortApplyReceiptSchema.safeParse({ ...receipt, failureReason: "not-bounded" }).success).toBe(false);
  });

  it("accepts only bounded, unique current container bindings", () => {
    const state = transportPortRuntimeStateSchema.parse({ projectId: "project-1", deploymentId: "deployment-1", containerId: "c".repeat(64),
      bindings: [{ protocol: "tcp", publishedPort: 25565, targetPort: 25565 }, { protocol: "udp", publishedPort: 25565, targetPort: 19132 }] });
    expect(state.bindings).toHaveLength(2);
    expect(transportPortRuntimeStateSchema.safeParse({ ...state, bindings: [...state.bindings, state.bindings[0]] }).success).toBe(false);
  });
});
