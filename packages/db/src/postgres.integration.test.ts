import "./execution-postgres.integration-cases.js";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDbClient, createDbPool, closeDbPool, type DeployLiteDb } from "./client.js";
import { assertEnvMetadataHasNoValueColumns, toEnvVariableMetadataInsert } from "./env-metadata.js";
import { DbAuthUserRepository, DbRoleRepository, DbSessionRepository } from "./repositories/auth.js";
import { DbAgentRepository, DbDeploymentRepository, DbProjectRepository } from "./repositories/deployment-data.js";
import { DbControlCommandRepository, DbControlGrantRepository } from "./repositories/control-plane.js";
import { DbTransportPortApplyStore } from "./repositories/transport-port-apply.js";
import { DbAgentReplayStore } from "./repositories/agent-replay.js";
import { DbComposeResourceCleanupStore } from "./repositories/compose-resource-cleanup.js";
import { DbDomainRouteClaimReader } from "./repositories/domain-routes.js";
import { IdempotencyConflictError, createConfirmation, createControlCommand, createDomainRoutePlan, createTransportPortPlan, digestControlInput, domainRouteNetworkName } from "@deploylite/domain";
import { createDeploymentSnapshot, createSourceIntent, domainRouteIntentSchema, transportPortApplyReceiptSchema, transportPortIntentSchema,
  trustedPriorExecutionReceiptSchema, type DomainRouteApplyReceiptV1, type TransportPortApplyReceiptV1, type TransportPortBindingV1,
  type TransportPortTransferV1 } from "@deploylite/contracts";
