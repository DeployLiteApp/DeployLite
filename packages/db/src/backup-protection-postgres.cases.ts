import {createHash, randomUUID} from "node:crypto";
import type pg from "pg";
import {sql} from "drizzle-orm";
import {expect, it} from "vitest";
import {managedDatabaseRuntimeReceiptSchema, managedDatabaseBackupReceiptSchema} from "@deploylite/contracts";
import {composeRuntimeResourceName, managedDatabaseRuntimeExecutionDigest, managedDatabaseBackupExecutionDigest, managedDatabaseBackupSourceDigest,
  nativeBackupInventoryAuditMetadata, prepareManagedDatabaseRestoreConfirmation, prepareComposeVolumeRestoreSourceConfirmation,
  prepareBackupRetirementConfirmation, planBackupRetention, type BackupInventoryRecord} from "@deploylite/domain";
import {createDbClient, createDbPool, type DeployLiteDb} from "./client.js";
import {trackPostgresFixtureShutdown} from "./postgres-fixture-shutdown.js";
import {DbControlCommandRepository} from "./repositories/control-plane.js";
import {DbBackupInventoryStore} from "./repositories/backup-inventory.js";
import {DbBackupRestoreProtectionStore} from "./repositories/backup-restore-protection.js";
import {DbComposeVolumeRestoreProtectionStore} from "./repositories/compose-volume-restore-protection.js";
import {DbAgentReplayStore} from "./repositories/agent-replay.js";
import {DbBackupRetirementStore} from "./repositories/backup-retirement.js";

