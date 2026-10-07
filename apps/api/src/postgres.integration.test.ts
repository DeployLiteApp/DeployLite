import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { closeDbPool, createDbClient, createDbPool, DbAgentRepository, DbAgentReplayStore, DbControlCommandRepository, DbDeploymentRepository, DbProjectRepository, type DeployLiteDb } from "@deploylite/db";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { dockerImageExecutionReceiptSchema, trustedPriorExecutionReceiptSchema, type TrustedPriorExecutionReceiptV1 } from "@deploylite/contracts";
import { buildApiApp, type DeploymentDispatcher, type DeploymentStopDispatcher } from "./app.js";

const integrationEnabled = process.env.DEPLOYLITE_API_POSTGRES_INTEGRATION === "1";
const describeIntegration = integrationEnabled ? describe : describe.skip;
const configuredDatabaseUrl = integrationEnabled ? requireIntegrationDatabaseUrl() : "";
const contentHeaders = { "content-type": "application/json" };
const adminPassword = "test_fixture_admin_password";

let maintenancePool: ReturnType<typeof createDbPool> | null = null;
let pool: ReturnType<typeof createDbPool> | null = null;
let db: DeployLiteDb | null = null;
let databaseName = "";
let databaseUrl = "";

describeIntegration("DeployLite API PostgreSQL integration", () => {
  beforeAll(async () => {
    databaseName = `deploylite_api_verify_${randomUUID().replaceAll("-", "_")}`;

    const maintenanceUrl = new URL(configuredDatabaseUrl);
    maintenanceUrl.pathname = "/postgres";
    maintenancePool = createDbPool(maintenanceUrl.toString(), { max: 1 });
    await maintenancePool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

    const testDatabaseUrl = new URL(configuredDatabaseUrl);
    testDatabaseUrl.pathname = `/${databaseName}`;
    databaseUrl = testDatabaseUrl.toString();

    await applyMigrations(databaseUrl);
    pool = createDbPool(databaseUrl, { max: 2 });
    db = createDbClient(pool);
  }, 30_000);

  afterAll(async () => {
    if (pool) {
      await closeDbPool(pool);
      pool = null;
      db = null;
    }

    if (maintenancePool && databaseName) {
      await maintenancePool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
      await closeDbPool(maintenancePool);
      maintenancePool = null;
    }
  }, 30_000);

  it("verifies bootstrap, restart-stable login, logout revocation, metadata persistence, and log reads", async () => {
    const firstApp = await createPostgresApp();

    const status = await firstApp.inject({ method: "GET", url: "/api/v1/bootstrap/status" });
    expect(status.statusCode).toBe(200);
    expect(status.json().data).toEqual({ setupRequired: true });

    const bootstrap = await firstApp.inject({
      method: "POST",
      url: "/api/v1/bootstrap/initial-admin",
      headers: contentHeaders,
      payload: { email: "Admin@Example.TEST", password: adminPassword }
    });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json().data.user).toMatchObject({ email: "Admin@Example.TEST", role: "admin", status: "active" });

    const locked = await firstApp.inject({ method: "GET", url: "/api/v1/bootstrap/status" });
    expect(locked.json().data).toEqual({ setupRequired: false });

    const login = await firstApp.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: contentHeaders,
      payload: { email: "admin@example.test", password: adminPassword }
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.headers["set-cookie"] as string;
    expect(cookie).toContain("dl_pg_session=");

    const projectId = randomUUID();
    const agentId = randomUUID();
    const deploymentId = randomUUID();
    await new DbProjectRepository(requireDb()).save({
      id: projectId,
      name: "PostgreSQL project",
      repoUrl: "https://github.com/example/deploylite-postgres",
      defaultBranch: "main",
      buildCommand: "pnpm build",
      runCommand: "pnpm start",
      port: 3000,
      description: null,
      imageTag: null
    });
    await new DbAgentRepository(requireDb()).save({
      id: agentId,
      name: "PostgreSQL agent",
      endpoint: "https://agent.postgres.test",
      status: "online",
      lastHeartbeatAt: null,
      resourceSnapshot: null
    });
    const deploymentsRepo = new DbDeploymentRepository(requireDb());
    await deploymentsRepo.save({
      id: deploymentId,
      projectId,
      agentId,
      status: "running",
      commitSha: "abcdef1234567890",
      startedAt: new Date().toISOString(),
      finishedAt: null
    });
    await deploymentsRepo.appendLog({
      id: randomUUID(),
      deploymentId,
      sequence: 1,
      level: "info",
      message: "PostgreSQL integration log token dl_fixture_token_1234567890abcdef should be redacted",
      timestamp: new Date().toISOString(),
      redactionApplied: false,
      requestId: "req_api_pg_integration",
      correlationId: "corr_api_pg_integration"
    });

    await firstApp.close();
    const restartedApp = await createPostgresApp();

    const meAfterRestart = await restartedApp.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie } });
    expect(meAfterRestart.statusCode).toBe(200);
    expect(meAfterRestart.json().data.user.email).toBe("Admin@Example.TEST");

    const projects = await restartedApp.inject({ method: "GET", url: "/api/v1/projects", headers: { cookie } });
    const agents = await restartedApp.inject({ method: "GET", url: "/api/v1/agents", headers: { cookie } });
    const deployments = await restartedApp.inject({ method: "GET", url: "/api/v1/deployments", headers: { cookie } });
    const logs = await restartedApp.inject({ method: "GET", url: `/api/v1/deployments/${deploymentId}/logs`, headers: { cookie } });

    expect(projects.json().data.projects).toEqual([expect.objectContaining({ id: projectId, name: "PostgreSQL project" })]);
    expect(agents.json().data.agents).toEqual([expect.objectContaining({ id: agentId, name: "PostgreSQL agent" })]);
    expect(deployments.json().data.deployments).toEqual([expect.objectContaining({ id: deploymentId, projectId, agentId })]);
    expect(logs.json().data.events).toEqual([
      expect.objectContaining({ deploymentId, sequence: 1, message: expect.stringContaining("[REDACTED]"), redactionApplied: true })
    ]);
    expect(JSON.stringify(logs.json())).not.toContain("dl_fixture_token_1234567890abcdef");

    const logout = await restartedApp.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie } });
    expect(logout.statusCode).toBe(200);
    const afterLogout = await restartedApp.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie } });
    expect(afterLogout.statusCode).toBe(401);

    await restartedApp.close();
  }, 30_000);

  it("persists the confirmed delete command and correlated audit while making replay idempotent", async () => {
    const app = await createPostgresApp();
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: contentHeaders, payload: { email: "admin@example.test", password: adminPassword } });
    const cookie = login.headers["set-cookie"] as string;
    const actorId = login.json().data.user.id as string;
    const projectId = randomUUID();
    await new DbProjectRepository(requireDb()).save({ id: projectId, name: "Confirmed PostgreSQL project", repoUrl: "https://github.com/example/confirmed-postgres", defaultBranch: "main", buildCommand: null, runCommand: null, port: null, description: null, imageTag: null });

    const noGrantHeaders = { cookie, "x-control-idempotency-key": "postgres-delete-without-grant" };
    const denied = await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}`, headers: noGrantHeaders });
    expect(denied.statusCode).toBe(403);
    await expect(requirePool().query("SELECT id FROM control_commands WHERE idempotency_key = $1", [noGrantHeaders["x-control-idempotency-key"]])).resolves.toMatchObject({ rowCount: 0 });

    await requirePool().query("INSERT INTO control_grants (actor_user_id, action, scope_kind, scope_key) VALUES ($1, 'project.delete', 'project', $2)", [actorId, projectId]);
    const headers = { cookie, "x-control-idempotency-key": "postgres-confirmed-delete" };

    const pending = await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}`, headers });
    expect(pending.statusCode).toBe(202);
    const { commandId, confirmationId } = pending.json().data;

    const completed = await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}`, headers: { ...headers, "x-control-confirmation-id": confirmationId } });
    expect(completed.statusCode).toBe(200);
    const replay = await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}`, headers: { ...headers, "x-control-confirmation-id": confirmationId } });
    expect(replay.json().data).toMatchObject({ removed: true, commandId, idempotent: true });

    const audit = await requirePool().query<{ outcome: string; correlation_id: string; consumed_at: Date | null; status: string }>("SELECT a.outcome, a.correlation_id, c.consumed_at, cmd.status FROM control_command_audits a JOIN control_command_confirmations c ON c.id = a.confirmation_id JOIN control_commands cmd ON cmd.id = a.command_id WHERE a.command_id = $1", [commandId]);
    expect(audit.rows).toEqual([expect.objectContaining({ outcome: "completed", status: "completed", consumed_at: expect.any(Date) })]);
    expect(audit.rows[0]?.correlation_id).toBeTruthy();
    await expect(requirePool().query("SELECT id FROM audit_events WHERE correlation_id = $1 AND action = 'project.delete' AND target_id = $2", [audit.rows[0]?.correlation_id, projectId])).resolves.toMatchObject({ rowCount: 1 });
    await expect(requirePool().query("SELECT id FROM projects WHERE id = $1", [projectId])).resolves.toMatchObject({ rowCount: 0 });
    await app.close();
  }, 30_000);

  it("persists synthetic-observation INITIAL and repeated redeploy atomically through default PostgreSQL repositories", async () => {
    const fixture = await postgresExecutionFixture();
    let app = fixture.app;
    try {
      const initial = await fixture.initial();
      expect(initial.statusCode, initial.body).toBe(200);
      const a = initial.json().data.deployment;
      const snapshotHash = initial.json().data.snapshotHash as string;
      expect(a.id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
      const second = await confirmedPostgresRedeploy(app, fixture.cookie, a.id, snapshotHash);
      expect(second.response.statusCode, second.response.body).toBe(200);
      const b = second.response.json().data.deployment;
      const third = await confirmedPostgresRedeploy(app, fixture.cookie, b.id, snapshotHash);
      expect(third.response.statusCode, third.response.body).toBe(200);
      const c = third.response.json().data.deployment;
      expect(new Set([a.id, b.id, c.id]).size).toBe(3);
      const rows = await requirePool().query("SELECT id,status,snapshot_hash,metadata,execution_receipt FROM deployments WHERE project_id=$1", [fixture.projectId]);
      expect(rows.rowCount).toBe(3);
      for (const row of rows.rows) {
        expect(row).toMatchObject({ status: "succeeded", snapshot_hash: snapshotHash, metadata: { snapshotOriginId: a.id },
          execution_receipt: { deploymentId: row.id, snapshotOriginId: a.id, snapshotHash, runtimeHost: fixture.agentId } });
      }
      expect(rows.rows.find((row) => row.id === b.id).metadata.sourceDeploymentId).toBe(a.id);
      expect(rows.rows.find((row) => row.id === c.id).metadata.sourceDeploymentId).toBe(b.id);
      expect(new Set(rows.rows.map((row) => row.execution_receipt.containerId)).size).toBe(3);
      const commands = await requirePool().query("SELECT id,status,result,execution_authority FROM control_commands WHERE scope_kind='deployment' AND scope_key::jsonb->>0=$1", [fixture.projectId]);
      expect(commands.rowCount).toBe(2);
      for (const row of commands.rows) {
        expect(row).toMatchObject({ status: "completed", result: { status: "completed", snapshotHash }, execution_authority: { commandId: row.id, projectId: fixture.projectId } });
      }
      expect(commands.rows.find((row) => row.id === third.commandId).execution_authority.sourceLease.deploymentId).toBe(b.id);
      expect((await fixture.initial()).json().data).toMatchObject({ replayed: true, deployment: { id: a.id } });
      expect(fixture.observations).toHaveLength(3);
      const canonical = await new DbDeploymentRepository(requireDb()).findByHash(snapshotHash);
      expect(canonical).toMatchObject({ deploymentId: a.id, projectId: fixture.projectId, hash: snapshotHash });
      const persisted = structuredClone(rows.rows);
      await app.close();
      await closeDbPool(requirePool());
      pool = createDbPool(databaseUrl, { max: 2 }); db = createDbClient(pool);
      app = await createPostgresApp(); // unavailable transport: completed replay must precede mutable dispatch availability.
      const replay = await second.replay(app);
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json().data).toMatchObject({ idempotent: true, deploymentId: b.id, command: { status: "completed" } });
      expect((await second.replay(app, "a".repeat(64))).statusCode).toBe(409);
      expect((await requirePool().query("SELECT id,status,snapshot_hash,metadata,execution_receipt FROM deployments WHERE project_id=$1", [fixture.projectId])).rows).toEqual(expect.arrayContaining(persisted));
      expect(fixture.observations).toHaveLength(3);
    } finally { await app.close(); }
  }, 30_000);

  it("keeps default PostgreSQL replacement and authority unresolved after a synthetic lost terminal reply", async () => {
    const fixture = await postgresExecutionFixture();
    try {
      const initial = await fixture.initial(); expect(initial.statusCode, initial.body).toBe(200);
      fixture.loseReplacementReply();
      const second = await confirmedPostgresRedeploy(fixture.app, fixture.cookie, initial.json().data.deployment.id, initial.json().data.snapshotHash);
      expect(second.response.statusCode, second.response.body).toBe(502);
      expect(second.response.json().error.code).toBe("REDEPLOY_OUTCOME_UNKNOWN");
      const before = await requirePool().query("SELECT d.id,d.status,d.execution_receipt,d.finished_at,c.status AS command_status,c.execution_authority FROM control_commands c JOIN deployments d ON d.id=(c.result->>'deploymentId')::uuid WHERE c.id=$1", [second.commandId]);
      expect(before.rows).toEqual([expect.objectContaining({ status: "running", execution_receipt: null, finished_at: null,
        command_status: "dispatching", execution_authority: expect.objectContaining({ commandId: second.commandId, projectId: fixture.projectId }) })]);
      const replay = await second.replay();
      expect(replay.statusCode, replay.body).toBe(202);
      expect(replay.json().data).toMatchObject({ pending: true, command: { status: "dispatching" } });
      expect((await requirePool().query("SELECT d.id,d.status,d.execution_receipt,d.finished_at,c.status AS command_status,c.execution_authority FROM control_commands c JOIN deployments d ON d.id=(c.result->>'deploymentId')::uuid WHERE c.id=$1", [second.commandId])).rows).toEqual(before.rows);
      expect(fixture.observations).toHaveLength(1);
    } finally { await fixture.app.close(); }
  }, 30_000);

  it.each(["initial", "redeploy"] as const)("retains default PostgreSQL running state and no terminal proof after an actual terminal trigger fault (%s)", async (kind) => {
    const fixture = await postgresExecutionFixture();
    const trigger = `api_terminal_fault_${randomUUID().replaceAll("-", "")}`;
    const table = kind === "initial" ? "deployments" : "control_commands";
    let installed = false;
    try {
      let sourceId = "", snapshotHash = "";
      if (kind === "redeploy") {
        const initial = await fixture.initial(); expect(initial.statusCode, initial.body).toBe(200);
        sourceId = initial.json().data.deployment.id; snapshotHash = initial.json().data.snapshotHash;
      }
      await requirePool().query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'API terminal fault'; END $$`);
      const condition = kind === "initial" ? `OLD.project_id='${fixture.projectId}'::uuid AND NEW.status='succeeded'`
        : `(OLD.scope_key::jsonb->>0)='${fixture.projectId}' AND NEW.status='completed'`;
      await requirePool().query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON ${table} FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION ${trigger}()`);
      installed = true;
      const response = kind === "initial" ? await fixture.initial()
        : (await confirmedPostgresRedeploy(fixture.app, fixture.cookie, sourceId, snapshotHash)).response;
      expect(response.statusCode, response.body).toBe(500);
      const rows = await requirePool().query("SELECT id,status,execution_receipt,finished_at FROM deployments WHERE project_id=$1 AND status='running'", [fixture.projectId]);
      expect(rows.rows).toEqual([{ id: expect.any(String), status: "running", execution_receipt: null, finished_at: null }]);
      const commands = await requirePool().query("SELECT status,execution_authority FROM control_commands WHERE scope_kind='deployment' AND scope_key::jsonb->>0=$1", [fixture.projectId]);
      if (kind === "initial") expect(commands.rowCount).toBe(0);
      else expect(commands.rows).toEqual([{ status: "dispatching", execution_authority: expect.objectContaining({ projectId: fixture.projectId }) }]);
      expect((await requirePool().query("SELECT id FROM deployment_logs WHERE deployment_id=$1 AND sequence=2", [rows.rows[0].id])).rowCount).toBe(0);
    } finally {
      if (installed) await requirePool().query(`DROP TRIGGER ${trigger} ON ${table}`);
      await requirePool().query(`DROP FUNCTION IF EXISTS ${trigger}()`);
      await fixture.app.close();
    }
  }, 30_000);

  it("executes default PostgreSQL A/H/R with stable original confirmation and immutable history", async () => {
    const f = await signedPostgresFixture();
    try {
      const { A, H } = await f.prepareAhr(), before = structuredClone([A, H]), pending = await f.rollback(A, H);
      expect(pending.statusCode, pending.body).toBe(202); const R = pending.json().data.deploymentId;
      const response = await f.rollback(A, H, pending.json().data.confirmationId); expect(response.statusCode, response.body).toBe(200);
      const result = response.json().data.deployment;
      expect(result).toMatchObject({ id: R, activeDeploymentId: A.id, sourceDeploymentId: H.id, snapshotOriginId: H.snapshotOriginId, snapshotHash: H.snapshotHash, status: "succeeded", executionReceipt: { containerId: f.docker.containers.get(`deploylite-active-${R}`)!.id, effectiveImageDigest: f.images.h.split("@")[1] } });
      expect(f.bodies.find((body) => body.authority?.action === "deployment.rollback")).toMatchObject({ activeDeploymentId: A.id, sourceDeploymentId: H.id, authority: { sourceLease: { deploymentId: A.id } }, replacement: { prior: A.executionReceipt, effectiveImage: f.images.a } });
      const repository = new DbDeploymentRepository(requireDb()); expect(await Promise.all(before.map((value) => repository.findById(value.id)))).toEqual(before);
      expect((await repository.findByHash(H.snapshotHash))!).toMatchObject({ configRevision: "default", runtimeRevision: "default", secretRefs: [] });
      const effects=f.counts(); expect((await f.rollback(A,H)).statusCode).toBe(200); expect(f.counts()).toEqual(effects);
      const stop=await f.control("stop",result,"stop-R");expect(stop.statusCode,stop.body).toBe(200);expect(await repository.findById(R)).toEqual(result);
    } finally { await f.app.close(); }
  }, 30_000);
  it.each(["INITIAL", "redeploy", "rollback", "Stop"] as const)("reconciles original cached %s receipt through signed receiver and default PostgreSQL repositories", async (kind) => {
    const f = await signedPostgresFixture();
    let trigger: string | undefined;
    try {
      let call: (requestId?: string) => ReturnType<typeof f.initial>, executionId="", commandId: string | null=null;
      if (kind === "INITIAL") { f.lose("initial"); call=(requestId)=>f.initial("a","lost-A",requestId); }
      else {
        const { A,H }=kind==="rollback" ? await f.prepareAhr() : { A:(await f.initial()).json().data.deployment,H:null };
        if(kind==="Stop") { const pending=await f.request("stop",A,"lost-stop"); commandId=pending.json().data.commandId; executionId=A.id; call=(id)=>f.request("stop",A,"lost-stop",pending.json().data.confirmationId,id);f.lose("stop"); }
        else if(kind==="redeploy") { const pending=await f.request("redeploy",A,"lost-B");commandId=pending.json().data.commandId;call=(id)=>f.request("redeploy",A,"lost-B",pending.json().data.confirmationId,id);f.lose("redeploy"); }
        else { const pending=await f.rollback(A,H);commandId=pending.json().data.commandId;executionId=pending.json().data.deploymentId;call=(id)=>f.rollback(A,H,pending.json().data.confirmationId,id);f.lose("rollback"); }
      }
      const unknown=await call("original-request");expect(unknown.statusCode,unknown.body).toBe(502);
      if(kind==="INITIAL")executionId=(await requirePool().query("SELECT id FROM deployments WHERE project_id=$1",[f.projectId])).rows[0].id;
      else if(kind==="redeploy")executionId=(await requirePool().query("SELECT result->>'deploymentId' AS id FROM control_commands WHERE id=$1",[commandId])).rows[0].id;
      const previous = (await requirePool().query("SELECT status,execution_receipt,finished_at FROM deployments WHERE id=$1",[executionId])).rows;
      expect(previous).toEqual([expect.objectContaining({status:kind==="Stop"?"succeeded":"running",finished_at:kind==="Stop"?expect.any(Date):null})]);
      const before=f.counts(), cacheBefore=(await requirePool().query("SELECT * FROM agent_replay WHERE command_id=$1",[kind==="Stop"?commandId:`deploy_${executionId}`])).rows;
      expect(cacheBefore).toHaveLength(1);expect(cacheBefore[0].status).toBe("completed");f.enableCache();
      if(kind==="rollback") {
        trigger=`pg_cache_fault_${randomUUID().replaceAll("-","")}`;
        await requirePool().query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'cached terminal fault'; END $$`);
        await requirePool().query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON control_commands FOR EACH ROW WHEN (OLD.id='${commandId}'::uuid) EXECUTE FUNCTION ${trigger}()`);
        const failed=await call("storage-retry");expect(failed.statusCode,failed.body).toBe(500);expect(f.counts()).toEqual(before);
        expect((await requirePool().query("SELECT status,execution_receipt,finished_at FROM deployments WHERE id=$1",[executionId])).rows).toEqual(previous);
        await requirePool().query(`DROP TRIGGER ${trigger} ON control_commands`);await requirePool().query(`DROP FUNCTION ${trigger}()`);trigger=undefined;
      }
      const recovered=await call("fresh-retry-request");expect(recovered.statusCode,recovered.body).toBe(200);expect(f.counts()).toEqual(before);
      expect((await requirePool().query("SELECT * FROM agent_replay WHERE command_id=$1",[kind==="Stop"?commandId:`deploy_${executionId}`])).rows).toEqual(cacheBefore);
      const query=f.bodies.at(-1)!;expect(query.commandId).toBe(kind==="Stop"?commandId:`deploy_${executionId}`);
      const logs=await new DbDeploymentRepository(requireDb()).listLogs(executionId);expect(logs).toEqual(expect.arrayContaining([expect.objectContaining({requestId:"fresh-retry-request",correlationId:query.correlationId})]));
      const committed=(await requirePool().query("SELECT status,execution_receipt,finished_at FROM deployments WHERE id=$1",[executionId])).rows;
      expect(committed[0]).toMatchObject({status:"succeeded",execution_receipt:expect.any(Object)});
      expect((await call("completed-replay")).statusCode).toBe(200);expect(f.counts()).toEqual(before);
      expect((await requirePool().query("SELECT status,execution_receipt,finished_at FROM deployments WHERE id=$1",[executionId])).rows).toEqual(committed);
    } finally { if(trigger){await requirePool().query(`DROP TRIGGER IF EXISTS ${trigger} ON control_commands`);await requirePool().query(`DROP FUNCTION IF EXISTS ${trigger}()`);}await f.app.close(); }
  }, 30_000);
  it("retries the same queued unclaimed PostgreSQL rollback after claim contention without new reservation", async () => {
    const f=await signedPostgresFixture(true);
    try {
      const {A,H}=await f.prepareAhr(); f.armClaimFault(); const pending=await f.rollback(A,H), R=pending.json().data.deploymentId, before=f.counts();
      const failed=await f.rollback(A,H,pending.json().data.confirmationId);expect(failed.statusCode,failed.body).toBe(500);expect(f.counts()).toEqual(before);
      const row=(await requirePool().query("SELECT status,result,execution_authority FROM control_commands WHERE id=$1",[pending.json().data.commandId])).rows[0];expect(row).toMatchObject({status:"eligible",execution_authority:null,result:{deploymentId:R}});
      const retried=await f.rollback(A,H);expect(retried.statusCode,retried.body).toBe(200);expect(retried.json().data.deployment.id).toBe(R);
      expect((await requirePool().query("SELECT id FROM deployments WHERE id=$1",[R])).rowCount).toBe(1);
      expect((await requirePool().query("SELECT id FROM control_commands WHERE action='deployment.rollback' AND scope_key::jsonb->>0=$1",[f.projectId])).rowCount).toBe(1);
    } finally {await f.app.close();}
  },30_000);

});

