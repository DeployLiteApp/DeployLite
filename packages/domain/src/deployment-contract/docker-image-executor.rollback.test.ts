import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDeploymentSnapshot, createSourceIntent, type DeploymentSnapshotV1 } from "@deploylite/contracts";
import { DockerImageExecutor, type DockerImageTransport, type PriorDockerImageExecutionReceiptV1 } from "./docker-image-executor.js";
import { InMemoryProtocolTransport } from "./protocol-memory.js";

const imageA = `registry.example.com/team/app@sha256:${"a".repeat(64)}`;
const imageH = `registry.example.com/team/app@sha256:${"b".repeat(64)}`;
const hasher = { sha256: (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex") };
const policy = { maxOutageMs: 30_000, maxRecoveryMs: 60_000 };
function snapshot(origin: string, image: string, overrides: Partial<DeploymentSnapshotV1> = {}) {
  return createDeploymentSnapshot({ schemaVersion: 1, deploymentId: origin, projectId: "project", agentId: "agent", source: createSourceIntent({ sourceMode: "image", requestedReference: image }, { policyVersion: "p1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true }), configRevision: overrides.configRevision ?? "default", runtimeRevision: overrides.runtimeRevision ?? "default", runtimePort: overrides.runtimePort ?? 3000, secretRefs: overrides.secretRefs ?? [], policyVersion: "p1" }, hasher);
}
function fixture() {
  const original = snapshot("origin-A", imageA), historical = snapshot("origin-H", imageH);
  const prior: PriorDockerImageExecutionReceiptV1 = { deploymentId: "A", projectId: "project", candidateId: "A:candidate:old", effectiveImage: imageA, runtimePort: 3000, runtimeConfig: { hostPort: 43000, containerPort: 3000 }, health: "passed", terminalStatus: "succeeded", proven: true, rollback: { target: null, result: "not-required" }, executionReceipt: { schemaVersion: 1, deploymentId: "A", projectId: "project", candidateId: "A:candidate:old", snapshotOriginId: original.deploymentId, snapshotHash: original.hash, effectiveImageDigest: imageA.split("@")[1]!, runtimeHost: "agent", container: "active-A", containerId: "1".repeat(64), hostPort: 43000, containerPort: 3000, network: null } };
  const calls: Array<{ operation: string; image: string; deploymentId: string }> = [];
  let healthy = true, promotionFailure = false;
  const transport: DockerImageTransport = {
    startCandidate: async (candidate) => { calls.push({ operation: "start", image: candidate.effectiveImage, deploymentId: candidate.deploymentId }); },
    checkHealth: async () => healthy,
    promoteCandidate: async (candidate) => { calls.push({ operation: "promote", image: candidate.effectiveImage, deploymentId: candidate.deploymentId }); if (promotionFailure) throw new Error("partial cutover failure"); return { container: "observed-active-R", containerId: "3".repeat(64), imageId: "sha256:independent-config-id", owner: "owner", projectId: "project", deploymentId: candidate.deploymentId, candidateId: candidate.candidateId, effectiveImage: candidate.effectiveImage, running: true, health: "healthy", hostPort: 43000, containerPort: 3000, network: null }; },
    restorePrior: async (value) => { calls.push({ operation: "restore", image: value.effectiveImage, deploymentId: value.deploymentId }); },
    discardCandidate: async (candidate) => { calls.push({ operation: "discard", image: candidate.effectiveImage, deploymentId: candidate.deploymentId }); }
  };
  const protocol = new InMemoryProtocolTransport({ clock: { now: () => 1 }, leasePolicy: { ttlMs: 200_000 }, retryPolicy: { maxAttempts: 1, deadlineMs: 0, backoffMs: () => 0 }, capabilities: ["deploy.execute"] });
  const executor = new DockerImageExecutor({ protocol, transport, trustedHosts: ["registry.example.com"], runtimeHost: "agent", snapshotHasher: hasher });
  const input = { snapshot: historical, commandId: "deploy_R", executionDeploymentId: "R", activeDeploymentId: "A", sourceDeploymentId: "H", lease: protocol.claimLease("R"), runtimeConfig: { hostPort: 43000, containerPort: 3000 }, priorProvenReceipt: prior, promotionPolicy: policy, authority: { expiresAt: Date.now() + 200_000, assertValid: async () => {} } };
  return { input, calls, run: (value = input) => executor.execute(value), unhealthy: () => { healthy = false; }, failPromotion: () => { promotionFailure = true; } };
}

describe("rollback executor independent A/H/R roles", () => {
  it("runs historical H with fresh physical R proof while A has another canonical origin and image", async () => {
    const f = fixture();
    const outcome = await f.run().then((receipt) => ({ receipt, error: null }), (error: Error) => ({ receipt: null, error: error.message }));
    expect(outcome).toMatchObject({ error: null, receipt: { deploymentId: "R", effectiveImage: imageH, terminalStatus: "succeeded", executionReceipt: { deploymentId: "R", containerId: "3".repeat(64), snapshotOriginId: "origin-H", snapshotHash: f.input.snapshot.hash, effectiveImageDigest: imageH.split("@")[1] } } });
    expect(f.calls.map((call) => [call.operation, call.image])).toEqual([["start", imageH], ["promote", imageH]]);
  });
  it("keeps A intact when the historical candidate is unhealthy", async () => {
    const f = fixture(); f.unhealthy();
    const result = await f.run().then((receipt) => receipt, () => null);
    expect(result).toMatchObject({ terminalStatus: "failed", proven: false });
    expect(f.calls.some((call) => call.operation === "promote")).toBe(false);
    // Recovery may inspect retained A idempotently; it must never use historical H as its target.
    expect(f.calls.filter((call) => call.operation === "restore")).toEqual([{ operation: "restore", image: imageA, deploymentId: "A" }]);
    expect(f.calls.filter((call) => call.operation !== "restore").every((call) => call.deploymentId === "R" && call.image === imageH)).toBe(true);
  });
  it("recovers active A rather than historical H after partial cutover", async () => {
    const f = fixture(); f.failPromotion();
    const result = await f.run().then((receipt) => receipt, () => null);
    expect(result).toMatchObject({ terminalStatus: "failed", rollback: { target: imageA, result: "restored" } });
    expect(f.calls.find((call) => call.operation === "restore")).toEqual({ operation: "restore", image: imageA, deploymentId: "A" });
  });
});


describe("rollback executor supported runtime and captured roles", () => {
  it.each(["active-other", "active-R", "missing-H", "historical-R", "config", "runtime", "secrets"])("rejects unsupported or mismatched %s before candidate effects", async (variant) => {
    const f = fixture(); const value = { ...f.input };
    if (variant === "active-other") value.activeDeploymentId = "other-A";
    if (variant === "active-R") value.activeDeploymentId = "R";
    if (variant === "missing-H") value.sourceDeploymentId = "";
    if (variant === "historical-R") value.sourceDeploymentId = "R";
    if (variant === "config") value.snapshot = snapshot("origin-H", imageH, { configRevision: "historical-config" });
    if (variant === "runtime") value.snapshot = snapshot("origin-H", imageH, { runtimeRevision: "historical-runtime" });
    if (variant === "secrets") value.snapshot = snapshot("origin-H", imageH, { secretRefs: [{ secretRefId: "unavailable-historical-secret", version: 1 }] });
    const result = await f.run(value).then(() => "resolved", () => "rejected");
    expect(result).toBe("rejected"); expect(f.calls).toEqual([]);
  });
  it("rejects changed historical execution identity on equal command replay", async () => {
    const f = fixture(); await f.run();
    await expect(f.run({ ...f.input, sourceDeploymentId: "other-H" })).rejects.toThrow();
    expect(f.calls.map((call) => call.operation)).toEqual(["start", "promote"]);
  });
});
