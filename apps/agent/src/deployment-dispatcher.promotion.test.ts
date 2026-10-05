import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeploymentSnapshot, createSourceIntent } from "@deploylite/contracts";
import { InMemoryProtocolTransport, type DockerPromotionContext, type DockerImageTransport, type PriorDockerImageExecutionReceiptV1 } from "@deploylite/domain";
import { DigestDeploymentDispatcher } from "./deployment-dispatcher.js";
const image = `registry.example.com/team/app@sha256:${"a".repeat(64)}`, policy = { maxOutageMs: 30_000, maxRecoveryMs: 60_000 };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function fixture(failure = false) {
  const snapshot = createDeploymentSnapshot({ deploymentId: "a", projectId: "project", agentId: "agent", schemaVersion: 1, source: createSourceIntent({ sourceMode: "image", requestedReference: image }, { policyVersion: "p1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true }), configRevision: "c1", runtimeRevision: "r1", runtimePort: 3000, secretRefs: [], policyVersion: "p1" }, { sha256: (bytes) => createHash("sha256").update(bytes).digest("hex") });
  const prior: PriorDockerImageExecutionReceiptV1 = { deploymentId: "a", projectId: "project", candidateId: "a:candidate:old", effectiveImage: image, runtimePort: 3000, runtimeConfig: { hostPort: 43000, containerPort: 3000 }, health: "passed", terminalStatus: "succeeded", proven: true, rollback: { target: null, result: "not-required" }, executionReceipt: { schemaVersion: 1, projectId: "project", deploymentId: "a", candidateId: "a:candidate:old", snapshotOriginId: "a", snapshotHash: snapshot.hash, effectiveImageDigest: image.split("@")[1]!, runtimeHost: "agent", container: "deploylite-active-a", containerId: "1".repeat(64), hostPort: 43000, containerPort: 3000, network: null } };
  const calls: string[] = []; const authority = { expiresAt: 200_000, assertValid: async () => { if (Date.now() >= 200_000) throw new Error("lease expired"); } };
  const transport: DockerImageTransport = { startCandidate: async () => { calls.push("prepare"); }, checkHealth: async () => { await sleep(20_000); return true; },
    promoteCandidate: async (candidate, _priorOrSignal, signal?: AbortSignal, context?: DockerPromotionContext) => {
      context?.completePreparation?.(); signal = context?.promotionSignal ?? signal;
      calls.push("cutover"); await sleep(25_000); if (signal?.aborted) throw new Error("execution timer leaked into cutover"); if (failure) throw new Error("partial failure");
      return { container: "deploylite-active-b", containerId: "2".repeat(64), imageId: `sha256:${"c".repeat(64)}`, owner: "owner", projectId: "project", deploymentId: "b", candidateId: candidate.candidateId, effectiveImage: image, running: true, health: "healthy", hostPort: 43000, containerPort: 3000, network: null };
    }, restorePrior: async (_receipt, signal) => { calls.push("recover"); await sleep(55_000); if (signal.aborted) throw new Error("recovery window expired"); }, discardCandidate: async () => { calls.push("discard"); } };
  const dispatcher = new DigestDeploymentDispatcher({ protocol: new InMemoryProtocolTransport({ clock: { now: Date.now }, leasePolicy: { ttlMs: 200_000 }, retryPolicy: { maxAttempts: 1, deadlineMs: 0, backoffMs: () => 0 }, capabilities: ["deploy.execute"] }), transport, hostPort: 43000, containerPort: 3000, trustedHosts: ["registry.example.com"], timeoutMs: 30_000, promotionPolicy: policy });
  return { calls, authority, transport, run: () => dispatcher.dispatch(snapshot, "new", undefined, { deploymentId: "b", leaseId: "control:execution:2", fence: 2, expiresAt: 200_000 }, { runtimeHost: "agent", executionDeploymentId: "b", priorProvenReceipt: prior, authority, promotionPolicy: policy }) };
}
afterEach(() => vi.useRealTimers());
describe("separate preparation, cutover and recovery budgets", () => {
  it("allows 20s preparation plus 25s cutover without confusing the preparation timer with the 30s outage bound", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0); const f = fixture(); let outcome: string | undefined;
    const pending = f.run().then((value) => { outcome = value.terminalStatus; }, () => { outcome = "error"; });
    try { await vi.advanceTimersByTimeAsync(45_000); expect(outcome).toBe("succeeded"); expect(f.calls).toEqual(["prepare", "cutover"]); }
    finally { await vi.runAllTimersAsync(); await pending; }
  });
  it("allows the independent 60s recovery budget after preparation and a partial cutover fault", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0); const f = fixture(true); let outcome: unknown;
    const pending = f.run().then((value) => { outcome = value; }, () => { outcome = "error"; });
    try { await vi.advanceTimersByTimeAsync(100_000); expect(outcome).toMatchObject({ terminalStatus: "failed", health: "failed", rollback: { result: "restored" } }); expect(f.calls).toEqual(["prepare", "cutover", "recover", "discard"]); }
    finally { await vi.runAllTimersAsync(); await pending; }
  });
});


describe("preparation fresh reads settle without consuming cutover or recovery", () => {
  it.each(["first-authority", "pre-cutover-authority", "health"])("bounds an uncooperative %s read and blocks its late continuation", async (stage) => {
    vi.useFakeTimers(); vi.setSystemTime(0); const f = fixture(); let resume!: () => void; const barrier = new Promise<void>((resolve) => { resume = resolve; }); let reads = 0;
    const validate = f.authority.assertValid;
    f.authority.assertValid = async () => { reads++; if ((stage === "first-authority" && reads === 1) || (stage === "pre-cutover-authority" && reads === 2)) await barrier; await validate(); };
    if (stage === "health") f.transport.checkHealth = async () => { await barrier; return true; };
    let outcome = "pending"; const pending = f.run().then(() => { outcome = "settled"; }, () => { outcome = "settled"; });
    await vi.advanceTimersByTimeAsync(90_000);
    try { expect(outcome).toBe("settled"); expect(f.calls).not.toContain("cutover"); }
    finally { resume(); await vi.runAllTimersAsync(); await pending; }
    expect(f.calls).not.toContain("cutover");
  });
});