async function createPostgresApp(deploymentDispatcher?: DeploymentDispatcher, deploymentStopDispatcher?: DeploymentStopDispatcher, controlRollback?: DbControlCommandRepository): Promise<FastifyInstance> {
  return buildApiApp({
    authConfig: { cookieName: "dl_pg_session", cookieSecure: false, sessionTtlSeconds: 3600 },
    db: { pool: requirePool(), client: requireDb() },
    state: deploymentDispatcher ? { deploymentDispatcher, ...(deploymentStopDispatcher ? { deploymentStopDispatcher } : {}), ...(controlRollback ? { controlRollback } : {}) } : undefined,
    env: { ...process.env, NODE_ENV: "test", DATABASE_URL: databaseUrl, DEPLOYLITE_AGENT_URL: undefined, DEPLOYLITE_AGENT_TRUST_KEY: undefined, DEPLOYLITE_AGENT_ID: undefined, DEPLOYLITE_BCRYPT_COST: "10", DEPLOYLITE_CONTROL_PLANE_CONFIRMED_DELETE: "true" }
  });
}


// The only synthetic boundary is Docker observation/dispatch. All default repositories use this fixture PostgreSQL DB.
const executionImage = `registry.example.com/pg-acceptance/app@sha256:${"b".repeat(64)}`;

