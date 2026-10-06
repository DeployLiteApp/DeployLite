import { describe, expect, it } from "vitest";
import { InMemoryExecutionState } from "./execution-memory-state.js";
import { createControlCommand } from "../control-plane.js";
import type { Deployment, DeploymentRedeployCommandResult, TrustedPriorExecutionReceiptV1 } from "@deploylite/contracts";

import {
  completeExecutionAtomically,
  type ExecutionCommandRecord,
  type ExecutionCompletionInput,
  type ExecutionCompletionStore,
  type ExecutionCompletionTransaction
} from "./execution-completion.js";

const hash = "a".repeat(64);
const digest = `sha256:${"b".repeat(64)}`;

function deployment(status: Deployment["status"] = "running"): Deployment {
  return {
    id: "execution-1",
    projectId: "project-1",
    agentId: "agent-1",
    status,
    commitSha: "abcdef1",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: status === "running" ? null : "2026-01-01T00:01:00.000Z",
    sourceDeploymentId: "source-1",
    snapshotOriginId: "origin-1",
    snapshotHash: hash
  };
}

function commandResult(status: "eligible" | "completed" = "eligible"): DeploymentRedeployCommandResult {
  return {
    commandId: "command-1",
    action: "deployment.redeploy",
    projectId: "project-1",
    sourceDeploymentId: "source-1",
    deploymentId: "execution-1",
    snapshotHash: hash,
    status,
    correlationId: "correlation-1",
    reason: null
  };
}

function command(status: ExecutionCommandRecord["status"] = "dispatching"): ExecutionCommandRecord {
  return { id: "command-1", status, result: commandResult(status === "completed" ? "completed" : "eligible") };
}

function proof(overrides: Partial<TrustedPriorExecutionReceiptV1> = {}): TrustedPriorExecutionReceiptV1 {
  return {
    schemaVersion: 1,
    candidateId: "candidate-1",
    deploymentId: "execution-1",
    projectId: "project-1",
    snapshotOriginId: "origin-1",
    snapshotHash: hash,
    effectiveImageDigest: digest,
    runtimeHost: "agent-1",
    container: "deploylite-execution-1",
    containerId: "container-1",
    hostPort: 43000,
    containerPort: 3000,
    network: null,
    ...overrides
  };
}

function input(overrides: Partial<ExecutionCompletionInput> = {}): ExecutionCompletionInput {
  return {
    commandId: "command-1",
    expectedStatus: "running",
    executionId: "execution-1",
    projectId: "project-1",
    sourceExecutionId: "source-1",
    snapshotOriginId: "origin-1",
    snapshotHash: hash,
    runtimeHost: "agent-1",
    effectiveImageDigest: digest,
    terminalStatus: "succeeded",
    finishedAt: "2026-01-01T00:01:00.000Z",
    commandResult: commandResult("completed"),
    proof: proof(),
    ...overrides
  };
}

class FakeTransactionalStore implements ExecutionCompletionStore {
  deployment: Deployment | null = deployment();
  command: ExecutionCommandRecord | null = command();
  readonly locks: string[] = [];
  failAfterDeployment = false;
  onDeploymentLock?: () => void;
  onDeploymentSaved?: () => void;

  async transaction<T>(work: (transaction: ExecutionCompletionTransaction) => Promise<T>): Promise<T> {
    const before = structuredClone({ deployment: this.deployment, command: this.command });
    try {
      return await work({
        validateAuthority: async () => true,
        lockCommand: async (id) => { this.locks.push(`command:${id}`); return structuredClone(this.command); },
        lockDeployment: async (id) => { this.locks.push(`deployment:${id}`); this.onDeploymentLock?.(); return structuredClone(this.deployment); },
        saveDeployment: async (value) => { this.deployment = structuredClone(value); this.onDeploymentSaved?.(); if (this.failAfterDeployment) throw new Error("injected write failure"); },
        saveCommand: async (value) => { this.command = structuredClone(value); }
      });
    } catch (error) {
      this.deployment = before.deployment;
      this.command = before.command;
      throw error;
    }
  }
}

