import { getTableColumns } from "drizzle-orm";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutionCompletionInput } from "@deploylite/domain";
import { createDbClient } from "../client.js";
import { controlCommands, deployments, type ControlCommandRow, type DeploymentRow } from "../schema.js";
import { DbDeploymentExecutionRepository } from "./execution-completion.js";

const startedAt = "2026-01-01T00:00:00.000Z";
const finishedAt = "2026-01-01T00:01:00.000Z";
const hash = "a".repeat(64);
const result = {
  commandId: "command-1", action: "deployment.redeploy" as const, projectId: "project-1", sourceDeploymentId: "source-1",
  deploymentId: "execution-1", snapshotHash: hash, status: "eligible" as const, correlationId: "correlation-1", reason: null
};
const input: ExecutionCompletionInput = {
  commandId: "command-1", expectedStatus: "running", executionId: "execution-1", projectId: "project-1",
  sourceExecutionId: "source-1", snapshotOriginId: "origin-1", snapshotHash: hash, runtimeHost: "agent-1",
  effectiveImageDigest: `sha256:${"b".repeat(64)}`, terminalStatus: "succeeded", finishedAt,
  commandResult: { ...result, status: "completed" },
  proof: {
    schemaVersion: 1, candidateId: "candidate-1", deploymentId: "execution-1", projectId: "project-1",
    snapshotOriginId: "origin-1", snapshotHash: hash, effectiveImageDigest: `sha256:${"b".repeat(64)}`,
    runtimeHost: "agent-1", container: "deploylite-execution-1", containerId: "container-1",
    hostPort: 43000, containerPort: 3000, network: null
  }
};

class RecordingTransactionalClient {
  state: { deployment: DeploymentRow | null; command: ControlCommandRow | null } = {
    deployment: {
      id: "execution-1", projectId: "project-1", agentId: "agent-1", status: "running", commitSha: "abcdef1",
      startedAt: new Date(startedAt), finishedAt: null, snapshotHash: hash, snapshotEvidence: null, executionReceipt: null,
      metadata: { sourceDeploymentId: "source-1", snapshotOriginId: "origin-1" }, createdAt: new Date(startedAt), updatedAt: new Date(startedAt)
    },
    command: {
      id: "command-1", actorUserId: "actor-1", action: "deployment.redeploy", scopeKind: "deployment",
      scopeKey: JSON.stringify(["project-1", "source-1"]), inputDigest: "input-1", idempotencyKey: "key-1",
      correlationId: "correlation-1", status: "dispatching", executionAuthority: null, result, expiresAt: new Date(finishedAt),
      createdAt: new Date(startedAt), updatedAt: new Date(startedAt)
    }
  };
  readonly queries: Array<{ text: string; values: unknown[] }> = [];
  private before: typeof this.state | undefined;
  missingWrite: "deployment" | "command" | null = null;
  failCommandWrite = false;
  extraCommands: ControlCommandRow[] = [];
  beforeCommandLock?: () => void;
  beforeCommandWrite?: () => void;

  // This model records real Drizzle SQL, but is not a PostgreSQL engine or concurrency harness.
  async query(query: string | { text: string }, values: unknown[] = []) {
    const text = typeof query === "string" ? query : query.text;
    this.queries.push({ text, values });
    if (text === "begin") this.before = structuredClone(this.state);
    if (text === "rollback" && this.before) this.state = this.before;
    if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (text.startsWith("select")) {
      if (text.includes('from "control_commands"') && text.endsWith("for update")) this.beforeCommandLock?.();
      const command = text.includes('from "control_commands"');
      const row = command ? this.state.command : this.state.deployment;
      const columns = getTableColumns(command ? controlCommands : deployments);
      const related = command && text.includes("::jsonb") ? [row, ...this.extraCommands].filter(Boolean) : row ? [row] : [];
      return { rows: related.map((entry) => Object.keys(columns).map((key) => entry![key as keyof typeof row])) };
    }
    if (text.startsWith("update")) {
      const command = text.includes('update "control_commands"');
      const row = command ? this.state.command : this.state.deployment;
      if (command) {
        this.beforeCommandWrite?.();
        if (text.includes("clock_timestamp()") && (!this.state.command?.executionAuthority || Math.min(this.state.command.expiresAt.getTime(), this.state.command.executionAuthority.projectLease.expiresAt, this.state.command.executionAuthority.executionLease.expiresAt, this.state.command.executionAuthority.sourceLease?.expiresAt ?? Infinity) <= Date.now())) return { rows: [] };
      }
      if (command && this.failCommandWrite) throw new Error("injected command write failure");
      if (!row || this.missingWrite === (command ? "command" : "deployment")) return { rows: [] };
      const set = text.split(" set ")[1]?.split(" where ")[0] ?? "";
      for (const match of set.matchAll(/"(\w+)" = \$(\d+)/g)) {
        const name = match[1] ?? "";
        const key = name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
        const value = values[Number(match[2]) - 1];
        (row as Record<string, unknown>)[key] = name === "result" || name === "execution_receipt" ? (typeof value === "string" ? JSON.parse(value) : value) : name.endsWith("_at") && value ? new Date(String(value)) : value;
      }
      return { rows: [[row.id]] };
    }
    return { rows: [] };
  }
}

