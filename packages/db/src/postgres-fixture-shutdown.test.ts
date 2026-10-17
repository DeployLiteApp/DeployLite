import {createHash, randomUUID} from "node:crypto";
import {backupRetentionRequestSchema} from "@deploylite/contracts";
import {planBackupRetention, prepareBackupRetirementConfirmation} from "@deploylite/domain";
import {nativeMetadata} from "./backup-protection-postgres.cases.js";
import {readFileSync} from "node:fs";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { trackPostgresFixtureShutdown } from "./postgres-fixture-shutdown.js";
function fixture() {
  const events = new EventEmitter();
  const end = vi.fn(async () => {});
  const pool = { on: events.on.bind(events), end } as unknown as Pick<Pool, "on" | "end">;
  return { events, end, close: trackPostgresFixtureShutdown(pool) };
}
describe("owned PostgreSQL fixture shutdown", () => {
  it("waits for every connection removal after the pool end promise resolves", async () => {
    const f = fixture(), first = {}, second = {};
    f.events.emit("connect", first); f.events.emit("connect", second);
    let closed = false;
    const closing = f.close().then(() => { closed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.end).toHaveBeenCalledOnce(); expect(closed).toBe(false);
    f.events.emit("remove", first);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(closed).toBe(false);
    f.events.emit("remove", second); await closing; expect(closed).toBe(true);
  });
  it("does not wait on a connection already removed before shutdown", async () => {
    const f = fixture(), client = {};
    f.events.emit("connect", client); f.events.emit("remove", client);
    await f.close(); expect(f.end).toHaveBeenCalledOnce();
  });
  it("propagates pool shutdown failure without accepting closure", async () => {
    const f = fixture(); f.events.emit("connect", {});
    f.end.mockRejectedValueOnce(new Error("fixture close failed"));
    await expect(f.close()).rejects.toThrow("fixture close failed");
  });
});

// Source contracts only: these assertions do not execute or certify PostgreSQL cases.
describe("hosted protection acceptance source contract", () => {
  const root = new URL("../../../", import.meta.url);
  const load = (path: string) => readFileSync(new URL(path, root), "utf8");
  const manifest = () => JSON.parse(load("scripts/ci/p2-acceptance-cases.json"));
  const path = "packages/db/src/backup-protection-postgres.cases.ts";
  const titles = [
    "preserves native protection rows and constraints across additive P3 migration",
    "enforces P3 source binding and original ledger/inventory/nonce SQL constraints",
    ...["native", "p3"].flatMap(lane => [true, false].map(first => `serializes ${lane} protection versus retirement with protection-first=${first}`)),
    ...["native", "p3"].map(lane => `preserves ${lane} duplicate originals and expiry/reopen observation`),
    ...["native", "p3"].map(lane => `denies expired and canceled ${lane} protection after an observed project-lock wait`)
  ];
  it("enrolls all ten exact physical case identities without replacing the original74", () => {
    const suite = manifest().suites.db;
    expect(suite.count).toBe(89); expect(suite.allowSkipped).toBe(false); expect(suite.cases).toHaveLength(89);
    expect(new Set(suite.cases.map((row: {fullName: string}) => row.fullName)).size).toBe(89);
    expect(suite.cases.filter((row: {file: string}) => row.file === path).slice(0, 10)).toEqual(titles.map(title => ({
      fullName: `P5 backup inventory durable PostgreSQL acceptance ${title}`, title, file: path, physicalRestart: false
    })));
  });
  it("binds every newly covered protection source in both artifact source lists", () => {
    const names = [path, "packages/db/src/repositories/compose-volume-restore-protection.ts", "packages/db/src/compose-volume-restore-protection.test.ts",
      "packages/db/migrations/0030_backup_retirement_reservation.sql", "packages/db/migrations/0031_compose_volume_restore_protections.sql",
      "packages/db/src/repositories/backup-retirement.ts", "packages/db/src/backup-retirement.test.ts", "packages/db/src/compose-volume-restore-protection-schema.test.ts",
      "packages/domain/src/compose-volume-restore-source.ts", "packages/domain/src/compose-volume-restore-source.test.ts", "packages/domain/src/backup-retirement.ts"];
    expect(manifest().sourceFiles).toHaveLength(420); expect(manifest().suites.db.sourceFiles).toHaveLength(43);
    for (const name of names) {expect(manifest().sourceFiles).toContain(name); expect(manifest().suites.db.sourceFiles).toContain(name);}
  });
  it("requires real SQL lock ownership, owned backend cancellation, original snapshots and settled cleanup stages", () => {
    const source = load(path);
    for (const token of ["pg_stat_activity", "pg_locks", "wait_event_type='Lock'", "pg_advisory_xact_lock", "classid", "objid", "objsubid", "granted",
      "pg_cancel_backend", "application_name", "current_database()", "holdBeforeCommit", "observeWait", "snapshotOriginals", "Promise.allSettled",
      "resolveProjectUpdateConfirmation", ".resolve(", "23503", "23514", "23505"])
      expect(source, `required physical source stage: ${token}`).toContain(token);
    expect(source.replace(/\s+/g, "")).toContain("Date.now()>=");
  });
  it("seeds the preservation probe BEFORE0031 inside the existing migration loop and registers only the existing fixture", () => {
    const source = load("packages/db/src/backup-inventory-postgres.integration-cases.ts");
    const probe = source.indexOf('if (file === "0031_compose_volume_restore_protections.sql")');
    const migration = source.indexOf("await migrationClient.query", probe);
    expect(probe).toBeGreaterThan(-1); expect(migration).toBeGreaterThan(probe);
    expect(source.slice(probe, migration)).toContain("prepareMigrationProbe(databaseUrl)");
    expect(source).toContain("defineBackupProtectionCases(() => pool, () => databaseUrl, () => migrationProbe)");
    expect(source.match(/CREATE DATABASE/g)).toHaveLength(1);
  });
});

// Execute the actual fixture request expression without a PostgreSQL connection.
describe("hosted protection retention fixture request", () => {
  it.each(["native", "p3"] as const)("plans %s retirement from authenticated inventory records without weakening the strict request", lane => {
    const projectId = randomUUID(), now = Date.now();
    const receipt = lane === "native" ? nativeMetadata(projectId).receipt : {
      schemaVersion: 1 as const, action: "compose.volume.backup" as const, agentId: "agent1", commandId: randomUUID(), projectId,
      inputDigest: "a".repeat(64), correlationId: randomUUID(), volumeKey: "data", destinationId: "local1",
      archiveId: "backup_" + randomUUID().replaceAll("-", ""), status: "created" as const, consistency: "stopped" as const,
      archiveBytes: 100, entries: 2, archiveSha256: "b".repeat(64), manifestSha256: "c".repeat(64), idempotent: false, redacted: true as const
    };
    const records = [{schemaVersion: 1 as const, receipt, createdAtMs: now - 2}, {schemaVersion: 1 as const,
      receipt: {...receipt, commandId: randomUUID(), correlationId: randomUUID(), archiveId: "backup_" + randomUUID().replaceAll("-", "")}, createdAtMs: now - 1}];
    const source = readFileSync(new URL("./backup-protection-postgres.cases.ts", import.meta.url), "utf8");
    const expression = source.match(/const snapshot = ([^\n]+);/)?.[1]; expect(expression).toBeDefined();
    const snapshot = new Function("projectId", "receipt", "records", `return (${expression});`)(projectId, receipt, records);
    const parsed = backupRetentionRequestSchema.safeParse(snapshot);
    expect(parsed.success, JSON.stringify(parsed.success ? [] : parsed.error.issues)).toBe(true);
    expect(snapshot.backups).toEqual(records.map(({receipt, createdAtMs}) => ({receipt, createdAtMs})));
    const raw = backupRetentionRequestSchema.safeParse({...snapshot, backups: records}); expect(raw.success).toBe(false);
    expect(records.map(record => record.schemaVersion)).toEqual([1, 1]);
    const plan = planBackupRetention(snapshot); expect(plan.retainedArchiveIds).toEqual([records[1]!.receipt.archiveId]);
    expect(plan.deletionCandidates.map(candidate => candidate.archiveId)).toEqual([receipt.archiveId]);
    const prepared = prepareBackupRetirementConfirmation({snapshot, archiveId: receipt.archiveId,
      expectedInventoryDigest: plan.inventoryDigest, expectedPlanDigest: plan.planDigest, actorId: randomUUID(),
      idempotencyKey: randomUUID(), correlationId: randomUUID(), now, commandTtlMs: 60000});
    expect(prepared.binding).toMatchObject({operation: "backup.retire", executionAllowed: false, receipt});
  });
});

// Structural assertions only. Actual PostgreSQL89 remains an opt-in hosted proof.
describe("committed retirement replay PostgreSQL acceptance source", () => {
  const root = new URL("../../../", import.meta.url), path = "packages/db/src/backup-protection-postgres.cases.ts";
  const load = (name: string) => readFileSync(new URL(name, root), "utf8"), source = () => load(path);
  const manifest = () => JSON.parse(load("scripts/ci/p2-acceptance-cases.json"));
  it("preserves the literal original84 prefix and appends exactly five current-runner physical identities", () => {
    const suite = manifest().suites.db;
    expect(createHash("sha256").update(JSON.stringify(suite.cases.slice(0, 84))).digest("hex")).toBe("d20f46c94b89c90faa2eb9a5f3ef87c646c12d9c206c9cc5fb4c6a728cab86d1");
    const titles = ["fences native replay reclaim and release after reservation commit", "fences p3 replay reclaim and release after reservation commit",
      "recovers native original replay cache after reserved lease expiry and reopen", "recovers p3 original replay cache after reserved lease expiry and reopen",
      "preserves unreserved UUID replay lease reclaim and token release"];
    expect(suite.count).toBe(89); expect(suite.allowSkipped).toBe(false); expect(suite.cases).toHaveLength(89);
    expect(suite.cases.slice(84)).toEqual(titles.map(title => ({fullName: `P5 backup inventory durable PostgreSQL acceptance ${title}`, title, file: path, physicalRestart: false})));
  });
  it("enrolls both existing replay sources in DB43 without changing the global417 list", () => {
    const m = manifest(); expect(m.sourceFiles).toHaveLength(420); expect(m.suites.db.sourceFiles).toHaveLength(43);
    for (const name of ["packages/db/src/repositories/agent-replay.ts", "packages/db/src/repositories/agent-replay.test.ts"]) {
      expect(m.sourceFiles).toContain(name); expect(m.suites.db.sourceFiles).toContain(name);
    }
  });
  it("orders distinct-session absent/commit/present observation before any replay admission", () => {
    const helper = source().slice(source().indexOf("async function withCommittedReplay("));
    const stages = ["reservationPromise = f.reserve(held.db)", "held.entered.then", "const absent = await replay.pool.query",
      "expect(absent.rows).toHaveLength(0)", "held.release(); const reserved = await reservationPromise", "const committed = await replay.pool.query",
      "expect(committed.rows).toEqual([expectedReservation])", "store: new DbAgentReplayStore", "await run(context)"];
    let offset = -1; for (const stage of stages) {const next = helper.indexOf(stage); expect(next, stage).toBeGreaterThan(offset); offset = next;}
    expect(helper).toContain("expect(reserverPid).not.toBe(replayPid)"); expect(helper).toContain("Promise.allSettled([reservationPromise, ...pending])");
    expect(helper).toContain("await Promise.all([reserver.close(), replay.close()])");
  });
  it("retains real expiry, original cache, token CAS, reopen and ordinary-row controls", () => {
    const text = source();
    for (const stage of ["retirementCommand: retired.command", "lease_expires_at = clock_timestamp() - interval '1 second'", "admissionTestOnly: true",
      "lookupByFingerprintDigest", 'createHash("sha256").update(fingerprint)', 'ownedPool(getUrl(), "replay_cache_reopen")',
      "snapshotOriginals", "numericDates", "laneRows", "first.claimToken", "next.claimToken", "beforeReservations", "Promise.allSettled(pending)"])
      expect(text, stage).toContain(stage);
  });
});
