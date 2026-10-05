import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDeploymentSnapshot, createSourceIntent, type TrustedPriorExecutionReceiptV1 } from "@deploylite/contracts";
import type { ExecutionCompletionInput } from "@deploylite/domain";
import { createDbClient, createDbPool } from "./client.js";
import { DbDeploymentRepository } from "./repositories/deployment-data.js";
import { DbDeploymentExecutionRepository } from "./repositories/execution-completion.js";

const enabled = process.env.DEPLOYLITE_DB_INTEGRATION === "1";
const suite = enabled ? describe : describe.skip;
const startedAt = "2026-01-01T00:00:00.000Z";
const finishedAt = "2026-01-01T00:01:00.000Z";
const digest = `sha256:${"b".repeat(64)}`;
let maintenance: pg.Client;
let pool: pg.Pool;
let databaseUrl: string;
let databaseName: string;

const deployments = () => new DbDeploymentRepository(createDbClient(pool));
const completion = () => new DbDeploymentExecutionRepository(createDbClient(pool));

async function seed(withCommand = true) {
  const actorId = randomUUID(), projectId = randomUUID(), agentId = randomUUID(), originId = randomUUID();
  const executionId = withCommand ? randomUUID() : originId;
  const snapshot = createDeploymentSnapshot({
    deploymentId: originId, projectId, agentId, commitSha: "abcdef1",
    source: createSourceIntent({ sourceMode: "image", requestedReference: `registry.example.com/app@${digest}` }, {
      policyVersion: "p1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true
    }),
    configRevision: "c1", runtimeRevision: "r1", runtimePort: 3000, secretRefs: [], policyVersion: "p1", schemaVersion: 1
  }, { sha256: (bytes) => createHash("sha256").update(bytes).digest("hex") });
  await pool.query("INSERT INTO users (id,email,email_normalized,password_hash,role_id) SELECT $1,$2,$2,'fixture',id FROM roles WHERE name='admin'", [actorId, `${actorId}@example.test`]);
  await pool.query("INSERT INTO projects (id,name,repo_url,default_branch) VALUES ($1,'Fixture','https://example.test/repo','main')", [projectId]);
  await pool.query("INSERT INTO agents (id,name,endpoint,status) VALUES ($1,'Fixture','https://agent.test','online')", [agentId]);
  const deployment = (id: string, source?: string) => ({
    id, projectId, agentId, status: "running" as const, commitSha: "abcdef1", startedAt, finishedAt: null,
    snapshotOriginId: originId, snapshotHash: snapshot.hash, ...(source ? { sourceDeploymentId: source } : {})
  });
  const proof = (id: string): TrustedPriorExecutionReceiptV1 => ({
    schemaVersion: 1, candidateId: `candidate-${id}`, deploymentId: id, projectId, snapshotOriginId: originId,
    snapshotHash: snapshot.hash, effectiveImageDigest: digest, runtimeHost: agentId, container: `deploylite-${id}`,
    containerId: `container-${id}`, hostPort: 43000, containerPort: 3000, network: null
  });
  const initial: ExecutionCompletionInput = {
    commandId: null, expectedStatus: "running", executionId: originId, projectId, sourceExecutionId: null,
    snapshotOriginId: originId, snapshotHash: snapshot.hash, runtimeHost: agentId, effectiveImageDigest: digest,
    terminalStatus: "succeeded", finishedAt, commandResult: null, proof: proof(originId)
  };
  await deployments().save(deployment(originId));
  await deployments().saveSnapshot(snapshot);
  if (!withCommand) return { input: initial, snapshot, actorId, deployment, proof };
  expect((await completion().completeExecution(initial)).kind).toBe("committed");
  await deployments().save(deployment(executionId, originId));
  const commandId = randomUUID();
  const input: ExecutionCompletionInput = {
    ...initial, commandId, executionId, sourceExecutionId: originId, proof: proof(executionId),
    commandResult: {
      commandId, action: "deployment.redeploy", projectId, sourceDeploymentId: originId, deploymentId: executionId,
      snapshotHash: snapshot.hash, status: "completed", correlationId: randomUUID(), reason: null
    }
  };
  await seedCommand(input, actorId);
  return { input, snapshot, actorId, deployment, proof };
}

