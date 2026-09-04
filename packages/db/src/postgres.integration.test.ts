import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDbClient, createDbPool, closeDbPool, type DeployLiteDb } from "./client.js";
import { assertEnvMetadataHasNoValueColumns, toEnvVariableMetadataInsert } from "./env-metadata.js";
import { DbAuthUserRepository, DbRoleRepository, DbSessionRepository } from "./repositories/auth.js";
import { DbAgentRepository, DbDeploymentRepository, DbProjectRepository } from "./repositories/deployment-data.js";
import { DbControlCommandRepository, DbControlGrantRepository } from "./repositories/control-plane.js";
import { DbAgentReplayStore } from "./repositories/agent-replay.js";
import { IdempotencyConflictError, createConfirmation, createControlCommand, digestControlInput } from "@deploylite/domain";
import { createDeploymentSnapshot, createSourceIntent } from "@deploylite/contracts";

const { Client } = pg;

const integrationEnabled = process.env.DEPLOYLITE_DB_INTEGRATION === "1";
const describeIntegration = integrationEnabled ? describe : describe.skip;
const configuredDatabaseUrl = integrationEnabled ? requireIntegrationDatabaseUrl() : "";

let maintenanceClient: pg.Client | null = null;
let databaseName = "";
let databaseUrl = "";
let pool: pg.Pool | null = null;
let db: DeployLiteDb | null = null;