describe("atomic execution completion", () => {
  it("commits terminal deployment, trusted proof, and command completion in lock order", async () => {
    const store = new FakeTransactionalStore();
    const outcome = await completeExecutionAtomically(store, input());

    expect(outcome).toMatchObject({ kind: "committed", deployment: { status: "succeeded", executionReceipt: { containerId: "container-1" } }, command: { status: "completed", result: { status: "completed" } } });
    expect(store.locks).toEqual(["command:command-1", "deployment:execution-1"]);
  });

  it("replays canonical-equal completion and conflicts on changed proof", async () => {
    const store = new FakeTransactionalStore();
    await completeExecutionAtomically(store, input());

    await expect(completeExecutionAtomically(store, structuredClone(input()))).resolves.toMatchObject({ kind: "replayed" });
    await expect(completeExecutionAtomically(store, input({ proof: proof({ containerId: "container-2" }) }))).resolves.toEqual({ kind: "conflict" });
    expect(store.deployment?.executionReceipt?.containerId).toBe("container-1");
  });

  it.each([
    ["deployment", { deployment: null, command: command() }],
    ["command", { deployment: deployment(), command: null }]
  ])("returns not-found when the %s row is missing without writes", async (_name, state) => {
    const store = new FakeTransactionalStore();
    Object.assign(store, state);

    await expect(completeExecutionAtomically(store, input())).resolves.toEqual({ kind: "not-found" });
    expect(store.deployment).toEqual(state.deployment);
    expect(store.command).toEqual(state.command);
  });

  it.each(["succeeded", "failed", "canceled"] as const)("rejects %s completion of an unclaimed eligible command without writes", async (terminalStatus) => {
    const store = new FakeTransactionalStore();
    store.command = command("eligible");
    const before = structuredClone({ deployment: store.deployment, command: store.command });
    await expect(completeExecutionAtomically(store, input({ terminalStatus, proof: terminalStatus === "succeeded" ? proof() : null }))).resolves.toEqual({ kind: "conflict" });
    expect({ deployment: store.deployment, command: store.command }).toEqual(before);
  });

  it("rejects wrong source binding before either row changes", async () => {
    const store = new FakeTransactionalStore();
    const before = structuredClone({ deployment: store.deployment, command: store.command });

    await expect(completeExecutionAtomically(store, input({ proof: proof({ snapshotOriginId: "wrong-origin" }) }))).resolves.toEqual({ kind: "conflict" });
    expect({ deployment: store.deployment, command: store.command }).toEqual(before);
  });

  it("rejects a proof attached through a generic write before terminal completion", async () => {
    const store = new FakeTransactionalStore();
    store.deployment = { ...deployment(), executionReceipt: proof() };

    await expect(completeExecutionAtomically(store, input())).resolves.toEqual({ kind: "conflict" });
    expect(store.deployment).toMatchObject({ status: "running", executionReceipt: { containerId: "container-1" } });
    expect(store.command).toEqual(command());
  });

  it.each(["failed", "canceled"] as const)("commits truthful %s completion without success proof", async (terminalStatus) => {
    const store = new FakeTransactionalStore();
    const outcome = await completeExecutionAtomically(store, input({ terminalStatus, proof: null, commandResult: { ...commandResult("completed"), reason: `agent-${terminalStatus}` } }));

    expect(outcome).toMatchObject({ kind: "committed", deployment: { status: terminalStatus }, command: { status: "completed", result: { reason: `agent-${terminalStatus}` } } });
    expect(outcome.kind === "committed" ? outcome.deployment : null).not.toHaveProperty("executionReceipt");
  });

  it("rolls back all writes when the transaction fails after deployment persistence", async () => {
    const store = new FakeTransactionalStore();
    const before = structuredClone({ deployment: store.deployment, command: store.command });
    store.failAfterDeployment = true;

    await expect(completeExecutionAtomically(store, input())).rejects.toThrow("injected write failure");
    expect({ deployment: store.deployment, command: store.command }).toEqual(before);
  });
});


