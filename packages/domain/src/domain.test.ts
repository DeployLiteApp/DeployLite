import { describe, expect, it } from "vitest";
import { createDeploymentSnapshot, createSourceIntent, type Deployment, type TrustedPriorExecutionReceiptV1 } from "@deploylite/contracts";
import { AgentStatusService, InMemoryAgentRepository, InMemoryDeploymentRepository, InMemorySnapshotStore } from "./index.js";

const now = new Date("2026-01-01T00:00:00.000Z");
const digest = `sha256:${"b".repeat(64)}`;

function deployment(status: Deployment["status"] = "running"): Deployment {
  return { id: "dep_1", projectId: "project_1", agentId: "agent_1", status, commitSha: "abcdef1", startedAt: now.toISOString(), finishedAt: status === "running" ? null : now.toISOString(), snapshotOriginId: "dep_origin", snapshotHash: "a".repeat(64) };
}

function receipt(overrides: Partial<TrustedPriorExecutionReceiptV1> = {}): TrustedPriorExecutionReceiptV1 {
  return { schemaVersion: 1, candidateId: "candidate_1", deploymentId: "dep_1", projectId: "project_1", snapshotOriginId: "dep_origin", snapshotHash: "a".repeat(64), effectiveImageDigest: digest, runtimeHost: "agent_1", container: "deploylite-dep-1", containerId: "container_1", hostPort: 43000, containerPort: 3000, network: null, ...overrides };
}

function snapshot() {
  return structuredClone(createDeploymentSnapshot({ deploymentId: "dep_origin", projectId: "project_1", source: createSourceIntent({ sourceMode: "build", sourceRevision: "abcdef1", buildProfileId: "profile_1" }), agentId: "agent_1", commitSha: "abcdef1", configRevision: "config_1", runtimeRevision: "runtime_1", runtimePort: 3000, secretRefs: [], policyVersion: "policy_1", schemaVersion: 1 }, { sha256: () => "a".repeat(64) }));
}

