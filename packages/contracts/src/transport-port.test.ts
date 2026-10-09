import { describe, expect, it } from "vitest";
import { transportPortClaimSchema, transportPortIntentSchema, transportPortPreviewRequestSchema,
  transportPortProtocolSchema, transportPortRollbackRequestSchema } from "./transport-port.js";

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
});
