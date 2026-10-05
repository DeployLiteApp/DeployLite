import { describe, expect, it } from "vitest";
import type { Deployment, DeploymentRedeployCommandResult, TrustedPriorExecutionReceiptV1 } from "@deploylite/contracts";
import { createControlCommand, type ExecutionCompletionInput } from "@deploylite/domain";
import { createInMemoryExecutionRepositories } from "./app.js";

const snapshotHash = "a".repeat(64), imageDigest = `sha256:${"b".repeat(64)}`, finishedAt = "2026-01-01T00:05:00.000Z";
function deployment(id = "execution_1", status: Deployment["status"] = "running"): Deployment { return { id, projectId: "project_1", agentId: "agent_1", status, commitSha: "abcdef1", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: status === "running" || status === "queued" ? null : finishedAt, sourceDeploymentId: "source_1", snapshotOriginId: "origin_1", snapshotHash }; }
function proof(): TrustedPriorExecutionReceiptV1 { return { schemaVersion: 1, candidateId: "candidate_1", deploymentId: "execution_1", projectId: "project_1", snapshotOriginId: "origin_1", snapshotHash, effectiveImageDigest: imageDigest, runtimeHost: "agent_1", container: "deploylite-execution-1", containerId: "container_1", hostPort: 43000, containerPort: 3000, network: null }; }
function result(status: "eligible" | "completed" = "completed"): DeploymentRedeployCommandResult { return { commandId: "command_1", action: "deployment.redeploy", projectId: "project_1", sourceDeploymentId: "source_1", deploymentId: "execution_1", snapshotHash, status, correlationId: "correlation_1", reason: null }; }
function input(overrides: Partial<ExecutionCompletionInput> = {}): ExecutionCompletionInput { return { commandId: "command_1", expectedStatus: "running", executionId: "execution_1", projectId: "project_1", sourceExecutionId: "source_1", snapshotOriginId: "origin_1", snapshotHash, runtimeHost: "agent_1", effectiveImageDigest: imageDigest, terminalStatus: "succeeded", finishedAt, commandResult: result(), proof: proof(), ...overrides }; }
async function seeded() { const repositories = createInMemoryExecutionRepositories(); await repositories.deployments.save(deployment()); await repositories.controls.resolve({ ...createControlCommand({ actorId: "actor_1", action: "deployment.redeploy", scope: { kind: "deployment", projectId: "project_1", deploymentId: "source_1" }, input: {}, idempotencyKey: "idempotency_1", correlationId: "correlation_1" }), id: "command_1", status: "dispatching", result: result("eligible") }); return repositories; }

describe("in-memory execution completion adapter", () => {
  it("publishes successful deployment proof and command completion atomically", async () => {
    const repositories = await seeded();
    const outcome = await repositories.completion.completeExecution(input());
    expect(outcome).toMatchObject({ kind: "committed", deployment: { status: "succeeded", executionReceipt: { containerId: "container_1" } }, command: { status: "completed", result: { status: "completed" } } });
    await expect(repositories.deployments.findById("execution_1")).resolves.toMatchObject({ status: "succeeded", executionReceipt: { containerId: "container_1" } });
    await expect(repositories.controls.findByIdempotency("actor_1", "idempotency_1")).resolves.toMatchObject({ status: "completed", result: { status: "completed" } });
  });

  it("rolls back staged writes when the transaction callback fails", async () => {
    const repositories = await seeded();
    await expect(repositories.completion.transaction(async (transaction) => { const current = await transaction.lockDeployment("execution_1"); await transaction.saveDeployment({ ...current!, status: "succeeded", finishedAt, executionReceipt: proof() }); throw new Error("injected fault"); })).rejects.toThrow("injected fault");
    const stored = await repositories.deployments.findById("execution_1");
    expect(stored).toMatchObject({ status: "running" }); expect(stored).not.toHaveProperty("executionReceipt");
  });

  it("replays equal concurrent completion, rejects changed replay, and retains unrelated writes", async () => {
    const repositories = await seeded(); await repositories.deployments.save(deployment("execution_2", "queued"));
    const [first, second] = await Promise.all([repositories.completion.completeExecution(input()), repositories.completion.completeExecution(input()), repositories.deployments.save(deployment("execution_2", "running"))]);
    expect([first.kind, second.kind].sort()).toEqual(["committed", "replayed"]);
    await expect(repositories.deployments.findById("execution_2")).resolves.toMatchObject({ status: "running" });
    await expect(repositories.completion.completeExecution(input({ finishedAt: "2026-01-01T00:06:00.000Z" }))).resolves.toEqual({ kind: "conflict" });
  });

  it("returns not-found without mutation when either required row is missing", async () => {
    const missingCommand = createInMemoryExecutionRepositories(); await missingCommand.deployments.save(deployment());
    const missingDeployment = createInMemoryExecutionRepositories(); const source = await seeded(); const command = await source.controls.findByIdempotency("actor_1", "idempotency_1"); await missingDeployment.controls.resolve(command!);
    await expect(missingCommand.completion.completeExecution(input())).resolves.toEqual({ kind: "not-found" });
    await expect(missingDeployment.completion.completeExecution(input())).resolves.toEqual({ kind: "not-found" });
    await expect(missingCommand.deployments.findById("execution_1")).resolves.toMatchObject({ status: "running" });
  });

  it.each(["failed", "canceled"] as const)("persists %s without proof or command", async (terminalStatus) => {
    const repositories = createInMemoryExecutionRepositories(); await repositories.deployments.save(deployment());
    const outcome = await repositories.completion.completeExecution(input({ commandId: null, commandResult: null, terminalStatus, proof: null }));
    expect(outcome).toMatchObject({ kind: "committed", deployment: { status: terminalStatus }, command: null });
    const stored = await repositories.deployments.findById("execution_1"); expect(stored).toMatchObject({ status: terminalStatus }); expect(stored).not.toHaveProperty("executionReceipt");
  });

  it("clones completion inputs, outcomes, and stored records", async () => {
    const repositories = await seeded(); const submittedProof = proof(); const pending = repositories.completion.completeExecution(input({ proof: submittedProof })); submittedProof.containerId = "mutated-input";
    const outcome = await pending; if (outcome.kind !== "committed") throw new Error(`unexpected ${outcome.kind}`); outcome.deployment.executionReceipt!.containerId = "mutated-output"; outcome.command!.result.reason = "mutated-output";
    await expect(repositories.deployments.findById("execution_1")).resolves.toMatchObject({ executionReceipt: { containerId: "container_1" } });
    await expect(repositories.controls.findByIdempotency("actor_1", "idempotency_1")).resolves.toMatchObject({ result: { reason: null } });
  });

  it("preserves legacy constructors and ordinary repository behavior", async () => {
    const repositories = createInMemoryExecutionRepositories(); await repositories.deployments.save(deployment("legacy", "queued")); await repositories.deployments.save(deployment("legacy", "running"));
    const command = createControlCommand({ actorId: "actor_1", action: "deployment.redeploy", scope: { kind: "deployment", projectId: "project_1", deploymentId: "source_1" }, input: {}, idempotencyKey: "legacy", correlationId: "legacy" });
    await expect(repositories.controls.resolve(command)).resolves.toMatchObject({ created: true, command: { status: "pending_confirmation" } });
    await expect(repositories.deployments.findById("legacy")).resolves.toMatchObject({ status: "running" });
  });
});