async function postgresExecutionFixture() {
  const projectId = randomUUID(), agentId = randomUUID(), initialKey = randomUUID();
  const observations: TrustedPriorExecutionReceiptV1[] = [];
  let loseReplacementReply = false;
  const dispatcher: DeploymentDispatcher = {
    available: () => true,
    async dispatch(snapshot, commandId, context) {
      if (!context?.agentId) throw new Error("Expected selected configured agent");
      expect(snapshot.hash).toBe(createHash("sha256").update(snapshot.canonicalBytes).digest("hex"));
      if (context.authority) await new DbControlCommandRepository(requireDb()).validateDeploymentAuthority(context.authority);
      if (context.executionDeploymentId && loseReplacementReply) throw new Error("synthetic lost terminal reply");
      const executionId = context.executionDeploymentId ?? snapshot.deploymentId;
      const candidateId = `${executionId}:candidate:${commandId}`;
      const proof = trustedPriorExecutionReceiptSchema.parse({ schemaVersion: 1, candidateId, deploymentId: executionId,
        projectId: snapshot.projectId, snapshotOriginId: snapshot.deploymentId, snapshotHash: snapshot.hash,
        effectiveImageDigest: `sha256:${"b".repeat(64)}`, runtimeHost: context.agentId,
        container: `synthetic-active-${executionId}`, containerId: `synthetic-container-${executionId}`,
        hostPort: 49170, containerPort: snapshot.runtimePort, network: null });
      observations.push(structuredClone(proof));
      const receipt = dockerImageExecutionReceiptSchema.parse({ deploymentId: executionId, candidateId,
        effectiveImage: executionImage, runtimePort: snapshot.runtimePort,
        runtimeConfig: { hostPort: 49170, containerPort: snapshot.runtimePort }, executionReceipt: proof,
        health: "passed", terminalStatus: "succeeded", rollback: { target: null, result: "not-required" }, proven: true });
      return context.sourceDeploymentId ? { ...receipt, projectId: snapshot.projectId,
        sourceDeploymentId: context.sourceDeploymentId, snapshotHash: snapshot.hash, correlationId: context.correlationId } : receipt;
    }
  };
  const app = await createPostgresApp(dispatcher);
  try {
    const setup = await app.inject({ method: "GET", url: "/api/v1/bootstrap/status" });
    if (setup.json().data.setupRequired) {
      expect((await app.inject({ method: "POST", url: "/api/v1/bootstrap/initial-admin", headers: contentHeaders,
        payload: { email: "Admin@Example.TEST", password: adminPassword } })).statusCode).toBe(200);
    }
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: contentHeaders,
      payload: { email: "admin@example.test", password: adminPassword } });
    expect(login.statusCode, login.body).toBe(200);
    const cookie = login.headers["set-cookie"] as string;
    const actorId = login.json().data.user.id as string;
    await new DbProjectRepository(requireDb()).save({ id: projectId, name: "Execution PostgreSQL fixture",
      repoUrl: "https://example.test/pg-execution", defaultBranch: "main", buildCommand: null, runCommand: null,
      port: 8080, description: null, imageTag: null });
    await new DbAgentRepository(requireDb()).save({ id: agentId, name: "Synthetic observation agent",
      endpoint: "https://agent.fixture.test", status: "online", lastHeartbeatAt: new Date().toISOString(), resourceSnapshot: null });
    await requirePool().query("INSERT INTO control_grants (actor_user_id,action,scope_kind,scope_key) VALUES ($1,'deployment.redeploy','platform','platform') ON CONFLICT (actor_user_id,action,scope_kind,scope_key) DO NOTHING", [actorId]);
    const initial = (target = app) => target.inject({ method: "POST", url: `/api/v1/projects/${projectId}/deployments`,
      headers: { ...contentHeaders, cookie, "x-deployment-idempotency-key": initialKey },
      payload: { imageReference: executionImage, agentId, commitSha: "abcdef1" } });
    return { app, cookie, actorId, projectId, agentId, initial, observations,
      loseReplacementReply: () => { loseReplacementReply = true; } };
  } catch (error) {
    await app.close();
    throw error;
  }
}

