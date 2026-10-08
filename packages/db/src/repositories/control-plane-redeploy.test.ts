import { getTableColumns } from "drizzle-orm";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createConfirmation, createControlCommand } from "@deploylite/domain";
import { createDbClient } from "../client.js";
import { controlCommands } from "../schema.js";
import { DbControlCommandRepository } from "./control-plane.js";

function fixture(sourceId: string) {
  const command = createControlCommand({ actorId: "actor", action: "deployment.redeploy", scope: { kind: "deployment", projectId: "project", deploymentId: sourceId }, input: { sourceDeploymentId: sourceId }, idempotencyKey: `key-${sourceId}`, correlationId: "correlation" });
  const confirmation = createConfirmation({ command, classification: "destructive" });
  const row: Record<string, unknown> = { id: command.id, actorUserId: command.actorId, action: command.action, scopeKind: "deployment", scopeKey: JSON.stringify(["project", sourceId]), inputDigest: command.inputDigest, idempotencyKey: command.idempotencyKey, correlationId: command.correlationId, status: command.status, result: null, executionAuthority: null, expiresAt: command.expiresAt, createdAt: new Date(), updatedAt: new Date() };
  const writes: Array<Record<string, unknown>> = []; const queries: string[] = [];
  // Real Drizzle SQL and mapped parameters; no PostgreSQL engine or pool connection.
  const client = { query: async (query: string | { text: string }, values: unknown[] = []) => {
    const text = typeof query === "string" ? query : query.text; queries.push(text);
    if (text.startsWith('insert into "deployments"')) {
      const columns = [...text.slice(text.indexOf("(") + 1, text.indexOf(")")).matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
      const expressions = text.split(" values (")[1]!.split(")")[0]!.split(", "); const inserted: Record<string, unknown> = {};
      columns.forEach((column, index) => { const match = /\$(\d+)/.exec(expressions[index] ?? ""); if (match) { const value = values[Number(match[1]) - 1]; inserted[column] = column === "metadata" && typeof value === "string" ? JSON.parse(value) : value; } }); writes.push(inserted);
    }
    if (text.startsWith('update "control_command_confirmations"')) return { rows: [[confirmation.id]] };
    if (text.startsWith('update "control_commands"')) for (const match of (text.split(" set ")[1]?.split(" where ")[0] ?? "").matchAll(/"(\w+)" = \$(\d+)/g)) {
      const key = match[1]!.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()); const value = values[Number(match[2]) - 1]; row[key] = key === "result" && typeof value === "string" ? JSON.parse(value) : value;
    }
    if (text.startsWith("select") || text.startsWith('update "control_commands"')) return { rows: [Object.keys(getTableColumns(controlCommands)).map((key) => row[key])] };
    return { rows: [] };
  } };
  const repository = new DbControlCommandRepository(createDbClient(client as unknown as Pool));
  return { repository, command, confirmation, writes, queries };
}

describe("redeploy admission preserves canonical origin through real Drizzle mapping", () => {
  it.each([["execution-A", "execution-B"], ["execution-B", "execution-C"]])("persists origin A and immediate %s when admitting %s", async (sourceId, id) => {
    const { repository, command, confirmation, writes, queries } = fixture(sourceId);
    const deployment = { id, projectId: "project", agentId: "agent", status: "queued" as const, commitSha: "abcdef1", startedAt: new Date().toISOString(), finishedAt: null, sourceDeploymentId: sourceId, snapshotOriginId: "execution-A", snapshotHash: "a".repeat(64) };
    const result = await repository.executeConfirmedDeploymentRedeploy({ command, confirmation, deployment, requestId: "request", snapshotHash: deployment.snapshotHash! });
    expect(result.accepted).toBe(true); expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ id, snapshot_hash: deployment.snapshotHash, metadata: { sourceDeploymentId: sourceId, snapshotOriginId: "execution-A" } });
    expect(result.result).toMatchObject({ sourceDeploymentId: sourceId, deploymentId: id });
    expect(queries[0]).toBe("begin"); expect(queries.at(-1)).toBe("commit");
  });
});