async function seedCommand(input: ExecutionCompletionInput, actorId: string) {
  const result = { ...input.commandResult!, status: "eligible" };
  await pool.query("INSERT INTO control_commands (id,actor_user_id,action,scope_kind,scope_key,input_digest,idempotency_key,correlation_id,status,result,expires_at) VALUES ($1,$2,'deployment.redeploy','deployment',$3,'fixture',$6,$4,'dispatching',$5,now()+interval '1 hour')", [
    input.commandId, actorId, JSON.stringify([input.projectId, input.sourceExecutionId]), result.correlationId, result, input.commandId
  ]);
}

suite("atomic execution PostgreSQL integration", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for opted-in integration");
    const url = new URL(process.env.DATABASE_URL);
    url.pathname = "/postgres";
    maintenance = new pg.Client({ connectionString: url.toString() });
    await maintenance.connect();
    databaseName = `deploylite_u2b_${randomUUID().replaceAll("-", "_")}`;
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
    url.pathname = `/${databaseName}`;
    databaseUrl = url.toString();
    pool = createDbPool(databaseUrl, { max: 3 });
    const directory = new URL("../migrations/", import.meta.url);
    for (const file of (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort()) {
      await pool.query(await readFile(new URL(file, directory), "utf8"));
    }
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (maintenance) {
      if (databaseName) await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await maintenance.end();
    }
  }, 30_000);

  it("executes receipt/index migrations and keeps both redeploy generations bound to their origin", async () => {
    const fixture = await seed();
    const columns = await pool.query("SELECT data_type,is_nullable,column_default FROM information_schema.columns WHERE table_name='deployments' AND column_name='execution_receipt'");
    expect(columns.rows).toEqual([{ data_type: "jsonb", is_nullable: "YES", column_default: null }]);
    const indexes = await pool.query("SELECT indexdef FROM pg_indexes WHERE tablename='deployments' AND indexname LIKE '%snapshot_hash%'");
    expect(indexes.rows).toHaveLength(1);
    expect(indexes.rows[0].indexdef).not.toContain("UNIQUE");
    expect((await completion().completeExecution(fixture.input)).kind).toBe("committed");
    const executionId = randomUUID(), commandId = randomUUID();
    const next: ExecutionCompletionInput = {
      ...fixture.input, executionId, commandId, sourceExecutionId: fixture.input.executionId, proof: fixture.proof(executionId),
      commandResult: { ...fixture.input.commandResult!, deploymentId: executionId, commandId, sourceDeploymentId: fixture.input.executionId }
    };
    await deployments().save(fixture.deployment(executionId, fixture.input.executionId));
    await seedCommand(next, fixture.actorId);
    expect((await completion().completeExecution(next)).kind).toBe("committed");
    const generations = await pool.query("SELECT id,snapshot_hash,metadata,execution_receipt FROM deployments WHERE project_id=$1", [next.projectId]);
    expect(generations.rows).toHaveLength(3);
    for (const row of generations.rows) {
      expect(row.snapshot_hash).toBe(fixture.snapshot.hash);
      expect(row.metadata.snapshotOriginId).toBe(fixture.snapshot.deploymentId);
      expect(row.execution_receipt).toMatchObject({ deploymentId: row.id, snapshotOriginId: fixture.snapshot.deploymentId });
    }
    await expect(deployments().findByHash(next.snapshotHash)).resolves.toEqual(fixture.snapshot);
  });

  it.each(["failed", "canceled"] as const)("atomically stores a %s outcome without proof", async (terminalStatus) => {
    const { input } = await seed();
    const ordinary = { ...input, terminalStatus, proof: null };
    expect((await completion().completeExecution(ordinary)).kind).toBe("committed");
    await expect(deployments().findById(input.executionId)).resolves.toMatchObject({ status: terminalStatus });
    const rows = await pool.query("SELECT execution_receipt FROM deployments WHERE id=$1", [input.executionId]);
    expect(rows.rows[0].execution_receipt).toBeNull();
    const command = await pool.query("SELECT status,result FROM control_commands WHERE id=$1", [input.commandId]);
    expect(command.rows[0]).toEqual({ status: "completed", result: input.commandResult });
    expect((await completion().completeExecution(ordinary)).kind).toBe("replayed");
  });

  it.each([false, true])("serializes equal or changed completion races (changed=%s)", async (changed) => {
    const { input } = await seed();
    const other = changed ? { ...input, proof: { ...input.proof!, containerId: "other-observed-container" } } : input;
    const poolA = createDbPool(databaseUrl, { max: 1 }), poolB = createDbPool(databaseUrl, { max: 1 });
    try {
      const first = new DbDeploymentExecutionRepository(createDbClient(poolA));
      const second = new DbDeploymentExecutionRepository(createDbClient(poolB));
      const outcomes = await Promise.all([first.completeExecution(input), second.completeExecution(other)]);
      expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(["committed", changed ? "conflict" : "replayed"]);
      const winner = outcomes.find((outcome) => outcome.kind === "committed");
      if (!winner || winner.kind !== "committed") throw new Error("Expected one committed writer");
      await expect(deployments().findById(input.executionId)).resolves.toEqual(winner.deployment);
    } finally {
      await poolA.end();
      await poolB.end();
    }
  });

  it("waits on the command row before locking the deployment row", async () => {
    const { input } = await seed();
    const blocker = await pool.connect();
    const application = `u2b_lock_${randomUUID()}`;
    const contender = createDbPool(databaseUrl, { max: 1, application_name: application });
    let work: ReturnType<DbDeploymentExecutionRepository["completeExecution"]> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM control_commands WHERE id=$1 FOR UPDATE", [input.commandId]);
      const submitted = structuredClone(input);
      work = new DbDeploymentExecutionRepository(createDbClient(contender)).completeExecution(submitted);
      let blocked = false;
      for (let attempt = 0; attempt < 40 && !blocked; attempt++) {
        const activity = await pool.query("SELECT query FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [application]);
        blocked = activity.rows.some((row) => row.query.includes('from "control_commands"'));
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(blocked).toBe(true);
      submitted.proof!.containerId = "mutated-during-lock-wait";
      await expect(blocker.query("SELECT id FROM deployments WHERE id=$1 FOR UPDATE NOWAIT", [input.executionId])).resolves.toMatchObject({ rowCount: 1 });
      await blocker.query("ROLLBACK");
      expect((await work).kind).toBe("committed");
      await expect(deployments().findById(input.executionId)).resolves.toMatchObject({ executionReceipt: input.proof });
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await work?.catch(() => undefined);
      await contender.end();
    }
  });

  it("rolls back deployment/proof and command together after a real PostgreSQL trigger fault", async () => {
    const { input } = await seed();
    const trigger = `u2b_fault_${randomUUID().replaceAll("-", "")}`;
    await pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected completion fault'; END $$`);
    await pool.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON control_commands FOR EACH ROW WHEN (OLD.id='${input.commandId}'::uuid) EXECUTE FUNCTION ${trigger}()`);
    try {
      await expect(completion().completeExecution(input)).rejects.toThrow();
      const deployment = await pool.query("SELECT status,execution_receipt,finished_at FROM deployments WHERE id=$1", [input.executionId]);
      expect(deployment.rows).toEqual([{ status: "running", execution_receipt: null, finished_at: null }]);
      const command = await pool.query("SELECT status,result FROM control_commands WHERE id=$1", [input.commandId]);
      expect(command.rows[0]).toEqual({ status: "dispatching", result: { ...input.commandResult!, status: "eligible" } });
    } finally {
      await pool.query(`DROP TRIGGER ${trigger} ON control_commands`);
      await pool.query(`DROP FUNCTION ${trigger}()`);
    }
    expect((await completion().completeExecution(input)).kind).toBe("committed");
  });

  it("rejects generic proof/history changes and isolates read references", async () => {
    const { input, snapshot } = await seed();
    const outcome = await completion().completeExecution(input);
    if (outcome.kind !== "committed") throw new Error("Expected committed fixture");
    const changed = { ...outcome.deployment, executionReceipt: { ...input.proof!, containerId: "forged" } };
    await expect(deployments().save(changed)).rejects.toThrow("immutable");
    await expect(deployments().saveIfStatus(changed, "succeeded")).resolves.toBeNull();
    await expect(deployments().save({ ...outcome.deployment, finishedAt: startedAt })).rejects.toThrow("immutable");
    await expect(deployments().saveSnapshot({ ...snapshot, canonicalJson: "{}" })).rejects.toThrow("immutable");
    outcome.deployment.executionReceipt!.containerId = "mutated-output";
    await expect(deployments().findById(input.executionId)).resolves.toMatchObject({ executionReceipt: input.proof });
  });

  it("reports missing rows and retains initial ordinary/legacy compatibility", async () => {
    const { input } = await seed(false);
    await expect(completion().completeExecution({ ...input, executionId: randomUUID() })).resolves.toEqual({ kind: "not-found" });
    const missing = await seed();
    await expect(completion().completeExecution({ ...missing.input, commandId: randomUUID() })).resolves.toEqual({ kind: "not-found" });
    expect((await completion().completeExecution({ ...input, terminalStatus: "failed", proof: null })).kind).toBe("committed");
    const legacy = await seed(false);
    const row = await deployments().findById(legacy.input.executionId);
    if (!row) throw new Error("Expected legacy row");
    await expect(deployments().save({ ...row, status: "succeeded", finishedAt })).resolves.not.toHaveProperty("executionReceipt");
  });

  it.each(["project", "source", "origin", "hash", "host", "digest", "correlation", "expected-status"])("rejects mismatched %s before any terminal write", async (kind) => {
    const { input } = await seed();
    const changes: Record<string, Partial<ExecutionCompletionInput>> = {
      project: { projectId: randomUUID() }, source: { sourceExecutionId: randomUUID() },
      origin: { snapshotOriginId: randomUUID() }, hash: { snapshotHash: "a".repeat(64) },
      host: { runtimeHost: randomUUID() }, digest: { effectiveImageDigest: `sha256:${"c".repeat(64)}` },
      correlation: { commandResult: { ...input.commandResult!, correlationId: "different" } },
      "expected-status": { expectedStatus: "queued" }
    };
    await expect(completion().completeExecution({ ...input, ...changes[kind] })).resolves.toEqual({ kind: "conflict" });
    const row = await pool.query("SELECT status,execution_receipt,finished_at FROM deployments WHERE id=$1", [input.executionId]);
    expect(row.rows).toEqual([{ status: "running", execution_receipt: null, finished_at: null }]);
    const command = await pool.query("SELECT status FROM control_commands WHERE id=$1", [input.commandId]);
    expect(command.rows).toEqual([{ status: "dispatching" }]);
  });

  it.each(["failed", "canceled"] as const)("retains initial %s outcomes without a command or proof", async (terminalStatus) => {
    const { input } = await seed(false);
    const ordinary = { ...input, terminalStatus, proof: null };
    expect((await completion().completeExecution(ordinary)).kind).toBe("committed");
    expect((await completion().completeExecution(ordinary)).kind).toBe("replayed");
    await expect(deployments().findById(input.executionId)).resolves.toMatchObject({ status: terminalStatus });
  });

  it("replays completed proof across a new pool lifecycle", async () => {
    const { input } = await seed();
    expect((await completion().completeExecution(input)).kind).toBe("committed");
    await pool.end();
    pool = createDbPool(databaseUrl, { max: 3 });
    expect((await completion().completeExecution(input)).kind).toBe("replayed");
    await expect(deployments().findById(input.executionId)).resolves.toMatchObject({ executionReceipt: input.proof });
  });

  it.skipIf(!process.env.DEPLOYLITE_PG_RESTART_HELPER)("retains proof, command and canonical origin across an owned server restart", async () => {
    const { input, snapshot } = await seed();
    expect((await completion().completeExecution(input)).kind).toBe("committed");
    await pool.end();
    await maintenance.end();
    await promisify(execFile)("python3", [process.env.DEPLOYLITE_PG_RESTART_HELPER!]);
    const url = new URL(databaseUrl);
    url.pathname = "/postgres";
    maintenance = new pg.Client({ connectionString: url.toString() });
    await maintenance.connect();
    pool = createDbPool(databaseUrl, { max: 3 });
    expect((await completion().completeExecution(input)).kind).toBe("replayed");
    await expect(deployments().findByHash(input.snapshotHash)).resolves.toEqual(snapshot);
    await expect(deployments().findById(input.executionId)).resolves.toMatchObject({ status: "succeeded", executionReceipt: input.proof });
  }, 30_000);
});