import { createComposePreview, type PreparedComposeResourceCleanup } from "@deploylite/domain";
import type { ComposeResourceCleanupConfirmationViewV1, ComposeResourceCleanupInput } from "@deploylite/contracts";

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
    const snapshot = createDeploymentSnapshot({ deploymentId, projectId, source: createSourceIntent({ sourceMode: "image", requestedReference: `registry.example.com/app@sha256:${"a".repeat(64)}` }, { policyVersion: "integration", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true }), configRevision: "config-1", runtimeRevision: "runtime-1", runtimePort: 3000, secretRefs: [{ secretRefId: "DATABASE_URL", version: 1 }], policyVersion: "integration", schemaVersion: 1 }, { sha256: (bytes) => createHash("sha256").update(bytes).digest("hex") });
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

    await expect(requireDbDeploymentRepository().findByHash(snapshot.hash)).resolves.toEqual(snapshot);

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

  it("atomically persists domain route revisions and replays an authorized rollback without detaching its certificate", async () => {
    const client = requirePool();
    const adminRole = (await client.query<{ id: string }>("SELECT id FROM roles WHERE name = 'admin'")).rows[0];
    if (!adminRole) throw new Error("Canonical admin role was not seeded");

    const actorId = randomUUID();
    const projectId = randomUUID();
    const deploymentId = randomUUID();
    const agentRowId = randomUUID();
    const now = new Date().toISOString();
    const agentId = `route-agent-${randomUUID()}`;
    const route = domainRouteIntentSchema.parse({
      schemaVersion: 1,
      projectId,
      deploymentId,
      domain: `route-${projectId.slice(0, 8)}.integration.test`
    });

    await client.query("INSERT INTO users (id, email, email_normalized, password_hash, role_id) VALUES ($1, $2, $2, $3, $4)", [
      actorId, `${actorId}@example.test`, "hash", adminRole.id
    ]);
    await new DbAgentRepository(requireDb()).save({
      id: agentRowId,
      name: "Route integration agent",
      endpoint: "https://route-agent.integration.test",
      status: "online",
      lastHeartbeatAt: now,
      resourceSnapshot: null
    });
    await requireDbProjectRepository().save({
      id: projectId,
      name: "Route integration project",
      repoUrl: "https://github.com/example/deploylite-route-integration",
      defaultBranch: "main",
      buildCommand: null,
      runCommand: "node server.js",
      port: 3000,
      description: null,
      imageTag: null
    });
    await requireDbDeploymentRepository().save({
      id: deploymentId,
      projectId,
      agentId: agentRowId,
      status: "succeeded",
      commitSha: "abcdef1234567",
      startedAt: now,
      finishedAt: now
    });

    const command = {
      ...createControlCommand({
        actorId,
        action: "project.update",
        scope: { kind: "project", projectId },
        input: { domainRoute: route },
        idempotencyKey: "domain-route-apply-pg",
        correlationId: "corr-domain-route-apply-pg"
      }),
      status: "eligible" as const
    };
    const commandRepo = new DbControlCommandRepository(requireDb());
    await commandRepo.resolve(command);
    const claimed = await commandRepo.claimProjectUpdate(command);
    expect(claimed.claimed).toBe(true);
    if (!claimed.authority) throw new Error("Project update authority was not claimed");

    const routeStore = new DbDomainRouteClaimReader(requireDb());
    const plan = createDomainRoutePlan({ desired: route, currentClaims: await routeStore.listClaims() });
    expect(plan.action).toBe("create");
    await routeStore.reserveDomainRouteApply({ command: claimed.command, route, plan, operation: "apply", rollbackRevisionId: null });

    const receipt: DomainRouteApplyReceiptV1 = {
      schemaVersion: 1,
      action: "domain.route.apply",
      agentId,
      commandId: command.id,
      projectId,
      domain: route.domain,
      deploymentId,
      inputDigest: command.inputDigest,
      correlationId: command.correlationId,
      networkName: domainRouteNetworkName(projectId),
      networkId: "a".repeat(64),
      targetContainerId: "b".repeat(64),
      traefikContainerId: "c".repeat(64),
      fileName: `domain-route-${createHash("sha256").update(projectId).digest("hex").slice(0, 24)}.yml`,
      contentDigest: "d".repeat(64),
      state: "created",
      observedAt: Date.now(),
      failureReason: null,
      redacted: true
    };
    const completion = {
      command: claimed.command,
      authority: claimed.authority,
      route,
      plan,
      operation: "apply" as const,
      rollbackRevisionId: null,
      receipt,
      audit: {
        actorUserId: actorId,
        action: "domain.route.applied",
        targetType: "project",
        targetId: projectId,
        requestId: "req-domain-route-apply-pg",
        correlationId: command.correlationId,
        metadata: { agentId }
      }
    };

    await expect(routeStore.completeDomainRouteApply(completion)).resolves.toMatchObject({ status: "completed", result: receipt });
    await expect(routeStore.completeDomainRouteApply(completion)).resolves.toMatchObject({ status: "completed", result: receipt });
    await expect(client.query("SELECT project_id, hostname, deployment_id, status, metadata FROM domains WHERE hostname = $1", [route.domain])).resolves.toMatchObject({
      rows: [expect.objectContaining({ project_id: projectId, hostname: route.domain, deployment_id: deploymentId, status: "active", metadata: expect.objectContaining({ commandId: command.id, networkName: domainRouteNetworkName(projectId) }) })]
    });
    await expect(client.query("SELECT status, result FROM control_commands WHERE id = $1", [command.id])).resolves.toMatchObject({
      rows: [{ status: "completed", result: receipt }]
    });
    await expect(client.query("SELECT outcome, correlation_id FROM control_command_audits WHERE command_id = $1", [command.id])).resolves.toMatchObject({
      rowCount: 1,
      rows: [{ outcome: "completed", correlation_id: command.correlationId }]
    });
    await expect(client.query("SELECT action, request_id, correlation_id, metadata FROM audit_events WHERE target_id = $1 AND action = 'domain.route.applied'", [projectId])).resolves.toMatchObject({
      rowCount: 1,
      rows: [expect.objectContaining({ request_id: "req-domain-route-apply-pg", correlation_id: command.correlationId, metadata: expect.objectContaining({ commandId: command.id, agentId }) })]
    });
    await expect(client.query("SELECT hostname FROM domain_route_reservations WHERE hostname = $1", [route.domain])).resolves.toMatchObject({ rowCount: 0, rows: [] });

    const firstRevision = await routeStore.findDomainRouteRevisionByCommand(command.id);
    expect(firstRevision).toMatchObject({ operation: "apply", deploymentId, revisionNumber: 1, commandId: command.id });
    const domainRow = (await client.query<{ id: string }>("SELECT id FROM domains WHERE hostname = $1", [route.domain])).rows[0];
    if (!domainRow) throw new Error("Applied domain row was not persisted");
    const certificateId = randomUUID();
    await client.query("INSERT INTO certificates (id, domain_id, provider, status, not_before, not_after, metadata) VALUES ($1, $2, 'acme-metadata-only', 'issued', now(), now() + interval '1 day', $3::jsonb)",
      [certificateId, domainRow.id, JSON.stringify({ issuer: "metadata-only" })]);

    const secondDeploymentId = randomUUID();
    await requireDbDeploymentRepository().save({
      id: secondDeploymentId, projectId, agentId: agentRowId, status: "succeeded", commitSha: "bcdefa1234567", startedAt: now, finishedAt: now
    });
    const secondRoute = { ...route, deploymentId: secondDeploymentId };
    const secondCommand = {
      ...createControlCommand({ actorId, action: "project.update", scope: { kind: "project", projectId },
        input: { domainRoute: secondRoute }, idempotencyKey: "domain-route-retarget-pg", correlationId: "corr-domain-route-retarget-pg" }),
      status: "eligible" as const
    };
    await commandRepo.resolve(secondCommand);
    const secondClaimed = await commandRepo.claimProjectUpdate(secondCommand);
    if (!secondClaimed.authority) throw new Error("Retarget project update authority was not claimed");
    const secondPlan = createDomainRoutePlan({ desired: secondRoute, currentClaims: await routeStore.listClaims() });
    expect(secondPlan).toMatchObject({ action: "retarget", previousDeploymentId: deploymentId });
    await routeStore.reserveDomainRouteApply({ command: secondClaimed.command, route: secondRoute, plan: secondPlan,
      operation: "apply", rollbackRevisionId: null });
    const secondReceipt: DomainRouteApplyReceiptV1 = { ...receipt, commandId: secondCommand.id, deploymentId: secondDeploymentId,
      inputDigest: secondCommand.inputDigest, correlationId: secondCommand.correlationId, state: "updated", contentDigest: "e".repeat(64),
      targetContainerId: "1".repeat(64) };
    const secondCompletion = { command: secondClaimed.command, authority: secondClaimed.authority, route: secondRoute, plan: secondPlan,
      operation: "apply" as const, rollbackRevisionId: null, receipt: secondReceipt,
      audit: { actorUserId: actorId, action: "domain.route.applied", targetType: "project", targetId: projectId,
        requestId: "req-domain-route-retarget-pg", correlationId: secondCommand.correlationId, metadata: { agentId } } };
    await expect(routeStore.completeDomainRouteApply(secondCompletion)).resolves.toMatchObject({ status: "completed", result: secondReceipt });
    await expect(client.query("SELECT deployment_id FROM domains WHERE id = $1", [domainRow.id])).resolves.toMatchObject({ rows: [{ deployment_id: secondDeploymentId }] });

    const rollbackTarget = await routeStore.findRollbackTarget(projectId, route.domain);
    expect(rollbackTarget).toMatchObject({ id: firstRevision?.id, deploymentId, revisionNumber: 1 });
    const rollbackRoute = { ...route, deploymentId };
    const rollbackCommand = {
      ...createControlCommand({ actorId, action: "project.update", scope: { kind: "project", projectId },
        input: { operation: "rollback", domain: route.domain }, idempotencyKey: "domain-route-rollback-pg", correlationId: "corr-domain-route-rollback-pg" }),
      status: "eligible" as const
    };
    await commandRepo.resolve(rollbackCommand);
    const rollbackClaimed = await commandRepo.claimProjectUpdate(rollbackCommand);
    if (!rollbackClaimed.authority) throw new Error("Rollback project update authority was not claimed");
    const rollbackPlan = createDomainRoutePlan({ desired: rollbackRoute, currentClaims: await routeStore.listClaims() });
    expect(rollbackPlan).toMatchObject({ action: "retarget", previousDeploymentId: secondDeploymentId });
    await routeStore.reserveDomainRouteApply({ command: rollbackClaimed.command, route: rollbackRoute, plan: rollbackPlan,
      operation: "rollback", rollbackRevisionId: firstRevision!.id });
    const rollbackReceipt: DomainRouteApplyReceiptV1 = { ...receipt, commandId: rollbackCommand.id, deploymentId,
      inputDigest: rollbackCommand.inputDigest, correlationId: rollbackCommand.correlationId, state: "updated", contentDigest: "f".repeat(64) };
    const rollbackCompletion = { command: rollbackClaimed.command, authority: rollbackClaimed.authority, route: rollbackRoute, plan: rollbackPlan,
      operation: "rollback" as const, rollbackRevisionId: firstRevision!.id, receipt: rollbackReceipt,
      audit: { actorUserId: actorId, action: "domain.route.rolled_back", targetType: "project", targetId: projectId,
        requestId: "req-domain-route-rollback-pg", correlationId: rollbackCommand.correlationId, metadata: { agentId } } };
    await expect(routeStore.completeDomainRouteApply(rollbackCompletion)).resolves.toMatchObject({ status: "completed", result: rollbackReceipt });
    await expect(routeStore.completeDomainRouteApply(rollbackCompletion)).resolves.toMatchObject({ status: "completed", result: rollbackReceipt });
    const rollbackRevision = await routeStore.findDomainRouteRevisionByCommand(rollbackCommand.id);
    expect(rollbackRevision).toMatchObject({ operation: "rollback", deploymentId, rollbackRevisionId: firstRevision?.id, revisionNumber: 3 });
    await expect(client.query("SELECT deployment_id FROM domains WHERE id = $1", [domainRow.id])).resolves.toMatchObject({ rows: [{ deployment_id: deploymentId }] });
    await expect(client.query("SELECT domain_id, provider, status, metadata FROM certificates WHERE id = $1", [certificateId])).resolves.toMatchObject({
      rows: [{ domain_id: domainRow.id, provider: "acme-metadata-only", status: "issued", metadata: { issuer: "metadata-only" } }]
    });
    await expect(client.query("SELECT operation, evidence FROM domain_route_revisions WHERE domain_id = $1 ORDER BY revision_number", [domainRow.id])).resolves.toMatchObject({
      rowCount: 3,
      rows: [
        { operation: "apply", evidence: { state: "created", contentDigest: "d".repeat(64), observedAt: receipt.observedAt, redacted: true } },
        { operation: "apply", evidence: { state: "updated", contentDigest: "e".repeat(64), observedAt: secondReceipt.observedAt, redacted: true } },
        { operation: "rollback", evidence: { state: "updated", contentDigest: "f".repeat(64), observedAt: rollbackReceipt.observedAt, redacted: true } }
      ]
    });
    await expect(client.query("SELECT action, correlation_id FROM audit_events WHERE target_id = $1 AND action = 'domain.route.rolled_back'", [projectId])).resolves.toMatchObject({
      rowCount: 1, rows: [{ action: "domain.route.rolled_back", correlation_id: rollbackCommand.correlationId }]
    });
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
    const claimed = await repo.claimDeploymentStop(admitted.command);
    expect(claimed.claimed).toBe(true);
    await expect(repo.completeDeploymentStop(claimed.command, result)).resolves.toMatchObject({ status: "completed", result });
    await expect(repo.executeConfirmedDeploymentStop({ command, confirmation, requestId: "req-stop" })).resolves.toMatchObject({ alreadyCompleted: true, result });
  });

  it("rolls back a redeploy when its deployment insert fault is injected", async () => {
    const client = requirePool(); const role = (await client.query<{ id: string }>("SELECT id FROM roles WHERE name = 'admin'")).rows[0]; if (!role) throw new Error("Canonical admin role was not seeded");
    const actorId = randomUUID(); const projectId = randomUUID(); const agentId = randomUUID(); const sourceId = randomUUID(); const redeployId = randomUUID(); const snapshot = createDeploymentSnapshot({ deploymentId: sourceId, projectId, agentId, commitSha: "abcdef1", source: createSourceIntent({ sourceMode: "image", requestedReference: `registry.example.com/app@sha256:${"a".repeat(64)}` }, { policyVersion: "p1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true }), configRevision: "c1", runtimeRevision: "r1", runtimePort: 3000, secretRefs: [], policyVersion: "p1", schemaVersion: 1 }, { sha256: () => "d".repeat(64) });
    await client.query("INSERT INTO users (id, email, email_normalized, password_hash, role_id) VALUES ($1, $2, $2, $3, $4)", [actorId, `${actorId}@example.test`, "hash", role.id]); await client.query("INSERT INTO projects (id, name, repo_url, default_branch) VALUES ($1, 'Redeploy project', 'https://example.test/repo', 'main')", [projectId]); await client.query("INSERT INTO agents (id, name, endpoint, status) VALUES ($1, 'Redeploy agent', 'https://agent.test', 'online')", [agentId]); await client.query("INSERT INTO deployments (id, project_id, agent_id, status, commit_sha, started_at, snapshot_hash, snapshot_evidence) VALUES ($1, $2, $3, 'succeeded', 'abcdef1', now(), $4, $5)", [sourceId, projectId, agentId, snapshot.hash, snapshot.canonicalJson]);
    const command = createControlCommand({ actorId, action: "deployment.redeploy", scope: { kind: "deployment", projectId, deploymentId: sourceId }, input: { actorId, projectId, sourceDeploymentId: sourceId, snapshotHash: snapshot.hash }, idempotencyKey: "redeploy-fault", correlationId: "corr-redeploy-fault" }); const confirmation = createConfirmation({ command, classification: "destructive" }); const repo = new DbControlCommandRepository(requireDb(), async (stage) => { if (stage === "redeploy-deployment-inserted") throw new Error("injected redeploy fault"); }); await repo.resolve(command); await repo.bind(confirmation);
    const redeploySnapshotHash = "e".repeat(64); await expect(repo.executeConfirmedDeploymentRedeploy({ command, confirmation, deployment: { id: redeployId, projectId, agentId, status: "queued", commitSha: "abcdef1", startedAt: new Date().toISOString(), finishedAt: null, sourceDeploymentId: sourceId, snapshotHash: redeploySnapshotHash }, requestId: "req-redeploy-fault", snapshotHash: redeploySnapshotHash })).rejects.toThrow("injected redeploy fault");
     await expect(client.query("SELECT status FROM control_commands WHERE id = $1", [command.id])).resolves.toMatchObject({ rows: [{ status: "pending_confirmation" }] }); await expect(client.query("SELECT consumed_at FROM control_command_confirmations WHERE id = $1", [confirmation.id])).resolves.toMatchObject({ rows: [{ consumed_at: null }] }); await expect(client.query("SELECT id FROM deployments WHERE id = $1", [redeployId])).resolves.toMatchObject({ rowCount: 0 });
     const admitted = await new DbControlCommandRepository(requireDb()).executeConfirmedDeploymentRedeploy({ command, confirmation, deployment: { id: redeployId, projectId, agentId, status: "queued", commitSha: "abcdef1", startedAt: new Date().toISOString(), finishedAt: null, sourceDeploymentId: sourceId, snapshotHash: redeploySnapshotHash }, requestId: "req-redeploy", snapshotHash: redeploySnapshotHash }); expect(admitted.result?.status).toBe("eligible"); const claimed = await new DbControlCommandRepository(requireDb()).claimDeploymentRedeploy(admitted.command); expect(claimed.claimed).toBe(true); const contended = await new DbControlCommandRepository(requireDb()).claimDeploymentRedeploy(admitted.command); expect(contended.claimed).toBe(false); const terminal = { ...admitted.result!, status: "completed" as const, reason: null }; await expect(new DbControlCommandRepository(requireDb()).completeDeploymentRedeploy(claimed.command, terminal)).resolves.toMatchObject({ status: "completed", result: terminal });
  });

  it("claims one concurrent PostgreSQL redeploy dispatch and preserves one execution identity", async () => {
    const client = requirePool(); const role = (await client.query<{ id: string }>("SELECT id FROM roles WHERE name = 'admin'")).rows[0]; if (!role) throw new Error("Canonical admin role was not seeded");
    const actorId = randomUUID(); const projectId = randomUUID(); const agentId = randomUUID(); const sourceId = randomUUID(); const executionId = randomUUID();
    await client.query("INSERT INTO users (id, email, email_normalized, password_hash, role_id) VALUES ($1, $2, $2, $3, $4)", [actorId, `${actorId}@example.test`, "hash", role.id]);
    await client.query("INSERT INTO projects (id, name, repo_url, default_branch) VALUES ($1, 'Concurrent redeploy project', 'https://example.test/repo', 'main')", [projectId]);
    await client.query("INSERT INTO agents (id, name, endpoint, status) VALUES ($1, 'Concurrent redeploy agent', 'https://agent.test', 'online')", [agentId]);
    const snapshotHash = "f".repeat(64); const command = createControlCommand({ actorId, action: "deployment.redeploy", scope: { kind: "deployment", projectId, deploymentId: sourceId }, input: { actorId, projectId, sourceDeploymentId: sourceId, snapshotHash }, idempotencyKey: "concurrent-redeploy-key", correlationId: "corr-concurrent-redeploy" });
    const confirmation = createConfirmation({ command, classification: "destructive" }); const deployment = { id: executionId, projectId, agentId, status: "queued" as const, commitSha: "abcdef1", startedAt: new Date().toISOString(), finishedAt: null, sourceDeploymentId: sourceId, snapshotHash };
    const setup = new DbControlCommandRepository(requireDb()); await setup.resolve(command); await setup.bind(confirmation); const admitted = await setup.executeConfirmedDeploymentRedeploy({ command, confirmation, deployment, requestId: "req-concurrent-redeploy", snapshotHash });
    const poolA = createDbPool(databaseUrl, { max: 1 }); const poolB = createDbPool(databaseUrl, { max: 1 });
    try {
      const repoA = new DbControlCommandRepository(createDbClient(poolA)); const repoB = new DbControlCommandRepository(createDbClient(poolB));
      const [first, second] = await Promise.all([repoA.claimDeploymentRedeploy(admitted.command), repoB.claimDeploymentRedeploy(admitted.command)]);
      expect([first, second].filter((result) => result.claimed)).toHaveLength(1);
      expect(new Set([first.deployment?.id, second.deployment?.id])).toEqual(new Set([executionId]));
      await expect(client.query("SELECT status, result->>'deploymentId' AS execution_id FROM control_commands WHERE id = $1", [command.id])).resolves.toMatchObject({ rows: [{ status: "dispatching", execution_id: executionId }] });
      await expect(client.query("SELECT count(*)::int AS count FROM deployments WHERE id = $1", [executionId])).resolves.toMatchObject({ rows: [{ count: 1 }] });
    } finally { await closeDbPool(poolA); await closeDbPool(poolB); }
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

  it("persists cleanup admission across clients and atomically recovers concurrent commit replies", async () => {
    const client = requirePool(), role = (await client.query<{ id: string }>("SELECT id FROM roles WHERE name = 'admin'")).rows[0];
    if (!role) throw new Error("Canonical admin role was not seeded");
    const actorId = randomUUID(), projectId = randomUUID(), now = 1_791_447_000_000, ttl = 60_000;
    await client.query("INSERT INTO users (id, email, email_normalized, password_hash, role_id) VALUES ($1, $2, $2, $3, $4)", [actorId, `${actorId}@example.test`, "hash", role.id]);
    const policy = { policyVersion: "cleanup-pg", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true };
    const document = JSON.stringify({ services: { app: { image: `registry.example.com/app@sha256:${"a".repeat(64)}` } } });
    const preview = createComposePreview(document, projectId, policy);
    const body: ComposeResourceCleanupInput = { document, projectId, kind: "volume", key: "data", expectedConfigDigest: preview.configDigest, expectedStateDigest: "b".repeat(64) };
    const safePreview: PreparedComposeResourceCleanup["preview"] = { schemaVersion: 1, operation: "compose.resource.cleanup", status: "preview", executionAllowed: false, requiresConfirmation: true,
      projectId, kind: "volume", key: "data", configDigest: preview.configDigest, stateDigest: body.expectedStateDigest, confirmationTtlMs: ttl };
    const make = (key: string) => {
      const command = createControlCommand({ actorId, action: "project.delete", scope: { kind: "project", projectId }, input: { ...safePreview, owner: "deploylite", agentId: "pg-agent" },
        idempotencyKey: key, correlationId: `corr-${key}`, expiresAt: new Date(now + ttl) });
      return { command, preview: safePreview, owner: "deploylite", agentId: "pg-agent", preparedAtMs: now } satisfies PreparedComposeResourceCleanup;
    };
    const storeA = new DbComposeResourceCleanupStore(requireDb(), () => now), prepared = make("cleanup-pg-key");
    const [first, simultaneousRetry] = await Promise.all([storeA.save(prepared, "cleanup-request-1"), storeA.save({ ...prepared, command: { ...prepared.command, id: randomUUID() } }, "cleanup-request-2")]);
    expect(first).toMatchObject({ commandId: expect.any(String), confirmationId: expect.any(String), status: "pending_confirmation", idempotent: false });
    expect(simultaneousRetry).toEqual({ ...first, idempotent: true });
    const restartPool = createDbPool(databaseUrl, { max: 2 });
    try {
      const restarted = new DbComposeResourceCleanupStore(createDbClient(restartPool), () => now), subject = { actorId, projectId, idempotencyKey: "cleanup-pg-key", confirmationId: first.confirmationId };
      const record = await restarted.find(subject), original = { ...prepared, command: record.command };
      expect(record.command).toMatchObject({ id: first.commandId, status: "pending_confirmation", inputDigest: prepared.command.inputDigest });
      const view: ComposeResourceCleanupConfirmationViewV1 = { ...safePreview, commandId: record.command.id, confirmationId: record.confirmation.id, confirmationValidated: true };
      const secondProcess = new DbComposeResourceCleanupStore(createDbClient(restartPool), () => now);
      const admissions = await Promise.all([restarted.admit(original, view, "cleanup-request-3"), secondProcess.admit(original, view, "cleanup-request-4")]);
      expect(admissions).toHaveLength(2);
      expect(admissions.map(value => value.idempotent).sort()).toEqual([false, true]);
      expect(admissions.map(value => value.status)).toEqual(["eligible", "eligible"]);
      const afterRestart = new DbComposeResourceCleanupStore(createDbClient(restartPool), () => now);
      const recovered = await afterRestart.find(subject);
      expect(recovered.command.status).toBe("eligible"); expect(recovered.confirmation.consumedAt).toEqual(new Date(now));
      const replay = await afterRestart.admit(original, view, "cleanup-request-5");
      expect(replay).toEqual({ ...admissions[0]!, idempotent: true });
      await expect(client.query("SELECT action, count(*)::int AS count FROM audit_events WHERE target_id = $1 AND action LIKE 'compose.resource.cleanup.%' GROUP BY action ORDER BY action", [projectId])).resolves.toMatchObject({ rows: [
        { action: "compose.resource.cleanup.admitted", count: 1 }, { action: "compose.resource.cleanup.prepared", count: 1 }
      ] });
      await expect(client.query("SELECT status, result, execution_authority FROM control_commands WHERE id = $1", [first.commandId])).resolves.toMatchObject({ rows: [{ status: "eligible", result: null, execution_authority: null }] });
    } finally { await closeDbPool(restartPool); }

    const abort = new AbortController(), cancelStore = new DbComposeResourceCleanupStore(requireDb(), () => now, stage => { if (stage === "prepared-audit-written") abort.abort(); });
    const canceled = make("cleanup-pg-cancel");
    await expect(cancelStore.save(canceled, "cleanup-request-cancel", abort.signal)).rejects.toMatchObject({ code: "COMPOSE_CLEANUP_FAILED" });
    await expect(client.query("SELECT count(*)::int AS count FROM control_commands c LEFT JOIN control_command_confirmations f ON f.command_id = c.id WHERE c.actor_user_id = $1 AND c.idempotency_key = $2", [actorId, "cleanup-pg-cancel"]))
      .resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(client.query("SELECT count(*)::int AS count FROM audit_events WHERE target_id = $1 AND request_id = $2", [projectId, "cleanup-request-cancel"]))
      .resolves.toMatchObject({ rows: [{ count: 0 }] });

    const admissionPrepared = make("cleanup-pg-cancel-admit"), admissionReceipt = await storeA.save(admissionPrepared, "cleanup-request-admit-save");
    const admissionSubject = { actorId, projectId, idempotencyKey: admissionPrepared.command.idempotencyKey, confirmationId: admissionReceipt.confirmationId };
    const admissionRecord = await storeA.find(admissionSubject), admissionCommand = { ...admissionPrepared, command: admissionRecord.command };
    const admissionView: ComposeResourceCleanupConfirmationViewV1 = { ...safePreview, commandId: admissionRecord.command.id,
      confirmationId: admissionRecord.confirmation.id, confirmationValidated: true };
    const cancelAdmission = new AbortController(), cancelAfterConsume = new DbComposeResourceCleanupStore(requireDb(), () => now,
      stage => { if (stage === "confirmation-consumed") cancelAdmission.abort(); });
    await expect(cancelAfterConsume.admit(admissionCommand, admissionView, "cleanup-request-admit-cancel-consume", cancelAdmission.signal))
      .rejects.toMatchObject({ code: "COMPOSE_CLEANUP_FAILED" });
    const cancelAudit = new AbortController(), cancelAfterAudit = new DbComposeResourceCleanupStore(requireDb(), () => now,
      stage => { if (stage === "admitted-audit-written") cancelAudit.abort(); });
    await expect(cancelAfterAudit.admit(admissionCommand, admissionView, "cleanup-request-admit-cancel-audit", cancelAudit.signal))
      .rejects.toMatchObject({ code: "COMPOSE_CLEANUP_FAILED" });
    const afterCancel = await storeA.find(admissionSubject);
    expect(afterCancel.command.status).toBe("pending_confirmation"); expect(afterCancel.confirmation.consumedAt).toBeNull();
    await expect(client.query("SELECT count(*)::int AS count FROM audit_events WHERE target_id = $1 AND action = 'compose.resource.cleanup.admitted'", [projectId]))
      .resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("atomically persists TCP/UDP reservation, apply revisions, active container state, and rollback", async () => {
    const client = requirePool(), database = requireDb(), actorId = randomUUID(), projectId = randomUUID(), deploymentId = randomUUID(), targetDeploymentId = randomUUID(), agentId = randomUUID();
    const adminRole = (await client.query<{ id: string }>("SELECT id FROM roles WHERE name = 'admin'")).rows.at(0);
    if (!adminRole) throw new Error("Canonical admin role was not seeded");
    await client.query("INSERT INTO users (id, email, email_normalized, password_hash, role_id) VALUES ($1, $2, $2, $3, $4)",
      [actorId, `${actorId}@example.test`, "hash", adminRole.id]);
    await requireDbAgentRepository().save({ id: agentId, name: "Transport integration agent", endpoint: "https://transport-agent.integration.test",
      status: "online", lastHeartbeatAt: new Date().toISOString(), resourceSnapshot: null });
    await requireDbProjectRepository().save({ id: projectId, name: "Transport integration project",
      repoUrl: "https://github.com/example/deploylite-transport-integration", defaultBranch: "main", buildCommand: null,
      runCommand: "node server.js", port: 3000, description: null, imageTag: null });
    await requireDbDeploymentRepository().save({ id: deploymentId, projectId, agentId, status: "succeeded", commitSha: "abcdef1234567",
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
    await requireDbDeploymentRepository().save({ id: targetDeploymentId, projectId, agentId, status: "succeeded", commitSha: "abcdef7654321",
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });

    const publishedPort = 31_000 + Math.floor(Math.random() * 10_000), protocol = "udp" as const;
    const store = new DbTransportPortApplyStore(database), commandRepo = new DbControlCommandRepository(database);
    const makeBinding = (targetPort: number): TransportPortBindingV1 => ({ protocol, publishedPort, targetPort });
    const image1 = `registry.example.com/team/source@sha256:${"a".repeat(64)}`, image2 = `registry.example.com/team/target@sha256:${"b".repeat(64)}`;
    const makeProof = (id: string, image: string, containerId: string) => trustedPriorExecutionReceiptSchema.parse({ schemaVersion: 1,
      candidateId: `${id}:candidate:trusted-command`, deploymentId: id, projectId, snapshotOriginId: id, snapshotHash: "c".repeat(64),
      effectiveImageDigest: image.split("@")[1], runtimeHost: agentId, container: `deploylite-active-${id}`, containerId,
      hostPort: id === deploymentId ? 43000 : 43001, containerPort: 3000, network: null });
    const proof1 = makeProof(deploymentId, image1, "a".repeat(64)), proof2 = makeProof(targetDeploymentId, image2, "b".repeat(64));
    const execute = async (targetPort: number, operation: "apply" | "rollback", rollbackRevisionId: string | null,
      currentContainerId: string, previousBindings: TransportPortBindingV1[], nextContainerId: string, targetId = deploymentId,
      portTransfer?: TransportPortTransferV1, nextSourceContainerId = "e".repeat(64)) => {
      const route = transportPortIntentSchema.parse({ schemaVersion: 1, projectId, deploymentId: targetId, protocol, publishedPort, targetPort });
      const currentClaims = await store.listClaims(), plan = createTransportPortPlan({ desired: route, currentClaims });
      const command = { ...createControlCommand({ actorId, action: "project.update", scope: { kind: "project", projectId },
        input: { route, operation, rollbackRevisionId, ...(portTransfer ? { portTransfer } : {}) }, idempotencyKey: `transport-${operation}-${targetPort}-${randomUUID()}`,
        correlationId: `corr-transport-${operation}-${targetPort}-${randomUUID()}`, expiresAt: new Date(Date.now() + 60_000) }), status: "eligible" as const };
      await commandRepo.resolve(command);
      const claimed = await commandRepo.claimProjectUpdate(command);
      expect(claimed.claimed).toBe(true);
      if (!claimed.authority) throw new Error("Project update authority was not claimed for transport apply");
      const bindings = [makeBinding(targetPort)];
      await store.reserveTransportPortApply({ command: claimed.command, route, plan, operation, rollbackRevisionId,
        currentContainerId, bindings, previousBindings, ...(portTransfer ? { portTransfer } : {}) });
      const receipt: TransportPortApplyReceiptV1 = transportPortApplyReceiptSchema.parse({ schemaVersion: 1,
        action: "transport.port.apply", agentId, commandId: command.id, projectId, protocol, publishedPort, targetPort,
        deploymentId: targetId, operation, rollbackRevisionId, inputDigest: command.inputDigest, correlationId: command.correlationId, containerId: nextContainerId,
        ...(portTransfer ? { portTransfer: { sourceDeploymentId: portTransfer.sourceDeploymentId, sourceContainerId: nextSourceContainerId, retainedPriorContainerIds: [] } } : {}),
        state: "updated", observedAt: Date.now(), failureReason: null, redacted: true });
      const completion = { command: claimed.command, authority: claimed.authority, route, plan, currentContainerId, bindings, previousBindings,
        ...(portTransfer ? { portTransfer } : {}), operation, rollbackRevisionId, receipt, audit: { actorUserId: actorId,
          action: operation === "rollback" ? "transport.port.rolled_back" : "transport.port.applied", targetType: "project", targetId: projectId,
          requestId: `request-${command.id}`, correlationId: command.correlationId, metadata: { agentId } } };
      const completed = await store.completeTransportPortApply(completion);
      expect(completed).toMatchObject({ status: "completed", result: receipt });
      await expect(store.completeTransportPortApply(completion)).resolves.toMatchObject({ status: "completed", result: receipt });
      return { receipt, revision: await store.findTransportPortRevisionByCommand(command.id) };
    };

    const initial = await execute(25565, "apply", null, "a".repeat(64), [], "b".repeat(64));
    expect(initial.revision).toMatchObject({ operation: "apply", revisionNumber: 1, targetPort: 25565 });
    const changed = await execute(25566, "apply", null, "b".repeat(64), [makeBinding(25565)], "c".repeat(64));
    expect(changed.revision).toMatchObject({ operation: "apply", revisionNumber: 2, targetPort: 25566 });
    const rollbackTarget = await store.findRollbackTarget(projectId, protocol, publishedPort);
    expect(rollbackTarget).toMatchObject({ id: initial.revision?.id, deploymentId, targetPort: 25565 });
    const rolledBack = await execute(25565, "rollback", rollbackTarget!.id, "c".repeat(64), [makeBinding(25566)], "d".repeat(64));
    expect(rolledBack.revision).toMatchObject({ operation: "rollback", revisionNumber: 3, rollbackRevisionId: initial.revision?.id });
    const outbound = { sourceDeploymentId: deploymentId, sourceContainerId: "d".repeat(64), sourceBindings: [],
      sourcePreviousBindings: [makeBinding(25565)], sourceExecutionReceipt: proof1, sourceEffectiveImage: image1 } satisfies TransportPortTransferV1;
    const transferred = await execute(25567, "apply", null, "b".repeat(64), [], "c".repeat(64), targetDeploymentId, outbound, "f".repeat(64));
    expect(transferred.revision).toMatchObject({ operation: "apply", revisionNumber: 4, deploymentId: targetDeploymentId, targetPort: 25567 });
    await expect(store.findTransportPortRuntimeState(projectId, deploymentId)).resolves.toEqual({ projectId, deploymentId,
      containerId: "f".repeat(64), bindings: [] });
    await expect(store.findTransportPortRuntimeState(projectId, targetDeploymentId)).resolves.toEqual({ projectId, deploymentId: targetDeploymentId,
      containerId: "c".repeat(64), bindings: [makeBinding(25567)] });
    const transferRollbackTarget = await store.findRollbackTarget(projectId, protocol, publishedPort);
    expect(transferRollbackTarget).toMatchObject({ deploymentId, targetPort: 25565 });
    const inbound = { sourceDeploymentId: targetDeploymentId, sourceContainerId: "c".repeat(64), sourceBindings: [],
      sourcePreviousBindings: [makeBinding(25567)], sourceExecutionReceipt: proof2, sourceEffectiveImage: image2 } satisfies TransportPortTransferV1;
    const transferredBack = await execute(25565, "rollback", transferRollbackTarget!.id, "f".repeat(64), [], "1".repeat(64), deploymentId, inbound, "2".repeat(64));
    expect(transferredBack.revision).toMatchObject({ operation: "rollback", revisionNumber: 5, rollbackRevisionId: transferRollbackTarget!.id });
    await expect(store.findTransportPortRuntimeState(projectId, deploymentId)).resolves.toEqual({ projectId, deploymentId,
      containerId: "1".repeat(64), bindings: [makeBinding(25565)] });
    await expect(store.findTransportPortRuntimeState(projectId, targetDeploymentId)).resolves.toEqual({ projectId, deploymentId: targetDeploymentId,
      containerId: "2".repeat(64), bindings: [] });
    await expect(client.query("SELECT target_port FROM transport_port_claims WHERE protocol = $1 AND published_port = $2", [protocol, publishedPort]))
      .resolves.toMatchObject({ rows: [{ target_port: 25565 }] });
    await expect(client.query("SELECT count(*)::int AS count FROM transport_port_reservations WHERE protocol = $1 AND published_port = $2", [protocol, publishedPort]))
      .resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(client.query("SELECT count(*)::int AS count FROM transport_port_revisions WHERE project_id = $1 AND protocol = $2 AND published_port = $3", [projectId, protocol, publishedPort]))
      .resolves.toMatchObject({ rows: [{ count: 5 }] });
    await expect(client.query("SELECT action, count(*)::int AS count FROM audit_events WHERE target_id = $1 AND action IN ('transport.port.applied', 'transport.port.rolled_back') GROUP BY action ORDER BY action", [projectId]))
      .resolves.toMatchObject({ rows: [{ action: "transport.port.applied", count: 3 }, { action: "transport.port.rolled_back", count: 2 }] });
  });
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
