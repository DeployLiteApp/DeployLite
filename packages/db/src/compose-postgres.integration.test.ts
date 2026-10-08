import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createComposePreview, prepareComposeRevisionSave, IdempotencyConflictError } from "@deploylite/domain";
import { createDbClient, createDbPool, closeDbPool } from "./client.js";
import { DbComposeRevisionSaveStore } from "./repositories/compose-revision-save.js";
import { DbControlCommandRepository } from "./repositories/control-plane.js";

// Same explicit disposable PostgreSQL opt-in as the existing suite. Never loaded with a local fallback URL.
const enabled = process.env.DEPLOYLITE_DB_INTEGRATION === "1";
const suite = enabled ? describe : describe.skip;
const configured = enabled ? process.env.DATABASE_URL : undefined;
if (enabled && !configured) throw new Error("DATABASE_URL is required for explicitly enabled Compose PostgreSQL integration.");
const policy = { policyVersion: "compose-pg-fixture", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true };
const document = JSON.stringify({ services: { web: { image: `registry.example.com/app@sha256:${"a".repeat(64)}`, environment: { TOKEN: "${APP_TOKEN}" } } } });
let maintenance: pg.Client, pool: pg.Pool, databaseName: string, databaseUrl: string;
const store = (options: ConstructorParameters<typeof DbComposeRevisionSaveStore>[1] = {}) => new DbComposeRevisionSaveStore(createDbClient(pool), options);
async function seed() {
  const actorId = randomUUID(), projectId = randomUUID();
  await pool.query("INSERT INTO users(id,email,email_normalized,password_hash,role_id) SELECT $1,$2,$2,'fixture',id FROM roles WHERE name='admin'", [actorId, `${actorId}@example.test`]);
  await pool.query("INSERT INTO projects(id,name,repo_url,default_branch) VALUES($1,'Compose fixture','https://example.test/repo','main')", [projectId]);
  const prepare = (overrides: Partial<Parameters<typeof prepareComposeRevisionSave>[0]> = {}) => {
    const nextDocument = overrides.document ?? document, nextProject = overrides.projectId ?? projectId;
    return prepareComposeRevisionSave({ document: nextDocument, projectId: nextProject, actorId, composeId: null, expectedRevisionId: null,
      expectedPreviewDigest: createComposePreview(nextDocument, nextProject, policy).configDigest, idempotencyKey: "p3-save-key", correlationId: randomUUID(), requestId: randomUUID(), now: new Date(), ...overrides }, policy);
  };
  return { actorId, projectId, prepare };
}
async function counts(projectId: string) {
  const result = await pool.query<{ resources: number; revisions: number; commands: number; audits: number; command_audits: number }>(`SELECT
    (SELECT count(*)::int FROM compose_resources WHERE project_id=$1) AS resources,
    (SELECT count(*)::int FROM compose_revisions WHERE project_id=$1) AS revisions,
    (SELECT count(*)::int FROM control_commands WHERE action='project.update' AND scope_key=$1::text) AS commands,
    (SELECT count(*)::int FROM audit_events WHERE target_id=$1::text AND action='compose.revision.saved') AS audits,
    (SELECT count(*)::int FROM control_command_audits a JOIN control_commands c ON c.id=a.command_id WHERE c.action='project.update' AND c.scope_key=$1::text) AS command_audits`, [projectId]);
  return result.rows[0]!;
}
suite("P3 Compose atomic durable acceptance on the explicit disposable database", () => {
  beforeAll(async () => {
    databaseName = `deploylite_verify_p3_${randomUUID().replaceAll("-", "_")}`;
    const url = new URL(configured!); url.pathname = "/postgres"; maintenance = new pg.Client({ connectionString: url.toString() }); await maintenance.connect();
    await maintenance.query(`CREATE DATABASE "${databaseName}"`); url.pathname = `/${databaseName}`; databaseUrl = url.toString();
    const client = new pg.Client({ connectionString: databaseUrl }); await client.connect();
    try { for (const file of (await readdir(new URL("../migrations/", import.meta.url))).filter((name) => name.endsWith(".sql")).sort()) await client.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8")); }
    finally { await client.end(); }
    pool = createDbPool(databaseUrl, { max: 2 });
  }, 30_000);
  afterAll(async () => {
    if (pool) await closeDbPool(pool);
    if (maintenance) { try { if (databaseName) await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); } finally { await maintenance.end(); } }
  }, 30_000);
  it("persists one owned resource/revision/shared result and two safe audit projections", async () => {
    const f = await seed(), saved = await store().save(f.prepare()); expect(saved.revision).toMatchObject({ projectId: f.projectId, createdBy: f.actorId, number: 1 });
    expect(await counts(f.projectId)).toEqual({ resources: 1, revisions: 1, commands: 1, audits: 1, command_audits: 1 });
    expect(await store().listResources(f.projectId, { limit: 20, offset: 0 })).toMatchObject({ total: 1, resources: [{ id: saved.revision.composeId, latestRevisionId: saved.revision.id, serviceNames: ["web"] }] });
    const audit = await pool.query("SELECT metadata FROM audit_events WHERE target_id=$1", [f.projectId]); expect(JSON.stringify(audit.rows)).not.toContain("APP_TOKEN"); expect(JSON.stringify(audit.rows)).not.toContain("canonicalDocument");
  });
  it("resolves two concurrent identical requests to one original command/revision/audit", async () => {
    const f = await seed(), outcomes = await Promise.all([store().save(f.prepare()), store().save(f.prepare())]);
    expect(outcomes[0]!.revision).toEqual(outcomes[1]!.revision); expect(outcomes.map((result) => result.idempotent).sort()).toEqual([false, true]); expect(await counts(f.projectId)).toEqual({ resources: 1, revisions: 1, commands: 1, audits: 1, command_audits: 1 });
  });
  it("commits exactly one competing update and rolls back the losing command reservation", async () => {
    const f = await seed(), first = await store().save(f.prepare());
    const outcomes = await Promise.allSettled(["next-a", "next-b"].map((idempotencyKey) => store().save(f.prepare({ composeId: first.revision.composeId, expectedRevisionId: first.revision.id, idempotencyKey }))));
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1); expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await counts(f.projectId)).toEqual({ resources: 1, revisions: 2, commands: 2, audits: 2, command_audits: 2 }); expect(await store().findRevision(f.projectId, first.revision.id)).toEqual(first.revision);
  });
  it("rejects different canonical input under a used idempotency key without extra writes", async () => {
    const f = await seed(); await store().save(f.prepare()); await expect(store().save(f.prepare({ document: document.replace("a".repeat(64), "b".repeat(64)) }))).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await counts(f.projectId)).toEqual({ resources: 1, revisions: 1, commands: 1, audits: 1, command_audits: 1 });
  });
  it("refuses a foreign logical owner without a command, revision or audit in that project", async () => {
    const owner = await seed(), foreign = await seed(), first = await store().save(owner.prepare());
    await expect(store().save(foreign.prepare({ composeId: first.revision.composeId, expectedRevisionId: first.revision.id }))).rejects.toThrow();
    expect(await counts(foreign.projectId)).toEqual({ resources: 0, revisions: 0, commands: 0, audits: 0, command_audits: 0 });
  });
  it.each(["revision-inserted", "command-completed", "audit-recorded"] as const)("rolls back real PostgreSQL effects after injected %s failure and allows exact retry", async (stage) => {
    const f = await seed(), prepared = f.prepare();
    await expect(store({ injectFault: (observed) => { if (observed === stage) throw new Error("fixture_literal_secret"); } }).save(prepared)).rejects.toThrow();
    expect(await counts(f.projectId)).toEqual({ resources: 0, revisions: 0, commands: 0, audits: 0, command_audits: 0 });
    expect((await store().save(prepared)).commandId).toBe(prepared.command.id);
  });
  it("retains saved data across a fresh pool/client lifecycle and replays read-only", async () => {
    const f = await seed(), first = await store().save(f.prepare()); await closeDbPool(pool); pool = createDbPool(databaseUrl, { max: 2 });
    expect(await store().findRevision(f.projectId, first.revision.id)).toEqual(first.revision); expect(await store().save(f.prepare())).toEqual({ ...first, idempotent: true }); expect((await counts(f.projectId)).audits).toBe(1);
  });
  it("rejects an expired eligible reservation with a full transaction rollback", async () => {
    const f = await seed(), prepared = f.prepare(); prepared.command.expiresAt = new Date(Date.now() - 1); await expect(store().save(prepared)).rejects.toThrow();
    expect(await counts(f.projectId)).toEqual({ resources: 0, revisions: 0, commands: 0, audits: 0, command_audits: 0 });
  });
  it.each(["missing", "executable", "string-false"] as const)("rejects %s preview fields in the actual SQL safety constraint", async (variant) => {
    const f = await seed(), first = await store().save(f.prepare()), prepared = f.prepare({ composeId: first.revision.composeId, expectedRevisionId: first.revision.id, idempotencyKey: "bad-preview" });
    await new DbControlCommandRepository(createDbClient(pool)).resolve(prepared.command);
    const preview = variant === "missing" ? {} : { ...prepared.preview, executionAllowed: variant === "executable" ? true : "false" };
    await expect(pool.query("INSERT INTO compose_revisions(id,compose_id,project_id,number,created_by,created_at,preview) VALUES($1,$2,$3,2,$4,now(),$5)", [prepared.command.id, first.revision.composeId, f.projectId, f.actorId, JSON.stringify(preview)])).rejects.toThrow();
  });
});