const lanes = ["native", "p3"] as const;
type Lane = typeof lanes[number];
function ownedPool(url: string, label: string) {
  const name = `p5_protection_${label}_${randomUUID()}`, pool = createDbPool(url, {max: 1, application_name: name, statement_timeout: 15000});
  return {pool, name, close: trackPostgresFixtureShutdown(pool)};
}
function latch() {let release!: () => void; const promise = new Promise<void>(resolve => {release = resolve;}); return {promise, release};}
async function until<T>(probe: () => T | undefined | Promise<T | undefined>, deadline = Date.now() + 10000): Promise<T> {
  while (Date.now() < deadline) {const value = await probe(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5));}
  throw new Error("Owned PostgreSQL acceptance predicate was not observed.");
}
function numericDates(value: unknown): unknown {
  if (value instanceof Date) return value.getTime();
  if (Array.isArray(value)) return value.map(numericDates);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, numericDates(child)]));
  return value;
}
async function snapshotOriginals(pool: pg.Pool, projectId: string) {
  const rows: Record<string, unknown> = {};
  for (const [table, column] of [["control_commands", "scope_key"], ["control_command_confirmations", "scope_key"], ["backup_inventory", "project_id"], ["audit_events", "target_id"]])
    rows[table!] = numericDates((await pool.query(`SELECT * FROM ${table} WHERE ${column}=$1 ORDER BY to_jsonb(${table})::text`, [projectId])).rows);
  return rows;
}
export function nativeMetadata(projectId: string) {
  const base = {schemaVersion: 1 as const, projectId, databaseId: "orders", engine: "postgres" as const, profileId: "profile1", planDigest: "a".repeat(64), environmentFingerprint: "b".repeat(32)};
  const {profileId: _profile, ...runtime} = base;
  const original = managedDatabaseRuntimeReceiptSchema.parse({...runtime, action: "database.runtime", agentId: "agent1", commandId: randomUUID(), inputDigest: managedDatabaseRuntimeExecutionDigest(base), correlationId: randomUUID(),
    containerId: "c".repeat(64), imageId: "sha256:" + "d".repeat(64), volumeName: composeRuntimeResourceName(projectId, "volume", "db-orders"), networkName: composeRuntimeResourceName(projectId, "network", "db-orders"), networkId: "e".repeat(64), volumeCreatedAt: "2026-10-10T00:00:00Z", observedAt: 500, status: "ready", storage: "verified", health: "passed", idempotent: false, redacted: true});
  const source = {...base, originalReceipt: original, originalReplayFingerprint: "f".repeat(64)}, capture = {...source, destinationId: "destination1", maxBytes: 1048576};
  const {status: _status, health: _health, inputDigest: _digest, correlationId: _correlation, ...physical} = original;
  const receipt = managedDatabaseBackupReceiptSchema.parse({...physical, profileId: base.profileId, action: "database.runtime.backup", commandId: randomUUID(), originalCommandId: original.commandId,
    inputDigest: managedDatabaseBackupExecutionDigest(capture), correlationId: randomUUID(), observedAt: 2000, destinationId: capture.destinationId, sourceDigest: managedDatabaseBackupSourceDigest(capture), volumeKey: "db-orders", archiveId: "backup_" + randomUUID().replaceAll("-", ""), archiveBytes: 4, archiveSha256: "a".repeat(64), manifestSha256: "b".repeat(64), format: "postgres-custom-gzip", consistency: "native-snapshot", status: "created", idempotent: false});
  return {receipt, preparation: {...source, backupReceipt: receipt, maxBytes: capture.maxBytes}};
}
async function fixture(pool: pg.Pool, lane: Lane, ttl = 60000) {
  const projectId = randomUUID(), actorId = randomUUID(), db = createDbClient(pool), controls = new DbControlCommandRepository(db);
  await pool.query("INSERT INTO users(id,email,email_normalized,password_hash,role_id) SELECT $1,$2,$2,'fixture',id FROM roles WHERE name='admin'", [actorId, `${actorId}@example.test`]);
  await pool.query("INSERT INTO projects(id,name,repo_url,default_branch) VALUES($1,'Protection SQL fixture','https://example.test/repo','main')", [projectId]);
  const native = lane === "native" ? nativeMetadata(projectId) : undefined;
  const receipt = native?.receipt ?? {schemaVersion: 1 as const, action: "compose.volume.backup" as const, agentId: "agent1", commandId: randomUUID(), projectId, inputDigest: "a".repeat(64), correlationId: randomUUID(), volumeKey: "data", destinationId: "local1", archiveId: "backup_" + randomUUID().replaceAll("-", ""), status: "created" as const, consistency: "stopped" as const, archiveBytes: 100, entries: 2, archiveSha256: "b".repeat(64), manifestSha256: "c".repeat(64), idempotent: false, redacted: true as const};
  const inventory = new DbBackupInventoryStore(db, "agent1"), records: BackupInventoryRecord[] = [];
  for (let index = 0; index < 2; index++) {
    if (index) await until(() => Date.now() > records[0]!.createdAtMs ? true : undefined);
    const item = index ? {...receipt, commandId: randomUUID(), correlationId: randomUUID(), archiveId: "backup_" + randomUUID().replaceAll("-", "")} : receipt;
    await pool.query("INSERT INTO control_commands(id,actor_user_id,action,scope_kind,scope_key,input_digest,idempotency_key,correlation_id,status,expires_at) VALUES($1,$2,'project.update','project',$3,$4,$6,$5,'eligible',now()+interval '1 hour')", [item.commandId, actorId, projectId, item.inputDigest, item.correlationId, item.commandId]);
    const backup = await controls.findProjectUpdateByIdempotency(actorId, projectId, item.commandId), claimed = await controls.claimProjectUpdate(backup!);
    await controls.completeProjectUpdate(claimed.command, claimed.authority!, {actorUserId: actorId, action: lane === "native" ? "database.runtime.backup.executed" : "compose.volume.backup.executed", targetType: "project", targetId: projectId, requestId: randomUUID(), correlationId: item.correlationId, metadata: lane === "native" ? nativeBackupInventoryAuditMetadata(item) : item});
    records.push(await inventory.recordAuthenticatedReceipt(item));
  }
  const source = records[0]!, now = Date.now();
  const candidate = (key: string) => lane === "native" ? prepareManagedDatabaseRestoreConfirmation({preparation: native!.preparation, actorId, idempotencyKey: key, correlationId: randomUUID(), now: Date.now(), commandTtlMs: ttl})
    : prepareComposeVolumeRestoreSourceConfirmation({source, projectId, expectedAgentId: "agent1", volumeKey: receipt.volumeKey, destinationId: receipt.destinationId, archiveId: receipt.archiveId, backupCommandId: receipt.commandId, expectedArchiveSha256: receipt.archiveSha256, expectedManifestSha256: receipt.manifestSha256, actorId, idempotencyKey: key, correlationId: randomUUID(), now: Date.now(), commandTtlMs: ttl});
  async function original(key = randomUUID()) {
    const proposed = candidate(key), resolved = await controls.resolve(proposed.command), confirmation = await controls.resolveProjectUpdateConfirmation(resolved.command, new Date());
    expect(confirmation).not.toBeNull(); return {command: resolved.command, confirmation: confirmation!, binding: lane === "p3" ? (proposed as ReturnType<typeof prepareComposeVolumeRestoreSourceConfirmation>).binding : undefined};
  }
  const restoreKey = randomUUID(), restore = await original(restoreKey);
  const snapshot = {schemaVersion: 1, projectId, volumeKey: receipt.volumeKey, destinationId: receipt.destinationId, keepNewest: 1, protectedArchiveIds: [], backups: records.map(({receipt, createdAtMs}) => ({receipt, createdAtMs}))};
  const plan = planBackupRetention(snapshot), proposedRetirement = prepareBackupRetirementConfirmation({snapshot, archiveId: receipt.archiveId, expectedInventoryDigest: plan.inventoryDigest, expectedPlanDigest: plan.planDigest, actorId, idempotencyKey: randomUUID(), correlationId: randomUUID(), now: Date.now(), commandTtlMs: ttl});
  const retired = await controls.resolve(proposedRetirement.command), retirementNonce = await controls.resolveProjectUpdateConfirmation(retired.command, new Date(now)); expect(retirementNonce).not.toBeNull();
  const protect = (connection: DeployLiteDb, value = restore) => lane === "native" ? new DbBackupRestoreProtectionStore(connection, "agent1").protect(native!.preparation, value.command, value.confirmation)
    : new DbComposeVolumeRestoreProtectionStore(connection, "agent1").protect(restore.binding!, value.command, value.confirmation);
  const list = (connection: DeployLiteDb) => lane === "native" ? new DbBackupRestoreProtectionStore(connection, "agent1").list(projectId, receipt.volumeKey, receipt.destinationId)
    : new DbComposeVolumeRestoreProtectionStore(connection, "agent1").list(projectId, receipt.volumeKey, receipt.destinationId);
  return {projectId, receipt, source, restore, original, restoreKey, protect, list, retirementCommand: retired.command, table: lane === "native" ? "backup_restore_protections" : "compose_volume_restore_protections",
    reserve: (connection: DeployLiteDb) => new DbBackupRetirementStore(connection, "agent1").reserve(proposedRetirement.binding, retired.command, retirementNonce!)};
}
function holdBeforeCommit(db: DeployLiteDb) {
  const entered = latch(), release = latch(), wrapped = Object.create(db) as DeployLiteDb;
  wrapped.transaction = (callback, config) => db.transaction(async tx => {const value = await callback(tx); entered.release(); await release.promise; return value;}, config);
  return {db: wrapped, entered: entered.promise, release: release.release};
}
async function observeWait(observer: pg.Pool, application: string, owner: number, waiter: number, projectId: string) {
  const proof = await until(async () => (await observer.query(`SELECT a.pid AS waiter_pid,o.pid AS owner_pid,w.classid::text,w.objid::text,w.objsubid,o.granted AS owner_granted,w.granted AS waiter_granted
    FROM pg_stat_activity a JOIN pg_locks w ON w.pid=a.pid JOIN pg_locks o ON o.locktype=w.locktype AND o.database IS NOT DISTINCT FROM w.database AND o.classid=w.classid AND o.objid=w.objid AND o.objsubid=w.objsubid
    WHERE a.datname=current_database() AND a.application_name=$1 AND a.pid=$2 AND a.wait_event_type='Lock' AND a.query LIKE '%pg_advisory_xact_lock%' AND w.locktype='advisory' AND NOT w.granted AND o.granted AND o.pid=$3`, [application, waiter, owner])).rows[0]);
  expect(proof).toMatchObject({waiter_pid: waiter, owner_pid: owner, owner_granted: true, waiter_granted: false});
  const key = (await observer.query("SELECT ((hashtextextended($1,0)>>32)&4294967295::bigint)::text AS classid,(hashtextextended($1,0)&4294967295::bigint)::text AS objid", [`deploylite:execution:${projectId}`])).rows[0];
  expect(proof).toMatchObject({...key, objsubid: 1});
  expect(proof.classid).toMatch(/^\d+$/); expect(proof.objid).toMatch(/^\d+$/); expect(proof.objsubid).toBeGreaterThan(0);
}
async function laneRows(pool: pg.Pool, f: Pick<Awaited<ReturnType<typeof fixture>>, "projectId" | "table">) {
  return {protection: (await pool.query(`SELECT * FROM ${f.table} WHERE project_id=$1 ORDER BY restore_command_id`, [f.projectId])).rows,
    retirement: (await pool.query("SELECT * FROM backup_retirement_reservations WHERE project_id=$1", [f.projectId])).rows};
}
async function rejectSql(pool: pg.Pool, text: string, values: unknown[], code: string) {
  const client = await pool.connect();
  try {await client.query("BEGIN"); await client.query("SAVEPOINT rejected_probe"); await expect(client.query(text, values)).rejects.toMatchObject({code}); await client.query("ROLLBACK TO SAVEPOINT rejected_probe");}
  finally {try {await client.query("ROLLBACK");} finally {client.release();}}
}
async function nativeConstraints(pool: pg.Pool) {
  return (await pool.query("SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='backup_restore_protections'::regclass ORDER BY conname")).rows;
}
export async function prepareMigrationProbe(url: string) {
  const owned = ownedPool(url, "migration");
  try {const f = await fixture(owned.pool, "native"); await f.protect(createDbClient(owned.pool));
    return {projectId: f.projectId, originals: await snapshotOriginals(owned.pool, f.projectId), rows: numericDates(await laneRows(owned.pool, f)), constraints: await nativeConstraints(owned.pool)};
  } finally {await owned.close();}
}
export type MigrationProbe = Awaited<ReturnType<typeof prepareMigrationProbe>>;

