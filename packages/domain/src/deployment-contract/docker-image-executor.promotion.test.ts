import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeploymentSnapshot, createSourceIntent } from "@deploylite/contracts";
import { DockerImageExecutor, type DockerImageTransport, type PriorDockerImageExecutionReceiptV1 } from "./docker-image-executor.js";
import { InMemoryProtocolTransport } from "./protocol-memory.js";
const image = `registry.example.com/team/app@sha256:${"a".repeat(64)}`;
const policy = { maxOutageMs: 30_000, maxRecoveryMs: 60_000 };
function fixture() {
  const snapshot = createDeploymentSnapshot({ schemaVersion: 1, deploymentId: "A", projectId: "project", agentId: "agent", source: createSourceIntent({ sourceMode: "image", requestedReference: image }, { policyVersion: "p1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true }), configRevision: "c1", runtimeRevision: "r1", runtimePort: 3000, secretRefs: [], policyVersion: "p1" }, { sha256: (bytes) => createHash("sha256").update(bytes).digest("hex") });
  const prior: PriorDockerImageExecutionReceiptV1 = { deploymentId: "A", projectId: "project", candidateId: "A:candidate:old", effectiveImage: image, runtimePort: 3000, runtimeConfig: { hostPort: 43000, containerPort: 3000 }, health: "passed", terminalStatus: "succeeded", proven: true, rollback: { target: null, result: "not-required" }, executionReceipt: { schemaVersion: 1, deploymentId: "A", projectId: "project", candidateId: "A:candidate:old", snapshotOriginId: "A", snapshotHash: snapshot.hash, effectiveImageDigest: image.split("@")[1]!, runtimeHost: "agent", container: "deploylite-active-A", containerId: "1".repeat(64), hostPort: 43000, containerPort: 3000, network: null } };
  const calls: Array<{ operation: string; signal: AbortSignal; context?: unknown }> = [];
  let lost = false, failPromotion = false; const parent = new AbortController();
  const authority = { assertValid: async () => { if (lost) throw new Error("authority lost"); } };
  const transport: DockerImageTransport = {
    startCandidate: async (_candidate, signal, context?: unknown) => { calls.push({ operation: "start", signal, context }); }, checkHealth: async () => true,
    promoteCandidate: async (_candidate: unknown, priorOrSignal: unknown, signal?: AbortSignal, context?: unknown) => {
      calls.push({ operation: "promote", signal: signal ?? priorOrSignal as AbortSignal, context });
      if (failPromotion) { parent.abort(); throw new Error("partial promotion fault"); }
    },
    restorePrior: async (_prior, signal, context?: unknown) => { calls.push({ operation: "restore", signal, context }); }, discardCandidate: async (_candidate, signal, context?: unknown) => { calls.push({ operation: "discard", signal, context }); }
  };
  const protocol = new InMemoryProtocolTransport({ clock: { now: () => 1 }, leasePolicy: { ttlMs: 200_000 }, retryPolicy: { maxAttempts: 1, deadlineMs: 0, backoffMs: () => 0 }, capabilities: ["deploy.execute"] });
  const executor = new DockerImageExecutor({ protocol, transport, trustedHosts: ["registry.example.com"], runtimeHost: "agent", snapshotHasher: { sha256: (bytes) => createHash("sha256").update(bytes).digest("hex") } });
  const input = { snapshot, commandId: "new", executionDeploymentId: "B", lease: protocol.claimLease("B"), runtimeConfig: prior.runtimeConfig, priorProvenReceipt: prior, signal: parent.signal, promotionPolicy: policy, authority };
  return { input, calls, parent, run: (value = input) => executor.execute(value), lose: () => { lost = true; }, fail: () => { failPromotion = true; } };
}
afterEach(() => vi.useRealTimers());
describe("executor replacement authority and independent recovery", () => {
  it("starts the recovery bound before a hanging fresh authority read and never performs late recovery", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0); const f = fixture(); f.fail(); let reads = 0;
    f.input.authority.assertValid = async () => { if (++reads >= 3) await new Promise(() => {}); };
    let outcome: string | undefined; f.run().then(() => { outcome = "terminal"; }, () => { outcome = "unresolved"; });
    await vi.advanceTimersByTimeAsync(60_000); expect(outcome).toBe("unresolved");
    expect(f.calls.some((call) => ["restore", "discard"].includes(call.operation))).toBe(false);
  });
  it("passes immutable prior, explicit limits and a fresh guard through the transport boundary", async () => {
    const f = fixture(); await f.run();
    expect(f.calls.find((call) => call.operation === "start")?.context).toMatchObject({ prior: f.input.priorProvenReceipt, policy, authority: { assertValid: expect.any(Function) } });
    expect(f.calls.find((call) => call.operation === "promote")?.context).toMatchObject({ prior: f.input.priorProvenReceipt, policy });
  });
  it.each(["authority", "promotionPolicy", "proof"])("fails closed without explicit %s before any effect", async (missing) => {
    const f = fixture(); const input = { ...f.input, priorProvenReceipt: structuredClone(f.input.priorProvenReceipt) };
    if (missing === "authority") input.authority = undefined as never;
    if (missing === "promotionPolicy") input.promotionPolicy = undefined as never;
    if (missing === "proof") delete (input.priorProvenReceipt as { executionReceipt?: unknown }).executionReceipt;
    await expect(f.run(input)).rejects.toThrow(); expect(f.calls).toEqual([]);
  });
  it("recovers independently of caller cancellation and reports failed health truthfully", async () => {
    const f = fixture(); f.fail(); const result = await f.run();
    expect(result).toMatchObject({ terminalStatus: "canceled", health: "failed", rollback: { result: "restored" } });
    expect(f.calls.find((call) => call.operation === "restore")?.signal.aborted).toBe(false);
    expect(f.calls.find((call) => call.operation === "discard")?.signal.aborted).toBe(false);
  });
  it("rejects lost authority before starting or recovering", async () => {
    const f = fixture(); f.lose(); await expect(f.run()).rejects.toThrow("authority lost"); expect(f.calls).toEqual([]);
  });
});