describe("cached terminal publication cancellation", () => {
  it.each(["before-handoff", "after-lock", "after-staged-write"] as const)("rolls back completion when canceled %s", async (at) => {
    const store = new FakeTransactionalStore(), before = structuredClone({ deployment: store.deployment, command: store.command }), controller = new AbortController();
    if (at === "before-handoff") controller.abort(new Error("cache publication canceled"));
    if (at === "after-lock") store.onDeploymentLock = () => controller.abort(new Error("cache publication canceled"));
    if (at === "after-staged-write") store.onDeploymentSaved = () => controller.abort(new Error("cache publication canceled"));
    await expect((completeExecutionAtomically as any)(store, input(), controller.signal)).rejects.toThrow("cache publication canceled");
    expect({ deployment: store.deployment, command: store.command }).toEqual(before);
  });
  it("preserves equal durable replay despite an aborted caller without a new write", async () => {
    const store = new FakeTransactionalStore(); await completeExecutionAtomically(store, input()); const before = structuredClone({ deployment: store.deployment, command: store.command }), controller = new AbortController(); controller.abort();
    await expect((completeExecutionAtomically as any)(store, input(), controller.signal)).resolves.toMatchObject({ kind: "replayed" }); expect({ deployment: store.deployment, command: store.command }).toEqual(before);
  });
});


it("rejects abort at the actual shared-memory map publication boundary", async () => {
  const state = new InMemoryExecutionState(), controller = new AbortController(); state.deployments.set("execution-1", deployment());
  state.commands.set("command-1", { ...createControlCommand({ actorId: "actor", action: "deployment.redeploy", scope: { kind: "deployment", projectId: "project-1", deploymentId: "source-1" }, input: {}, idempotencyKey: "key", correlationId: "correlation-1" }), ...command() });
  const before = structuredClone({ deployments: state.deployments, commands: state.commands }), original = state.transaction.bind(state);
  state.transaction = (async (work: Parameters<typeof state.transaction>[0], signal?: AbortSignal) => (original as any)(async (transaction: ExecutionCompletionTransaction) => { const result = await work(transaction); controller.abort(new Error("cache publication canceled")); return result; }, signal)) as typeof state.transaction;
  await expect((state.completeExecution as any)(input(), controller.signal)).rejects.toThrow("cache publication canceled"); expect({ deployments: state.deployments, commands: state.commands }).toEqual(before);
});