async function signedPostgresFixture(claimFault=false) {
  const [{AuthenticatedAgentCommandReceiver,DigestDeploymentDispatcher},{InMemoryProtocolTransport},{AuthenticatedAgentDeploymentTransport},{createPromotionDockerRunner}]=await Promise.all([import("@deploylite/agent"),import("@deploylite/domain"),import("./agent-transport.js"),import("./testing/promotion-docker-runner.js")]);
  const projectId=randomUUID(),agentId=randomUUID(),docker=createPromotionDockerRunner(),images={a:`registry.example.com/pg/app@sha256:${"e".repeat(64)}`,h:`registry.example.com/pg/app@sha256:${"f".repeat(64)}`};
  // Decorate only synthetic image observations so H and A have distinct config IDs, just as the real two-image Docker lane requires.
  const runner={run:async (...args:Parameters<typeof docker.runner.run>)=>{const result=await docker.runner.run(...args),argv=args[0];
    if(argv[1]==="image")return {...result,stdout:JSON.stringify(`sha256:${createHash("sha256").update(argv.at(-1)!).digest("hex")}`)};
    if(argv[1]==="container" && result.exitCode===0){const value=JSON.parse(result.stdout);if(value.imageId)value.imageId=`sha256:${createHash("sha256").update(value.effectiveImage).digest("hex")}`;return {...result,stdout:JSON.stringify(value)};}return result;}};
  let fault=false;const controls=new DbControlCommandRepository(requireDb(),async(stage)=>{if(fault&&stage==="authority-claimed"){fault=false;throw new Error("queued rollback claim fault");}});
  const dispatcher=new DigestDeploymentDispatcher({protocol:new InMemoryProtocolTransport({clock:{now:Date.now},leasePolicy:{ttlMs:180_000},retryPolicy:{maxAttempts:1,deadlineMs:0,backoffMs:()=>0},capabilities:["deploy.execute"]}),runner,owner:"pg-recording-owner",hostPort:49170,temporaryHostPort:49171,containerPort:8080,trustedHosts:["registry.example.com"],promotionPolicy:{maxOutageMs:30_000,maxRecoveryMs:60_000}});
  const nativeCache=new DbAgentReplayStore(requireDb(),`pg-receiver-${projectId}`), counts={dispatch:0,claim:0,wait:0,release:0}, bodies:any[]=[];
  let loss:string|undefined, cacheAvailable=true, dropped=false;
  const replayStore={durable:true as const,lookup:async(...args:Parameters<typeof nativeCache.lookup>)=>cacheAvailable?nativeCache.lookup(...args):null,claim:async(...args:Parameters<typeof nativeCache.claim>)=>{counts.claim++;return nativeCache.claim(...args);},wait:async(...args:Parameters<typeof nativeCache.wait>)=>{counts.wait++;return nativeCache.wait(...args);},complete:nativeCache.complete.bind(nativeCache),release:async(...args:Parameters<typeof nativeCache.release>)=>{counts.release++;return nativeCache.release(...args);}};
  const receiver=new AuthenticatedAgentCommandReceiver({agentId,trustKey:"pg-source-only-trust-key-123456789",capabilities:["deploy.execute","deployment.stop"],dispatcher,stopDispatcher:dispatcher,replayStore,authorityValidator:controls});
  const transport=new AuthenticatedAgentDeploymentTransport({endpoint:"https://agent.fixture.test",agentId,trustKey:"pg-source-only-trust-key-123456789",fetch:async(url,init)=>{
    const signature=String((init?.headers as Record<string,string>)["x-deploylite-signature"]);
    if(String(url).endsWith("/capabilities")){expect(receiver.verifyRequest("GET /capabilities",signature)).toBe(true);return new Response(JSON.stringify({schemaVersion:1,agentId,capabilities:receiver.capabilities,protocolVersions:[1,2]}),{headers:{"x-deploylite-request-signature":signature}});}
    const body=JSON.parse(String(init?.body));bodies.push(body);
    if(String(url).endsWith("/receipt"))return new Response(JSON.stringify(await receiver.readReceipt(body,signature,init?.signal??undefined)));
    counts.dispatch++;const receipt=await receiver.receive(body,signature,init?.signal??undefined);
    const kind=body.action==="deployment.stop"?"stop":body.authority?.action==="deployment.rollback"?"rollback":body.schemaVersion===2?"redeploy":"initial";
    if(!dropped&&loss===kind){dropped=true;throw new Error("drop original cached terminal reply once");}return new Response(JSON.stringify(receipt));
  }});
  const app=await createPostgresApp(transport,transport,controls);
  try {
    if((await app.inject({method:"GET",url:"/api/v1/bootstrap/status"})).json().data.setupRequired)expect((await app.inject({method:"POST",url:"/api/v1/bootstrap/initial-admin",headers:contentHeaders,payload:{email:"Admin@Example.TEST",password:adminPassword}})).statusCode).toBe(200);
    const login=await app.inject({method:"POST",url:"/api/v1/auth/login",headers:contentHeaders,payload:{email:"admin@example.test",password:adminPassword}});expect(login.statusCode).toBe(200);const cookie=login.headers["set-cookie"] as string,actor=login.json().data.user.id;
    await new DbProjectRepository(requireDb()).save({id:projectId,name:"AHR PostgreSQL fixture",repoUrl:"https://example.test/pg",defaultBranch:"main",buildCommand:null,runCommand:null,port:8080,description:null,imageTag:null});
    await new DbAgentRepository(requireDb()).save({id:agentId,name:"Recording CLI agent",endpoint:"https://agent.fixture.test",status:"online",lastHeartbeatAt:new Date().toISOString(),resourceSnapshot:null});
    for(const action of ["deployment.redeploy","deployment.stop","deployment.rollback"])await requirePool().query("INSERT INTO control_grants (actor_user_id,action,scope_kind,scope_key) VALUES ($1,$2,'platform','platform') ON CONFLICT (actor_user_id,action,scope_kind,scope_key) DO NOTHING",[actor,action]);
    const initial=(flavor:"a"|"h"="a",key="initial-A",id: string=randomUUID())=>app.inject({method:"POST",url:`/api/v1/projects/${projectId}/deployments`,headers:{cookie,"x-deployment-idempotency-key":key,"x-request-id":id},payload:{imageReference:images[flavor],agentId,commitSha:"abcdef1",configRevision:"default",runtimeRevision:"default"}});
    const request=(action:"redeploy"|"stop",A:any,key:string,confirmation?:string,id: string=randomUUID())=>app.inject({method:"POST",url:`/api/v1/deployments/${A.id}/${action}`,headers:{cookie,"x-control-idempotency-key":key,"x-request-id":id,...(confirmation?{"x-control-confirmation-id":confirmation}:{})},...(action==="redeploy"?{payload:{snapshotHash:A.snapshotHash}}:{})});
    const control=async(action:"redeploy"|"stop",A:any,key:string)=>{const pending=await request(action,A,key);expect(pending.statusCode,pending.body).toBe(202);return request(action,A,key,pending.json().data.confirmationId);};
    const prepareAhr=async()=>{const historical=await initial("h","initial-H");expect(historical.statusCode,historical.body).toBe(200);const H=historical.json().data.deployment;expect((await control("stop",H,"stop-H")).statusCode).toBe(200);const current=await initial();expect(current.statusCode,current.body).toBe(200);return {A:current.json().data.deployment,H};};
    const rollback=(A:any,H:any,confirmation?:string,id: string=randomUUID())=>app.inject({method:"POST",url:`/api/v1/deployments/${A.id}/rollback`,headers:{cookie,"x-control-idempotency-key":"A-H-R","x-request-id":id,...(confirmation?{"x-control-confirmation-id":confirmation}:{})},payload:{historicalDeploymentId:H.id,snapshotHash:H.snapshotHash}});
    return {app,cookie,projectId,images,docker,bodies,initial,request,control,prepareAhr,rollback,armClaimFault:()=>{fault=claimFault;},counts:()=>({docker:docker.calls.length,...counts}),lose:(kind:string)=>{loss=kind;cacheAvailable=false;},enableCache:()=>{cacheAvailable=true;}};
  } catch(error){await app.close();throw error;}
}