function harness() {
  const client = new RecordingTransactionalClient();
  const repository = new DbDeploymentExecutionRepository(createDbClient(client as unknown as Pool));
  return { client, repository };
}

afterEach(() => vi.useRealTimers());
describe("PostgreSQL execution-completion adapter with a recording transaction model", () => {
  it.each(["expired-at-lock", "superseded-at-lock", "expired-at-write"])("checks persisted authority inside the terminal transaction for %s", async (fault) => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-04T19:00:00Z"));
    const { client, repository } = harness();
    const lease = (deploymentId: string) => ({ deploymentId, leaseId: `${deploymentId}:owner`, fence: 2, expiresAt: Date.now() + 120_000 });
    const authority = { projectId: input.projectId, commandId: input.commandId!, action: "deployment.redeploy" as const, projectLease: lease(input.projectId), sourceLease: lease(input.sourceExecutionId!), executionLease: lease(input.executionId) };
    Object.assign(client.state.command!, { executionAuthority: structuredClone(authority), expiresAt: new Date(authority.projectLease.expiresAt) });
    client.beforeCommandLock = () => {
      if (fault === "expired-at-lock") vi.setSystemTime(authority.projectLease.expiresAt);
      if (fault === "superseded-at-lock") client.extraCommands = [{ ...structuredClone(client.state.command!), id: "newer", executionAuthority: { ...structuredClone(authority), commandId: "newer", projectLease: { ...authority.projectLease, fence: 3 } } }];
    };
    if (fault === "expired-at-write") client.beforeCommandWrite = () => vi.setSystemTime(authority.projectLease.expiresAt);
    await expect(repository.completeExecution({ ...input, authority } as ExecutionCompletionInput)).resolves.toEqual({ kind: "conflict" });
    expect(client.state).toMatchObject({ deployment: { status: "running", executionReceipt: null }, command: { status: "dispatching", result } });
    if (fault !== "expired-at-write") expect(client.queries.some(({ text }) => text.startsWith("update"))).toBe(false);
  });
  it("serializes authority-bearing completion with claims and replays an equal terminal result after expiry", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-04T19:00:00Z"));
    const { client, repository } = harness();
    const lease = (deploymentId: string) => ({ deploymentId, leaseId: `${deploymentId}:owner`, fence: 2, expiresAt: Date.now() + 120_000 });
    const authority = { projectId: input.projectId, commandId: input.commandId!, action: "deployment.redeploy" as const, projectLease: lease(input.projectId), sourceLease: lease(input.sourceExecutionId!), executionLease: lease(input.executionId) };
    Object.assign(client.state.command!, { executionAuthority: authority, expiresAt: new Date(authority.projectLease.expiresAt) });
    const submitted = { ...input, authority };
    expect((await repository.completeExecution(submitted)).kind).toBe("committed");
    const projectLock = client.queries.findIndex(({ text }) => text.includes("pg_advisory_xact_lock"));
    const commandLock = client.queries.findIndex(({ text }) => text.includes('from "control_commands"') && text.endsWith("for update"));
    expect(projectLock).toBeGreaterThan(0); expect(projectLock).toBeLessThan(commandLock);
    expect(client.queries[projectLock]?.values).toEqual(["deploylite:execution:project-1"]);
    expect(client.queries.find(({ text }) => text.startsWith('update "control_commands"'))?.text).toContain("clock_timestamp()");
    const writes = client.queries.filter(({ text }) => text.startsWith("update")).length;
    vi.setSystemTime(authority.projectLease.expiresAt);
    expect((await repository.completeExecution(submitted)).kind).toBe("replayed");
    expect(client.queries.filter(({ text }) => text.startsWith("update"))).toHaveLength(writes);
  });
  it("rejects null-command INITIAL completion after persisted stop authority without rewriting its outcome", async () => {
    const { client, repository } = harness();
    const lease = { deploymentId: input.executionId, leaseId: "stop:owner", fence: 2, expiresAt: Date.now() + 120_000 };
    Object.assign(client.state.command!, { action: "deployment.stop", scopeKey: JSON.stringify([input.projectId, input.executionId]), status: "completed", executionAuthority: { projectId: input.projectId, commandId: "command-1", action: "deployment.stop", projectLease: { ...lease, deploymentId: input.projectId }, executionLease: lease }, result: { commandId: "command-1", action: "deployment.stop", projectId: input.projectId, deploymentId: input.executionId, status: "completed", correlationId: "correlation-1", reason: "stopped" } });
    client.state.deployment!.metadata = { snapshotOriginId: input.snapshotOriginId };
    expect(await repository.completeExecution({ ...input, commandId: null, commandResult: null, sourceExecutionId: null, terminalStatus: "failed", proof: null })).toEqual({ kind: "conflict" });
    expect(client.state.deployment?.status).toBe("running"); expect(client.state.command?.status).toBe("completed");
    expect(client.queries.some(({ text }) => text.startsWith("update"))).toBe(false);
  });
  it("commits deployment proof and command result together after command-first locks", async () => {
    const { client, repository } = harness();
    expect(await repository.completeExecution(input)).toMatchObject({
      kind: "committed", deployment: { status: "succeeded", executionReceipt: { containerId: "container-1" } },
      command: { status: "completed", result: { status: "completed" } }
    });
    expect(client.state).toMatchObject({ deployment: { status: "succeeded", executionReceipt: input.proof }, command: { status: "completed", result: input.commandResult } });
    const selects = client.queries.filter(({ text }) => text.startsWith("select"));
    expect(selects.map(({ text }) => text.match(/from "([^"]+)"/)?.[1])).toEqual(["control_commands", "deployments"]);
    expect(selects.every(({ text }) => text.endsWith("for update"))).toBe(true);
    expect(client.queries.map(({ text }) => text).filter((text) => text === "begin" || text === "commit")).toEqual(["begin", "commit"]);
    const updates = client.queries.filter(({ text }) => text.startsWith("update"));
    expect(updates).toHaveLength(2);
    for (const { text } of updates) expect(text.slice(text.indexOf(" where "))).toContain('"status" =');
    expect(updates[0]?.values.slice(-2)).toEqual(["execution-1", "running"]);
    expect(updates[1]?.values.slice(-2)).toEqual(["command-1", "dispatching"]);
  });

  it("replays equal completion and rejects a changed proof without new writes", async () => {
    const { client, repository } = harness();
    await repository.completeExecution(input);
    const writes = client.queries.filter(({ text }) => text.startsWith("update")).length;
    await expect(repository.completeExecution(structuredClone(input))).resolves.toMatchObject({ kind: "replayed" });
    await expect(repository.completeExecution({ ...input, proof: { ...input.proof!, containerId: "container-2" } })).resolves.toEqual({ kind: "conflict" });
    expect(client.queries.filter(({ text }) => text.startsWith("update"))).toHaveLength(writes);
    expect(client.state.deployment?.executionReceipt?.containerId).toBe("container-1");
  });

  it.each(["command", "deployment"] as const)("returns not-found for missing %s without writes", async (missing) => {
    const { client, repository } = harness();
    client.state[missing] = null;
    const before = structuredClone(client.state);
    await expect(repository.completeExecution(input)).resolves.toEqual({ kind: "not-found" });
    expect(client.state).toEqual(before);
    expect(client.queries.some(({ text }) => text.startsWith("update"))).toBe(false);
  });

  it.each([
    { action: "project.delete" }, { scopeKind: "project" }, { scopeKey: '["project-2","source-1"]' },
    { correlationId: "different-correlation" }, { status: "eligible" }, { result: null }, { scopeKey: "not-json" }
  ])("rejects persisted command-ledger mismatches before writes: %j", async (patch) => {
    const { client, repository } = harness();
    Object.assign(client.state.command!, patch);
    const before = structuredClone(client.state);
    await expect(repository.completeExecution(input)).resolves.toEqual({ kind: "conflict" });
    expect(client.state).toEqual(before);
    expect(client.queries.some(({ text }) => text.startsWith("update"))).toBe(false);
  });

  it.each([
    { snapshotHash: "c".repeat(64) },
    { metadata: { snapshotOriginId: "origin-1", sourceDeploymentId: "wrong-source" } },
    { executionReceipt: input.proof }
  ])("rejects changed execution binding or generic proof bypass: %j", async (patch) => {
    const { client, repository } = harness();
    Object.assign(client.state.deployment!, patch);
    const before = structuredClone(client.state);
    await expect(repository.completeExecution(input)).resolves.toEqual({ kind: "conflict" });
    expect(client.state).toEqual(before);
    expect(client.queries.some(({ text }) => text.startsWith("update"))).toBe(false);
  });

  it.each(["deployment", "command"] as const)("rolls back both rows when the %s CAS returns no row", async (missingWrite) => {
    const { client, repository } = harness();
    client.missingWrite = missingWrite;
    const before = structuredClone(client.state);
    await expect(repository.completeExecution(input)).resolves.toEqual({ kind: "conflict" });
    expect(client.state).toEqual(before);
    expect(client.queries.at(-1)?.text).toBe("rollback");
  });

  it("rolls back the deployment write when command persistence throws", async () => {
    const { client, repository } = harness();
    client.failCommandWrite = true;
    const before = structuredClone(client.state);
    await expect(repository.completeExecution(input)).rejects.toMatchObject({ cause: { message: "injected command write failure" } });
    expect(client.state).toEqual(before);
    expect(client.queries.at(-1)?.text).toBe("rollback");
  });

  it.each(["failed", "canceled"] as const)("completes initial %s execution without command or success proof", async (terminalStatus) => {
    const { client, repository } = harness();
    client.state.command = null;
    client.state.deployment!.metadata = { snapshotOriginId: "origin-1" };
    await expect(repository.completeExecution({ ...input, commandId: null, commandResult: null, sourceExecutionId: null, terminalStatus, proof: null })).resolves.toMatchObject({ kind: "committed", deployment: { status: terminalStatus }, command: null });
    expect(client.state.deployment).toMatchObject({ status: terminalStatus, executionReceipt: null });
    expect(client.queries.some(({ text }) => text.includes('"control_commands"') && (text.endsWith("for update") || text.startsWith("update")))).toBe(false);
  });

  it("clones submitted and returned references and rejects invalid proof before transactions", async () => {
    const { client, repository } = harness();
    const submitted = structuredClone(input);
    const pending = repository.completeExecution(submitted);
    submitted.proof!.containerId = "mutated-input";
    const outcome = await pending;
    if (outcome.kind !== "committed") throw new Error("Expected committed completion");
    outcome.deployment.executionReceipt!.containerId = "mutated-output";
    outcome.command!.result.correlationId = "mutated-result";
    expect(client.state).toMatchObject({ deployment: { executionReceipt: { containerId: "container-1" } }, command: { result: { correlationId: "correlation-1" } } });
    const invalid = harness();
    await expect(invalid.repository.completeExecution({ ...input, proof: { ...input.proof!, containerId: "" } })).rejects.toThrow();
    expect(invalid.client.queries).toEqual([]);
  });
});


describe("cached completion cancellation under the PostgreSQL transaction", () => {
  it.each(["after-lock", "during-command-write"] as const)("rolls back terminal publication when aborted %s", async (at) => {
    const { client, repository } = harness(), before = structuredClone(client.state), controller = new AbortController();
    if (at === "after-lock") client.beforeCommandLock = () => controller.abort(new Error("cache publication canceled"));
    else client.beforeCommandWrite = () => controller.abort(new Error("cache publication canceled"));
    await expect((repository.completeExecution as any)(input, controller.signal)).rejects.toThrow("cache publication canceled"); expect(client.state).toEqual(before); expect(client.queries.at(-1)?.text).toBe("rollback");
  });
});
