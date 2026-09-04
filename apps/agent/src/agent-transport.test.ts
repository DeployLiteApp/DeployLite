import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { signAgentTransport } from "@deploylite/config";
import { createDeploymentSnapshot, createSourceIntent } from "@deploylite/contracts";
import { FakeDockerImageTransport } from "@deploylite/domain";
import { AuthenticatedAgentCommandReceiver } from "./agent-transport.js";
import { DigestDeploymentDispatcher } from "./deployment-dispatcher.js";
import { InMemoryProtocolTransport } from "@deploylite/domain";

const digest = `sha256:${"a".repeat(64)}`;
function command() { const snapshot = createDeploymentSnapshot({ deploymentId: "dep_receiver", projectId: "project_receiver", source: createSourceIntent({ sourceMode: "image", requestedReference: `registry.example.com/team/app@${digest}` }, { policyVersion: "p1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true }), configRevision: "c1", runtimeRevision: "r1", runtimePort: 3000, secretRefs: [], policyVersion: "p1", schemaVersion: 1 }, { sha256: (bytes) => createHash("sha256").update(bytes).digest("hex") }); const body = { schemaVersion: 1 as const, agentId: "agent-1", commandId: "cmd-1", deploymentId: snapshot.deploymentId, projectId: snapshot.projectId, snapshot: { ...snapshot, canonicalBytes: undefined }, snapshotHash: snapshot.hash, requiredCapabilities: ["deploy.execute"], lease: { leaseId: "lease-1", deploymentId: snapshot.deploymentId, fence: 1, expiresAt: 10_000 }, context: { requestId: "req-1", correlationId: "corr-1" }, timeoutMs: 1000, cancellationRequested: false }; return body; }

describe("agent command receiver", () => {
    it("authenticates, executes once, and replays the settled receipt", async () => {
    const body = command(); const payload = JSON.stringify(body); const transport = new FakeDockerImageTransport(); const dispatcher = new DigestDeploymentDispatcher({ protocol: new InMemoryProtocolTransport({ clock: { now: () => 1 }, leasePolicy: { ttlMs: 100 }, retryPolicy: { maxAttempts: 1, deadlineMs: 0, backoffMs: () => 0 }, capabilities: ["deploy.execute"] }), transport, trustedHosts: ["registry.example.com"] }); const records = new Map<string, any>(); const pending = new Map<string, Promise<any>>(); const replayStore = { claim: async (id: string, fingerprint: string) => { const prior = records.get(id); if (prior) { if (prior.fingerprint !== fingerprint) throw new Error("payload conflict"); return { claimed: false, receipt: prior.receipt }; } if (pending.has(id)) return { claimed: false }; pending.set(id, new Promise((resolve) => (replayStore as any).resolve = resolve)); return { claimed: true }; }, wait: async (id: string) => new Promise((resolve) => { const done = pending.get(id)!; done.then(resolve); }), complete: async (id: string, value: any) => { records.set(id, value); (replayStore as any).resolve(value.receipt); pending.delete(id); }, release: async (id: string) => { pending.delete(id); } }; const receiver = new AuthenticatedAgentCommandReceiver({ agentId: "agent-1", trustKey: "transport_test_key_123", capabilities: ["deploy.execute"], dispatcher, replayStore: replayStore as unknown as import("./agent-transport.js").AgentReplayStore, now: () => 1 });
    const [first, second] = await Promise.all([receiver.receive(body, signAgentTransport(payload, "transport_test_key_123")), receiver.receive(body, signAgentTransport(payload, "transport_test_key_123"))]);
    expect(first.redacted).toBe(true); expect(second.receipt).toEqual(first.receipt); expect(transport.calls).toEqual(["start", "health", "promote"]);
  });

  it("rejects unauthorized, expired, and conflicting delivery before execution", async () => {
    const body = command(); const replayStore = { claim: async () => ({ claimed: true }), wait: async () => { throw new Error("must not wait"); }, complete: async () => {}, release: async () => {} }; const receiver = new AuthenticatedAgentCommandReceiver({ agentId: "agent-1", trustKey: "transport_test_key_123", capabilities: [], dispatcher: { dispatch: async () => { throw new Error("must not execute"); } }, replayStore: replayStore as unknown as import("./agent-transport.js").AgentReplayStore, now: () => 20_000 }); const signed = signAgentTransport(JSON.stringify(body), "transport_test_key_123");
    await expect(receiver.receive(body, signed)).rejects.toThrow("Unsupported protocol capability");
    const valid = { ...body, requiredCapabilities: [] }; const validSignature = signAgentTransport(JSON.stringify(valid), "transport_test_key_123"); await expect(receiver.receive(valid, validSignature)).rejects.toThrow("Unsupported protocol capability");
    const conflict = { ...body, snapshot: { ...body.snapshot, projectId: "other" } }; await expect(receiver.receive(conflict, signAgentTransport(JSON.stringify(conflict), "transport_test_key_123"))).rejects.toThrow();
  });

  it("validates the receipt before completing replay state", async () => {
    const body = command(); let completed = 0; const replayStore = { claim: async () => ({ claimed: true }), wait: async () => { throw new Error("unexpected wait"); }, complete: async () => { completed++; }, release: async () => {} };
    const receiver = new AuthenticatedAgentCommandReceiver({ agentId: "agent-1", trustKey: "transport_test_key_123", capabilities: ["deploy.execute"], dispatcher: { dispatch: async () => ({ deploymentId: "other", effectiveImage: `registry.example.com/app@sha256:${"a".repeat(64)}`, runtimePort: 3000, health: "passed", terminalStatus: "succeeded", rollback: { target: null, result: "not-required" }, proven: true } as never) }, replayStore: replayStore as never, now: () => 1 });
    await expect(receiver.receive(body, signAgentTransport(JSON.stringify(body), "transport_test_key_123"))).rejects.toThrow("deployment scope"); expect(completed).toBe(0);
  });
});