async function confirmedPostgresRedeploy(app: FastifyInstance, cookie: string, sourceId: string, snapshotHash: string) {
  const url = `/api/v1/deployments/${sourceId}/redeploy`;
  const headers = { ...contentHeaders, cookie, "x-control-idempotency-key": randomUUID() };
  const payload = { snapshotHash };
  const pending = await app.inject({ method: "POST", url, headers, payload });
  expect(pending.statusCode, pending.body).toBe(202);
  const confirmationId = pending.json().data.confirmationId as string;
  const commandId = pending.json().data.commandId as string;
  expect(confirmationId).toBeTruthy(); expect(commandId).toBeTruthy();
  const confirmedHeaders = { ...headers, "x-control-confirmation-id": confirmationId };
  const response = await app.inject({ method: "POST", url, headers: confirmedHeaders, payload });
  return { response, commandId, replay: (target = app, changedHash = snapshotHash) =>
    target.inject({ method: "POST", url, headers: confirmedHeaders, payload: { snapshotHash: changedHash } }) };
}

function requireIntegrationDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be set when DEPLOYLITE_API_POSTGRES_INTEGRATION=1.");
  }

  return databaseUrl;
}

function requirePool(): ReturnType<typeof createDbPool> {
  if (!pool) {
    throw new Error("PostgreSQL integration pool is not initialized");
  }

  return pool;
}

function requireDb(): DeployLiteDb {
  if (!db) {
    throw new Error("PostgreSQL integration client is not initialized");
  }

  return db;
}

async function applyMigrations(connectionString: string): Promise<void> {
  const migrationPool = createDbPool(connectionString, { max: 1 });

  try {
    const migrationsUrl = new URL("../../../packages/db/migrations/", import.meta.url);
    const migrationFiles = (await readdir(migrationsUrl)).filter((file) => file.endsWith(".sql")).sort();

    for (const file of migrationFiles) {
      const sql = await readFile(new URL(file, migrationsUrl), "utf8");
      await migrationPool.query(sql);
    }
  } finally {
    await closeDbPool(migrationPool);
  }
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe PostgreSQL identifier: ${identifier}`);
  }

  return `"${identifier}"`;
}
