import { describe, expect, it } from "vitest";
import { createDeploymentPlan, createDeploymentSnapshot } from "./snapshot-plan.js";
import { createSourceIntent } from "./source-intent.js";
const source = createSourceIntent({ sourceMode: "image", requestedReference: "registry.example.com/app:stable" }, { policyVersion: "p1", trustedHosts: ["registry.example.com"], allowTags: true, allowDigests: true });
const hash = "a".repeat(64); const make = (extra = {}) => createDeploymentSnapshot({ deploymentId: "d1", projectId: "p1", source, configRevision: "c1", runtimeRevision: "r1", runtimePort: 8080, secretRefs: [{ secretRefId: "API_KEY", version: 1 }], policyVersion: "p1", schemaVersion: 1, ...extra }, { sha256: () => hash });
describe("deployment snapshots", () => {
  it("hashes only canonical contract evidence", () => { const snapshot = make({ secretValues: { API_KEY: "secret-value" }, timestamp: Date.now(), random: Math.random() }); expect(snapshot.canonicalJson).not.toContain("secret-value"); expect(snapshot.canonicalJson).not.toContain("timestamp"); expect(snapshot.hash).toMatch(/^[0-9a-f]{64}$/); });
  it("rejects invalid hash output and normalizes digests", () => { expect(() => createDeploymentSnapshot({ ...make(), resolvedDigest: "sha256:BAD" }, { sha256: () => hash })).toThrow("resolved digest"); expect(make({ resolvedDigest: `SHA256:${"B".repeat(64)}` }).resolvedDigest).toBe(`sha256:${"b".repeat(64)}`); });
  it("blocks unresolved image tags", () => expect(createDeploymentPlan(make())).toMatchObject({ status: "blocked", blocked: { code: "image-digest-required" } }));
  it("allows digest-resolved plans", () => expect(createDeploymentPlan(make({ resolvedDigest: `sha256:${"b".repeat(64)}` })).status).toBe("executable"));
});