describeIntegration("PostgreSQL auth foundation integration", () => {
  beforeAll(async () => {
    databaseName = `deploylite_verify_${randomUUID().replaceAll("-", "_")}`;

    const maintenanceUrl = new URL(configuredDatabaseUrl);
    maintenanceUrl.pathname = "/postgres";
    maintenanceClient = new Client({ connectionString: maintenanceUrl.toString() });
    await maintenanceClient.connect();
    await maintenanceClient.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

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

    if (maintenanceClient && databaseName) {
      await maintenanceClient.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
      await maintenanceClient.end();
      maintenanceClient = null;
    }
  }, 30_000);

  it("applies migrations to an empty database and seeds canonical roles", async () => {
    const roles = await requireDbRoleRepository().list();

    expect(roles.map((role) => role.name).sort()).toEqual(["admin", "auditor", "operator", "read-only"]);
  });

  it("rejects invalid roles, user FK/status, and env metadata constraints", async () => {
    const client = requirePool();
    const adminRole = (await client.query<{ id: string }>("SELECT id FROM roles WHERE name = 'admin'")).rows.at(0);

    if (!adminRole) {
      throw new Error("Canonical admin role was not seeded");
    }

    await expect(client.query("INSERT INTO roles (name, description) VALUES ('owner', 'Legacy owner')")).rejects.toThrow();
    await expect(
      client.query("INSERT INTO users (email, email_normalized, password_hash, role_id) VALUES ($1, $2, $3, gen_random_uuid())", [
        "fk@example.test",
        "fk@example.test",
        "hash"
      ])
    ).rejects.toThrow();
    await expect(
      client.query("INSERT INTO users (email, email_normalized, password_hash, role_id, status) VALUES ($1, $2, $3, $4, 'locked')", [
        "status@example.test",
        "status@example.test",
        "hash",
        adminRole.id
      ])
    ).rejects.toThrow();
    await expect(
      client.query("INSERT INTO env_variable_metadata (project_id, key, scope) VALUES (gen_random_uuid(), 'TOKEN', 'global')")
    ).rejects.toThrow();
    await expect(
      client.query("INSERT INTO env_variable_metadata (project_id, key, scope) VALUES (gen_random_uuid(), 'TOKEN', 'project')")
    ).rejects.toThrow();
  });

  it("persists auth users and sessions across a new PostgreSQL client lifecycle", async () => {
    const users = requireDbAuthUserRepository();
    const sessions = requireDbSessionRepository();
    const createdUser = await users.createInitialAdmin({ email: "Admin@Example.TEST", passwordHash: "$2b$04$integrationhash" });
    const createdSession = await sessions.create({
      userId: createdUser.id,
      tokenHash: "sha256:integration-token-hash",
      expiresAt: new Date(Date.now() + 60_000),
      ipHash: "sha256:ip",
      userAgent: "deploylite-integration-test"
    });

    await closeDbPool(requirePool());
    pool = createDbPool(databaseUrl, { max: 2 });
    db = createDbClient(pool);

    await expect(requireDbAuthUserRepository().findByEmail("admin@example.test")).resolves.toMatchObject({
      id: createdUser.id,
      email: "Admin@Example.TEST",
      role: "admin",
      status: "active"
    });
    await expect(requireDbSessionRepository().findValidByTokenHash("sha256:integration-token-hash")).resolves.toMatchObject({
      id: createdSession.id,
      userId: createdUser.id,
      tokenHash: "sha256:integration-token-hash"
    });
  });

  it("persists deployment metadata foundations across a new PostgreSQL client lifecycle", async () => {
    const client = requirePool();
    const now = new Date().toISOString();
    const serverId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const deploymentId = randomUUID();
    const deploymentLogId = randomUUID();
    const domainId = randomUUID();
    const certificateId = randomUUID();
    const envMetadataId = randomUUID();

    await client.query(
      "INSERT INTO servers (id, name, endpoint, status, metadata) VALUES ($1, $2, $3, $4, $5::jsonb)",
      [serverId, "Integration server", "https://server.integration.test", "online", JSON.stringify({ region: "local" })]
    );

    await requireDbAgentRepository().save({
      id: agentId,
      name: "Integration agent",
      endpoint: "https://agent.integration.test",
      status: "online",
      lastHeartbeatAt: now,
      resourceSnapshot: {
        cpuLoad: 0.25,
        memoryUsedBytes: 128,
        memoryTotalBytes: 1024,
        diskUsedBytes: 256,
        diskTotalBytes: 2048
      }
    });
    await client.query("UPDATE agents SET server_id = $1 WHERE id = $2", [serverId, agentId]);

    await requireDbProjectRepository().save({
      id: projectId,
      name: "Integration project",
      repoUrl: "https://github.com/example/deploylite-integration",
      defaultBranch: "main",
      buildCommand: "pnpm build",
      runCommand: "pnpm start",
      port: 3000,
      description: null,
      imageTag: null
    });

    await requireDbDeploymentRepository().save({
      id: deploymentId,
      projectId,
      agentId,
      status: "running",
      commitSha: "abcdef1234567890",
      startedAt: now,
      finishedAt: null
    });
    const snapshot = createDeploymentSnapshot({ deploymentId, projectId, source: createSourceIntent({ sourceMode: "image", requestedReference: `registry.example.com/app@sha256:${"a".repeat(64)}` }, { policyVersion: "integration", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true }), configRevision: "config-1", runtimeRevision: "runtime-1", runtimePort: 3000, secretRefs: [{ secretRefId: "DATABASE_URL", version: 1 }], policyVersion: "integration", schemaVersion: 1 }, { sha256: () => "b".repeat(64) });
    await requireDbDeploymentRepository().saveSnapshot(snapshot);
    await expect(client.query("SELECT snapshot_hash, snapshot_evidence FROM deployments WHERE id = $1", [deploymentId])).resolves.toMatchObject({ rows: [{ snapshot_hash: snapshot.hash, snapshot_evidence: snapshot.canonicalJson }] });
    await requireDbDeploymentRepository().appendLog({
      id: deploymentLogId,
      deploymentId,
      sequence: 1,
      level: "info",
      message: "Deployment metadata persisted with secret token=plain-text removed",
      timestamp: now,
      redactionApplied: false,
      requestId: "req-integration-metadata",
      correlationId: "corr-integration-metadata"
    });

    await client.query(
      "INSERT INTO domains (id, project_id, hostname, status, metadata) VALUES ($1, $2, $3, $4, $5::jsonb)",
      [domainId, projectId, "integration.deploylite.test", "active", JSON.stringify({ source: "integration-test" })]
    );
    await client.query(
      "INSERT INTO certificates (id, domain_id, provider, status, not_before, not_after, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)",
      [
        certificateId,
        domainId,
        "acme-metadata-only",
        "issued",
        new Date(Date.now() - 60_000),
        new Date(Date.now() + 86_400_000),
        JSON.stringify({ issuer: "metadata-only" })
      ]
    );
    await client.query(
      "INSERT INTO env_variable_metadata (id, project_id, key, scope, value_present, value_fingerprint, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)",
      [
        envMetadataId,
        projectId,
        "DEPLOYLITE_TOKEN",
        "project",
        false,
        null,
        JSON.stringify({ description: "metadata only" })
      ]
    );

    await closeDbPool(requirePool());
    pool = createDbPool(databaseUrl, { max: 1 });
    db = createDbClient(pool);

    await expect(requireDbAgentRepository().findById(agentId)).resolves.toMatchObject({
      id: agentId,
      name: "Integration agent",
      endpoint: "https://agent.integration.test",
      status: "online"
    });
    expect(await requireDbProjectRepository().list()).toContainEqual(expect.objectContaining({
      id: projectId,
      name: "Integration project",
      repoUrl: "https://github.com/example/deploylite-integration",
      defaultBranch: "main",
      buildCommand: "pnpm build",
      runCommand: "pnpm start",
      port: 3000,
      description: null,
      imageTag: null
    }));
    await expect(requireDbDeploymentRepository().findById(deploymentId)).resolves.toMatchObject({
      id: deploymentId,
      projectId,
      agentId,
      status: "running",
      commitSha: "abcdef1234567890"
    });
    await expect(requireDbDeploymentRepository().listLogs(deploymentId)).resolves.toEqual([
      expect.objectContaining({
        id: deploymentLogId,
        deploymentId,
        sequence: 1,
        level: "info",
        redactionApplied: true
      })
    ]);

    const reopenedClient = requirePool();
    await expect(reopenedClient.query("SELECT id, name, status, metadata FROM servers WHERE id = $1", [serverId])).resolves.toMatchObject({
      rows: [expect.objectContaining({ id: serverId, name: "Integration server", status: "online", metadata: { region: "local" } })]
    });
    await expect(reopenedClient.query("SELECT id, hostname, status, metadata FROM domains WHERE id = $1", [domainId])).resolves.toMatchObject({
      rows: [expect.objectContaining({ id: domainId, hostname: "integration.deploylite.test", status: "active", metadata: { source: "integration-test" } })]
    });
    await expect(reopenedClient.query("SELECT id, provider, status, metadata FROM certificates WHERE id = $1", [certificateId])).resolves.toMatchObject({
      rows: [expect.objectContaining({ id: certificateId, provider: "acme-metadata-only", status: "issued", metadata: { issuer: "metadata-only" } })]
    });
    await expect(
      reopenedClient.query("SELECT id, key, scope, value_present, value_fingerprint, metadata FROM env_variable_metadata WHERE id = $1", [
        envMetadataId
      ])
    ).resolves.toMatchObject({
      rows: [
        expect.objectContaining({
          id: envMetadataId,
          key: "DEPLOYLITE_TOKEN",
          scope: "project",
          value_present: false,
          value_fingerprint: null,
          metadata: { description: "metadata only" }
        })
      ]
    });
  });

  it("keeps env metadata value-free at helper and PostgreSQL column boundaries", async () => {
    const client = requirePool();
    const columns = (
      await client.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'env_variable_metadata' ORDER BY ordinal_position"
      )
    ).rows.map((row) => row.column_name);

    expect(assertEnvMetadataHasNoValueColumns(columns)).toBe(true);
    expect(columns).not.toContain("value");
    expect(columns).not.toContain("secret");
    expect(columns).not.toContain("encrypted_value");
    expect(() =>
      toEnvVariableMetadataInsert({
        projectId: randomUUID(),
        key: "TOKEN",
        scope: "project",
        value: "plain-text-secret"
      } as Parameters<typeof toEnvVariableMetadataInsert>[0])
    ).toThrow("Environment variable metadata cannot include secret value field");
  });

  it("resolves concurrent idempotency retries once, rejects mismatched reuse, and rolls back a command", async () => {
    const client = requirePool();
    const role = (await client.query<{ id: string }>("SELECT id FROM roles WHERE name = 'admin'")).rows[0];
    if (!role) throw new Error("Canonical admin role was not seeded");
    const actorId = randomUUID();
    await client.query("INSERT INTO users (id, email, email_normalized, password_hash, role_id) VALUES ($1, $2, $2, $3, $4)", [actorId, `${actorId}@example.test`, "hash", role.id]);
    const command = createControlCommand({ actorId, action: "project.delete", scope: { kind: "project", projectId: randomUUID() }, input: { project: "one" }, idempotencyKey: "retry-key", correlationId: "corr-command" });
    const repo = new DbControlCommandRepository(requireDb());
    const retries = await Promise.all([repo.resolve(command), repo.resolve({ ...command, id: randomUUID() })]);
    expect(retries.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(retries.map((result) => result.command.id))).toEqual(new Set([retries.find((result) => result.created)?.command.id]));
    await expect(repo.resolve({ ...command, id: randomUUID(), inputDigest: digestControlInput({ project: "other" }) })).rejects.toBeInstanceOf(IdempotencyConflictError);

    const rolledBackId = randomUUID();
    await client.query("BEGIN");
    await client.query("INSERT INTO control_commands (id, actor_user_id, action, scope_kind, scope_key, input_digest, idempotency_key, correlation_id, expires_at) VALUES ($1, $2, 'project.delete', 'project', $3, $4, 'rollback-key', 'corr-rollback', now())", [rolledBackId, actorId, randomUUID(), digestControlInput({ rollback: true })]);
    await client.query("ROLLBACK");
    await expect(client.query("SELECT id FROM control_commands WHERE id = $1", [rolledBackId])).resolves.toMatchObject({ rowCount: 0 });
  });

  it("loads only persisted actor/action grants and fails closed for absent or cross-project scopes", async () => {
    const client = requirePool();
    const role = (await client.query<{ id: string }>("SELECT id FROM roles WHERE name = 'operator'")).rows[0];
    if (!role) throw new Error("Canonical operator role was not seeded");
    const actorId = randomUUID();
    await client.query("INSERT INTO users (id, email, email_normalized, password_hash, role_id) VALUES ($1, $2, $2, $3, $4)", [actorId, `${actorId}@example.test`, "hash", role.id]);
    const projectA = randomUUID();
    const projectB = randomUUID();
    await client.query("INSERT INTO control_grants (actor_user_id, action, scope_kind, scope_key) VALUES ($1, 'project.delete', 'project', $2)", [actorId, projectA]);
    const grants = await new DbControlGrantRepository(requireDb()).listForActor(actorId);

    expect(grants).toEqual([expect.objectContaining({ actorId, action: "project.delete", scope: { kind: "project", projectId: projectA } })]);
    expect(grants.some((grant) => grant.scope.kind === "project" && grant.scope.projectId === projectB)).toBe(false);
    await expect(new DbControlGrantRepository(requireDb()).listForActor(randomUUID())).resolves.toEqual([]);
  });

  it("atomically rejects mismatched, expired, and replayed confirmations with correlated audit evidence", async () => {
    const client = requirePool();
    const role = (await client.query<{ id: string }>("SELECT id FROM roles WHERE name = 'admin'")).rows[0];
    if (!role) throw new Error("Canonical admin role was not seeded");
    const actorId = randomUUID();
    await client.query("INSERT INTO users (id, email, email_normalized, password_hash, role_id) VALUES ($1, $2, $2, $3, $4)", [actorId, `${actorId}@example.test`, "hash", role.id]);
    const repo = new DbControlCommandRepository(requireDb());
    const command = createControlCommand({ actorId, action: "project.delete", scope: { kind: "project", projectId: randomUUID() }, input: { project: "one" }, idempotencyKey: "confirmation-key", correlationId: "corr-confirmation" });
    await repo.resolve(command);
    const mismatchedActorId = randomUUID();
    await client.query("INSERT INTO users (id, email, email_normalized, password_hash, role_id) VALUES ($1, $2, $2, $3, $4)", [mismatchedActorId, `${mismatchedActorId}@example.test`, "hash", role.id]);
    const mismatched = { ...createConfirmation({ command, classification: "destructive" }), actorId: mismatchedActorId };
    await repo.bind(mismatched);
    await expect(repo.consume(command, mismatched)).resolves.toMatchObject({ accepted: false, reason: "confirmation_rejected" });
    const validCommand = createControlCommand({ ...command, idempotencyKey: "confirmation-valid-key", input: { project: "valid" } });
    await repo.resolve(validCommand);
    const confirmation = createConfirmation({ command: validCommand, classification: "destructive" });
    await repo.bind(confirmation);
    const outcomes = await Promise.all([repo.consume(validCommand, confirmation), repo.consume(validCommand, confirmation)]);
    expect(outcomes.filter((outcome) => outcome.accepted)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.accepted)).toHaveLength(1);
    await expect(client.query("SELECT outcome, correlation_id FROM control_command_audits WHERE command_id = $1 ORDER BY created_at", [validCommand.id])).resolves.toMatchObject({ rowCount: 2, rows: expect.arrayContaining([expect.objectContaining({ outcome: "accepted", correlation_id: validCommand.correlationId }), expect.objectContaining({ outcome: "rejected", correlation_id: validCommand.correlationId })]) });

    const expired = createControlCommand({ ...command, idempotencyKey: "expired-key", correlationId: "corr-expired", input: { project: "expired" } });
    await repo.resolve(expired);
    const expiredConfirmation = createConfirmation({ command: expired, classification: "destructive", expiresAt: new Date(0) });
    await repo.bind(expiredConfirmation);
    await expect(repo.consume(expired, expiredConfirmation)).resolves.toMatchObject({ accepted: false, reason: "confirmation_rejected" });
  });

  it("durably resolves deployment stop once and replays its completed result", async () => {
    const client = requirePool();
    const role = (await client.query<{ id: string }>("SELECT id FROM roles WHERE name = 'admin'")).rows[0];
    if (!role) throw new Error("Canonical admin role was not seeded");
    const actorId = randomUUID(); const projectId = randomUUID(); const deploymentId = randomUUID();
    await client.query("INSERT INTO users (id, email, email_normalized, password_hash, role_id) VALUES ($1, $2, $2, $3, $4)", [actorId, `${actorId}@example.test`, "hash", role.id]);
    const command = createControlCommand({ actorId, action: "deployment.stop", scope: { kind: "deployment", projectId, deploymentId }, input: { deploymentId }, idempotencyKey: "stop-key", correlationId: "corr-stop" });
    const repo = new DbControlCommandRepository(requireDb());
    const resolved = await Promise.all([repo.resolve(command), repo.resolve({ ...command, id: randomUUID() })]);
    expect(resolved.filter((item) => item.created)).toHaveLength(1);
    await expect(repo.resolve({ ...command, id: randomUUID(), inputDigest: digestControlInput({ deploymentId: "other" }) })).rejects.toBeInstanceOf(IdempotencyConflictError);
    const confirmation = createConfirmation({ command, classification: "destructive" }); await repo.bind(confirmation);
    const otherDeploymentId = randomUUID();
    const otherCommand = createControlCommand({ actorId, action: "deployment.stop", scope: { kind: "deployment", projectId, deploymentId: otherDeploymentId }, input: { deploymentId: otherDeploymentId }, idempotencyKey: "other-stop-key", correlationId: "corr-other-stop" });
    await repo.resolve(otherCommand);
    await expect(repo.executeConfirmedDeploymentStop({ command: otherCommand, confirmation, requestId: "req-stop" })).resolves.toMatchObject({ accepted: false, reason: "confirmation_rejected" });
    const admitted = await repo.executeConfirmedDeploymentStop({ command, confirmation, requestId: "req-stop" });
    expect(admitted).toMatchObject({ accepted: true, result: { status: "eligible", deploymentId } });
    const result = { ...admitted.result!, status: "completed" as const, reason: null };
    await expect(repo.completeDeploymentStop(admitted.command, result)).resolves.toMatchObject({ status: "completed", result });
    await expect(repo.executeConfirmedDeploymentStop({ command, confirmation, requestId: "req-stop" })).resolves.toMatchObject({ alreadyCompleted: true, result });
  });

  it("rolls back a redeploy when its deployment insert fault is injected", async () => {
    const client = requirePool(); const role = (await client.query<{ id: string }>("SELECT id FROM roles WHERE name = 'admin'")).rows[0]; if (!role) throw new Error("Canonical admin role was not seeded");
    const actorId = randomUUID(); const projectId = randomUUID(); const agentId = randomUUID(); const sourceId = randomUUID(); const redeployId = randomUUID(); const snapshot = createDeploymentSnapshot({ deploymentId: sourceId, projectId, agentId, commitSha: "abcdef1", source: createSourceIntent({ sourceMode: "image", requestedReference: `registry.example.com/app@sha256:${"a".repeat(64)}` }, { policyVersion: "p1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true }), configRevision: "c1", runtimeRevision: "r1", runtimePort: 3000, secretRefs: [], policyVersion: "p1", schemaVersion: 1 }, { sha256: () => "d".repeat(64) });
    await client.query("INSERT INTO users (id, email, email_normalized, password_hash, role_id) VALUES ($1, $2, $2, $3, $4)", [actorId, `${actorId}@example.test`, "hash", role.id]); await client.query("INSERT INTO projects (id, name, repo_url, default_branch) VALUES ($1, 'Redeploy project', 'https://example.test/repo', 'main')", [projectId]); await client.query("INSERT INTO agents (id, name, endpoint, status) VALUES ($1, 'Redeploy agent', 'https://agent.test', 'online')", [agentId]); await client.query("INSERT INTO deployments (id, project_id, agent_id, status, commit_sha, started_at, snapshot_hash, snapshot_evidence) VALUES ($1, $2, $3, 'succeeded', 'abcdef1', now(), $4, $5)", [sourceId, projectId, agentId, snapshot.hash, snapshot.canonicalJson]);
    const command = createControlCommand({ actorId, action: "deployment.redeploy", scope: { kind: "deployment", projectId, deploymentId: sourceId }, input: { actorId, projectId, sourceDeploymentId: sourceId, snapshotHash: snapshot.hash }, idempotencyKey: "redeploy-fault", correlationId: "corr-redeploy-fault" }); const confirmation = createConfirmation({ command, classification: "destructive" }); const repo = new DbControlCommandRepository(requireDb(), async (stage) => { if (stage === "redeploy-deployment-inserted") throw new Error("injected redeploy fault"); }); await repo.resolve(command); await repo.bind(confirmation);
    await expect(repo.executeConfirmedDeploymentRedeploy({ command, confirmation, deployment: { id: redeployId, projectId, agentId, status: "queued", commitSha: "abcdef1", startedAt: new Date().toISOString(), finishedAt: null, sourceDeploymentId: sourceId, snapshotHash: snapshot.hash }, requestId: "req-redeploy-fault", snapshotHash: snapshot.hash })).rejects.toThrow("injected redeploy fault");
    await expect(client.query("SELECT status FROM control_commands WHERE id = $1", [command.id])).resolves.toMatchObject({ rows: [{ status: "pending_confirmation" }] }); await expect(client.query("SELECT consumed_at FROM control_command_confirmations WHERE id = $1", [confirmation.id])).resolves.toMatchObject({ rows: [{ consumed_at: null }] }); await expect(client.query("SELECT id FROM deployments WHERE id = $1", [redeployId])).resolves.toMatchObject({ rowCount: 0 });
  });

  it("rejects a non-stop action before confirmation consumption", async () => {
    const client = requirePool(); const role = (await client.query<{ id: string }>("SELECT id FROM roles WHERE name = 'admin'")).rows[0];
    if (!role) throw new Error("Canonical admin role was not seeded");
    const actorId = randomUUID(); const projectId = randomUUID();
    await client.query("INSERT INTO users (id, email, email_normalized, password_hash, role_id) VALUES ($1, $2, $2, $3, $4)", [actorId, `${actorId}@example.test`, "hash", role.id]);
    const command = createControlCommand({ actorId, action: "project.delete", scope: { kind: "project", projectId }, input: { projectId }, idempotencyKey: "wrong-action-key", correlationId: "corr-wrong-action" });
    const confirmation = createConfirmation({ command, classification: "destructive" }); const repo = new DbControlCommandRepository(requireDb());
    await repo.resolve(command); await repo.bind(confirmation);
    await expect(repo.executeConfirmedDeploymentStop({ command, confirmation, requestId: "req-wrong-action" })).resolves.toMatchObject({ accepted: false, reason: "invalid_action" });
    await expect(client.query("SELECT status FROM control_commands WHERE id = $1", [command.id])).resolves.toMatchObject({ rows: [{ status: "pending_confirmation" }] });
  });

  it("claims replay once, detects payload conflicts, and replays a receipt after client restart", async () => {
    const commandId = randomUUID(); const lease = { leaseId: "lease-replay", deploymentId: randomUUID(), fence: 1, expiresAt: Date.now() + 30_000 };
    const receipt = { deploymentId: lease.deploymentId, effectiveImage: `registry.example.com/app@sha256:${"a".repeat(64)}`, runtimePort: 3000, health: "passed" as const, terminalStatus: "succeeded" as const, rollback: { target: null, result: "not-required" as const }, proven: true as const };
    const first = new DbAgentReplayStore(requireDb(), "worker-a"); const second = new DbAgentReplayStore(requireDb(), "worker-b");
    const claims = await Promise.all([first.claim(commandId, "payload-a", lease), second.claim(commandId, "payload-a", lease)]);
    expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
    await expect(first.claim(commandId, "payload-b", lease)).rejects.toThrow("replayed with a different payload");
    const ownerIndex = claims.findIndex((claim) => claim.claimed); const owner = ownerIndex === 0 ? first : second; await owner.complete(commandId, { fingerprint: "payload-a", claimToken: claims[ownerIndex]!.claimToken!, receipt });
    await expect(new DbAgentReplayStore(requireDb(), "worker-c").claim(commandId, "payload-a", lease)).resolves.toMatchObject({ claimed: false, receipt });
  });
  it("rejects the old claimant after atomic lease reclaim", async () => { const commandId = randomUUID(); const deploymentId = randomUUID(); const receipt = { deploymentId, effectiveImage: `registry.example.com/app@sha256:${"a".repeat(64)}`, runtimePort: 3000, health: "passed" as const, terminalStatus: "succeeded" as const, rollback: { target: null, result: "not-required" as const }, proven: true as const }; const first = new DbAgentReplayStore(requireDb(), "same-process"); const second = new DbAgentReplayStore(requireDb(), "same-process"); const oldLease = { leaseId: "old", deploymentId, fence: 1, expiresAt: Date.now() + 30_000 }; const oldClaim = await first.claim(commandId, "payload", oldLease); await requirePool().query("UPDATE agent_replay SET lease_expires_at = now() - interval '1 second' WHERE command_id = $1", [commandId]); const newClaim = await second.claim(commandId, "payload", { ...oldLease, leaseId: "new", expiresAt: Date.now() + 30_000 }); await expect(first.complete(commandId, { fingerprint: "payload", claimToken: oldClaim.claimToken!, receipt })).rejects.toThrow("stale"); await second.complete(commandId, { fingerprint: "payload", claimToken: newClaim.claimToken!, receipt }); await expect(new DbAgentReplayStore(requireDb(), "reader").claim(commandId, "payload", oldLease)).resolves.toMatchObject({ claimed: false, receipt }); });
});

function requirePool(): pg.Pool {
  if (!pool) {
    throw new Error("PostgreSQL integration pool is not initialized");
  }

  return pool;
}

function requireIntegrationDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be set when DEPLOYLITE_DB_INTEGRATION=1.");
  }

  return databaseUrl;
}

