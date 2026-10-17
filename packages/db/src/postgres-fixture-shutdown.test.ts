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
    expect(suite.count).toBe(84); expect(suite.allowSkipped).toBe(false); expect(suite.cases).toHaveLength(84);
    expect(new Set(suite.cases.map((row: {fullName: string}) => row.fullName)).size).toBe(84);
    expect(suite.cases.filter((row: {file: string}) => row.file === path)).toEqual(titles.map(title => ({
      fullName: `P5 backup inventory durable PostgreSQL acceptance ${title}`, title, file: path, physicalRestart: false
    })));
  });
  it("binds every newly covered protection source in both artifact source lists", () => {
    const names = [path, "packages/db/src/repositories/compose-volume-restore-protection.ts", "packages/db/src/compose-volume-restore-protection.test.ts",
      "packages/db/migrations/0030_backup_retirement_reservation.sql", "packages/db/migrations/0031_compose_volume_restore_protections.sql",
      "packages/db/src/repositories/backup-retirement.ts", "packages/db/src/backup-retirement.test.ts", "packages/db/src/compose-volume-restore-protection-schema.test.ts",
      "packages/domain/src/compose-volume-restore-source.ts", "packages/domain/src/compose-volume-restore-source.test.ts", "packages/domain/src/backup-retirement.ts"];
    expect(manifest().sourceFiles).toHaveLength(414); expect(manifest().suites.db.sourceFiles).toHaveLength(41);
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
