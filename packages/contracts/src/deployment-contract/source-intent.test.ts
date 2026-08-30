import { describe, expect, it } from "vitest";
import { createSourceIntent, SourceIntentValidationError, validateImageReference } from "./source-intent.js";

const policy = { policyVersion: "policy-1", trustedHosts: ["Registry.Example.com."], allowTags: true, allowDigests: true } as const;
describe("deployment source intent", () => {
  it("normalizes builds without performing effects", () => expect(createSourceIntent({ sourceMode: "build", sourceRevision: "abc", buildProfileId: "node" })).toEqual({ schemaVersion: 1, sourceMode: "build", sourceRevision: "abc", buildProfileId: "node" }));
  it("allowlists and redacts image selectors", () => { const intent = createSourceIntent({ sourceMode: "image", requestedReference: "Registry.Example.com/app/api:Release_1" }, policy); expect(intent).toMatchObject({ sourceMode: "image", image: { reference: "registry.example.com/app/api:Release_1", redactedReference: "registry.example.com/app/api:<tag>", declaredIntentOnly: true } }); });
  it("rejects untrusted hosts and forbidden selectors", () => { const digest = `sha256:${"a".repeat(64)}`; expect(() => validateImageReference("evil.example/app:x", policy)).toThrowError(SourceIntentValidationError); expect(() => validateImageReference(`registry.example.com/app@${digest}`, { ...policy, allowDigests: false })).toThrow("not admitted"); });
  it("never includes arbitrary or secret input", () => { const result = createSourceIntent({ sourceMode: "image", requestedReference: "registry.example.com/app:stable", imageTag: "password=secret" }, policy); expect(JSON.stringify(result)).not.toContain("password"); });
});