/** Actual SQL acceptance only in the existing opted-in disposable fixture; synthetic archive metadata is not runtime restore proof. */
export function defineBackupProtectionCases(getPool: () => pg.Pool, getUrl: () => string, getProbe: () => MigrationProbe | undefined) {
  it("preserves native protection rows and constraints across additive P3 migration", async () => {
    const probe = getProbe(); expect(probe).toBeDefined();
    expect(await snapshotOriginals(getPool(), probe!.projectId)).toEqual(probe!.originals);
    expect(numericDates(await laneRows(getPool(), {projectId: probe!.projectId, table: "backup_restore_protections"}))).toEqual(probe!.rows);
    expect(await nativeConstraints(getPool())).toEqual(probe!.constraints);
    await rejectSql(getPool(), "UPDATE backup_restore_protections SET archive_id='invalid' WHERE project_id=$1", [probe!.projectId], "23514");
    await rejectSql(getPool(), "UPDATE backup_restore_protections SET volume_key='invalid' WHERE project_id=$1", [probe!.projectId], "23514");
    expect(numericDates(await laneRows(getPool(), {projectId: probe!.projectId, table: "backup_restore_protections"}))).toEqual(probe!.rows);
    expect(await snapshotOriginals(getPool(), probe!.projectId)).toEqual(probe!.originals); expect(await nativeConstraints(getPool())).toEqual(probe!.constraints);
  });
  it("enforces P3 source binding and original ledger/inventory/nonce SQL constraints", async () => {
    const pool = getPool(), f = await fixture(pool, "p3"), db = createDbClient(pool); await f.protect(db);
    const second = await f.original(); await f.protect(db, second); expect((await laneRows(pool, f)).protection).toHaveLength(2);
    const third = await f.original(), before = await snapshotOriginals(pool, f.projectId), rows = numericDates(await laneRows(pool, f));
    await rejectSql(pool, "UPDATE compose_volume_restore_protections SET confirmation_id=$2 WHERE restore_command_id=$1", [f.restore.command.id, randomUUID()], "23503");
    await rejectSql(pool, "UPDATE compose_volume_restore_protections SET restore_command_id=$2 WHERE restore_command_id=$1", [f.restore.command.id, randomUUID()], "23503");
    await rejectSql(pool, "UPDATE compose_volume_restore_protections SET volume_key='invalid!' WHERE restore_command_id=$1", [f.restore.command.id], "23514");
    await rejectSql(pool, "UPDATE compose_volume_restore_protections SET source_binding=jsonb_set(source_binding,'{executionAllowed}','true'::jsonb) WHERE restore_command_id=$1", [f.restore.command.id], "23514");
    await rejectSql(pool, "UPDATE compose_volume_restore_protections SET archive_sha256=$2 WHERE restore_command_id=$1", [f.restore.command.id, "z".repeat(64)], "23514");
    await rejectSql(pool, "UPDATE compose_volume_restore_protections SET archive_sha256=$2 WHERE restore_command_id=$1", [f.restore.command.id, "d".repeat(64)], "23514");
    await rejectSql(pool, "UPDATE compose_volume_restore_protections SET source_binding=jsonb_set(source_binding,'{source,receipt,projectId}',to_jsonb($2::text)) WHERE restore_command_id=$1", [f.restore.command.id, randomUUID()], "23514");
    await rejectSql(pool, "DELETE FROM backup_inventory WHERE project_id=$1 AND archive_id=$2", [f.projectId, f.receipt.archiveId], "23503");
    await rejectSql(pool, "INSERT INTO compose_volume_restore_protections SELECT $2,confirmation_id,project_id,volume_key,destination_id,archive_id,backup_command_id,input_digest,archive_sha256,manifest_sha256,source_binding,created_at FROM compose_volume_restore_protections WHERE restore_command_id=$1", [f.restore.command.id, third.command.id], "23505");
    expect(await snapshotOriginals(pool, f.projectId)).toEqual(before); expect(numericDates(await laneRows(pool, f))).toEqual(rows);
  });
  for (const lane of lanes) for (const first of [true, false]) it(`serializes ${lane} protection versus retirement with protection-first=${first}`, async () => {
    const observer = getPool(), f = await fixture(observer, lane), before = await snapshotOriginals(observer, f.projectId);
    const owner = ownedPool(getUrl(), "owner"), waiter = ownedPool(getUrl(), "waiter"), held = holdBeforeCommit(createDbClient(owner.pool));
    let owning: Promise<unknown> | undefined, contending: Promise<unknown> | undefined;
    try {
      const ownerPid = (await owner.pool.query("SELECT pg_backend_pid() AS pid")).rows[0].pid, waiterPid = (await waiter.pool.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      owning = first ? f.protect(held.db) : f.reserve(held.db); const ownerOutcome = owning.then(() => false, () => false);
      expect(await Promise.race([held.entered.then(() => true), ownerOutcome])).toBe(true);
      contending = first ? f.reserve(createDbClient(waiter.pool)) : f.protect(createDbClient(waiter.pool)); void contending.catch(() => {});
      await observeWait(observer, waiter.name, ownerPid, waiterPid, f.projectId); held.release(); await owning;
      await expect(contending).rejects.toThrow(first ? "Archive retirement is unavailable." : "protection is unavailable.");
      const rows = await laneRows(observer, f); expect(rows.protection).toHaveLength(first ? 1 : 0); expect(rows.retirement).toHaveLength(first ? 0 : 1);
      expect(await snapshotOriginals(observer, f.projectId)).toEqual(before);
    } finally {held.release(); await Promise.allSettled([owning, contending]); await Promise.all([owner.close(), waiter.close()]);}
  }, 30000);
  for (const lane of lanes) it(`preserves ${lane} duplicate originals and expiry/reopen observation`, async () => {
    const pool = getPool(), f = await fixture(pool, lane, 5000), before = await snapshotOriginals(pool, f.projectId), db = createDbClient(pool);
    const retry = await f.original(f.restoreKey); expect(retry.command).toEqual(f.restore.command); expect(retry.confirmation).toEqual(f.restore.confirmation);
    await Promise.all([f.protect(db), f.protect(db, retry)]); const rows = numericDates(await laneRows(pool, f)); expect((await laneRows(pool, f)).protection).toHaveLength(1);
    await until(() => Date.now() >= f.restore.command.expiresAt.getTime() ? true : undefined, f.restore.command.expiresAt.getTime() + 10000);
    const fresh = ownedPool(getUrl(), "reopen");
    try {if (lane === "native") await expect(f.protect(createDbClient(fresh.pool))).rejects.toThrow("protection is unavailable."); else await f.protect(createDbClient(fresh.pool));
      expect(await f.list(createDbClient(fresh.pool))).toEqual([f.receipt.archiveId]);
      expect(numericDates(await laneRows(fresh.pool, f))).toEqual(rows); expect(await snapshotOriginals(fresh.pool, f.projectId)).toEqual(before);
    } finally {await fresh.close();}
  }, 30000);
  for (const lane of lanes) it(`denies expired and canceled ${lane} protection after an observed project-lock wait`, async () => {
    for (const mode of ["expiry", "cancellation"] as const) {
      const observer = getPool(), f = await fixture(observer, lane, mode === "expiry" ? 5000 : 60000), before = await snapshotOriginals(observer, f.projectId);
      const owner = ownedPool(getUrl(), "blocker"), waiter = ownedPool(getUrl(), "contender"), held = holdBeforeCommit(createDbClient(owner.pool));
      let owning: Promise<unknown> | undefined, contending: Promise<unknown> | undefined;
      try {
        const ownerPid = (await owner.pool.query("SELECT pg_backend_pid() AS pid")).rows[0].pid, waiterPid = (await waiter.pool.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        owning = held.db.transaction(tx => tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`deploylite:execution:${f.projectId}`},0))`)); void owning.catch(() => {});
        expect(await Promise.race([held.entered.then(() => true), owning.then(() => false, () => false)])).toBe(true);
        contending = f.protect(createDbClient(waiter.pool)); void contending.catch(() => {}); await observeWait(observer, waiter.name, ownerPid, waiterPid, f.projectId);
        if (mode === "expiry") await until(() => Date.now() >= f.restore.command.expiresAt.getTime() ? true : undefined, f.restore.command.expiresAt.getTime() + 10000);
        else {expect((await observer.query("SELECT pg_cancel_backend($1) AS cancelled", [waiterPid])).rows[0].cancelled).toBe(true);}
        if (mode === "expiry") {held.release(); await owning;}
        await expect(contending).rejects.toThrow("protection is unavailable.");
        await until(async () => (await observer.query("SELECT count(*)::int AS count FROM pg_locks WHERE pid=$1 AND locktype='advisory'", [waiterPid])).rows[0].count === 0 ? true : undefined);
        expect(await laneRows(observer, f)).toEqual({protection: [], retirement: []}); expect(await snapshotOriginals(observer, f.projectId)).toEqual(before);
        held.release(); await owning;
        if (mode === "cancellation") {await f.protect(createDbClient(waiter.pool)); expect((await laneRows(observer, f)).protection).toHaveLength(1); expect(await snapshotOriginals(observer, f.projectId)).toEqual(before);}
      } finally {held.release(); await Promise.allSettled([owning, contending]); await Promise.all([owner.close(), waiter.close()]);}
    }
  }, 30000);
  type ReplayContext = {f: Awaited<ReturnType<typeof fixture>>; pool: pg.Pool; peer: pg.Pool; store: DbAgentReplayStore;
    fingerprint: string; lease: Parameters<DbAgentReplayStore["claim"]>[2]; pending: Promise<unknown>[]; track: <T>(value: Promise<T>) => Promise<T>};
  async function replayRows(pool: pg.Pool, commandId: string) {
    return numericDates((await pool.query("SELECT * FROM agent_replay WHERE command_id=$1", [commandId])).rows);
  }
  async function expireReplay(pool: pg.Pool, commandId: string) {
    const before = (await pool.query("SELECT * FROM agent_replay WHERE command_id=$1", [commandId])).rows; expect(before).toHaveLength(1);
    const changed = await pool.query("UPDATE agent_replay SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE command_id=$1 RETURNING command_id", [commandId]);
    expect(changed.rowCount).toBe(1); expect(changed.rows).toEqual([{command_id: commandId}]);
    expect((await pool.query("SELECT lease_expires_at < clock_timestamp() AS expired FROM agent_replay WHERE command_id=$1", [commandId])).rows).toEqual([{expired: true}]);
    const after = (await pool.query("SELECT * FROM agent_replay WHERE command_id=$1", [commandId])).rows; expect(after).toHaveLength(1);
    expect({...after[0], lease_expires_at: before[0].lease_expires_at}).toEqual(before[0]); return numericDates(after);
  }
  async function withCommittedReplay(lane: Lane, run: (context: ReplayContext) => Promise<void>) {
    const f = await fixture(getPool(), lane), originals = await snapshotOriginals(getPool(), f.projectId);
    const reserver = ownedPool(getUrl(), "replay_reserver"), replay = ownedPool(getUrl(), "replay_observer"), held = holdBeforeCommit(createDbClient(reserver.pool));
    const pending: Promise<unknown>[] = [], track = <T>(value: Promise<T>) => {pending.push(value); void value.catch(() => {}); return value;};
    let reservationPromise: ReturnType<typeof f.reserve> | undefined;
    try {
      const reserverPid = (await reserver.pool.query("SELECT pg_backend_pid() AS pid")).rows[0].pid, replayPid = (await replay.pool.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      expect(reserverPid).not.toBe(replayPid); expect(f.receipt.commandId).not.toBe(f.retirementCommand.id);
      reservationPromise = f.reserve(held.db); const earlyOutcome = reservationPromise.then(() => false, () => false);
      expect(await Promise.race([held.entered.then(() => true), earlyOutcome])).toBe(true);
      const absent = await replay.pool.query("SELECT command_id FROM backup_retirement_reservations WHERE command_id=$1", [f.retirementCommand.id]);
      expect(absent.rows).toHaveLength(0);
      held.release(); const reserved = await reservationPromise;
      expect(reserved).toEqual({reserved: true, executionAllowed: false, commandId: f.retirementCommand.id});
      const committed = await replay.pool.query("SELECT command_id,project_id,volume_key,destination_id,archive_id,input_digest FROM backup_retirement_reservations WHERE command_id=$1", [f.retirementCommand.id]);
      const expectedReservation = {command_id: f.retirementCommand.id, project_id: f.projectId, volume_key: f.receipt.volumeKey,
        destination_id: f.receipt.destinationId, archive_id: f.receipt.archiveId, input_digest: f.retirementCommand.inputDigest};
      expect(committed.rows).toEqual([expectedReservation]); const reservedRows = numericDates(await laneRows(replay.pool, f));
      const context: ReplayContext = {f, pool: replay.pool, peer: reserver.pool, store: new DbAgentReplayStore(createDbClient(replay.pool), "original-replay-owner"),
        fingerprint: JSON.stringify({commandId: f.retirementCommand.id, inputDigest: f.retirementCommand.inputDigest, correlationId: f.retirementCommand.correlationId}),
        lease: {leaseId: randomUUID(), fence: 1, expiresAt: Date.now() + 60000}, pending, track};
      await run(context);
      expect(await snapshotOriginals(replay.pool, f.projectId)).toEqual(originals); expect(numericDates(await laneRows(replay.pool, f))).toEqual(reservedRows);
    } finally {held.release(); await Promise.allSettled([reservationPromise, ...pending]); await Promise.all([reserver.close(), replay.close()]);}
  }
  for (const lane of lanes) it(`fences ${lane} replay reclaim and release after reservation commit`, async () => {
    await withCommittedReplay(lane, async ({f, pool, peer, store, fingerprint, lease, track}) => {
      const commandId = f.retirementCommand.id, first = await track(store.claim(commandId, fingerprint, lease)); expect(first.claimed).toBe(true); expect(first.claimToken).toEqual(expect.any(String));
      const fresh = new DbAgentReplayStore(createDbClient(peer), "reopened-replay-owner"), admitted = await replayRows(pool, commandId);
      expect(await track(fresh.claim(commandId, fingerprint, {...lease, leaseId: randomUUID()}))).toEqual({claimed: false});
      for (const token of [undefined, "foreign-token", first.claimToken]) {await track(store.release(commandId, token)); expect(await replayRows(pool, commandId)).toEqual(admitted);}
      const expired = await expireReplay(pool, commandId);
      const duplicate = new DbAgentReplayStore(createDbClient(pool), "parallel-replay-owner");
      expect(await Promise.all([fresh, duplicate].map(owner => track(owner.claim(commandId, fingerprint, {...lease, leaseId: randomUUID(), expiresAt: Date.now() + 60000}))))).toEqual([{claimed: false}, {claimed: false}]);
      await track(store.release(commandId, first.claimToken)); await track(fresh.release(commandId, first.claimToken));
      await expect(track(fresh.claim(commandId, "foreign-fingerprint", lease))).rejects.toThrow("replay"); expect(await replayRows(pool, commandId)).toEqual(expired);
    });
  }, 30000);
  for (const lane of lanes) it(`recovers ${lane} original replay cache after reserved lease expiry and reopen`, async () => {
    await withCommittedReplay(lane, async context => {
      const {f, pool, peer, store, fingerprint, lease, pending, track} = context, commandId = f.retirementCommand.id;
      const first = await track(store.claim(commandId, fingerprint, lease)); expect(first.claimed).toBe(true); expect(first.claimToken).toEqual(expect.any(String));
      const expired = await expireReplay(pool, commandId), receipt = {admissionTestOnly: true, commandId, correlationId: f.retirementCommand.correlationId};
      const foreign = new DbAgentReplayStore(createDbClient(peer), "foreign-replay-owner");
      for (const [owner, input, token] of [[foreign, fingerprint, first.claimToken!], [store, "foreign", first.claimToken!], [store, fingerprint, "foreign-token"]] as const) {
        await expect(track(owner.complete(commandId, {fingerprint: input, claimToken: token, receipt}))).rejects.toThrow("stale"); expect(await replayRows(pool, commandId)).toEqual(expired);
      }
      await track(store.complete(commandId, {fingerprint, claimToken: first.claimToken!, receipt})); const completed = await replayRows(pool, commandId);
      const reopened = ownedPool(getUrl(), "replay_cache_reopen");
      try {
        const fresh = new DbAgentReplayStore(createDbClient(reopened.pool), "cache-reader-after-reopen"), found = await track(fresh.lookup(commandId, fingerprint));
        expect(found).toEqual(receipt); found!.admissionTestOnly = false; expect(await track(fresh.lookup(commandId, fingerprint))).toEqual(receipt);
        const digest = createHash("sha256").update(fingerprint).digest("hex"); expect(await track(fresh.lookupByFingerprintDigest(commandId, digest))).toEqual(receipt);
        expect(await track(fresh.claim(commandId, fingerprint, {...lease, expiresAt: Date.now() + 60000}))).toEqual({claimed: false, receipt});
        await expect(track(fresh.lookup(commandId, "foreign-fingerprint"))).rejects.toThrow("replay"); await expect(track(fresh.lookupByFingerprintDigest(commandId, "0".repeat(64)))).rejects.toThrow("replay");
        await expect(track(store.complete(commandId, {fingerprint, claimToken: first.claimToken!, receipt}))).rejects.toThrow("stale");
        await track(store.release(commandId, first.claimToken)); await track(fresh.release(commandId, first.claimToken)); expect(await replayRows(reopened.pool, commandId)).toEqual(completed);
      } finally {await Promise.allSettled(pending); await reopened.close();}
    });
  }, 30000);
  it("preserves unreserved UUID replay lease reclaim and token release", async () => {
    const commandId = randomUUID(), fingerprint = JSON.stringify({admissionTestOnly: true, commandId}), pending: Promise<unknown>[] = [];
    const track = <T>(value: Promise<T>) => {pending.push(value); void value.catch(() => {}); return value;};
    const beforeReservations = numericDates((await getPool().query("SELECT * FROM backup_retirement_reservations ORDER BY command_id")).rows);
    const owner = ownedPool(getUrl(), "ordinary_replay_owner"), reopened = ownedPool(getUrl(), "ordinary_replay_reopen");
    try {
      expect((await reopened.pool.query("SELECT command_id FROM backup_retirement_reservations WHERE command_id=$1", [commandId])).rows).toEqual([]);
      const original = new DbAgentReplayStore(createDbClient(owner.pool), "ordinary-owner"), fresh = new DbAgentReplayStore(createDbClient(reopened.pool), "ordinary-successor");
      const lease = {leaseId: randomUUID(), fence: 1, expiresAt: Date.now() + 60000}, first = await track(original.claim(commandId, fingerprint, lease)); expect(first.claimed).toBe(true);
      await expireReplay(owner.pool, commandId); const next = await track(fresh.claim(commandId, fingerprint, {...lease, leaseId: randomUUID()})); expect(next.claimed).toBe(true); expect(next.claimToken).not.toBe(first.claimToken);
      const successor = await replayRows(reopened.pool, commandId); await track(original.release(commandId, first.claimToken)); await track(fresh.release(commandId, "wrong-token")); expect(await replayRows(reopened.pool, commandId)).toEqual(successor);
      await track(fresh.release(commandId, next.claimToken)); expect(await replayRows(reopened.pool, commandId)).toEqual([]);
      const again = await track(fresh.claim(commandId, fingerprint, {...lease, leaseId: randomUUID()})); expect(again.claimed).toBe(true); expect(again.claimToken).not.toBe(next.claimToken);
      const receipt = {admissionTestOnly: true, commandId}; await track(fresh.complete(commandId, {fingerprint, claimToken: again.claimToken!, receipt})); const completed = await replayRows(reopened.pool, commandId);
      expect(await track(original.lookup(commandId, fingerprint))).toEqual(receipt); expect(await track(original.claim(commandId, fingerprint, lease))).toEqual({claimed: false, receipt});
      await track(fresh.release(commandId, again.claimToken)); expect(await replayRows(owner.pool, commandId)).toEqual(completed);
      expect(numericDates((await getPool().query("SELECT * FROM backup_retirement_reservations ORDER BY command_id")).rows)).toEqual(beforeReservations);
    } finally {await Promise.allSettled(pending); await Promise.all([owner.close(), reopened.close()]);}
  }, 30000);
}
