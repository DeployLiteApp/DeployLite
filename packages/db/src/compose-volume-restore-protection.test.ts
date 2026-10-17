import {expect, it} from "vitest";
import {PgDialect} from "drizzle-orm/pg-core";
import {prepareComposeVolumeRestoreSourceConfirmation, prepareBackupRetirementConfirmation, planBackupRetention} from "@deploylite/domain";
import type {DeployLiteDb} from "./client.js";
import {auditEvents, backupInventory, composeVolumeRestoreProtections, backupRetirementReservations, backupRestoreProtections, controlCommands, controlCommandConfirmations} from "./schema.js";
import {DbComposeVolumeRestoreProtectionStore} from "./repositories/compose-volume-restore-protection.js";
import {DbBackupRetirementStore} from "./repositories/backup-retirement.js";

type Row = Record<string, any>;
function harness() {
  const receipt = {schemaVersion: 1, action: "compose.volume.backup", agentId: "agent-a", commandId: "backup-a", projectId: "project-a", inputDigest: "a".repeat(64), correlationId: "capture-a", volumeKey: "data", destinationId: "local-a", archiveId: "old", status: "created", consistency: "stopped", archiveBytes: 100, entries: 2, archiveSha256: "b".repeat(64), manifestSha256: "c".repeat(64), idempotent: false, redacted: true};
  const source = {schemaVersion: 1, receipt, createdAtMs: 100};
  const intent = prepareComposeVolumeRestoreSourceConfirmation({source, projectId: receipt.projectId, expectedAgentId: receipt.agentId,
    volumeKey: receipt.volumeKey, destinationId: receipt.destinationId, archiveId: receipt.archiveId, backupCommandId: receipt.commandId,
    expectedArchiveSha256: receipt.archiveSha256, expectedManifestSha256: receipt.manifestSha256,
    actorId: "operator-a", idempotencyKey: "restore-a", correlationId: "restore-a", now: 1000, commandTtlMs: 1000});
  const commands: Row[] = [], nonces: Row[] = [], protections: Row[] = [], reservations: Row[] = [], queries: unknown[][] = [];
  function remember(value: Pick<typeof intent, "command" | "confirmation">) {
    const command: Row = {...value.command, actorUserId: value.command.actorId, scopeKind: "project", scopeKey: "project-a", executionAuthority: null, result: null};
    const nonce: Row = {...value.confirmation, actorUserId: value.confirmation.actorId, scopeKind: "project", scopeKey: "project-a"};
    commands.push(command); nonces.push(nonce); return {command, nonce};
  }
  const original = remember(intent);
  const backup: Row = {id: receipt.commandId, actorUserId: "backup-operator", action: "project.update", scopeKind: "project", scopeKey: receipt.projectId, status: "completed", inputDigest: receipt.inputDigest, correlationId: receipt.correlationId};
  commands.push(backup);
  const audit: Row = {id: "audit-a", action: "compose.volume.backup.executed", actorUserId: backup.actorUserId, targetType: "project", targetId: receipt.projectId, correlationId: receipt.correlationId, createdAt: new Date(100), metadata: {...receipt}};
  const archive: Row = {projectId: receipt.projectId, volumeKey: receipt.volumeKey, destinationId: receipt.destinationId, archiveId: receipt.archiveId, commandId: receipt.commandId, auditId: audit.id, receipt, createdAt: new Date(100)};
  let now = 1000, fail = false, badReply = false, omitAudit = false, wait = async (_point: string) => {};
  const port = {
    async execute(query: Parameters<PgDialect["sqlToQuery"]>[0]) {queries.push(new PgDialect().sqlToQuery(query).params); await wait("lock");},
    select() {return {from(table: unknown) {
      let params: unknown[] = [], maximum = Infinity;
      const query = {where(condition: Parameters<PgDialect["sqlToQuery"]>[0]) {params = new PgDialect().sqlToQuery(condition).params; queries.push(params); return query;},
        limit(value: number) {maximum = value; return query;}, for() {return query;}, orderBy() {return query;},
        then(resolve: (rows: Row[]) => unknown) {return Promise.resolve().then(async () => {
          await wait(table === backupInventory ? "inventory" : "read");
          const scoped = (row: Row) => [row.projectId, row.volumeKey, row.destinationId, row.archiveId].slice(0, params.length).every((value, index) => value === params[index]);
          const rows = table === controlCommands ? commands.filter(row => row.id === params[0])
            : table === controlCommandConfirmations ? nonces.filter(row => row.commandId === params[0])
            : table === auditEvents ? omitAudit ? [] : [audit].filter(row => row.id === params[0])
            : table === backupInventory ? [archive].filter(scoped)
            : table === backupRestoreProtections ? []
            : table === backupRetirementReservations ? reservations.filter(scoped)
            : protections.filter(row => params.length === 1 ? row.restoreCommandId === params[0] : scoped(row));
          return structuredClone(rows.slice(0, maximum));
        }).then(resolve);}}; return query;
    }};},
    insert(table: unknown) {return {values(value: Row) {return {onConflictDoNothing() {return {returning: async () => {
      const target = table === composeVolumeRestoreProtections ? protections : reservations;
      if (target.some(row => (row.restoreCommandId ?? row.commandId) === (value.restoreCommandId ?? value.commandId))) return [];
      if (target.some(row => row.confirmationId === value.confirmationId)) throw new Error("unique original nonce");
      target.push(structuredClone(value)); if (fail) throw new Error("private-fixture-fault"); return [{...structuredClone(value), createdAt: badReply ? new Date(3000) : value.createdAt}];
    }};}};}};}
  };
  // Injected single-project transaction serialization, NOT physical PostgreSQL lock proof.
  let queue = Promise.resolve();
  const db = {transaction: (run: (tx: typeof port) => Promise<unknown>) => {
    const result = queue.then(async () => {const before = structuredClone({protections, reservations});
      try {return await run(port);} catch (error) {protections.splice(0, protections.length, ...before.protections); reservations.splice(0, reservations.length, ...before.reservations); throw error;}});
    queue = result.then(() => {}, () => {}); return result;
  }} as unknown as DeployLiteDb;
  return {intent, ...original, commands, nonces, backup, audit, archive, receipt, protections, reservations, queries, remember,
    store: (agent = "agent-a") => new DbComposeVolumeRestoreProtectionStore(db, agent, () => now),
    retirement: () => new DbBackupRetirementStore(db, "agent-a", () => now),
    setTime: (value: number) => {now = value;}, fault: () => {fail = true;}, corruptReply: () => {badReply = true;}, omitAudit: () => {omitAudit = true;},
    waitAt(point: string) {let entered!: () => void, release!: () => void;
      const waiting = new Promise<void>(resolve => {entered = resolve;}), resumed = new Promise<void>(resolve => {release = resolve;});
      wait = async where => {if (where === point) {entered(); await resumed;}}; return {waiting, release};}
  };
}
const error = "P3 restore archive protection is unavailable.";
const protect = (h: ReturnType<typeof harness>) => h.store().protect(h.intent.binding, h.intent.command, h.intent.confirmation);
const list = (h: ReturnType<typeof harness>) => h.store().list("project-a", "data", "local-a");
it("corroborates one original intent and converges concurrent duplicates/repository recreation without renewal", async () => {
  const h = harness(); expect(h.store().executionAvailable()).toBe(false);
  await expect(Promise.all([protect(h), protect(h)])).resolves.toEqual([undefined, undefined]);
  expect(h.protections).toHaveLength(1); const before = structuredClone(h.protections); h.setTime(3000);
  await expect(protect(h)).resolves.toBeUndefined(); expect(await list(h)).toEqual(["old"]);
  expect(h.protections).toEqual(before); expect(h.nonce.consumedAt).toBeNull(); expect(h.command.status).toBe("pending_confirmation");
  expect(h.queries.filter(params => String(params[0]).startsWith("deploylite:execution:"))).toEqual(Array(4).fill(["deploylite:execution:project-a"]));
});
it.each(["actor", "digest", "scope", "correlation", "idempotency", "status", "authority", "result", "expiry", "nonce", "nonceActor", "nonceDigest", "nonceScope", "nonceClass", "nonceExpiry", "consumed", "duplicateNonce", "inventoryHash", "inventoryTime", "inventoryExtra", "backupStatus", "backupScope", "backupDigest", "backupActor", "backupCorrelation", "backupMissing", "auditActor", "auditHash", "auditTarget", "auditAction", "auditMissing"])("rejects %s durable proof without writes or consumption", async mode => {
  const h = harness();
  const commandFields: Record<string, string> = {actor: "actorUserId", digest: "inputDigest", scope: "scopeKey", correlation: "correlationId", idempotency: "idempotencyKey", status: "status"};
  if (mode in commandFields) Object.assign(h.command, {[commandFields[mode]!]: "foreign"});
  if (mode === "authority") h.command.executionAuthority = {}; if (mode === "result") h.command.result = {};
  if (mode === "expiry") h.command.expiresAt = new Date(2001);
  const nonceFields: Record<string, string> = {nonce: "id", nonceActor: "actorUserId", nonceDigest: "inputDigest", nonceScope: "scopeKey", nonceClass: "classification"};
  if (mode in nonceFields) Object.assign(h.nonce, {[nonceFields[mode]!]: "foreign"});
  if (mode === "nonceExpiry") h.nonce.expiresAt = new Date(2001); if (mode === "consumed") h.nonce.consumedAt = new Date(1000);
  if (mode === "duplicateNonce") h.nonces.push(structuredClone(h.nonce));
  if (mode === "inventoryHash") h.archive.receipt.archiveSha256 = "0".repeat(64);
  if (mode === "inventoryTime") h.archive.createdAt = new Date(101); if (mode === "inventoryExtra") h.archive.receipt.privatePath = "sentinel";
  if (mode === "backupMissing") h.commands.splice(h.commands.indexOf(h.backup), 1);
  if (mode.startsWith("backup") && mode !== "backupMissing") Object.assign(h.backup, {[{backupStatus: "status", backupScope: "scopeKey", backupDigest: "inputDigest", backupActor: "actorUserId", backupCorrelation: "correlationId"}[mode]!]: "foreign"});
  if (mode === "auditTarget") h.audit.targetId = "foreign"; if (mode === "auditAction") h.audit.action = "foreign";
  if (mode === "auditActor") h.audit.actorUserId = "foreign"; if (mode === "auditHash") h.audit.metadata.archiveSha256 = "0".repeat(64); if (mode === "auditMissing") h.omitAudit();
  const before = structuredClone({protections: h.protections, command: h.command, nonce: h.nonce});
  await expect(protect(h)).rejects.toThrow(error); expect({protections: h.protections, command: h.command, nonce: h.nonce}).toEqual(before);
});
it("rejects foreign agent, native substitution, private fields and a fresh unpersisted retry identity", async () => {
  const h = harness(); await expect(h.store("foreign").protect(h.intent.binding, h.intent.command, h.intent.confirmation)).rejects.toThrow(error);
  for (const binding of [{...h.intent.binding, privatePath: "sentinel"}, {...h.intent.binding, source: {...h.intent.binding.source, receipt: {...h.receipt, action: "database.runtime.backup"}}}])
    await expect(h.store().protect(binding, h.intent.command, h.intent.confirmation)).rejects.toThrow(error);
  await expect(h.store().protect(h.intent.binding, {...h.intent.command, id: "fresh-unpersisted"}, {...h.intent.confirmation, commandId: "fresh-unpersisted"})).rejects.toThrow(error);
  expect(h.protections).toEqual([]);
});
it.each(["lock", "inventory"])("checks current authority after awaiting %s; original observation remains read-only", async point => {
  for (const original of [false, true]) {const h = harness(); if (original) await protect(h); const before = structuredClone(h.protections);
    const gate = h.waitAt(point), attempt = protect(h); expect(await Promise.race([gate.waiting.then(() => true), attempt.then(() => false, () => false)])).toBe(true); h.setTime(3000); gate.release();
    if (original) await expect(attempt).resolves.toBeUndefined(); else await expect(attempt).rejects.toThrow(error);
    expect(h.protections).toEqual(before);
  }
});
it.each([-1, NaN, 999])("rejects invalid/regressed current clock %s", async value => {
  const h = harness(), gate = h.waitAt("inventory"), attempt = protect(h); expect(await Promise.race([gate.waiting.then(() => true), attempt.then(() => false, () => false)])).toBe(true); h.setTime(value); gate.release();
  await expect(attempt).rejects.toThrow(error); expect(h.protections).toEqual([]);
});
it("retains consumed original protection; lists distinct archives and fails closed on corruption/overflow", async () => {
  const h = harness(); await protect(h); h.command.status = "dispatching"; h.nonce.consumedAt = new Date(1100); h.setTime(3000);
  expect(await list(h)).toEqual(["old"]); const original = structuredClone(h.protections[0]!);
  h.protections[0]!.archiveSha256 = "0".repeat(64); await expect(list(h)).rejects.toThrow(error);
  h.protections.splice(0, h.protections.length, ...Array.from({length: 10001}, () => structuredClone(original)));
  await expect(list(h)).rejects.toThrow(error);
});
it("rolls back uncertain insertion and refuses conflicting original rows without overwrite", async () => {
  const failed = harness(); failed.fault(); await expect(protect(failed)).rejects.toThrow(error); expect(failed.protections).toEqual([]);
  const h = harness(); await protect(h); h.protections[0]!.inputDigest = "0".repeat(64); const before = structuredClone(h.protections);
  await expect(protect(h)).rejects.toThrow(error); expect(h.protections).toEqual(before);
});
it.each([true, false])("arbitrates P3 protection-first=%s and retirement-first under the same injected project lock", async first => {
  const h = harness(), snapshot = {schemaVersion: 1, projectId: "project-a", volumeKey: "data", destinationId: "local-a", keepNewest: 1, protectedArchiveIds: [], backups: [{receipt: h.receipt, createdAtMs: 100}, {receipt: {...h.receipt, archiveId: "new"}, createdAtMs: 101}]};
  const plan = planBackupRetention(snapshot), retirement = prepareBackupRetirementConfirmation({snapshot, archiveId: "old", expectedInventoryDigest: plan.inventoryDigest, expectedPlanDigest: plan.planDigest, actorId: "operator-a", idempotencyKey: "retire-a", correlationId: "retire-a", now: 1000, commandTtlMs: 1000});
  h.remember(retirement); const reserve = () => h.retirement().reserve(retirement.binding, retirement.command, retirement.confirmation);
  if (first) {await protect(h); await expect(reserve()).rejects.toThrow("Archive retirement is unavailable."); expect(h.reservations).toEqual([]);}
  else {await reserve(); await expect(protect(h)).rejects.toThrow(error); expect(h.protections).toEqual([]);}
  expect(h.nonce.consumedAt).toBeNull(); expect(h.command.status).toBe("pending_confirmation");
  expect(h.queries.filter(params => String(params[0]).startsWith("deploylite:execution:"))).toEqual(Array(2).fill(["deploylite:execution:project-a"]));
});

it("keeps distinct original restore intents for one archive and deduplicates its protection view", async () => {
  const h = harness(); await protect(h);
  const second = {command: {...h.intent.command, id: "other-intent", idempotencyKey: "restore-b", correlationId: "restore-b"},
    confirmation: {...h.intent.confirmation, id: "nonce-b", commandId: "other-intent"}};
  h.remember(second); await h.store().protect(h.intent.binding, second.command, second.confirmation);
  expect(h.protections).toHaveLength(2); expect(await list(h)).toEqual(["old"]);
});

it("rejects a changed insertion timestamp rather than accepting a non-exact write readback", async () => {
  const h = harness(); h.corruptReply(); await expect(protect(h)).rejects.toThrow(error); expect(h.protections).toEqual([]);
});
it("rejects reuse of another original intent's unique nonce without overwriting protection", async () => {
  const h = harness(); await protect(h); const before = structuredClone(h.protections);
  const second = {command: {...h.intent.command, id: "other-intent", idempotencyKey: "restore-b"},
    confirmation: {...h.intent.confirmation, commandId: "other-intent"}};
  h.remember(second); await expect(h.store().protect(h.intent.binding, second.command, second.confirmation)).rejects.toThrow(error);
  expect(h.protections).toEqual(before);
});
