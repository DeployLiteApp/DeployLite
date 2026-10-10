import { expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { auditEvents, controlCommands } from "./schema.js";
import type { DeployLiteDb } from "./client.js";
import { DbBackupInventoryStore } from "./repositories/backup-inventory.js";

function fixture() {
  const receipt = {schemaVersion: 1, action: "compose.volume.backup", agentId: "agent-1", commandId: "command-1", projectId: "project-1", inputDigest: "a".repeat(64), correlationId: "correlation-1", volumeKey: "data", destinationId: "local-1", archiveId: "archive-1", status: "created", consistency: "stopped", archiveBytes: 100, entries: 2, archiveSha256: "b".repeat(64), manifestSha256: "c".repeat(64), idempotent: false, redacted: true};
  const command = {id: receipt.commandId, actorUserId: "actor-1", action: "project.update", scopeKind: "project", scopeKey: receipt.projectId, status: "completed", inputDigest: receipt.inputDigest, correlationId: receipt.correlationId};
  const metadata = Object.fromEntries(["projectId", "commandId", "inputDigest", "volumeKey", "destinationId", "archiveId", "archiveBytes", "entries", "archiveSha256", "manifestSha256", "consistency", "status"].map(key => [key, receipt[key as keyof typeof receipt]]));
  const audit = {id: "audit-1", action: "compose.volume.backup.executed", actorUserId: "actor-1", targetType: "project", targetId: receipt.projectId, correlationId: receipt.correlationId, createdAt: new Date(1000), metadata};
  return {receipt, command, audit};
}
function harness(f = fixture()) {
  let saved: Record<string, unknown> | undefined;
  let inserts = 0;
  const filters: unknown[][] = [];
  const queries = {
    select() { return {from(table: unknown) {
      const rows = table === controlCommands ? [f.command] : table === auditEvents ? [f.audit] : saved ? [saved] : [];
      const query = {
        where(condition: Parameters<PgDialect["sqlToQuery"]>[0]) { filters.push(new PgDialect().sqlToQuery(condition).params); return query; },
        limit() { return query; }, for() { return query; }, orderBy() { return query; },
        then(resolve: (rows: unknown[]) => unknown) { return Promise.resolve(rows).then(resolve); }
      };
      return query;
    }}; },
    insert() { return {values(value: Record<string, unknown>) { inserts++; return {onConflictDoNothing() { return {returning: async () => {
      if (saved) return [];
      saved = structuredClone(value);
      return [saved];
    }}; }}; }}; }
  };
  const db = {...queries, transaction: async (run: (tx: typeof queries) => Promise<unknown>) => run(queries)} as unknown as DeployLiteDb;
  return {store: () => new DbBackupInventoryStore(db, "agent-1", () => 2000), saved: () => saved, inserts: () => inserts, filters, f};
}
it("persists corroborated evidence and reads it after constructing a fresh repository", async () => {
  const h = harness();
  expect(await h.store().recordAuthenticatedReceipt(h.f.receipt)).toMatchObject({createdAtMs: 1000, receipt: h.f.receipt});
  expect(await h.store().list("project-1", "data", "local-1")).toEqual([{schemaVersion: 1, receipt: h.f.receipt, createdAtMs: 1000}]);
  expect(h.filters.at(-1)).toEqual(["project-1", "data", "local-1"]);
});
it("reuses original audit creation time and canonical proof on authenticated cache replay", async () => {
  const h = harness();
  const first = await h.store().recordAuthenticatedReceipt(h.f.receipt);
  const second = await h.store().recordAuthenticatedReceipt({...h.f.receipt, status: "already-created", idempotent: true});
  expect(second).toEqual(first);
  expect(h.saved()).toMatchObject({receipt: h.f.receipt, createdAt: new Date(1000)});
});
it.each(["status", "scopeKey", "inputDigest", "actorUserId"])("rejects foreign durable command %s before inserting", async field => {
  const h = harness(); Object.assign(h.f.command, {[field]: "foreign"});
  await expect(h.store().recordAuthenticatedReceipt(h.f.receipt)).rejects.toThrow("cannot be accepted safely");
  expect(h.inserts()).toBe(0);
});
it("rejects foreign authenticated agent and unexpected receipt secrets before DB writes", async () => {
  const h = harness();
  await expect(h.store().recordAuthenticatedReceipt({...h.f.receipt, agentId: "foreign"})).rejects.toThrow("cannot be accepted safely");
  await expect(h.store().recordAuthenticatedReceipt({...h.f.receipt, password: "sentinel"})).rejects.toThrow("cannot be accepted safely");
  expect(h.inserts()).toBe(0);
});
it("rejects an archive collision without replacing the original proof", async () => {
  const h = harness(); await h.store().recordAuthenticatedReceipt(h.f.receipt);
  h.f.receipt.archiveSha256 = "d".repeat(64); h.f.audit.metadata.archiveSha256 = h.f.receipt.archiveSha256;
  await expect(h.store().recordAuthenticatedReceipt(h.f.receipt)).rejects.toThrow("cannot be accepted safely");
  expect(h.saved()).toMatchObject({receipt: {archiveSha256: "b".repeat(64)}});
});
it("rejects corrupted stored receipt scope before returning an inventory", async () => {
  const h = harness(); await h.store().recordAuthenticatedReceipt(h.f.receipt);
  Object.assign(h.saved()!.receipt as object, {projectId: "foreign"});
  await expect(h.store().list("project-1", "data", "local-1")).rejects.toThrow("cannot be accepted safely");
});