describe("rollback atomic independent active and historical bindings", () => {
  it("publishes R proof/status/result while retaining active A and historical H independently", async () => {
    const store = new FakeTransactionalStore(), R = "00000000-0000-4000-8000-000000000010";
    const rollback = { ...commandResult(), action: "deployment.rollback" as const, activeDeploymentId: "active-A", sourceDeploymentId: "historical-H", deploymentId: R };
    store.deployment = { ...deployment(), id: R, sourceDeploymentId: "historical-H", activeDeploymentId: "active-A" };
    const authority = rollbackCompletion().submitted.authority;
    store.command = { id: "command-1", action: "deployment.rollback", scope: { kind: "deployment", projectId: "project-1", deploymentId: "active-A" }, status: "dispatching", result: rollback, executionAuthority: authority } as unknown as ExecutionCommandRecord;
    const submitted = { ...input(), authority, executionId: R, sourceExecutionId: "historical-H", activeDeploymentId: "active-A", commandResult: { ...rollback, status: "completed" as const }, proof: proof({ deploymentId: R }) };
    const outcome = await completeExecutionAtomically(store, submitted as unknown as ExecutionCompletionInput);
    expect(outcome).toMatchObject({ kind: "committed", deployment: { status: "succeeded", activeDeploymentId: "active-A", sourceDeploymentId: "historical-H" }, command: { status: "completed", result: { activeDeploymentId: "active-A", sourceDeploymentId: "historical-H", deploymentId: R } } });
  });
  it("claims A as source authority while R is execution and H remains historical lineage", async () => {
    const { claimDeploymentAuthority } = await import("./deployment-authority.js");
    const R = "00000000-0000-4000-8000-000000000010";
    const current = createControlCommand({ actorId: "actor", action: "deployment.rollback", scope: { kind: "deployment", projectId: "project-1", deploymentId: "active-A" }, input: {}, idempotencyKey: "rollback", correlationId: "original" });
    current.status = "eligible"; current.result = { commandId: current.id, action: "deployment.rollback", projectId: "project-1", activeDeploymentId: "active-A", sourceDeploymentId: "historical-H", deploymentId: R, snapshotHash: hash, status: "eligible", correlationId: "original", reason: null };
    expect(claimDeploymentAuthority([current], current, R)).toMatchObject({ action: "deployment.rollback", sourceLease: { deploymentId: "active-A" }, executionLease: { deploymentId: R } });
    expect(current.result.sourceDeploymentId).toBe("historical-H");
  });
});
function rollbackCompletion() {
  const R = "00000000-0000-4000-8000-000000000010", lease = (deploymentId: string) => ({ deploymentId, leaseId: `${deploymentId}:rollback`, fence: 2, expiresAt: Date.now() + 200_000 });
  const authority = { action: "deployment.rollback" as const, commandId: "command-1", projectId: "project-1", projectLease: lease("project-1"), sourceLease: lease("active-A"), executionLease: lease(R) };
  const result = { ...commandResult(), action: "deployment.rollback" as const, activeDeploymentId: "active-A", sourceDeploymentId: "historical-H", deploymentId: R };
  const current = { ...deployment(), id: R, sourceDeploymentId: "historical-H", activeDeploymentId: "active-A" };
  const submitted = { ...input(), authority, executionId: R, sourceExecutionId: "historical-H", activeDeploymentId: "active-A", commandResult: { ...result, status: "completed" as const }, proof: proof({ deploymentId: R }) };
  const state = new InMemoryExecutionState(); state.deployments.set(R, structuredClone(current));
  state.commands.set("rollback", { ...createControlCommand({ actorId: "actor", action: "deployment.rollback", scope: { kind: "deployment", projectId: "project-1", deploymentId: "active-A" }, input: {}, idempotencyKey: "rollback", correlationId: "correlation-1" }), id: "command-1", status: "dispatching", result, executionAuthority: authority });
  return { state, submitted, current, result };
}
describe("rollback completion guards at actual shared memory publication", () => {
  it.each(["submitted-A", "persisted-A", "expected-A", "result-A", "missing-authority", "source-lease-H"])("rejects %s without status/proof/result publication", async (variant) => {
    const f = rollbackCompletion(), value = structuredClone(f.submitted);
    if (variant === "submitted-A") value.activeDeploymentId = "other-A";
    if (variant === "persisted-A") f.state.deployments.get(value.executionId)!.activeDeploymentId = "other-A";
    if (variant === "expected-A") (f.state.commands.get("rollback")!.result as any).activeDeploymentId = "other-A";
    if (variant === "result-A") value.commandResult.activeDeploymentId = "other-A";
    if (variant === "missing-authority") { delete (value as any).authority; delete f.state.commands.get("rollback")!.executionAuthority; }
    if (variant === "source-lease-H") { value.authority.sourceLease.deploymentId = "historical-H"; f.state.commands.get("rollback")!.executionAuthority = structuredClone(value.authority); }
    const before = structuredClone({ deployments: f.state.deployments, commands: f.state.commands });
    expect(await f.state.completeExecution(value)).toEqual({ kind: "conflict" });
    expect({ deployments: f.state.deployments, commands: f.state.commands }).toEqual(before);
  });
  it("commits and replays a canonical-equal rollback before expired authority/deleted mutable dependencies", async () => {
    const f = rollbackCompletion(); expect((await f.state.completeExecution(f.submitted)).kind).toBe("committed");
    const command = f.state.commands.get("rollback")!; command.expiresAt = new Date(0);
    // An equal durable receipt retains the original immutable authority instead of refreshing it.
    expect((await f.state.completeExecution(f.submitted)).kind).toBe("replayed");
    expect(await f.state.completeExecution({ ...f.submitted, activeDeploymentId: "changed-A" })).toEqual({ kind: "conflict" });
  });
});


describe("rollback completion keeps the persisted command scope/action bound", () => {
  it.each(["scope", "action"])("rejects changed command %s at actual shared publication", async (variant) => {
    const f = rollbackCompletion(), command = f.state.commands.get("rollback")!;
    if (variant === "scope") command.scope = { kind: "deployment", projectId: "project-1", deploymentId: "historical-H" };
    else command.action = "deployment.redeploy";
    const before = structuredClone({ deployments: f.state.deployments, commands: f.state.commands });
    expect(await f.state.completeExecution(f.submitted)).toEqual({ kind: "conflict" });
    expect({ deployments: f.state.deployments, commands: f.state.commands }).toEqual(before);
  });
});
