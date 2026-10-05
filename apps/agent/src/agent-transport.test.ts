import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { signAgentTransport } from "@deploylite/config";
import { createDeploymentSnapshot, createSourceIntent, trustedPriorExecutionReceiptSchema, TransportCanceledError } from "@deploylite/contracts";
import { FakeDockerImageTransport } from "@deploylite/domain";
import { AuthenticatedAgentCommandReceiver } from "./agent-transport.js";
import { DigestDeploymentDispatcher } from "./deployment-dispatcher.js";
import { InMemoryProtocolTransport } from "@deploylite/domain";

const digest = `sha256:${"a".repeat(64)}`;
 function command() { const snapshot = createDeploymentSnapshot({ deploymentId: "dep_receiver", projectId: "project_receiver", source: createSourceIntent({ sourceMode: "image", requestedReference: `registry.example.com/team/app@${digest}` }, { policyVersion: "p1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true }), configRevision: "c1", runtimeRevision: "r1", runtimePort: 3000, secretRefs: [], policyVersion: "p1", schemaVersion: 1 }, { sha256: (bytes) => createHash("sha256").update(bytes).digest("hex") }); const body = { schemaVersion: 2 as const, agentId: "agent-1", commandId: "cmd-1", deploymentId: "dep_execution", sourceDeploymentId: snapshot.deploymentId, projectId: snapshot.projectId, snapshot: { ...snapshot, canonicalBytes: undefined }, snapshotHash: snapshot.hash, requiredCapabilities: ["deploy.execute"], lease: { leaseId: "lease-1", deploymentId: "dep_execution", fence: 1, expiresAt: 10_000 }, context: { requestId: "req-1", correlationId: "corr-1" }, timeoutMs: 1000, cancellationRequested: false }; return body; }
function stopCommand(overrides: Record<string, unknown> = {}) { return { schemaVersion: 1 as const, action: "deployment.stop" as const, agentId: "agent-1", commandId: "stop-1", projectId: "project-1", deploymentId: "dep-1", candidateId: "dep-1:candidate:cmd-1", effectiveImage: `registry.example.com/team/app@${digest}`, requiredCapabilities: ["deployment.stop" as const], lease: { leaseId: "stop-lease-1", deploymentId: "dep-1", fence: 1, expiresAt: 10_000 }, context: { requestId: "stop-req-1", correlationId: "stop-corr-1" }, timeoutMs: 1000, cancellationRequested: false, ...overrides }; }

describe("agent command receiver", () => {
    it("authenticates, executes once, and replays the settled receipt", async () => {
    const body = command(); const payload = JSON.stringify(body); const transport = new FakeDockerImageTransport(); const dispatcher = new DigestDeploymentDispatcher({ protocol: new InMemoryProtocolTransport({ clock: { now: () => 1 }, leasePolicy: { ttlMs: 100 }, retryPolicy: { maxAttempts: 1, deadlineMs: 0, backoffMs: () => 0 }, capabilities: ["deploy.execute"] }), transport, trustedHosts: ["registry.example.com"] }); const records = new Map<string, any>(); const pending = new Map<string, Promise<any>>(); const replayStore = { claim: async (id: string, fingerprint: string) => { const prior = records.get(id); if (prior) { if (prior.fingerprint !== fingerprint) throw new Error("payload conflict"); return { claimed: false, receipt: prior.receipt }; } if (pending.has(id)) return { claimed: false }; pending.set(id, new Promise((resolve) => (replayStore as any).resolve = resolve)); return { claimed: true, claimToken: "claim-1" }; }, wait: async (id: string) => new Promise((resolve) => { const done = pending.get(id)!; done.then(resolve); }), complete: async (id: string, value: any) => { records.set(id, value); (replayStore as any).resolve(value.receipt); pending.delete(id); }, release: async (id: string) => { pending.delete(id); } }; const receiver = new AuthenticatedAgentCommandReceiver({ agentId: "agent-1", trustKey: "transport_test_key_123", capabilities: ["deploy.execute"], dispatcher, replayStore: replayStore as unknown as import("./agent-transport.js").AgentReplayStore, now: () => 1 });
    const [first, second] = await Promise.all([receiver.receive(body, signAgentTransport(payload, "transport_test_key_123")), receiver.receive(body, signAgentTransport(payload, "transport_test_key_123"))]);
    expect(first.redacted).toBe(true); expect(second.receipt).toEqual(first.receipt); expect(transport.calls).toEqual(["start", "health", "promote"]);
  });

  it("rejects unauthorized, expired, and conflicting delivery before execution", async () => {
    const body = command(); const replayStore = { claim: async () => ({ claimed: true, claimToken: "claim-1" }), wait: async () => { throw new Error("must not wait"); }, complete: async () => {}, release: async () => {} }; const receiver = new AuthenticatedAgentCommandReceiver({ agentId: "agent-1", trustKey: "transport_test_key_123", capabilities: [], dispatcher: { dispatch: async () => { throw new Error("must not execute"); } }, replayStore: replayStore as unknown as import("./agent-transport.js").AgentReplayStore, now: () => 20_000 }); const signed = signAgentTransport(JSON.stringify(body), "transport_test_key_123");
    await expect(receiver.receive(body, signed)).rejects.toThrow("Unsupported protocol capability");
    const valid = { ...body, requiredCapabilities: [] }; const validSignature = signAgentTransport(JSON.stringify(valid), "transport_test_key_123"); await expect(receiver.receive(valid, validSignature)).rejects.toThrow("Unsupported protocol capability");
    const conflict = { ...body, snapshot: { ...body.snapshot, projectId: "other" } }; await expect(receiver.receive(conflict, signAgentTransport(JSON.stringify(conflict), "transport_test_key_123"))).rejects.toThrow();
  });

  it("validates the receipt before completing replay state", async () => {
    const body = command(); let completed = 0; const replayStore = { claim: async () => ({ claimed: true, claimToken: "claim-1" }), wait: async () => { throw new Error("unexpected wait"); }, complete: async () => { completed++; }, release: async () => {} };
    const receiver = new AuthenticatedAgentCommandReceiver({ agentId: "agent-1", trustKey: "transport_test_key_123", capabilities: ["deploy.execute"], dispatcher: { dispatch: async () => ({ deploymentId: "other", effectiveImage: `registry.example.com/app@sha256:${"a".repeat(64)}`, runtimePort: 3000, health: "passed", terminalStatus: "succeeded", rollback: { target: null, result: "not-required" }, proven: true } as never) }, replayStore: replayStore as never, now: () => 1 });
    await expect(receiver.receive(body, signAgentTransport(JSON.stringify(body), "transport_test_key_123"))).rejects.toThrow("deployment scope"); expect(completed).toBe(0);
  });

  it("validates stop authority before Docker and returns one replayed terminal receipt", async () => {
    const body = stopCommand(); const calls: string[] = []; const records = new Map<string, any>(); const replayStore = { claim: async (id: string, fingerprint: string) => { const prior = records.get(id); if (prior && prior.fingerprint !== fingerprint) throw new Error("payload conflict"); if (prior) return { claimed: false, receipt: prior.receipt }; return { claimed: true, claimToken: "stop-claim" }; }, wait: async () => { throw new Error("unexpected wait"); }, complete: async (id: string, value: any) => { records.set(id, value); }, release: async () => {} };
    const receiver = new AuthenticatedAgentCommandReceiver({ agentId: "agent-1", trustKey: "transport_test_key_123", capabilities: ["deployment.stop"], dispatcher: { dispatch: async () => { throw new Error("must not execute"); } }, stopDispatcher: { stop: async (input, signal) => { calls.push(`${input.projectId}:${input.deploymentId}`); expect(signal?.aborted).toBe(false); return "stopped"; } }, replayStore, now: () => 1 });
    const signed = signAgentTransport(JSON.stringify(body), "transport_test_key_123"); const first = await receiver.receive(body, signed); const second = await receiver.receive(body, signed); expect(first.status).toBe("stopped"); expect(second).toEqual(first); expect(calls).toEqual(["project-1:dep-1"]);
  });

  it("fails closed for an already-aborted stop without claiming replay or invoking the dispatcher", async () => {
    const body = stopCommand(); let claims = 0; let stops = 0; let completions = 0; let additions = 0; let removals = 0; const signal = { aborted: true, addEventListener: () => { additions++; }, removeEventListener: () => { removals++; } } as unknown as AbortSignal;
    const receiver = new AuthenticatedAgentCommandReceiver({ agentId: "agent-1", trustKey: "transport_test_key_123", capabilities: ["deployment.stop"], dispatcher: { dispatch: async () => { throw new Error("must not execute"); } }, stopDispatcher: { stop: async () => { stops++; return "canceled" as const; } }, replayStore: { claim: async () => { claims++; throw new Error("must not claim"); }, wait: async () => { throw new Error("must not wait"); }, complete: async () => { completions++; }, release: async () => {} }, now: () => 1 });
    await expect(receiver.receive(body, signAgentTransport(JSON.stringify(body), "transport_test_key_123"), signal)).rejects.toBeInstanceOf(TransportCanceledError); expect({ claims, stops, completions, additions, removals }).toEqual({ claims: 0, stops: 0, completions: 0, additions: 0, removals: 0 });
  });

  it.each([
    ["wrong agent", { agentId: "agent-2" }], ["wrong scope", { projectId: "project-2" }], ["wrong capability", { requiredCapabilities: ["deploy.execute"] }], ["expired lease", { lease: { leaseId: "stop-lease-1", deploymentId: "dep-1", fence: 1, expiresAt: 0 } }]
  ])("rejects stop %s before dispatch", async (_name, overrides) => {
    const body = stopCommand(overrides); const stop = { stop: async () => { throw new Error("must not stop"); } }; const receiver = new AuthenticatedAgentCommandReceiver({ agentId: "agent-1", trustKey: "transport_test_key_123", capabilities: ["deployment.stop"], dispatcher: { dispatch: async () => { throw new Error("must not execute"); } }, stopDispatcher: stop, replayStore: { claim: async () => ({ claimed: true, claimToken: "x" }), wait: async () => { throw new Error("must not wait"); }, complete: async () => {}, release: async () => {} }, now: () => 1 }); const signed = signAgentTransport(JSON.stringify(body), "transport_test_key_123"); await expect(receiver.receive(body, signed)).rejects.toThrow();
  });
});

function proofReceipt(body: ReturnType<typeof command>, patch: Record<string, unknown> = {}) {
  const proof = trustedPriorExecutionReceiptSchema.parse({ schemaVersion: 1, candidateId: `${body.deploymentId}:candidate:${body.commandId}`, deploymentId: body.deploymentId, projectId: body.projectId, snapshotOriginId: body.snapshot.deploymentId, snapshotHash: body.snapshotHash, effectiveImageDigest: digest, runtimeHost: "agent-1", container: "active-observed", containerId: "physical-container", hostPort: 43000, containerPort: 3000, network: null, ...patch });
  return { deploymentId: proof.deploymentId, candidateId: proof.candidateId, effectiveImage: `registry.example.com/team/app@${proof.effectiveImageDigest}`, runtimePort: proof.containerPort, runtimeConfig: { hostPort: proof.hostPort, containerPort: proof.containerPort, ...(proof.network ? { networkName: proof.network } : {}) }, health: "passed" as const, terminalStatus: "succeeded" as const, rollback: { target: null, result: "not-required" as const }, proven: true, executionReceipt: proof };
}
function receiverStore() {
  const records = new Map<string, any>();
  return { claims: 0, completions: 0, claim: async function(id: string, fingerprint: string) { this.claims++; const prior = records.get(id); if (prior) { if (prior.fingerprint !== fingerprint) throw new Error("payload conflict"); return { claimed: false, receipt: prior.receipt }; } return { claimed: true, claimToken: "proof-claim" }; }, wait: async () => { throw new Error("unexpected wait"); }, complete: async function(id: string, value: any) { this.completions++; records.set(id, structuredClone(value)); }, release: async () => {} };
}

describe("configured observed proof receiver", () => {
  it("threads configured identity to the actual executor and retains equal replay proof", async () => {
    const body = command(); const calls: string[] = [];
    const dispatcher = new DigestDeploymentDispatcher({ protocol: new InMemoryProtocolTransport({ clock: { now: () => 1 }, leasePolicy: { ttlMs: 1000 }, retryPolicy: { maxAttempts: 1, deadlineMs: 0, backoffMs: () => 0 }, capabilities: ["deploy.execute"] }), hostPort: 43000, containerPort: 3000, trustedHosts: ["registry.example.com"], transport: { startCandidate: async () => { calls.push("start"); }, checkHealth: async () => true, promoteCandidate: async (candidate) => { calls.push("promote"); return { container: "actual-active", containerId: "physical-receiver-container", imageId: "sha256:actual-config-id", owner: "configured-owner", projectId: body.projectId, deploymentId: body.deploymentId, candidateId: candidate.candidateId, effectiveImage: candidate.effectiveImage, running: true, health: "healthy", hostPort: 43000, containerPort: 3000, network: null }; }, discardCandidate: async () => {}, restorePrior: async () => {} } });
    const store = receiverStore();
    const receiver = new AuthenticatedAgentCommandReceiver({ agentId: "agent-1", trustKey: "transport_test_key_123", capabilities: ["deploy.execute"], dispatcher, replayStore: store, now: () => 1 });
    const signature = signAgentTransport(JSON.stringify(body), "transport_test_key_123");
    const first = await receiver.receive(body, signature);
    expect(first.receipt).toMatchObject({ executionReceipt: { runtimeHost: "agent-1", snapshotOriginId: "dep_receiver", container: "actual-active", containerId: "physical-receiver-container" } });
    expect(await receiver.receive(body, signature)).toEqual(first);
    expect(calls).toEqual(["start", "promote"]); expect(store.completions).toBe(1);
  });

  it.each(["projectId", "deploymentId", "runtimePort", "agentId", "configRevision", "runtimeRevision", "source"])("rejects signed changed canonical %s before replay or effects", async (field) => {
    const body = command(); const changed: any = structuredClone(body);
    changed.snapshot[field] = field === "runtimePort" ? 3001 : field === "source" ? { ...body.snapshot.source, image: { ...(body.snapshot.source as any).image, repository: "team/other", reference: `registry.example.com/team/other@${digest}` } } : "other";
    if (field === "projectId") changed.projectId = "other";
    if (field === "deploymentId") changed.sourceDeploymentId = "other";
    let dispatched = 0; const store = receiverStore();
    const receiver = new AuthenticatedAgentCommandReceiver({ agentId: "agent-1", trustKey: "transport_test_key_123", capabilities: ["deploy.execute"], dispatcher: { dispatch: async () => { dispatched++; return proofReceipt(body); } }, replayStore: store, now: () => 1 });
    await expect(receiver.receive(changed, signAgentTransport(JSON.stringify(changed), "transport_test_key_123"))).rejects.toThrow();
    expect({ dispatched, claims: store.claims, completions: store.completions }).toEqual({ dispatched: 0, claims: 0, completions: 0 });
  });

  it.each([
    ["project", { projectId: "other" }], ["configured host", { runtimeHost: "request-override" }], ["canonical origin", { snapshotOriginId: "other" }],
    ["canonical hash", { snapshotHash: "b".repeat(64) }], ["digest", { effectiveImageDigest: `sha256:${"b".repeat(64)}` }],
    ["candidate", { candidateId: "other-candidate" }], ["host port", { hostPort: 44000 }], ["container port", { containerPort: 8080 }], ["network", { network: "other" }]
  ])("rejects provided proof with wrong signed/configured %s before replay publication", async (_field, patch) => {
    const body = command(); const store = receiverStore();
    const receiver = new AuthenticatedAgentCommandReceiver({ agentId: "agent-1", trustKey: "transport_test_key_123", capabilities: ["deploy.execute"], dispatcher: { runtimeConfig: { hostPort: 43000, containerPort: 3000 }, dispatch: async () => proofReceipt(body, patch) } as any, replayStore: store, now: () => 1 });
    await expect(receiver.receive(body, signAgentTransport(JSON.stringify(body), "transport_test_key_123"))).rejects.toThrow();
    expect(store.completions).toBe(0);
  });

  it("rejects a validly hashed snapshot for another configured host before dispatch", async () => {
    const body = command(); const source = body.snapshot as any;
    const snapshot = createDeploymentSnapshot({ ...source, agentId: "other-agent", schemaVersion: source.sourceSchemaVersion }, { sha256: (bytes) => createHash("sha256").update(bytes).digest("hex") });
    const changed = { ...body, snapshot: { ...snapshot, canonicalBytes: undefined }, snapshotHash: snapshot.hash };
    let effects = 0; const store = receiverStore();
    const receiver = new AuthenticatedAgentCommandReceiver({ agentId: "agent-1", trustKey: "transport_test_key_123", capabilities: ["deploy.execute"], dispatcher: { dispatch: async () => { effects++; return proofReceipt(body); } }, replayStore: store, now: () => 1 });
    await expect(receiver.receive(changed, signAgentTransport(JSON.stringify(changed), "transport_test_key_123"))).rejects.toThrow();
    expect(effects).toBe(0); expect(store.claims).toBe(0);
  });
});

it("preserves direct legacy stub-hashed dispatch without creating eligible proof", async () => {
  const value = command().snapshot;
  const snapshot = { ...value, hash: "b".repeat(64), canonicalBytes: new TextEncoder().encode(value.canonicalJson) };
  const transport = new FakeDockerImageTransport();
  const dispatcher = new DigestDeploymentDispatcher({ protocol: new InMemoryProtocolTransport({ clock: { now: () => 1 }, leasePolicy: { ttlMs: 1000 }, retryPolicy: { maxAttempts: 1, deadlineMs: 0, backoffMs: () => 0 }, capabilities: ["deploy.execute"] }), transport, trustedHosts: ["registry.example.com"] });
  let result: any; let failure: unknown;
  try { result = await dispatcher.dispatch(snapshot as any, "legacy"); } catch (error) { failure = error; }
  expect(failure).toBeUndefined(); expect(result).toMatchObject({ terminalStatus: "succeeded", health: "passed" });
  expect(result).not.toHaveProperty("executionReceipt"); expect(transport.calls).toEqual(["start", "health", "promote"]);
});


describe("repeated execution source versus canonical origin", () => {
  it("accepts signed C from immediate B with canonical A proof and rejects changed-source replay", async () => {
    const body = { ...command(), commandId: "cmd-C", deploymentId: "execution-C", sourceDeploymentId: "execution-B", lease: { ...command().lease, deploymentId: "execution-C" } };
    const store = receiverStore(); let effects = 0;
    const receiver = new AuthenticatedAgentCommandReceiver({ agentId: "agent-1", trustKey: "transport_test_key_123", capabilities: ["deploy.execute"], now: () => 1, replayStore: store, dispatcher: { runtimeConfig: { hostPort: 43000, containerPort: 3000 }, dispatch: async () => { effects++; return proofReceipt(body); } } });
    const signed = signAgentTransport(JSON.stringify(body), "transport_test_key_123"); let first: any; let failure: unknown;
    try { first = await receiver.receive(body, signed); } catch (error) { failure = error; }
    expect(failure).toBeUndefined(); expect(first).toMatchObject({ sourceDeploymentId: "execution-B", receipt: { executionReceipt: { deploymentId: "execution-C", snapshotOriginId: "dep_receiver" } } });
    expect(await receiver.receive(body, signed)).toEqual(first); expect(effects).toBe(1);
    const changed = { ...body, sourceDeploymentId: "execution-other" };
    await expect(receiver.receive(changed, signAgentTransport(JSON.stringify(changed), "transport_test_key_123"))).rejects.toThrow("payload conflict"); expect(effects).toBe(1);
  });
  it("rejects a proof that substitutes immediate source for canonical origin", async () => {
    const body = { ...command(), sourceDeploymentId: "execution-B" }; const store = receiverStore();
    const receiver = new AuthenticatedAgentCommandReceiver({ agentId: "agent-1", trustKey: "transport_test_key_123", capabilities: ["deploy.execute"], now: () => 1, replayStore: store, dispatcher: { runtimeConfig: { hostPort: 43000, containerPort: 3000 }, dispatch: async () => proofReceipt(body, { snapshotOriginId: "execution-B" }) } });
    await expect(receiver.receive(body, signAgentTransport(JSON.stringify(body), "transport_test_key_123"))).rejects.toThrow(); expect(store.completions).toBe(0);
  });
});
