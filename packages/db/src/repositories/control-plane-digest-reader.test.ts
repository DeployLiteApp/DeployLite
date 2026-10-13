import { getTableColumns } from "drizzle-orm";
import type { Pool } from "pg";
import { expect, it } from "vitest";
import { createControlCommand } from "@deploylite/domain";
import { createDbClient } from "../client.js";
import { controlCommands } from "../schema.js";
import { DbControlCommandRepository } from "./control-plane.js";
function fixture() {
  const command = createControlCommand({actorId: "original-operator", action: "project.update", scope: {kind: "project", projectId: "project-a"},
    input: {operation: "database.runtime.apply"}, idempotencyKey: "original-create", correlationId: "original-correlation", expiresAt: new Date(1000)});
  const row: Record<string, unknown> = {id: command.id, actorUserId: command.actorId, action: command.action, scopeKind: "project", scopeKey: "project-a",
    inputDigest: command.inputDigest, idempotencyKey: command.idempotencyKey, correlationId: command.correlationId, status: "completed", result: null,
    executionAuthority: null, expiresAt: command.expiresAt, createdAt: new Date(0), updatedAt: new Date(0)};
  const queries: Array<{text: string; values: unknown[]}> = [];
  const pool = {query: async (query: {text: string}, values: unknown[]) => {
    queries.push({text: query.text, values});
    const matches = [...query.text.matchAll(/"control_commands"\."(action|scope_kind|scope_key|input_digest|status)" = \$(\d+)/g)]
      .every(match => row[match[1]!.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())] === values[Number(match[2]) - 1]);
    return {rows: matches ? [Object.keys(getTableColumns(controlCommands)).map(key => row[key])] : []};
  }};
  return {command, row, queries, repository: new DbControlCommandRepository(createDbClient(pool as unknown as Pool))};
}
it("finds all original completed digest-bound project commands without actor or expiry restrictions or writes", async () => {
  const f = fixture(), before = structuredClone(f.row);
  expect(await f.repository.findProjectUpdatesByInputDigest("project-a", f.command.inputDigest)).toMatchObject([{id: f.command.id, actorId: "original-operator", status: "completed", expiresAt: new Date(1000)}]);
  expect(f.row).toEqual(before); expect(f.queries).toHaveLength(1);
  const sql = f.queries[0]!.text;
  expect(sql).toContain('"control_commands"."input_digest"');
  expect(sql).toContain('order by "control_commands"."created_at" asc, "control_commands"."id" asc');
  expect(sql).not.toContain('"control_commands"."actor_user_id" =');
  expect(sql.toLowerCase()).not.toMatch(/insert|update |delete|for update|limit|expires_at" [<>=]/);
});
it("requires exact project, digest, project scope, update action and completed status", async () => {
  for (const patch of [{scopeKey: "foreign"}, {scopeKind: "platform"}, {action: "deployment.stop"}, {status: "dispatching"}, {inputDigest: "0".repeat(64)}]) {
    const f = fixture(); Object.assign(f.row, patch);
    expect(await f.repository.findProjectUpdatesByInputDigest("project-a", f.command.inputDigest)).toEqual([]);
  }
});
it("rejects invalid project or digest before any private query", async () => {
  for (const [projectId, digest] of [["", "a".repeat(64)], ["../foreign", "a".repeat(64)], ["project-a", "A".repeat(64)], ["project-a", "bad"]]) {
    const f = fixture();
    await expect(f.repository.findProjectUpdatesByInputDigest(projectId!, digest!)).rejects.toThrow("Database original history is unavailable.");
    expect(f.queries).toHaveLength(0);
  }
});
