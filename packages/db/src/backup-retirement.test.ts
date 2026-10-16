import {expect, it} from "vitest";
import {PgDialect} from "drizzle-orm/pg-core";
import {planBackupRetention, prepareBackupRetirementConfirmation} from "@deploylite/domain";
import type {DeployLiteDb} from "./client.js";
import {backupInventory, backupRestoreProtections, backupRetirementReservations, controlCommands, controlCommandConfirmations} from "./schema.js";
import {DbBackupRetirementStore} from "./repositories/backup-retirement.js";

function harness() {
  const receipt = {schemaVersion: 1, action: "compose.volume.backup", agentId: "agent-a", commandId: "backup-a", projectId: "project-a", inputDigest: "a".repeat(64), correlationId: "capture-a", volumeKey: "data", destinationId: "local-a", archiveId: "old", status: "created", consistency: "stopped", archiveBytes: 100, entries: 2, archiveSha256: "b".repeat(64), manifestSha256: "c".repeat(64), idempotent: false, redacted: true};
  const snapshot = {schemaVersion: 1, projectId: "project-a", volumeKey: "data", destinationId: "local-a", keepNewest: 1, protectedArchiveIds: [], backups: [{receipt, createdAtMs: 1}, {receipt: {...receipt, archiveId: "new"}, createdAtMs: 2}]};
  const plan = planBackupRetention(snapshot);
  const intent = prepareBackupRetirementConfirmation({snapshot, archiveId: "old", expectedInventoryDigest: plan.inventoryDigest,
    expectedPlanDigest: plan.planDigest, actorId: "operator-a", idempotencyKey: "retire-old", correlationId: "retire-a", now: 1000, commandTtlMs: 1000});
  const command = {...intent.command, actorUserId: intent.command.actorId, scopeKind: "project", scopeKey: "project-a", executionAuthority: null, result: null};
  const nonce = {...intent.confirmation, actorUserId: intent.confirmation.actorId, scopeKind: "project", scopeKey: "project-a"};
  const archive = {...receipt, commandId: receipt.commandId, receipt, createdAt: new Date(1)};
  const reservations: Record<string, unknown>[] = [], protections: Record<string, unknown>[] = [], queries: unknown[][] = [];
  let now = 1000, fail = false;
  let wait = async (_point: string) => {};
  const port = {
    execute: async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {queries.push(new PgDialect().sqlToQuery(query).params); await wait("lock");},
    select() {return {from(table: unknown) {
      const rows = table === controlCommands ? [command] : table === controlCommandConfirmations ? [nonce]
        : table === backupInventory ? [archive] : table === backupRestoreProtections ? protections : reservations;
      const query = {where(sql: Parameters<PgDialect["sqlToQuery"]>[0]) {queries.push(new PgDialect().sqlToQuery(sql).params); return query;},
        limit() {return query;}, for() {return query;}, then(resolve: (rows: unknown[]) => unknown) {return Promise.resolve().then(async () => {await wait("read"); return structuredClone(rows);}).then(resolve);}};
      return query;
    }};},
    insert(table: unknown) {expect(table).toBe(backupRetirementReservations); return {values(value: Record<string, unknown>) {return {onConflictDoNothing() {return {
      returning: async () => {reservations.push(structuredClone(value)); if (fail) throw new Error("private-fixture-error"); return structuredClone(reservations);}
    };}};}};}
  };
  const db = {transaction: async (run: (tx: typeof port) => Promise<unknown>) => {
    const before = structuredClone(reservations); try {return await run(port);} catch (error) {reservations.splice(0, reservations.length, ...before); throw error;}
  }} as unknown as DeployLiteDb;
  return {intent, command, nonce, archive, reservations, protections, queries, expire: () => {now = 3000;}, fault: () => {fail = true;},
    waitAt: (point: string) => {
      let entered!: () => void, release!: () => void;
      const waiting = new Promise<void>(resolve => {entered = resolve;}), resumed = new Promise<void>(resolve => {release = resolve;});
      wait = async where => {if (where === point) {entered(); await resumed;}};
      return {waiting, release};
    },
    store: () => new DbBackupRetirementStore(db, "agent-a", () => now)};
}
it("preserves one P3 preparatory reservation across repository loss, lost reply and expiry without execution", async () => {
  const h = harness(), {binding, command, confirmation} = h.intent;
  expect(h.store().executionAvailable()).toBe(false);
  await expect(h.store().reserve(binding, command, confirmation)).resolves.toMatchObject({reserved: true, executionAllowed: false});
  const before = structuredClone(h.reservations); h.expire();
  await expect(h.store().reserve(binding, command, confirmation)).resolves.toMatchObject({commandId: command.id, executionAllowed: false});
  expect(h.reservations).toEqual(before); expect(h.nonce.consumedAt).toBeNull(); expect(h.command.status).toBe("pending_confirmation");
  expect(h.queries[0]).toEqual(["deploylite:execution:project-a"]);
});
it.each(["protection", "actor", "nonce", "receipt", "expiry", "fault", "conflict"])("denies %s without releasing protections or reserving a second archive", async mode => {
  const h = harness(), {binding, command, confirmation} = h.intent;
  if (mode === "protection") h.protections.push({archiveId: binding.receipt.archiveId});
  if (mode === "actor") h.command.actorUserId = "foreign";
  if (mode === "nonce") h.nonce.id = "foreign";
  if (mode === "receipt") h.archive.receipt.archiveSha256 = "0".repeat(64);
  if (mode === "expiry") h.expire();
  if (mode === "fault") h.fault();
  if (mode === "conflict") {await h.store().reserve(binding, command, confirmation); h.reservations[0]!.commandId = "other-command";}
  const before = structuredClone(h.reservations);
  await expect(h.store().reserve(binding, command, confirmation)).rejects.toThrow("Archive retirement is unavailable.");
  expect(h.reservations).toEqual(before);
});

it.each(["lock", "read"])("rejects NEW reservation after confirmation expires while awaiting %s", async point => {
  const h = harness(), {binding, command, confirmation} = h.intent, gate = h.waitAt(point);
  const before = structuredClone({reservations: h.reservations, protections: h.protections, command: h.command, nonce: h.nonce});
  const attempt = h.store().reserve(binding, command, confirmation);
  await gate.waiting; h.expire(); gate.release();
  await expect(attempt).rejects.toThrow("Archive retirement is unavailable.");
  expect({reservations: h.reservations, protections: h.protections, command: h.command, nonce: h.nonce}).toEqual(before);
});
it.each(["lock", "read"])("observes only the exact ORIGINAL reservation after expiry while awaiting %s", async point => {
  const h = harness(), {binding, command, confirmation} = h.intent;
  await h.store().reserve(binding, command, confirmation);
  const before = structuredClone({reservations: h.reservations, protections: h.protections, command: h.command, nonce: h.nonce});
  const gate = h.waitAt(point), attempt = h.store().reserve(binding, command, confirmation);
  await gate.waiting; h.expire(); gate.release();
  await expect(attempt).resolves.toEqual({reserved: true, executionAllowed: false, commandId: command.id});
  expect({reservations: h.reservations, protections: h.protections, command: h.command, nonce: h.nonce}).toEqual(before);
});