function requireDb(): DeployLiteDb {
  if (!db) {
    throw new Error("PostgreSQL integration client is not initialized");
  }

  return db;
}

function requireDbRoleRepository(): DbRoleRepository {
  return new DbRoleRepository(requireDb());
}

function requireDbAuthUserRepository(): DbAuthUserRepository {
  return new DbAuthUserRepository(requireDb());
}

function requireDbSessionRepository(): DbSessionRepository {
  return new DbSessionRepository(requireDb());
}

function requireDbAgentRepository(): DbAgentRepository {
  return new DbAgentRepository(requireDb());
}

function requireDbProjectRepository(): DbProjectRepository {
  return new DbProjectRepository(requireDb());
}

function requireDbDeploymentRepository(): DbDeploymentRepository {
  return new DbDeploymentRepository(requireDb());
}

async function applyMigrations(connectionString: string): Promise<void> {
  const migrationClient = new Client({ connectionString });
  await migrationClient.connect();

  try {
    const migrationsUrl = new URL("../migrations/", import.meta.url);
    const migrationFiles = (await readdir(migrationsUrl)).filter((file) => file.endsWith(".sql")).sort();

    for (const file of migrationFiles) {
      const sql = await readFile(new URL(file, migrationsUrl), "utf8");
      await migrationClient.query(sql);
    }
  } finally {
    await migrationClient.end();
  }
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe PostgreSQL identifier: ${identifier}`);
  }

  return `"${identifier}"`;
}