describe("domain foundation", () => {
  it("marks stale heartbeats without deleting the last resource snapshot", async () => {
    const agents = new InMemoryAgentRepository();
    const service = new AgentStatusService(agents);
    await agents.save({
      id: "agent_1",
      name: "Mock VPS",
      endpoint: "https://agent.example.test",
      status: "online",
      lastHeartbeatAt: "2025-12-31T23:58:00.000Z",
      resourceSnapshot: {
        cpuLoad: 0.2,
        memoryUsedBytes: 10,
        memoryTotalBytes: 100,
        diskUsedBytes: 20,
        diskTotalBytes: 200
      }
    });

    const agent = await agents.findById("agent_1");
    expect(agent ? service.markStale(agent, now).status : "missing").toBe("stale");
  });

  it("updates deployment records when status transitions to a terminal state", async () => {
    const deployments = new InMemoryDeploymentRepository();
    const deployment = {
      id: "dep_1",
      projectId: "project_1",
      agentId: "agent_1",
      status: "running" as const,
      commitSha: "abcdef1",
      startedAt: now.toISOString(),
      finishedAt: null
    };

    await deployments.save(deployment);
    const next = await deployments.save({ ...deployment, status: "succeeded" });
    expect(next.status).toBe("succeeded");
    expect(await deployments.findById("dep_1")).toMatchObject({ status: "succeeded" });
  });

  it("clones deployment inputs and outputs while preserving ordinary lifecycle updates", async () => {
    const deployments = new InMemoryDeploymentRepository();
    const input = deployment("queued");
    const saved = await deployments.save(input);
    input.projectId = "mutated_input";
    saved.agentId = "mutated_output";
    const found = await deployments.findById("dep_1");
    if (found) found.commitSha = "fffffff";

    expect(await deployments.findById("dep_1")).toMatchObject({ projectId: "project_1", agentId: "agent_1", commitSha: "abcdef1" });

    await deployments.save({ ...deployment("running"), finishedAt: null });
    expect(await deployments.findById("dep_1")).toMatchObject({ projectId: "project_1", agentId: "agent_1", status: "running" });
  });

  it("rejects generic identity, snapshot, and proof overwrites", async () => {
    const deployments = new InMemoryDeploymentRepository();
    await deployments.save(deployment("succeeded"));
    await deployments.saveExecutionReceipt("dep_1", receipt());

    await expect(deployments.save({ ...deployment(), projectId: "project_2" })).rejects.toThrow("immutable");
    await expect(deployments.save({ ...deployment(), snapshotHash: "c".repeat(64) })).rejects.toThrow("immutable");
    await expect(deployments.save({ ...deployment(), executionReceipt: receipt({ containerId: "container_2" }) })).rejects.toThrow("immutable");
  });

  it.each(["failed", "canceled"] as const)("keeps %s terminal outcomes immutable", async (status) => {
    const deployments = new InMemoryDeploymentRepository();
    await deployments.save(deployment("running"));
    await deployments.save(deployment(status));

    await expect(deployments.save({ ...deployment(status), finishedAt: "2026-01-02T00:00:00.000Z" })).rejects.toThrow("immutable");
    expect(await deployments.findById("dep_1")).toMatchObject({ status, finishedAt: now.toISOString() });
  });

  it("clones snapshots, accepts equal replay, and rejects changed content for a hash", () => {
    const snapshots = new InMemorySnapshotStore();
    const input = snapshot();
    const saved = snapshots.save(input);
    input.projectId = "mutated_input";
    saved.configRevision = "mutated_output";

    let replay;
    expect(() => { replay = snapshots.save(snapshot()); }).not.toThrow();
    expect(replay).toMatchObject({ projectId: "project_1", configRevision: "config_1" });
    expect(() => snapshots.save({ ...snapshot(), projectId: "project_2" })).toThrow("immutable");
    expect(snapshots.get("a".repeat(64))).toMatchObject({ projectId: "project_1", configRevision: "config_1" });
  });

  it("clones proof references, accepts equal replay, and rejects changed proof", async () => {
    const deployments = new InMemoryDeploymentRepository();
    await deployments.save(deployment("succeeded"));
    const input = receipt();
    const saved = await deployments.saveExecutionReceipt("dep_1", input);
    input.containerId = "mutated_input";
    if (saved?.executionReceipt) saved.executionReceipt.containerId = "mutated_output";

    await expect(deployments.saveExecutionReceipt("dep_1", receipt())).resolves.toMatchObject({ executionReceipt: { containerId: "container_1" } });
    await expect(deployments.saveExecutionReceipt("dep_1", receipt({ containerId: "container_2" }))).rejects.toThrow("immutable");
    expect(await deployments.findById("dep_1")).toMatchObject({ executionReceipt: { containerId: "container_1" } });
  });

  it.each([
    receipt({ projectId: "project_2" }),
    { ...receipt(), containerId: undefined }
  ])("rejects invalid proof before changing deployment state", async (invalidProof) => {
    const deployments = new InMemoryDeploymentRepository();
    await deployments.save(deployment("succeeded"));
    const result = await deployments.saveExecutionReceipt("dep_1", invalidProof as TrustedPriorExecutionReceiptV1).then(() => "resolved", () => "rejected");

    expect({ result, stored: (await deployments.findById("dep_1"))?.executionReceipt ?? null }).toEqual({ result: "rejected", stored: null });
  });

  it("redacts and preserves ordered immutable logs", async () => {
    const deployments = new InMemoryDeploymentRepository();
    await deployments.appendLog({
      id: "log_1",
      deploymentId: "dep_1",
      sequence: 1,
      level: "info",
      message: "deployed with token dl_fixture_token_1234567890abcdef",
      timestamp: now.toISOString(),
      redactionApplied: false,
      requestId: "req_1",
      correlationId: "req_1"
    });

    const logs = await deployments.listLogs("dep_1", 0);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.message).toBe("deployed with token [REDACTED]");
    await expect(deployments.appendLog({ ...logs[0]!, id: "log_2" })).rejects.toThrow("unique");
  });
});
