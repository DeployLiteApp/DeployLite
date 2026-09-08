import { describe, expect, it } from "vitest";
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

  async transaction<T>(work: (transaction: ExecutionCompletionTransaction) => Promise<T>): Promise<T> {
    const before = structuredClone({ deployment: this.deployment, command: this.command });
    try {
      return await work({
        lockCommand: async (id) => { this.locks.push(`command:${id}`); return structuredClone(this.command); },
        lockDeployment: async (id) => { this.locks.push(`deployment:${id}`); return structuredClone(this.deployment); },
        saveDeployment: async (value) => { this.deployment = structuredClone(value); if (this.failAfterDeployment) throw new Error("injected write failure"); },
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
