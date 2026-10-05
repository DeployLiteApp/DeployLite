import { getTableColumns } from "drizzle-orm";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
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

  // This model records real Drizzle SQL, but is not a PostgreSQL engine or concurrency harness.
  async query(query: string | { text: string }, values: unknown[] = []) {
    const text = typeof query === "string" ? query : query.text;
    this.queries.push({ text, values });
    if (text === "begin") this.before = structuredClone(this.state);
    if (text === "rollback" && this.before) this.state = this.before;
    if (text.startsWith("select")) {
      const command = text.includes('from "control_commands"');
      const row = command ? this.state.command : this.state.deployment;
      const columns = getTableColumns(command ? controlCommands : deployments);
      return { rows: row ? [Object.keys(columns).map((key) => row[key as keyof typeof row])] : [] };
    }
    if (text.startsWith("update")) {
      const command = text.includes('update "control_commands"');
      const row = command ? this.state.command : this.state.deployment;
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

describe("PostgreSQL execution-completion adapter with a recording transaction model", () => {
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
    expect(client.queries.some(({ text }) => text.includes('"control_commands"'))).toBe(false);
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
