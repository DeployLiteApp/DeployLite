import { getTableColumns } from "drizzle-orm";
import type { Pool } from "pg";
import { expect, it } from "vitest";
import { createControlCommand } from "@deploylite/domain";
import { createDbClient } from "../client.js";
import { controlCommands } from "../schema.js";
import { DbControlCommandRepository } from "./control-plane.js";

function fixture() {
  const command = createControlCommand({ actorId: "original-operator", action: "project.update",
    scope: { kind: "project", projectId: "project-a" }, input: { operation: "database.runtime.apply" },
    idempotencyKey: "original-create", correlationId: "original-correlation", expiresAt: new Date(1000) });
  const row: Record<string, unknown> = { id: command.id, actorUserId: command.actorId, action: command.action,
    scopeKind: "project", scopeKey: "project-a", inputDigest: command.inputDigest, idempotencyKey: command.idempotencyKey,
    correlationId: command.correlationId, status: "completed", result: null, executionAuthority: null,
    expiresAt: command.expiresAt, createdAt: new Date(0), updatedAt: new Date(0) };
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const pool = { query: async (query: { text: string }, values: unknown[]) => {
    queries.push({ text: query.text, values });
    const matches = [...query.text.matchAll(/"control_commands"\."(id|action|scope_kind|scope_key)" = \$(\d+)/g)]
      .every(match => row[match[1]!.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())] === values[Number(match[2]) - 1]);
    return { rows: matches ? [Object.keys(getTableColumns(controlCommands)).map(key => row[key])] : [] };
  } };
  return { command, row, queries, repository: new DbControlCommandRepository(createDbClient(pool as unknown as Pool)) };
}

it("reads the original expired project command independently of the current operator without writing", async () => {
  const f = fixture(), before = structuredClone(f.row);
  const result = await f.repository.findProjectUpdateById("project-a", f.command.id);
  expect(result).toMatchObject({ id: f.command.id, actorId: "original-operator", status: "completed", expiresAt: new Date(1000) });
  expect(f.row).toEqual(before);
  expect(f.queries).toHaveLength(1);
  expect(f.queries[0]!.text).toContain('"control_commands"."id"');
  expect(f.queries[0]!.text).toContain('"control_commands"."scope_key"');
  expect(f.queries[0]!.text).not.toContain('"control_commands"."actor_user_id" =');
  expect(f.queries[0]!.text.toLowerCase()).not.toMatch(/insert|update |delete|for update/);
});

it("requires exact project, original command, project scope and update action", async () => {
  for (const variant of ["project", "command", "scope", "action"]) {
    const f = fixture();
    if (variant === "scope") f.row.scopeKind = "platform";
    if (variant === "action") f.row.action = "deployment.stop";
    const result = await f.repository.findProjectUpdateById(variant === "project" ? "other-project" : "project-a", variant === "command" ? "other-command" : f.command.id);
    expect(result).toBeNull();
    expect(f.queries).toHaveLength(1);
    expect(f.queries[0]!.text).toContain('"control_commands"."scope_kind"');
    expect(f.queries[0]!.text).toContain('"control_commands"."action"');
  }
});
