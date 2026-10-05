import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDeploymentSnapshot, createSourceIntent, type DeploymentSnapshotV1 } from "@deploylite/contracts";
import { DockerImageExecutor, type DockerActiveIdentityObservation, type DockerImageCandidateV1, type DockerImageTransport } from "./docker-image-executor.js";
import { FakeDockerImageTransport } from "./testing/fake-docker-image-transport.js";
import { InMemoryProtocolTransport } from "./protocol-memory.js";

const digest = `sha256:${"a".repeat(64)}`;
const hasher = { sha256: (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex") };
function snapshot() {
  return createDeploymentSnapshot({ deploymentId: "origin", projectId: "project", agentId: "configured-agent", source: createSourceIntent({ sourceMode: "image", requestedReference: `registry.example.com/team/app@${digest}` }, { policyVersion: "p1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true }), configRevision: "c1", runtimeRevision: "r1", runtimePort: 3000, secretRefs: [], policyVersion: "p1", schemaVersion: 1 }, hasher);
}
function setup(patch: Partial<DockerActiveIdentityObservation> = {}, onStart?: () => void) {
  const calls: string[] = [];
  const protocol = new InMemoryProtocolTransport({ clock: { now: () => 1 }, leasePolicy: { ttlMs: 1000 }, retryPolicy: { maxAttempts: 1, deadlineMs: 0, backoffMs: () => 0 }, capabilities: ["deploy.execute"] });
  const transport: DockerImageTransport = {
    startCandidate: async () => { calls.push("start"); onStart?.(); }, checkHealth: async () => { calls.push("health"); return true; },
    promoteCandidate: async (candidate: DockerImageCandidateV1) => { calls.push("promote"); return { container: "active-observed", containerId: "physical-container", imageId: "sha256:config-object-id", owner: "configured-owner", projectId: "project", deploymentId: "execution", candidateId: candidate.candidateId, effectiveImage: candidate.effectiveImage, running: true, health: "healthy", hostPort: 43000, containerPort: 3000, network: null, ...patch }; },
    discardCandidate: async () => { calls.push("discard"); }, restorePrior: async () => { calls.push("restore"); }
  };
  const executor = new DockerImageExecutor({ protocol, transport, trustedHosts: ["registry.example.com"], runtimeHost: "configured-agent", snapshotHasher: hasher });
  const input = { snapshot: snapshot(), executionDeploymentId: "execution", commandId: "cmd", lease: protocol.claimLease("execution"), runtimeConfig: { hostPort: 43000, containerPort: 3000 } };
  return { executor, input, protocol, transport, calls };
}

describe("observed INITIAL proof producer", () => {
  it("retains physical observed identity and canonical origin separately from execution", async () => {
    const { executor, input, calls } = setup();
    const result = await executor.execute(input);
    expect(result).toMatchObject({ terminalStatus: "succeeded", executionReceipt: { schemaVersion: 1, candidateId: "execution:candidate:cmd", deploymentId: "execution", projectId: "project", snapshotOriginId: "origin", snapshotHash: input.snapshot.hash, effectiveImageDigest: digest, runtimeHost: "configured-agent", container: "active-observed", containerId: "physical-container", hostPort: 43000, containerPort: 3000, network: null } });
    expect(calls).toEqual(["start", "health", "promote"]);
  });

  it("keeps healthy legacy void promotion readable without eligible proof", async () => {
    const { input, protocol } = setup();
    const transport = new FakeDockerImageTransport();
    const executor = new DockerImageExecutor({ protocol, transport, trustedHosts: ["registry.example.com"], runtimeHost: "configured-agent", snapshotHasher: hasher });
    const result = await executor.execute(input);
    expect(result).toMatchObject({ terminalStatus: "succeeded", health: "passed", proven: true });
    expect(result).not.toHaveProperty("executionReceipt");
  });

  it.each([
    ["project", { projectId: "other" }], ["execution", { deploymentId: "other" }], ["candidate", { candidateId: "other" }],
    ["image", { effectiveImage: `registry.example.com/team/app@sha256:${"b".repeat(64)}` }],
    ["running", { running: false }], ["health", { health: "unhealthy" }], ["host port", { hostPort: 44000 }],
    ["container port", { containerPort: 8080 }], ["network", { network: "unexpected" }], ["container ID", { containerId: "" }]
  ])("does not trust a mismatched observed %s", async (_field, patch) => {
    const { executor, input } = setup(patch as Partial<DockerActiveIdentityObservation>);
    const result = await executor.execute(input);
    expect(result.terminalStatus).toBe("failed");
    expect(result).not.toHaveProperty("executionReceipt");
  });

  it.each([
    ["project", { projectId: "other" }], ["origin", { deploymentId: "other" }], ["agent", { agentId: "other" }],
    ["source", { source: { ...snapshot().source, image: { ...(snapshot().source as any).image, repository: "team/other", reference: `registry.example.com/team/other@${digest}` } } }],
    ["runtime port", { runtimePort: 3001 }], ["config revision", { configRevision: "other" }], ["runtime revision", { runtimeRevision: "other" }],
    ["secret references", { secretRefs: [{ secretRefId: "other", version: 1 }] }], ["canonical hash", { hash: "b".repeat(64) }]
  ])("rejects a changed canonical projection %s before transport", async (_field, patch) => {
    const { executor, input, calls } = setup();
    await expect(executor.execute({ ...input, snapshot: { ...input.snapshot, ...patch } as DeploymentSnapshotV1 })).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("rejects configured container-port mismatch before runtime effects", async () => {
    const { executor, input, calls } = setup();
    await expect(executor.execute({ ...input, runtimeConfig: { hostPort: 43000, containerPort: 8080 } })).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("captures immutable proof bindings before awaiting an untrusted transport", async () => {
    const mutable = structuredClone(snapshot());
    const config = { hostPort: 43000, containerPort: 3000 };
    const { executor, input } = setup({}, () => { (mutable as any).projectId = "mutated"; (mutable as any).hash = "b".repeat(64); config.hostPort = 44000; });
    const result = await executor.execute({ ...input, snapshot: mutable, runtimeConfig: config });
    expect(result).toMatchObject({ terminalStatus: "succeeded", runtimeConfig: { hostPort: 43000 }, executionReceipt: { projectId: "project", snapshotHash: snapshot().hash, hostPort: 43000 } });
  });

  it("replays equal proof without another effect and conflicts on changed runtime configuration", async () => {
    const { executor, input, calls } = setup();
    const first = await executor.execute(input);
    expect(await executor.execute(input)).toEqual(first);
    await expect(executor.execute({ ...input, runtimeConfig: { hostPort: 44000, containerPort: 3000 } })).rejects.toThrow();
    expect(calls).toEqual(["start", "health", "promote"]);
  });
});
