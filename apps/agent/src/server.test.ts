import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { signAgentTransport } from "@deploylite/config";
import { createDeploymentSnapshot, createSourceIntent } from "@deploylite/contracts";
import { AuthenticatedAgentCommandReceiver } from "./agent-transport.js";
import { startAgentServer } from "./server.js";

describe("agent HTTP server", () => {
  it("mounts the authenticated execution path and closes cleanly", async () => {
    const receiver = { receive: async () => ({ schemaVersion: 2 as const, commandId: "cmd", deploymentId: "dep", sourceDeploymentId: "source", snapshotHash: "a".repeat(64), terminalStatus: "succeeded" as const, health: "passed" as const, redacted: true as const, correlationId: "corr", receipt: { deploymentId: "dep", effectiveImage: `registry.example/app@sha256:${"a".repeat(64)}`, runtimePort: 3000, health: "passed" as const, terminalStatus: "succeeded" as const, rollback: { target: null, result: "not-required" as const }, proven: true as const } }) };
    const server = await startAgentServer({ host: "127.0.0.1", port: 0, receiver: receiver as never, replayStore: { durable: true } as never });
    const address = server.server.address();
    expect(address && typeof address === "object").toBe(true);
    const port = (address as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/deployments/execute`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(200);
    await server.close();
    expect(server.server.listening).toBe(false);
  });

  it("fails closed without an explicit durable replay adapter", async () => {
    const receiver = { receive: async () => ({}) };
    await expect(startAgentServer({ host: "127.0.0.1", port: 0, receiver: receiver as never, replayStore: undefined as never })).rejects.toThrow("durable agent replay store");
  });

  it("authenticates the real receiver and rejects wrong-key and tampered requests", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const snapshot = createDeploymentSnapshot({ deploymentId: "dep-auth", projectId: "project-auth", source: createSourceIntent({ sourceMode: "image", requestedReference: `registry.example.com/app@${digest}` }, { policyVersion: "p1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true }), configRevision: "c", runtimeRevision: "r", runtimePort: 3000, secretRefs: [], policyVersion: "p1", schemaVersion: 1 }, { sha256: (bytes) => createHash("sha256").update(bytes).digest("hex") });
    const body = { schemaVersion: 2, agentId: "agent-auth", commandId: "cmd-auth", deploymentId: snapshot.deploymentId, sourceDeploymentId: snapshot.deploymentId, projectId: snapshot.projectId, snapshot: { ...snapshot, canonicalBytes: undefined }, snapshotHash: snapshot.hash, requiredCapabilities: ["deploy.execute"], lease: { leaseId: "lease-auth", deploymentId: snapshot.deploymentId, fence: 1, expiresAt: Date.now() + 30_000 }, context: { requestId: "req-auth", correlationId: "corr-auth" }, timeoutMs: 1000, cancellationRequested: false };
    const receiver = new AuthenticatedAgentCommandReceiver({ agentId: "agent-auth", trustKey: "transport_test_key_123", capabilities: ["deploy.execute"], dispatcher: { dispatch: async () => ({ deploymentId: snapshot.deploymentId, effectiveImage: `registry.example.com/app@${digest}`, runtimePort: 3000, health: "passed" as const, terminalStatus: "succeeded" as const, rollback: { target: null, result: "not-required" as const }, proven: true as const }) }, replayStore: { durable: true, claim: async () => ({ claimed: true }), wait: async () => { throw new Error("unexpected wait"); }, complete: async () => {}, release: async () => {} } });
    const server = await startAgentServer({ host: "127.0.0.1", port: 0, receiver, replayStore: receiver as never }); const port = (server.server.address() as { port: number }).port;
     try { const payload = JSON.stringify(body); const wrong = await fetch(`http://127.0.0.1:${port}/deployments/execute`, { method: "POST", body: payload, headers: { "x-deploylite-signature": signAgentTransport(payload, "wrong_transport_key_123") } }); expect(wrong.status).toBe(401); const tampered = { ...body, commandId: "cmd-tampered" }; const response = await fetch(`http://127.0.0.1:${port}/deployments/execute`, { method: "POST", body: JSON.stringify(tampered), headers: { "x-deploylite-signature": signAgentTransport(payload, "transport_test_key_123") } }); expect(response.status).toBe(401); const stale = { ...body, lease: { ...body.lease, expiresAt: 0 } }; const stalePayload = JSON.stringify(stale); const staleResponse = await fetch(`http://127.0.0.1:${port}/deployments/execute`, { method: "POST", body: stalePayload, headers: { "x-deploylite-signature": signAgentTransport(stalePayload, "transport_test_key_123") } }); expect(staleResponse.status).toBe(409); } finally { await server.close(); }
  });

  it("authenticates capability negotiation and binds the response to its request", async () => {
    const trustKey = "transport_test_key_123";
    const receiver = new AuthenticatedAgentCommandReceiver({ agentId: "agent-capabilities", trustKey, capabilities: ["deploy.execute"], dispatcher: { dispatch: async () => { throw new Error("must not dispatch"); } }, replayStore: { durable: true, claim: async () => ({ claimed: true, claimToken: "claim" }), wait: async () => ({}), complete: async () => {}, release: async () => {} } });
    const server = await startAgentServer({ host: "127.0.0.1", port: 0, receiver, replayStore: receiver as never });
    const port = (server.server.address() as { port: number }).port;
    try {
      const unsigned = await fetch(`http://127.0.0.1:${port}/capabilities`);
      expect(unsigned.status).toBe(401);
      const signature = signAgentTransport("GET /capabilities", trustKey);
      const negotiated = await fetch(`http://127.0.0.1:${port}/capabilities`, { headers: { "x-deploylite-signature": signature } });
      expect(negotiated.status).toBe(200);
      expect(negotiated.headers.get("x-deploylite-request-signature")).toBe(signature);
      expect(await negotiated.json()).toMatchObject({ agentId: "agent-capabilities", protocolVersions: [1, 2] });
      const malformed = await fetch(`http://127.0.0.1:${port}/capabilities`, { headers: { "x-deploylite-signature": "not-a-signature" } });
      expect(malformed.status).toBe(401);
    } finally { await server.close(); }
  });
});
