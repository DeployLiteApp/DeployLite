import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createComposePreview, prepareComposeRevisionSave } from "@deploylite/domain";
import { createDbClient } from "../client.js";
import * as schema from "../schema.js";
import { DbComposeRevisionSaveStore } from "./compose-revision-save.js";
const projectId = "574c9a70-2b49-4f89-b9d3-90f41060a9c0", actorId = "e9f4a088-3e3c-4c59-bf86-6d782cf80b9f";
const document = JSON.stringify({ services: { web: { image: `registry.example.com/app@sha256:${"a".repeat(64)}` } } });
const policy = { policyVersion: "db-compose-fixture", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true };
const input = () => prepareComposeRevisionSave({ document, projectId, actorId, composeId: null, expectedRevisionId: null, expectedPreviewDigest: createComposePreview(document, projectId, policy).configDigest, idempotencyKey: "db-save-key", correlationId: "db-correlation", requestId: "db-request", now: new Date() }, policy);
type Row = Record<string, unknown>;
function fixture(injectFault?: (stage: string) => void) {
  let tables: Record<string, Map<string, Row>> = Object.fromEntries(["control_commands", "compose_resources", "compose_revisions", "audit_events", "control_command_audits"].map((name) => [name, new Map()]));
  let snapshot: typeof tables | null = null; const queries: string[] = [];
  const exports: Record<string, string> = { control_commands: "controlCommands", compose_resources: "composeResources", compose_revisions: "composeRevisions", audit_events: "auditEvents", control_command_audits: "controlCommandAudits" };
  const camel = (key: string) => key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
  const client = { query: async (query: string | { text: string; rowMode?: string }, values: unknown[] = []) => {
    const text = typeof query === "string" ? query : query.text; queries.push(text);
    if (text === "begin") { snapshot = structuredClone(tables); return { rows: [] }; }
    if (text === "rollback") { tables = snapshot!; snapshot = null; return { rows: [] }; }
    if (text === "commit") { snapshot = null; return { rows: [] }; }
    const name = /(?:from|into|update) "(\w+)"/.exec(text)?.[1]; if (!name || !tables[name]) return { rows: [] };
    const table = tables[name]!; let rows: Row[] = [];
    if (text.startsWith("insert")) {
      const columns = [...text.slice(text.indexOf("(") + 1, text.indexOf(")")).matchAll(/"(\w+)"/g)].map((match) => camel(match[1]!));
      const expressions = text.split(" values (")[1]!.split(")")[0]!.split(", "); const row: Row = { id: randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), result: null, executionAuthority: null };
      columns.forEach((column, i) => { const match = /\$(\d+)/.exec(expressions[i] ?? ""); if (match) { let value = values[Number(match[1]) - 1]; if (["preview", "metadata", "result"].includes(column) && typeof value === "string") value = JSON.parse(value); row[column] = value; } });
      const exists = table.has(String(row.id)) || name === "control_commands" && [...table.values()].some((stored) => ["actorUserId", "action", "scopeKey", "idempotencyKey"].every((key) => stored[key] === row[key]));
      if (!exists) { table.set(String(row.id), row); rows = [row]; }
    } else if (text.startsWith("update")) {
      const idParameter = /"id" = \$(\d+)/.exec(text); const row = idParameter ? table.get(String(values[Number(idParameter[1]) - 1])) : undefined;
      if (row) { for (const match of (text.split(" set ")[1]?.split(" where ")[0] ?? "").matchAll(/"(\w+)" = \$(\d+)/g)) { const key = camel(match[1]!); let value = values[Number(match[2]) - 1]; if (key === "result" && typeof value === "string") value = JSON.parse(value); row[key] = value; } rows = [row]; }
    } else if (text.startsWith("select")) {
      rows = [...table.values()];
      if (name === "control_commands") rows = rows.filter((row) => row.actorUserId === values[0] && row.action === values[1] && row.scopeKey === values[2] && row.idempotencyKey === values[3]);
      if (name === "compose_resources") rows = rows.filter((row) => text.includes('"project_id" =') ? row.projectId === values[0] : row.id === values[0]);
      if (name === "compose_revisions") rows = rows.filter((row) => row.projectId === values[0] && (text.includes('"compose_id" =') ? row.composeId === values[1] : row.id === values[1])).sort((a, b) => Number(b.number) - Number(a.number));
      if (text.includes("limit")) rows = rows.slice(0, Number(values.at(-1)));
    }
    if (!text.includes("returning") && !text.startsWith("select")) return { rows: [] };
    const columns = Object.keys(getTableColumns(Reflect.get(schema, exports[name]!) as PgTable));
    return { rows: typeof query !== "string" && query.rowMode === "array" ? rows.map((row) => columns.map((key) => row[key])) : rows };
  } };
  return { store: new DbComposeRevisionSaveStore(createDbClient(client as unknown as Pool), injectFault ? { injectFault } : undefined), queries, table: (name: string) => tables[name]! };
}
describe("Compose durable adapter through real Drizzle SQL without a local engine", () => {
  it("defines project/resource ownership and immutable revision-number uniqueness without another command ledger", () => {
    const resource = schema.composeResources, revision = schema.composeRevisions;
    expect(resource).toBeDefined(); expect(revision).toBeDefined();
    expect(getTableConfig(revision).foreignKeys.map((fk) => fk.reference().columns.map((column) => column.name))).toContainEqual(["compose_id", "project_id"]);
    expect(getTableConfig(revision).indexes.some((index) => index.config.unique && index.config.columns.map((column) => "name" in column ? column.name : "").join() === "compose_id,number")).toBe(true);
    const migration = readFileSync(new URL("../../migrations/0019_compose_resources_revisions.sql", import.meta.url), "utf8"); expect(migration).not.toMatch(/DROP TABLE|TRUNCATE|DELETE FROM|RENAME/i);
    expect(migration).toContain("REFERENCES control_commands(id)");
  });
  it("commits resource/revision/shared command and both audit projections in one real SQL transaction", async () => {
    const f = fixture(), prepared = input(), result = await f.store.save(prepared); expect(result).toMatchObject({ commandId: prepared.command.id, idempotent: false, revision: { projectId, number: 1 } });
    expect(f.queries[0]).toBe("begin"); expect(f.queries.at(-1)).toBe("commit"); expect(f.queries.some((query) => query.includes("pg_advisory_xact_lock"))).toBe(true);
    for (const name of ["compose_resources", "compose_revisions", "control_commands", "audit_events", "control_command_audits"]) expect(f.table(name).size).toBe(1);
    expect([...f.table("control_commands").values()][0]).toMatchObject({ status: "completed", result: { operation: "compose.revision.save" } });
  });
  it("replays the original row/command without another resource/revision/audit insert", async () => { const f = fixture(), first = await f.store.save(input()), replay = await f.store.save(input()); expect(replay).toEqual({ ...first, idempotent: true }); for (const name of ["compose_resources", "compose_revisions", "control_commands", "audit_events", "control_command_audits"]) expect(f.table(name).size).toBe(1); });
  it.each(["revision-inserted", "command-completed", "audit-recorded"])("rolls back all staged rows if %s fails", async (stage) => {
    const f = fixture((observed) => { if (observed === stage) throw new Error("fixture_literal_secret"); }); await expect(f.store.save(input())).rejects.toThrow();
    expect(f.queries.at(-1)).toBe("rollback"); for (const name of ["compose_resources", "compose_revisions", "control_commands", "audit_events", "control_command_audits"]) expect(f.table(name).size).toBe(0);
  });
  it("refuses invalid command binding before transaction or pool interaction", async () => { const f = fixture(), prepared = input(); prepared.command.inputDigest = "b".repeat(64); await expect(f.store.save(prepared)).rejects.toThrow(); expect(f.queries).toHaveLength(0); });
});
