import { describe, expect, it } from "vitest";
import { createDeploymentCommand, CapabilityError, InMemoryCapabilityRegistry, protocolPayloadFingerprint, ProtocolValidationError } from "./protocol.js";
const lease = { leaseId: "l1", deploymentId: "d1", fence: 1, expiresAt: 100 };
describe("deployment protocol envelope", () => {
  it("normalizes versioned commands and fingerprints canonical payloads", () => { const a = createDeploymentCommand({ schemaVersion: 1, commandId: "c1", deploymentId: "d1", requiredCapabilities: ["deploy", "deploy"], payload: { b: 2, a: 1 }, lease }); const b = createDeploymentCommand({ ...a, payload: { a: 1, b: 2 } }); expect(a.requiredCapabilities).toEqual(["deploy"]); expect(protocolPayloadFingerprint(a.payload)).toBe(protocolPayloadFingerprint(b.payload)); });
  it("validates version and lease identity", () => { expect(() => createDeploymentCommand({ schemaVersion: 2, commandId: "c", deploymentId: "d", requiredCapabilities: [], payload: {}, lease })).toThrow(ProtocolValidationError); expect(() => createDeploymentCommand({ schemaVersion: 1, commandId: "c", deploymentId: "d", requiredCapabilities: [], payload: {}, lease: { ...lease, deploymentId: "other" } })).toThrow("does not match"); });
  it("exposes capability and classified error contracts", () => { expect(new InMemoryCapabilityRegistry(["deploy"]).has("deploy")).toBe(true); expect(new CapabilityError("missing").code).toBe("capability-unsupported"); });
});
