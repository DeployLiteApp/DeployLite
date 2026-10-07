import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDeploymentSnapshot, createSourceIntent, deploymentRedeployCommandResultSchema, deploymentRollbackCommandResultSchema, type Deployment, type DeploymentExecutionAuthorityV1, type TrustedPriorExecutionReceiptV1 } from "@deploylite/contracts";
import { createConfirmation, createControlCommand, type ControlCommand, type ExecutionCompletionInput } from "@deploylite/domain";
import { createDbClient, createDbPool } from "./client.js";
import { DbDeploymentRepository } from "./repositories/deployment-data.js";
import { DbDeploymentExecutionRepository } from "./repositories/execution-completion.js";
import { DbControlCommandRepository } from "./repositories/control-plane.js";
import { DbAgentReplayStore } from "./repositories/agent-replay.js";

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


// Acceptance-only fixtures. Container observations are synthetic; PostgreSQL is real only when opted in.
const controls = () => new DbControlCommandRepository(createDbClient(pool));
type AuthorityFixture = Awaited<ReturnType<typeof seed>>;
type AuthorityEntry = { command: ControlCommand; confirmation: ReturnType<typeof createConfirmation>; deployment: Deployment | null };

async function authorityFixture() {
  const fixture = await seed(false);
  expect((await completion().completeExecution(fixture.input)).kind).toBe("committed");
  return fixture;
}

async function prepareAuthorityCommand(fixture: AuthorityFixture, action: "deployment.stop" | "deployment.redeploy"): Promise<AuthorityEntry> {
  const sourceId = fixture.input.executionId;
  const command = createControlCommand({ actorId: fixture.actorId, action,
    scope: { kind: "deployment", projectId: fixture.input.projectId, deploymentId: sourceId },
    input: { projectId: fixture.input.projectId, sourceDeploymentId: sourceId, snapshotHash: fixture.snapshot.hash },
    idempotencyKey: randomUUID(), correlationId: randomUUID(), expiresAt: new Date(Date.now() + 600_000) });
  const confirmation = createConfirmation({ command, classification: "destructive" });
  await controls().resolve(command);
  await controls().bind(confirmation);
  return { command, confirmation, deployment: action === "deployment.redeploy"
    ? { ...fixture.deployment(randomUUID(), sourceId), status: "queued" } : null };
}

async function admitAuthorityCommand(fixture: AuthorityFixture, action: "deployment.stop" | "deployment.redeploy") {
  const entry = await prepareAuthorityCommand(fixture, action);
  const admitted = entry.deployment
    ? await controls().executeConfirmedDeploymentRedeploy({ ...entry, deployment: entry.deployment, requestId: randomUUID(), snapshotHash: fixture.snapshot.hash })
    : await controls().executeConfirmedDeploymentStop({ command: entry.command, confirmation: entry.confirmation, requestId: randomUUID() });
  expect(admitted.accepted).toBe(true);
  expect(admitted.command.status).toBe("eligible");
  return { ...entry, command: admitted.command };
}

function claimAuthority(repository: DbControlCommandRepository, entry: AuthorityEntry) {
  return entry.command.action === "deployment.stop"
    ? repository.claimDeploymentStop(entry.command) : repository.claimDeploymentRedeploy(entry.command);
}

function requireAuthority(claim: { claimed: boolean; authority?: DeploymentExecutionAuthorityV1 }) {
  expect(claim.claimed).toBe(true);
  if (!claim.authority) throw new Error("Expected persisted execution authority");
  return claim.authority;
}

