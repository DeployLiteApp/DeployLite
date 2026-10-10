import { redactSecrets } from "@deploylite/config";
import { DbControlCommandRepository } from "./repositories/control-plane.js";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createDbClient, createDbPool, closeDbPool } from "./client.js";
import { DbBackupInventoryStore } from "./repositories/backup-inventory.js";

const enabled = process.env.DEPLOYLITE_DB_INTEGRATION === "1";
const configured = enabled ? process.env.DATABASE_URL : undefined;
if (enabled && !configured) throw new Error("DATABASE_URL must be set when DEPLOYLITE_DB_INTEGRATION=1.");
let maintenance: pg.Client, pool: pg.Pool, databaseName: string, databaseUrl: string;
const store = (connection = pool) => new DbBackupInventoryStore(createDbClient(connection), "agent-1");
async function seed(projectId = randomUUID(), archiveId: string = randomUUID()) {
  const actorId = randomUUID(), commandId = randomUUID(), correlationId = randomUUID(), auditId = randomUUID();
  await pool.query("INSERT INTO users(id,email,email_normalized,password_hash,role_id) SELECT $1,$2,$2,'fixture',id FROM roles WHERE name='admin'", [actorId, `${actorId}@example.test`]);
  await pool.query("INSERT INTO projects(id,name,repo_url,default_branch) VALUES($1,'P5 fixture','https://example.test/repo','main') ON CONFLICT DO NOTHING", [projectId]);
  const receipt = {schemaVersion: 1, action: "compose.volume.backup", agentId: "agent-1", commandId, projectId, inputDigest: "a".repeat(64), correlationId, volumeKey: "data", destinationId: "local-1", archiveId, status: "created", consistency: "stopped", archiveBytes: 100, entries: 2, archiveSha256: "b".repeat(64), manifestSha256: "c".repeat(64), idempotent: false, redacted: true};
  await pool.query("INSERT INTO control_commands(id,actor_user_id,action,scope_kind,scope_key,input_digest,idempotency_key,correlation_id,status,expires_at) VALUES($1,$2,'project.update','project',$3,$4,$6,$5,'completed',now()+interval '1 hour')", [commandId, actorId, projectId, receipt.inputDigest, correlationId, commandId]);
  const metadata = Object.fromEntries(["projectId", "commandId", "inputDigest", "volumeKey", "destinationId", "archiveId", "archiveBytes", "entries", "archiveSha256", "manifestSha256", "consistency", "status"].map(key => [key, receipt[key as keyof typeof receipt]]));
  const createdAt = new Date(Date.now() - 1000);
  await pool.query("INSERT INTO audit_events(id,actor_user_id,action,target_type,target_id,request_id,correlation_id,metadata,created_at) VALUES($1,$2,'compose.volume.backup.executed','project',$3,$7,$4,$5,$6)", [auditId, actorId, projectId, correlationId, metadata, createdAt, auditId]);
  return {receipt, createdAt, auditId, actorId, metadata};
}
async function count(projectId: string) {
  return (await pool.query("SELECT count(*)::int AS count FROM backup_inventory WHERE project_id=$1", [projectId])).rows[0].count;
}
(enabled ? describe : describe.skip)("P5 backup inventory durable PostgreSQL acceptance", () => {
  beforeAll(async () => {
    databaseName = `deploylite_verify_p5_${randomUUID().replaceAll("-", "_")}`;
    const url = new URL(configured!); url.pathname = "/postgres";
    maintenance = new pg.Client({connectionString: url.toString()}); await maintenance.connect();
    await maintenance.query(`CREATE DATABASE "${databaseName}"`); url.pathname = `/${databaseName}`; databaseUrl = url.toString();
    const migrationClient = new pg.Client({connectionString: databaseUrl}); await migrationClient.connect();
    try { for (const file of (await readdir(new URL("../migrations/", import.meta.url))).filter(name => name.endsWith(".sql")).sort()) await migrationClient.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8")); }
    finally { await migrationClient.end(); }
    pool = createDbPool(databaseUrl, {max: 3});
  }, 30_000);
  afterAll(async () => {
    if (pool) await closeDbPool(pool);
    if (maintenance) { try { if (databaseName) await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); } finally { await maintenance.end(); } }
  }, 30_000);
  it("persists corroborated inventory across a new PostgreSQL pool lifecycle", async () => {
    const f = await seed(), original = await store().recordAuthenticatedReceipt(f.receipt);
    const fresh = createDbPool(databaseUrl, {max: 1});
    try { expect(await store(fresh).list(f.receipt.projectId, "data", "local-1")).toEqual([original]); }
    finally { await closeDbPool(fresh); }
    expect(original.createdAtMs).toBe(f.createdAt.getTime());
  });
  it("converges concurrent writers and authenticated replay to one immutable archive", async () => {
    const f = await seed();
    const results = await Promise.all([store().recordAuthenticatedReceipt(f.receipt), store().recordAuthenticatedReceipt(f.receipt)]);
    expect(results[0]).toEqual(results[1]);
    expect(await store().recordAuthenticatedReceipt({...f.receipt, status: "already-created", idempotent: true})).toEqual(results[0]);
    expect(await count(f.receipt.projectId)).toBe(1);
  });
  it("refuses incomplete command and mismatched audit without any inventory write", async () => {
    const f = await seed();
    await pool.query("UPDATE control_commands SET status='dispatching' WHERE id=$1", [f.receipt.commandId]);
    await expect(store().recordAuthenticatedReceipt(f.receipt)).rejects.toThrow("cannot be accepted safely");
    await pool.query("UPDATE control_commands SET status='completed' WHERE id=$1", [f.receipt.commandId]);
    await pool.query("UPDATE audit_events SET metadata=jsonb_set(metadata,'{archiveSha256}',to_jsonb($2::text)) WHERE id=$1", [f.auditId, "d".repeat(64)]);
    await expect(store().recordAuthenticatedReceipt(f.receipt)).rejects.toThrow("cannot be accepted safely");
    expect(await count(f.receipt.projectId)).toBe(0);
  });
  it("rejects competing archive evidence without overwriting the original command", async () => {
    const f = await seed(), original = await store().recordAuthenticatedReceipt(f.receipt);
    const competing = await seed(f.receipt.projectId, f.receipt.archiveId);
    await expect(store().recordAuthenticatedReceipt(competing.receipt)).rejects.toThrow("cannot be accepted safely");
    expect(await store().list(f.receipt.projectId, "data", "local-1")).toEqual([original]);
    expect(await count(f.receipt.projectId)).toBe(1);
  });
  it("corroborates the actual redacted project-update completion audit for canonical archive IDs", async () => {
    const f = await seed();
    f.receipt.archiveId = "backup_0123456789abcdef0123456789abcdef";
    f.metadata.archiveId = f.receipt.archiveId;
    await pool.query("DELETE FROM audit_events WHERE id=$1", [f.auditId]);
    await pool.query("UPDATE control_commands SET status='eligible' WHERE id=$1", [f.receipt.commandId]);
    const controls = new DbControlCommandRepository(createDbClient(pool));
    const command = await controls.findProjectUpdateByIdempotency(f.actorId, f.receipt.projectId, f.receipt.commandId);
    const claimed = await controls.claimProjectUpdate(command!);
    await controls.completeProjectUpdate(claimed.command, claimed.authority!, {actorUserId: f.actorId,
      action: "compose.volume.backup.executed", targetType: "project", targetId: f.receipt.projectId,
      requestId: randomUUID(), correlationId: f.receipt.correlationId, metadata: f.metadata});
    expect(redactSecrets(f.metadata).archiveId).toBe(f.receipt.archiveId);
    expect((await store().recordAuthenticatedReceipt(f.receipt)).receipt.archiveId).toBe(f.receipt.archiveId);
    expect(await count(f.receipt.projectId)).toBe(1);
  });
  it("enforces SQL receipt binding and keeps reads isolated to the complete scope", async () => {
    const f = await seed(); await store().recordAuthenticatedReceipt(f.receipt);
    await expect(pool.query("UPDATE backup_inventory SET receipt=jsonb_set(receipt,'{projectId}',to_jsonb($2::text)) WHERE project_id=$1", [f.receipt.projectId, randomUUID()])).rejects.toMatchObject({code: "23514"});
    await expect(pool.query("UPDATE backup_inventory SET created_at=to_timestamp(-1) WHERE project_id=$1", [f.receipt.projectId])).rejects.toMatchObject({code: "23514"});
    expect(await store().list(randomUUID(), "data", "local-1")).toEqual([]);
    expect(await store().list(f.receipt.projectId, "foreign", "local-1")).toEqual([]);
    expect(await store().list(f.receipt.projectId, "data", "foreign")).toEqual([]);
    expect(await count(f.receipt.projectId)).toBe(1);
  });
});
