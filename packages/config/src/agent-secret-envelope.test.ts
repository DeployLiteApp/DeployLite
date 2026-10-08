import { describe, expect, it } from "vitest";
import { openAgentSecretEnvelope, sealAgentSecretEnvelope } from "./agent-secret-envelope.js";

const trustKey = "compose_runtime_secret_envelope_test_key_123";
const binding = { agentId: "agent-1", commandId: "command-1", inputDigest: "a".repeat(64), projectId: "project-1" };
const secrets = { API_KEY: "secret-value-that-must-not-travel-in-clear", CERTIFICATE: "line one\nline two\n" };

describe("agent-bound Compose secret envelopes", () => {
  it("seals only bounded environment entries to the exact command binding", () => {
    const envelope = sealAgentSecretEnvelope(secrets, trustKey, binding);
    expect(envelope).not.toContain(secrets.API_KEY);
    expect(envelope).not.toContain("line one");
    expect(openAgentSecretEnvelope(envelope, trustKey, binding)).toEqual(secrets);
  });

  it("rejects a different agent, command, project, or input digest", () => {
    const envelope = sealAgentSecretEnvelope(secrets, trustKey, binding);
    for (const mismatch of [
      { ...binding, agentId: "agent-2" },
      { ...binding, commandId: "command-2" },
      { ...binding, projectId: "project-2" },
      { ...binding, inputDigest: "b".repeat(64) }
    ]) expect(() => openAgentSecretEnvelope(envelope, trustKey, mismatch)).toThrow("agent secret envelope rejected");
  });

  it("rejects tampering, wrong transport keys, and invalid environment names without reflecting input", () => {
    const envelope = sealAgentSecretEnvelope(secrets, trustKey, binding);
    const wire = JSON.parse(envelope) as { ciphertext: string };
    wire.ciphertext = `${wire.ciphertext.slice(0, -2)}AA`;
    expect(() => openAgentSecretEnvelope(JSON.stringify(wire), trustKey, binding)).toThrow("agent secret envelope rejected");
    expect(() => openAgentSecretEnvelope(envelope, `${trustKey}-other`, binding)).toThrow("agent secret envelope rejected");
    expect(() => sealAgentSecretEnvelope({ "bad-key": "value" }, trustKey, binding)).toThrow("agent secret envelope rejected");
  });
});