function authorityCompletion(fixture: AuthorityFixture, entry: AuthorityEntry, authority: DeploymentExecutionAuthorityV1): ExecutionCompletionInput {
  if (!entry.deployment) throw new Error("Expected replacement execution fixture");
  return { ...fixture.input, commandId: entry.command.id, executionId: entry.deployment.id,
    sourceExecutionId: fixture.input.executionId, proof: fixture.proof(entry.deployment.id), authority,
    commandResult: deploymentRedeployCommandResultSchema.parse({ ...entry.command.result, status: "completed", reason: null }) };
}

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForProjectLock(application: string) {
  const deadline = Date.now() + 5_000;
  do {
    const activity = await pool.query<{ blocked: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%') AS blocked", [application]);
    if (activity.rows[0]?.blocked) return;
    await yieldToLoop();
  } while (Date.now() < deadline);
  throw new Error("Contender did not reach the controlled project lock barrier");
}


function stopTerminal(entry: AuthorityEntry) {
  if (entry.command.scope.kind !== "deployment") throw new Error("Expected deployment control scope");
  return { commandId: entry.command.id, action: "deployment.stop" as const, projectId: entry.command.scope.projectId,
    deploymentId: entry.command.scope.deploymentId, status: "completed" as const, correlationId: entry.command.correlationId, reason: "stopped" };
}

async function waitForCommandLock(application: string) {
  const deadline = Date.now() + 5_000;
  do {
    const activity = await pool.query<{ blocked: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE '%control_commands%') AS blocked", [application]);
    if (activity.rows[0]?.blocked) return;
    await yieldToLoop();
  } while (Date.now() < deadline);
  throw new Error("Stop completion did not reach its controlled command-row barrier");
}

// Final A/H/R acceptance fixture: real SQL, synthetic observations; no Docker or listener.
async function rollbackFixture() {
  const seedH = await seed(false), H_id = seedH.input.executionId;
  const imageH = `registry.example.com/app@sha256:${"f".repeat(64)}`, imageA = `registry.example.com/app@sha256:${"e".repeat(64)}`;
  // Fresh fixture rows have not executed; configure them before binding canonical snapshots.
  await pool.query("DELETE FROM deployments WHERE id=$1", [H_id]);
  const makeSnapshot = (id: string, image: string) => createDeploymentSnapshot({ schemaVersion: 1, deploymentId: id,
    projectId: seedH.input.projectId, agentId: seedH.input.runtimeHost, commitSha: "abcdef1",
    source: createSourceIntent({ sourceMode: "image", requestedReference: image }, { policyVersion: "p1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true }),
    configRevision: "default", runtimeRevision: "default", runtimePort: 8080, secretRefs: [], policyVersion: "p1" }, { sha256: (bytes) => createHash("sha256").update(bytes).digest("hex") });
  const makeInitial = async (id: string, image: string) => {
    const snapshot = makeSnapshot(id, image), physical = createHash("sha256").update(`synthetic-${id}`).digest("hex");
    const proof: TrustedPriorExecutionReceiptV1 = { ...seedH.proof(id), snapshotOriginId: id, snapshotHash: snapshot.hash,
      effectiveImageDigest: image.split("@")[1]!, containerId: physical, hostPort: 49170, containerPort: 8080 };
    await deployments().save({ ...seedH.deployment(id), snapshotOriginId: id, snapshotHash: snapshot.hash });
    await deployments().saveSnapshot(snapshot);
    const input: ExecutionCompletionInput = { ...seedH.input, executionId: id, snapshotOriginId: id, snapshotHash: snapshot.hash, effectiveImageDigest: proof.effectiveImageDigest, proof };
    expect((await completion().completeExecution(input)).kind).toBe("committed");
    return { deployment: (await deployments().findById(id))!, snapshot, input };
  };
  const H = await makeInitial(H_id, imageH), A = await makeInitial(randomUUID(), imageA);
  const tentative = (id = randomUUID(), key = randomUUID(), actorId = seedH.actorId) => {
    const value = createControlCommand({ actorId, action: "deployment.rollback", scope: { kind: "deployment", projectId: seedH.input.projectId, deploymentId: A.deployment.id },
      input: { actorId, projectId: seedH.input.projectId, activeDeploymentId: A.deployment.id, sourceDeploymentId: H.deployment.id, deploymentId: id, snapshotHash: H.snapshot.hash }, idempotencyKey: key, correlationId: randomUUID() });
    return { ...value, result: deploymentRollbackCommandResultSchema.parse({ commandId: value.id, action: "deployment.rollback", projectId: seedH.input.projectId, activeDeploymentId: A.deployment.id, sourceDeploymentId: H.deployment.id, deploymentId: id, snapshotHash: H.snapshot.hash, status: "pending_confirmation", correlationId: value.correlationId, reason: null }) };
  };
  const reserve = async (value = tentative()) => {
    const { command } = await controls().resolve(value), confirmation = createConfirmation({ command, classification: "destructive" });
    await controls().bind(confirmation);
    const result = deploymentRollbackCommandResultSchema.parse(command.result);
    const deployment: Deployment = { ...seedH.deployment(result.deploymentId, H.deployment.id), snapshotOriginId: H.snapshot.deploymentId,
      snapshotHash: H.snapshot.hash, activeDeploymentId: A.deployment.id, status: "queued" };
    return { command, confirmation, deployment };
  };
  const admit = async (entry: Awaited<ReturnType<typeof reserve>>) => {
    const accepted = await controls().executeConfirmedDeploymentRollback({ ...entry, requestId: randomUUID() });
    expect(accepted.accepted).toBe(true); return { ...entry, command: accepted.command };
  };
  const run = async (entry: Awaited<ReturnType<typeof reserve>>) => {
    const claim = await controls().claimDeploymentRollback(entry.command), authority = requireAuthority(claim);
    await deployments().save({ ...entry.deployment, status: "running" });
    const proof = { ...H.input.proof!, deploymentId: entry.deployment.id, candidateId: `candidate-${entry.deployment.id}`, container: `deploylite-${entry.deployment.id}`, containerId: createHash("sha256").update(`R-${entry.deployment.id}`).digest("hex") };
    const input: ExecutionCompletionInput = { ...H.input, commandId: entry.command.id, authority, executionId: entry.deployment.id, activeDeploymentId: A.deployment.id, sourceExecutionId: H.deployment.id, proof,
      commandResult: deploymentRollbackCommandResultSchema.parse({ ...claim.command.result, status: "completed" }) };
    return { claim, input };
  };
  return { H, A, actorId: seedH.actorId, projectId: seedH.input.projectId, tentative, reserve, admit, run };
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


  it.each(["deployment.stop", "deployment.redeploy"] as const)("serializes competing Stop/redeploy claims behind the same project lock (first=%s)", async (firstAction) => {
    const fixture = await authorityFixture();
    const firstEntry = await admitAuthorityCommand(fixture, firstAction);
    const secondEntry = await admitAuthorityCommand(fixture, firstAction === "deployment.stop" ? "deployment.redeploy" : "deployment.stop");
    const application = `p2_authority_${randomUUID()}`;
    const poolA = createDbPool(databaseUrl, { max: 1, statement_timeout: 10_000 });
    const poolB = createDbPool(databaseUrl, { max: 1, application_name: application, statement_timeout: 10_000 });
    const reached = latch(), unblock = latch();
    let first: ReturnType<typeof claimAuthority> | undefined, second: ReturnType<typeof claimAuthority> | undefined;
    try {
      const owner = new DbControlCommandRepository(createDbClient(poolA), async (stage) => {
        if (stage === "authority-claimed") { reached.resolve(); await unblock.promise; }
      });
      first = claimAuthority(owner, firstEntry);
      await Promise.race([reached.promise, first.then(() => { throw new Error("Claim bypassed controlled barrier"); })]);
      second = claimAuthority(new DbControlCommandRepository(createDbClient(poolB)), secondEntry);
      await waitForProjectLock(application);
      const before = await pool.query("SELECT status,execution_authority FROM control_commands WHERE id=ANY($1::uuid[])", [[firstEntry.command.id, secondEntry.command.id]]);
      expect(before.rows).toEqual([expect.objectContaining({ status: "eligible", execution_authority: null }), expect.objectContaining({ status: "eligible", execution_authority: null })]);
      unblock.resolve();
      const [winner, loser] = await Promise.all([first, second]);
      const authority = requireAuthority(winner);
      expect(loser.claimed).toBe(false);
      expect(authority).toMatchObject({ projectId: fixture.input.projectId, projectLease: { fence: 2 } });
      await expect(controls().validateDeploymentAuthority(authority)).resolves.toBeUndefined();
      const rows = await pool.query("SELECT id,status,execution_authority FROM control_commands WHERE id=ANY($1::uuid[])", [[firstEntry.command.id, secondEntry.command.id]]);
      expect(rows.rows).toEqual(expect.arrayContaining([
        { id: firstEntry.command.id, status: "dispatching", execution_authority: authority },
        { id: secondEntry.command.id, status: "eligible", execution_authority: null }
      ]));
    } finally {
      unblock.resolve();
      await Promise.allSettled([first, second]);
      await Promise.all([poolA.end(), poolB.end()]);
    }
  }, 30_000);

  it("allows a different project claim while one project transaction holds its authority lock", async () => {
    const fixtureA = await authorityFixture(), fixtureB = await authorityFixture();
    const entryA = await admitAuthorityCommand(fixtureA, "deployment.redeploy");
    const entryB = await admitAuthorityCommand(fixtureB, "deployment.stop");
    const poolA = createDbPool(databaseUrl, { max: 1, statement_timeout: 10_000 });
    const poolB = createDbPool(databaseUrl, { max: 1, statement_timeout: 5_000 });
    const reached = latch(), unblock = latch();
    let first: ReturnType<typeof claimAuthority> | undefined;
    try {
      const owner = new DbControlCommandRepository(createDbClient(poolA), async (stage) => {
        if (stage === "authority-claimed") { reached.resolve(); await unblock.promise; }
      });
      first = claimAuthority(owner, entryA);
      await Promise.race([reached.promise, first.then(() => { throw new Error("Claim bypassed controlled barrier"); })]);
      const independent = await claimAuthority(new DbControlCommandRepository(createDbClient(poolB)), entryB);
      const authorityB = requireAuthority(independent);
      expect(authorityB.projectId).toBe(fixtureB.input.projectId);
      await expect(controls().validateDeploymentAuthority(authorityB)).resolves.toBeUndefined();
      expect((await pool.query("SELECT status FROM control_commands WHERE id=$1", [entryA.command.id])).rows).toEqual([{ status: "eligible" }]);
      unblock.resolve();
      expect(requireAuthority(await first).projectId).toBe(fixtureA.input.projectId);
    } finally {
      unblock.resolve();
      await first?.catch(() => undefined);
      await Promise.all([poolA.end(), poolB.end()]);
    }
  }, 30_000);

  it("rejects an expired persisted command without allocating an execution claim", async () => {
    const fixture = await authorityFixture();
    const entry = await admitAuthorityCommand(fixture, "deployment.stop");
    await pool.query("UPDATE control_commands SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [entry.command.id]);
    await expect(claimAuthority(controls(), entry)).resolves.toMatchObject({ claimed: false });
    expect((await pool.query("SELECT status,execution_authority FROM control_commands WHERE id=$1", [entry.command.id])).rows).toEqual([{ status: "eligible", execution_authority: null }]);
  }, 30_000);

  it("increments fences on expiry and rejects superseded or same-fence conflicting authority before terminal writes", async () => {
    const fixture = await authorityFixture();
    const entry = await admitAuthorityCommand(fixture, "deployment.redeploy");
    if (!entry.deployment) throw new Error("Expected execution fixture");
    await deployments().save({ ...entry.deployment, status: "running" });
    const old = requireAuthority(await claimAuthority(controls(), entry));
    await expect(controls().validateDeploymentAuthority(old, old.projectLease.expiresAt)).rejects.toThrow();
    const conflicting = structuredClone(old);
    conflicting.projectLease.leaseId = "same-fence-other-owner";
    await expect(controls().validateDeploymentAuthority(conflicting)).rejects.toThrow();
    await pool.query("UPDATE control_commands SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [entry.command.id]);
    const successor = await admitAuthorityCommand(fixture, "deployment.stop");
    const current = requireAuthority(await claimAuthority(controls(), successor));
    expect(current.projectLease.fence).toBe(old.projectLease.fence + 1);
    expect(current.executionLease.fence).toBe(current.projectLease.fence);
    await expect(controls().validateDeploymentAuthority(old)).rejects.toThrow();
    await expect(completion().completeExecution(authorityCompletion(fixture, entry, old))).resolves.toEqual({ kind: "conflict" });
    expect((await pool.query("SELECT status,execution_receipt,finished_at FROM deployments WHERE id=$1", [entry.deployment.id])).rows).toEqual([{ status: "running", execution_receipt: null, finished_at: null }]);
    expect((await pool.query("SELECT status,execution_authority FROM control_commands WHERE id=$1", [successor.command.id])).rows).toEqual([{ status: "dispatching", execution_authority: current }]);
    await expect(controls().validateDeploymentAuthority(current)).resolves.toBeUndefined();
  }, 30_000);

  it("rolls back confirmed allocation and confirmation when the existing allocation fault fires", async () => {
    const fixture = await authorityFixture();
    const entry = await prepareAuthorityCommand(fixture, "deployment.redeploy");
    if (!entry.deployment) throw new Error("Expected execution fixture");
    const repository = new DbControlCommandRepository(createDbClient(pool), (stage) => {
      if (stage === "redeploy-deployment-inserted") throw new Error("acceptance allocation fault");
    });
    await expect(repository.executeConfirmedDeploymentRedeploy({ ...entry, deployment: entry.deployment, requestId: randomUUID(), snapshotHash: fixture.snapshot.hash })).rejects.toThrow("acceptance allocation fault");
    expect((await pool.query("SELECT id FROM deployments WHERE id=$1", [entry.deployment.id])).rowCount).toBe(0);
    expect((await pool.query("SELECT status,result,execution_authority FROM control_commands WHERE id=$1", [entry.command.id])).rows).toEqual([{ status: "pending_confirmation", result: null, execution_authority: null }]);
    expect((await pool.query("SELECT consumed_at FROM control_command_confirmations WHERE id=$1", [entry.confirmation.id])).rows).toEqual([{ consumed_at: null }]);
    expect((await pool.query("SELECT id FROM control_command_audits WHERE command_id=$1", [entry.command.id])).rowCount).toBe(0);
  }, 30_000);

  it("rolls back a claim fault without leaking authority or altering the already admitted allocation", async () => {
    const fixture = await authorityFixture();
    const entry = await admitAuthorityCommand(fixture, "deployment.redeploy");
    if (!entry.deployment) throw new Error("Expected execution fixture");
    const before = await deployments().findById(entry.deployment.id);
    const repository = new DbControlCommandRepository(createDbClient(pool), (stage) => {
      if (stage === "authority-claimed") throw new Error("acceptance claim fault");
    });
    await expect(claimAuthority(repository, entry)).rejects.toThrow("acceptance claim fault");
    expect((await pool.query("SELECT status,execution_authority FROM control_commands WHERE id=$1", [entry.command.id])).rows).toEqual([{ status: "eligible", execution_authority: null }]);
    await expect(deployments().findById(entry.deployment.id)).resolves.toEqual(before);
    expect((await pool.query("SELECT count(*)::int AS count FROM deployments WHERE id=$1", [entry.deployment.id])).rows).toEqual([{ count: 1 }]);
    requireAuthority(await claimAuthority(controls(), entry));
  }, 30_000);

  it("rereads persisted execution authority through a new PostgreSQL pool", async () => {
    const fixture = await authorityFixture();
    const entry = await admitAuthorityCommand(fixture, "deployment.redeploy");
    const authority = requireAuthority(await claimAuthority(controls(), entry));
    await pool.end();
    pool = createDbPool(databaseUrl, { max: 3 });
    expect((await pool.query("SELECT execution_authority FROM control_commands WHERE id=$1", [entry.command.id])).rows).toEqual([{ execution_authority: authority }]);
    await expect(controls().validateDeploymentAuthority(authority)).resolves.toBeUndefined();
    const changed = structuredClone(authority);
    changed.executionLease.fence++;
    await expect(controls().validateDeploymentAuthority(changed)).rejects.toThrow();
  }, 30_000);


  it("rejects stale Stop terminal completion after a higher-fence replacement claim", async () => {
    const fixture = await authorityFixture();
    const stop = await admitAuthorityCommand(fixture, "deployment.stop");
    const oldClaim = await claimAuthority(controls(), stop), old = requireAuthority(oldClaim);
    await pool.query("UPDATE control_commands SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [stop.command.id]);
    const replacement = await admitAuthorityCommand(fixture, "deployment.redeploy");
    const current = requireAuthority(await claimAuthority(controls(), replacement));
    expect(current.projectLease.fence).toBe(old.projectLease.fence + 1);
    const before = await pool.query("SELECT id,status,result,execution_authority,updated_at FROM control_commands WHERE id=ANY($1::uuid[]) ORDER BY id", [[stop.command.id, replacement.command.id]]);
    await expect(controls().completeDeploymentStop(oldClaim.command, stopTerminal(stop))).rejects.toThrow();
    expect((await pool.query("SELECT id,status,result,execution_authority,updated_at FROM control_commands WHERE id=ANY($1::uuid[]) ORDER BY id", [[stop.command.id, replacement.command.id]])).rows).toEqual(before.rows);
    await expect(controls().validateDeploymentAuthority(current)).resolves.toBeUndefined();
    await expect(deployments().findById(fixture.input.executionId)).resolves.toMatchObject({ status: "succeeded", executionReceipt: fixture.input.proof });
  }, 30_000);

  it("rejects Stop terminal completion when persisted expiry changes during its command-row lock wait", async () => {
    const fixture = await authorityFixture();
    const stop = await admitAuthorityCommand(fixture, "deployment.stop");
    const claim = await claimAuthority(controls(), stop), authority = requireAuthority(claim);
    const blocker = await pool.connect(), application = `p2_stop_lock_${randomUUID()}`;
    const contender = createDbPool(databaseUrl, { max: 1, application_name: application, statement_timeout: 10_000 });
    let work: ReturnType<DbControlCommandRepository["completeDeploymentStop"]> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM control_commands WHERE id=$1 FOR UPDATE", [stop.command.id]);
      work = new DbControlCommandRepository(createDbClient(contender)).completeDeploymentStop(claim.command, stopTerminal(stop));
      void work.catch(() => undefined);
      await waitForCommandLock(application);
      await blocker.query("UPDATE control_commands SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [stop.command.id]);
      await blocker.query("COMMIT");
      await expect(work).rejects.toThrow();
      expect((await pool.query("SELECT status,execution_authority FROM control_commands WHERE id=$1", [stop.command.id])).rows).toEqual([{ status: "dispatching", execution_authority: authority }]);
    } finally {
      await blocker.query("ROLLBACK"); blocker.release();
      await work?.catch(() => undefined);
      await contender.end();
    }
  }, 30_000);

  it("replays equal completed Stop terminal evidence after expiry and deleted source without rewriting the ledger", async () => {
    const fixture = await authorityFixture();
    const stop = await admitAuthorityCommand(fixture, "deployment.stop");
    const claim = await claimAuthority(controls(), stop); requireAuthority(claim);
    const terminal = stopTerminal(stop);
    await expect(controls().completeDeploymentStop(claim.command, terminal)).resolves.toMatchObject({ status: "completed", result: terminal });
    await pool.query("UPDATE control_commands SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [stop.command.id]);
    await pool.query("DELETE FROM deployments WHERE id=$1", [fixture.input.executionId]);
    const before = await pool.query("SELECT status,result,execution_authority,updated_at FROM control_commands WHERE id=$1", [stop.command.id]);
    await expect(controls().completeDeploymentStop(claim.command, terminal)).resolves.toMatchObject({ status: "completed", result: terminal });
    expect((await pool.query("SELECT status,result,execution_authority,updated_at FROM control_commands WHERE id=$1", [stop.command.id])).rows).toEqual(before.rows);
  }, 30_000);

  it.each(["different-owner", "same-owner"])("preserves a reclaimed replay claim against old completion and release (%s)", async (ownership) => {
    const commandId = randomUUID(), executionId = randomUUID();
    const poolA = createDbPool(databaseUrl, { max: 1 }), poolB = createDbPool(databaseUrl, { max: 1 });
    try {
      const owner = `acceptance-${randomUUID()}`;
      const first = new DbAgentReplayStore(createDbClient(poolA), owner);
      const second = new DbAgentReplayStore(createDbClient(poolB), ownership === "same-owner" ? owner : `${owner}-new`);
      const lease = { leaseId: "old", deploymentId: executionId, fence: 2, expiresAt: Date.now() + 60_000 };
      const old = await first.claim(commandId, "acceptance-payload", lease);
      await pool.query("UPDATE agent_replay SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE command_id=$1", [commandId]);
      const current = await second.claim(commandId, "acceptance-payload", { ...lease, leaseId: "current", fence: 3, expiresAt: Date.now() + 60_000 });
      expect(old.claimed).toBe(true); expect(current.claimed).toBe(true);
      expect(current.claimToken).not.toBe(old.claimToken);
      const receipt = { deploymentId: executionId, acceptanceFixture: true };
      await expect(first.complete(commandId, { fingerprint: "acceptance-payload", claimToken: old.claimToken!, receipt })).rejects.toThrow("stale");
      await first.release(commandId, old.claimToken);
      expect((await pool.query("SELECT status,claim_token FROM agent_replay WHERE command_id=$1", [commandId])).rows).toEqual([{ status: "in_progress", claim_token: current.claimToken }]);
      await second.release(commandId, current.claimToken);
      expect((await pool.query("SELECT command_id FROM agent_replay WHERE command_id=$1", [commandId])).rowCount).toBe(0);
    } finally {
      await Promise.all([poolA.end(), poolB.end()]);
    }
  }, 30_000);

  it("atomically rolls back authority-bearing terminal writes and replays committed proof after expiry", async () => {
    const fixture = await authorityFixture();
    const entry = await admitAuthorityCommand(fixture, "deployment.redeploy");
    if (!entry.deployment) throw new Error("Expected execution fixture");
    await deployments().save({ ...entry.deployment, status: "running" });
    const authority = requireAuthority(await claimAuthority(controls(), entry));
    const input = authorityCompletion(fixture, entry, authority);
    const trigger = `p2_authority_fault_${randomUUID().replaceAll("-", "")}`;
    await pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'authority terminal fault'; END $$`);
    await pool.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON control_commands FOR EACH ROW WHEN (OLD.id='${entry.command.id}'::uuid) EXECUTE FUNCTION ${trigger}()`);
    try {
      await expect(completion().completeExecution(input)).rejects.toMatchObject({ cause: { message: "authority terminal fault", code: "P0001" } });
      expect((await pool.query("SELECT status,execution_receipt,finished_at FROM deployments WHERE id=$1", [entry.deployment.id])).rows).toEqual([{ status: "running", execution_receipt: null, finished_at: null }]);
      expect((await pool.query("SELECT status,execution_authority,result FROM control_commands WHERE id=$1", [entry.command.id])).rows).toEqual([{ status: "dispatching", execution_authority: authority, result: entry.command.result }]);
    } finally {
      await pool.query(`DROP TRIGGER ${trigger} ON control_commands`);
      await pool.query(`DROP FUNCTION ${trigger}()`);
    }
    expect((await completion().completeExecution(input)).kind).toBe("committed");
    await pool.query("UPDATE control_commands SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [entry.command.id]);
    expect((await completion().completeExecution(input)).kind).toBe("replayed");
    expect((await pool.query("SELECT d.status AS execution_status,d.execution_receipt,c.status AS command_status FROM deployments d JOIN control_commands c ON c.id=$1 WHERE d.id=$2", [entry.command.id, entry.deployment.id])).rows).toEqual([{ execution_status: "succeeded", execution_receipt: input.proof, command_status: "completed" }]);
  }, 30_000);

  it("converges concurrent A/H/R reservation and original confirmation across PostgreSQL clients", async () => {
    const f = await rollbackFixture(), key = randomUUID(), one = f.tentative(randomUUID(), key), two = f.tentative(randomUUID(), key);
    const [a, b] = await Promise.all([controls().resolve(one), controls().resolve(two)]);
    expect(a.command).toEqual(b.command); expect([one.result.deploymentId,two.result.deploymentId]).toContain(a.command.result?.deploymentId);
    const confirmation = createConfirmation({ command: a.command, classification: "destructive" }); await controls().bind(confirmation);
    expect(await controls().resolveRollbackConfirmation(b.command)).toEqual(confirmation);
    await expect(controls().findByIdempotency(f.actorId, key, "deployment.stop")).resolves.toBeNull();
    expect((await pool.query("SELECT id FROM control_commands WHERE actor_user_id=$1 AND idempotency_key=$2", [f.actorId, key])).rowCount).toBe(1);
  });
  it("resumes a queued unclaimed rollback after competing project authority completes", async () => {
    const f = await rollbackFixture(), entry = await f.admit(await f.reserve());
    const value = createControlCommand({ actorId: f.actorId, action: "deployment.stop", scope: { kind: "deployment", projectId: f.projectId, deploymentId: f.A.deployment.id }, input: {}, idempotencyKey: randomUUID(), correlationId: randomUUID() });
    await controls().resolve(value); const confirmation = createConfirmation({ command: value, classification: "destructive" }); await controls().bind(confirmation);
    const admitted = await controls().executeConfirmedDeploymentStop({ command: value, confirmation, requestId: randomUUID() });
    const current = await controls().claimDeploymentStop(admitted.command); requireAuthority(current);
    expect((await controls().claimDeploymentRollback(entry.command)).claimed).toBe(false);
    expect(await deployments().findById(entry.deployment.id)).toMatchObject({ status: "queued", finishedAt: null });
    await controls().completeDeploymentStop(current.command, { commandId: current.command.id, action: "deployment.stop", projectId: f.projectId, deploymentId: f.A.deployment.id, status: "completed", correlationId: current.command.correlationId, reason: "stopped" });
    expect((await controls().claimDeploymentRollback(entry.command)).claimed).toBe(true);
  });
  it("resumes the same queued rollback after a transactional claim fault", async () => {
    const f = await rollbackFixture(), entry = await f.admit(await f.reserve());
    const faulty = new DbControlCommandRepository(createDbClient(pool), async (stage) => { if (stage === "authority-claimed") throw new Error("rollback claim barrier fault"); });
    await expect(faulty.claimDeploymentRollback(entry.command)).rejects.toThrow("rollback claim barrier fault");
    const before = (await pool.query("SELECT status,result,execution_authority FROM control_commands WHERE id=$1", [entry.command.id])).rows[0];
    expect(before).toMatchObject({ status: "eligible", execution_authority: null, result: { deploymentId: entry.deployment.id } });
    expect((await controls().claimDeploymentRollback(entry.command)).claimed).toBe(true);
    expect((await pool.query("SELECT id FROM deployments WHERE id=$1", [entry.deployment.id])).rowCount).toBe(1);
  });
  it("serializes rollback and Stop authority on active A across PostgreSQL clients", async () => {
    const f = await rollbackFixture(), entry = await f.admit(await f.reserve()), locked = await pool.connect();
    const application = `p2_rollback_${randomUUID()}`, contender = createDbPool(databaseUrl, { max: 1, application_name: application, statement_timeout: 5_000 });
    let claiming: ReturnType<DbControlCommandRepository["claimDeploymentRollback"]> | undefined;
    try {
      await locked.query("BEGIN"); await locked.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`deploylite:execution:${f.projectId}`]);
      claiming = new DbControlCommandRepository(createDbClient(contender)).claimDeploymentRollback(entry.command);
      await waitForProjectLock(application); expect((await pool.query("SELECT execution_authority FROM control_commands WHERE id=$1", [entry.command.id])).rows).toEqual([{ execution_authority: null }]);
      await locked.query("COMMIT"); const claimed = await claiming; expect(requireAuthority(claimed).sourceLease?.deploymentId).toBe(f.A.deployment.id);
      const stopCommand = createControlCommand({ actorId: f.actorId, action: "deployment.stop", scope: { kind: "deployment", projectId: f.projectId, deploymentId: f.A.deployment.id }, input: {}, idempotencyKey: randomUUID(), correlationId: randomUUID() });
      const second = new DbControlCommandRepository(createDbClient(contender)); await second.resolve(stopCommand);
      const confirmation = createConfirmation({ command: stopCommand, classification: "destructive" }); await second.bind(confirmation);
      const stop = await second.executeConfirmedDeploymentStop({ command: stopCommand, confirmation, requestId: randomUUID() });
      expect((await second.claimDeploymentStop(stop.command)).claimed).toBe(false);
      expect((await pool.query("SELECT status,execution_authority FROM control_commands WHERE id=$1", [stop.command.id])).rows).toEqual([{ status: "eligible", execution_authority: null }]);
    } finally { await locked.query("ROLLBACK"); locked.release(); await Promise.allSettled([claiming]); await contender.end(); }
  }, 30_000);
  it("commits R proof and rollback result with H lineage and independent active A atomically", async () => {
    const f = await rollbackFixture(), entry = await f.admit(await f.reserve()), { input } = await f.run(entry), history = [f.A.deployment, f.H.deployment];
    expect((await completion().completeExecution(input)).kind).toBe("committed");
    expect((await completion().completeExecution(input)).kind).toBe("replayed");
    expect(await deployments().findById(input.executionId)).toMatchObject({ status: "succeeded", sourceDeploymentId: f.H.deployment.id, activeDeploymentId: f.A.deployment.id, snapshotOriginId: f.H.snapshot.deploymentId, executionReceipt: input.proof });
    expect(await Promise.all(history.map((d) => deployments().findById(d.id)))).toEqual(history);
    expect((await pool.query("SELECT status,result FROM control_commands WHERE id=$1", [entry.command.id])).rows).toEqual([{ status: "completed", result: input.commandResult }]);
  });
  it("rolls back an A/H/R terminal trigger fault and completes the identical cached receipt once", async () => {
    const f = await rollbackFixture(), entry = await f.admit(await f.reserve()), { input } = await f.run(entry), cache = new DbAgentReplayStore(createDbClient(pool), "ahr-original");
    const lease = input.authority!.executionLease, claimed = await cache.claim(entry.command.id, "original-fingerprint", lease);
    await cache.complete(entry.command.id, { claimToken: claimed.claimToken!, fingerprint: "original-fingerprint", receipt: { input } });
    const trigger = `p2_ahr_fault_${randomUUID().replaceAll("-", "")}`;
    await pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'AHR terminal fault'; END $$`);
    await pool.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON control_commands FOR EACH ROW WHEN (OLD.id='${entry.command.id}'::uuid) EXECUTE FUNCTION ${trigger}()`);
    try { await expect(completion().completeExecution(input)).rejects.toMatchObject({ cause: { message: "AHR terminal fault", code: "P0001" } }); expect(await deployments().findById(input.executionId)).toMatchObject({ status: "running", finishedAt: null }); }
    finally { await pool.query(`DROP TRIGGER ${trigger} ON control_commands`); await pool.query(`DROP FUNCTION ${trigger}()`); }
    const cached = await cache.lookup(entry.command.id, "original-fingerprint"); expect(cached).toEqual({ input });
    expect((await completion().completeExecution(cached!.input as ExecutionCompletionInput)).kind).toBe("committed"); expect((await completion().completeExecution(input)).kind).toBe("replayed");
  }, 30_000);
  it("reads original execute and Stop cached receipts after reopening the PostgreSQL client without claims", async () => {
    const f = await rollbackFixture(), one = new DbAgentReplayStore(createDbClient(pool), "original-owner"), lease = { leaseId: randomUUID(), deploymentId: f.A.deployment.id, fence: 1, expiresAt: Date.now()+120_000 };
    const ids = [randomUUID(), randomUUID()];
    for (const id of ids) { const claim = await one.claim(id, `fp-${id}`, lease); await one.complete(id, { claimToken: claim.claimToken!, fingerprint: `fp-${id}`, receipt: { commandId: id, correlationId: "original", proof: f.A.input.proof } }); }
    const freshPool = createDbPool(databaseUrl, { max: 1 });
    try {
      const fresh = new DbAgentReplayStore(createDbClient(freshPool), "fresh-reader"), before = (await pool.query("SELECT * FROM agent_replay WHERE command_id=ANY($1::text[]) ORDER BY command_id", [ids])).rows;
      for (const id of ids) expect(await fresh.lookup(id, `fp-${id}`)).toMatchObject({ commandId: id, correlationId: "original", proof: f.A.input.proof });
      expect((await pool.query("SELECT * FROM agent_replay WHERE command_id=ANY($1::text[]) ORDER BY command_id", [ids])).rows).toEqual(before);
      await expect(fresh.lookup(ids[0]!, "changed")).rejects.toThrow();
      await pool.query("UPDATE agent_replay SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE command_id=$1", [ids[0]]); expect(await fresh.lookup(ids[0]!, `fp-${ids[0]}`)).toBeNull();
    } finally { await freshPool.end(); }
  });
  it("rolls back cancellation observed during staged rollback publication and preserves durable equal replay", async () => {
    const f = await rollbackFixture(), entry = await f.admit(await f.reserve()), { input } = await f.run(entry), controller = new AbortController();
    const key = `p2:cancel:${entry.command.id}`, trigger = `p2_cancel_${randomUUID().replaceAll("-", "")}`, locked = await pool.connect();
    const application = `p2_cancel_${randomUUID()}`, writer = createDbPool(databaseUrl, { max: 1, application_name: application, statement_timeout: 5_000 });
    let writing: Promise<unknown> | undefined;
    try {
      await locked.query("BEGIN"); await locked.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
      await pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('${key}',0)); RETURN NEW; END $$`);
      await pool.query(`CREATE TRIGGER ${trigger} AFTER UPDATE ON deployments FOR EACH ROW WHEN (OLD.id='${input.executionId}'::uuid) EXECUTE FUNCTION ${trigger}()`);
      writing = new DbDeploymentExecutionRepository(createDbClient(writer)).completeExecution(input, controller.signal);
      const deadline=Date.now()+5_000; let blocked=false;
      do { blocked=Boolean((await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') AS blocked", [application])).rows[0].blocked); if (!blocked) await yieldToLoop(); } while (!blocked && Date.now()<deadline);
      expect(blocked).toBe(true); controller.abort(new Error("request aborted during staged R write")); await locked.query("COMMIT");
      await expect(writing).rejects.toThrow("request aborted"); expect(await deployments().findById(input.executionId)).toMatchObject({ status:"running",finishedAt:null });
      expect((await pool.query("SELECT status FROM control_commands WHERE id=$1",[entry.command.id])).rows).toEqual([{status:"dispatching"}]);
    } finally { await locked.query("ROLLBACK"); locked.release(); await Promise.allSettled([writing]); await writer.end(); await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON deployments`); await pool.query(`DROP FUNCTION IF EXISTS ${trigger}()`); }
    expect((await completion().completeExecution(input)).kind).toBe("committed"); expect((await completion().completeExecution(input, controller.signal)).kind).toBe("replayed");
  }, 30_000);

  it.skipIf(!process.env.DEPLOYLITE_PG_RESTART_HELPER)("retains proof, command and canonical origin across an owned server restart", async () => {
    const { input, snapshot } = await seed();
    expect((await completion().completeExecution(input)).kind).toBe("committed");
    const ahr = await rollbackFixture(), entryR = await ahr.admit(await ahr.reserve()), terminalR = await ahr.run(entryR);
    expect((await completion().completeExecution(terminalR.input)).kind).toBe("committed");
    const cache = new DbAgentReplayStore(createDbClient(pool), "restart-original"), cacheId = `deploy_${entryR.deployment.id}`;
    const cacheClaim = await cache.claim(cacheId, "restart-fingerprint", terminalR.input.authority!.executionLease);
    await cache.complete(cacheId, { fingerprint: "restart-fingerprint", claimToken: cacheClaim.claimToken!, receipt: { input: terminalR.input } });
    const fixture = await authorityFixture();
    const replacement = await admitAuthorityCommand(fixture, "deployment.redeploy");
    if (!replacement.deployment) throw new Error("Expected execution fixture");
    await deployments().save({ ...replacement.deployment, status: "running" });
    const stale = requireAuthority(await claimAuthority(controls(), replacement));
    await pool.query("UPDATE control_commands SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [replacement.command.id]);
    const stop = await admitAuthorityCommand(fixture, "deployment.stop");
    const current = requireAuthority(await claimAuthority(controls(), stop));
    expect(current.projectLease.fence).toBe(stale.projectLease.fence + 1);
    await pool.end();
    await maintenance.end();
    await promisify(execFile)("python3", [process.env.DEPLOYLITE_PG_RESTART_HELPER!]);
    const url = new URL(databaseUrl);
    url.pathname = "/postgres";
    maintenance = new pg.Client({ connectionString: url.toString() });
    await maintenance.connect();
    pool = createDbPool(databaseUrl, { max: 3 });
    expect((await completion().completeExecution(input)).kind).toBe("replayed");
    expect((await completion().completeExecution(terminalR.input)).kind).toBe("replayed");
    expect(await new DbAgentReplayStore(createDbClient(pool), "restart-reader").lookup(cacheId, "restart-fingerprint")).toEqual({ input: terminalR.input });
    expect(await deployments().findById(entryR.deployment.id)).toMatchObject({ activeDeploymentId: ahr.A.deployment.id, sourceDeploymentId: ahr.H.deployment.id, executionReceipt: terminalR.input.proof });
    await expect(deployments().findByHash(input.snapshotHash)).resolves.toEqual(snapshot);
    await expect(deployments().findById(input.executionId)).resolves.toMatchObject({ status: "succeeded", executionReceipt: input.proof });
    expect((await pool.query("SELECT execution_authority FROM control_commands WHERE id=$1", [stop.command.id])).rows).toEqual([{ execution_authority: current }]);
    await expect(controls().validateDeploymentAuthority(current)).resolves.toBeUndefined();
    await expect(controls().validateDeploymentAuthority(stale)).rejects.toThrow();
    await expect(completion().completeExecution(authorityCompletion(fixture, replacement, stale))).resolves.toEqual({ kind: "conflict" });
    expect((await pool.query("SELECT status,execution_receipt,finished_at FROM deployments WHERE id=$1", [replacement.deployment.id])).rows).toEqual([{ status: "running", execution_receipt: null, finished_at: null }]);
  }, 30_000);
});
