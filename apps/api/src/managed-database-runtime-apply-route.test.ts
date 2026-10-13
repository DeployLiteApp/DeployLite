import { buildApiApp } from "./app.js";
import Fastify, { type FastifyReply } from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { createEnvSecretCipher } from "@deploylite/config";
import { managedDatabaseRuntimePreparationSchema, type ApprovedManagedDatabaseProfileV1, type ManagedDatabaseEngineV1 } from "@deploylite/contracts";
import { ensureManagedDatabaseCredentials, planManagedDatabaseProfile, materializeManagedDatabaseRuntime, composeRuntimeResourceName, resolveControlCommandInMemory, type ControlCommand, type ProjectUpdateControlRepository, type EncryptedEnvSecretValueRecord, type EnvSecretValueInput } from "@deploylite/domain";
import { registerManagedDatabaseRuntimeApplyRoute } from "./managed-database-runtime-apply-route.js";
import type { ManagedDatabaseRuntimeReceiptV1 } from "@deploylite/contracts";
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function fixture(settings: { engine?: ManagedDatabaseEngineV1; allowed?: boolean; anonymous?: boolean; deadlineMs?: number } = {}) {
  const app = Fastify(); apps.push(app);
  const engine = settings.engine ?? "postgres", rows = new Map<string, EncryptedEnvSecretValueRecord>();
  const profiles = new Map<ManagedDatabaseEngineV1, ApprovedManagedDatabaseProfileV1>();
  const paths = { postgres: "/var/lib/postgresql", mysql: "/var/lib/mysql", mariadb: "/var/lib/mysql", mongodb: "/data/db", redis: "/data" };
  const ports = { postgres: 5432, mysql: 3306, mariadb: 3306, mongodb: 27017, redis: 6379 };
  for (const value of ["postgres", "mysql", "mariadb", "mongodb", "redis"] as const) profiles.set(value, {
    schemaVersion: 1, profileId: `profile-${value}`, engine: value, image: `registry.example.com/${value}@sha256:${"a".repeat(64)}`,
    dataPath: paths[value], containerPort: ports[value], credentialKeys: ["DATABASE_PASSWORD"], backupStrategy: value === "redis" ? "volume-quiesced" : "engine-native"
  });
  const cipher = createEnvSecretCipher(Buffer.alloc(32, 14));
  const secrets = { find: vi.fn(async (project: string, key: string) => rows.get(project + key)), createIfAbsent: vi.fn(async (record: EnvSecretValueInput) => {
    const row = { ...record, id: "secret-a", valuePresent: true, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
    rows.set(record.projectId + record.key, row); return row;
  }) };
  const imagePolicy = { policyVersion: "images-1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true };
  await ensureManagedDatabaseCredentials({ schemaVersion: 1, projectId: "project-a", databaseId: "orders", engine }, profiles.get(engine), {
    imagePolicy, cipher, secrets, authorize: async () => true, entropy: () => Buffer.alloc(32, 19)
  });
  secrets.find.mockClear(); secrets.createIfAbsent.mockClear();
  const audit = vi.fn(async () => ({} as never));
  const grants = vi.fn(async () => settings.allowed === false ? [] : [{ id: "grant-a", actorId: "actor-a", action: "project.update" as const, scope: { kind: "project" as const, projectId: "project-a" } }]);
  const projects = vi.fn(async (id: string) => ({ id, name: "fixture", repoUrl: "https://example.test/repo", defaultBranch: "main", buildCommand: null, runCommand: null, port: null, description: null, imageTag: null }));
  const configuration = { profiles, deadlineMs: settings.deadlineMs ?? 1000 };
  const options = { prefix: "/api/v1", configuration, secrets, cipher, imagePolicy, projects: { findById: projects }, grants: { listForActor: grants }, audit: { append: audit },
    requireAuth: async (request: unknown, reply: FastifyReply) => { if (settings.anonymous) return reply.code(401).send({ error: "unauthenticated" });
      Object.assign(request as object, { auth: { user: { id: "actor-a", role: "operator" } }, correlationContext: { requestId: "request-a", correlationId: "correlation-a" } }); },
    requireRole: async () => {}, ok: (_request: unknown, data: unknown) => ({ data }), error: (_request: unknown, code: string) => ({ error: { code } }) };
  const ledger = new Map<string, ControlCommand>(), cache = new Map<string, ManagedDatabaseRuntimeReceiptV1>();
  const controls = {
    resolve: vi.fn(async (command: ControlCommand) => resolveControlCommandInMemory(ledger, command)),
    complete: vi.fn(async (command: ControlCommand) => command),
    findProjectUpdateByIdempotency: vi.fn(async () => structuredClone([...ledger.values()][0] ?? null)),
    claimProjectUpdate: vi.fn(async (command: ControlCommand) => {
      const authority = { schemaVersion: 1 as const, projectId: "project-a", commandId: command.id, action: "project.update" as const, inputDigest: command.inputDigest,
        projectLease: { leaseId: "lease-a", projectId: "project-a", fence: 1, expiresAt: command.expiresAt.getTime() } };
      const claimed = { ...command, status: "dispatching" as const, projectExecutionAuthority: authority };
      ledger.set([...ledger.keys()][0]!, claimed); return { command: claimed, claimed: true, authority };
    }),
    validateProjectUpdateAuthority: vi.fn(async () => {}),
    completeProjectUpdate: vi.fn(async (command: ControlCommand) => { const completed = { ...command, status: "completed" as const }; ledger.set([...ledger.keys()][0]!, completed); return completed; })
  } satisfies ProjectUpdateControlRepository;
  const nativeInput = { schemaVersion: 1 as const, projectId: "project-a", databaseId: "orders", engine };
  const plan = planManagedDatabaseProfile(nativeInput, profiles.get(engine)!, imagePolicy);
  const runtime = materializeManagedDatabaseRuntime(nativeInput, profiles.get(engine)!, { imagePolicy, cipher, credentials: [...rows.values()][0]! });
  const preparation = { ...nativeInput, profileId: plan.profileId, planDigest: plan.planDigest, environmentFingerprint: runtime.environmentFingerprint };
  const transport = { available: () => true, readReceipt: vi.fn(async (prepared: { command: ControlCommand }) => cache.get(prepared.command.id) ?? null),
    dispatch: vi.fn(async (prepared: { command: ControlCommand }) => {
      const receipt: ManagedDatabaseRuntimeReceiptV1 = { ...nativeInput, action: "database.runtime", agentId: "agent-a", commandId: prepared.command.id,
        inputDigest: prepared.command.inputDigest, planDigest: plan.planDigest, environmentFingerprint: runtime.environmentFingerprint, correlationId: prepared.command.correlationId,
        containerId: "c".repeat(64), imageId: `sha256:${"d".repeat(64)}`, networkId: "e".repeat(64), volumeCreatedAt: "2026-10-10T00:00:00Z",
        volumeName: composeRuntimeResourceName("project-a", "volume", "db-orders"), networkName: composeRuntimeResourceName("project-a", "network", "db-orders"),
        observedAt: 1000, status: "ready", health: "passed", storage: "verified", idempotent: false, redacted: true };
      cache.set(prepared.command.id, receipt); return receipt;
    }) };
  const execution = { controls, transport, agentId: "agent-a", now: () => 1000, commandTtlMs: 1000, deadlineMs: settings.deadlineMs ?? 1000 };
  const executions = new Map([["project-a", execution]]);
  registerManagedDatabaseRuntimeApplyRoute(app, { ...options, executions });
  const post = (payload: unknown = (({ projectId, databaseId, ...publicBody }) => publicBody)(preparation), project = "project-a", key: string | undefined = "apply-orders") => app.inject({ method: "POST", url: `/api/v1/projects/${project}/databases/orders/runtime/apply`, headers: key === undefined ? {} : { "idempotency-key": key }, payload: payload as Record<string, unknown> });
  return { app, rows, secrets, profiles, cipher, audit, grants, projects, configuration, options, post, controls, transport, executions, preparation };
}
it.each(["postgres", "mysql", "mariadb", "mongodb", "redis"] as const)("applies %s from encrypted preview binding and returns only public evidence", async engine => {
  const f = await fixture({ engine }), response = await f.post(); expect(response.statusCode).toBe(200);
  expect(response.json().data).toMatchObject({ applied: true, command: { status: "completed" }, receipt: { engine, redacted: true } });
  expect(response.json().data.originalReplayFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(f.transport.dispatch).toHaveBeenCalledTimes(1); expect(f.secrets.createIfAbsent).not.toHaveBeenCalled();
  expect(response.body).not.toContain("13".repeat(32)); expect(response.body).not.toContain([...f.rows.values()][0]!.encryptedValue.toString("base64"));
});
it("denies unauthorized scopes before project, encrypted row or control reads", async () => {
  for (const settings of [{ anonymous: true }, { allowed: false }]) {
    const f = await fixture(settings); expect((await f.post()).statusCode).toBe(settings.anonymous ? 401 : 403);
    expect(f.projects).not.toHaveBeenCalled(); expect(f.secrets.find).not.toHaveBeenCalled(); expect(f.controls.resolve).not.toHaveBeenCalled();
  }
});
it("requires an explicit project execution binding and strict preview input", async () => {
  const missing = await fixture(); missing.executions.clear(); expect((await missing.post()).statusCode).toBe(503); expect(missing.secrets.find).not.toHaveBeenCalled();
  const f = await fixture(); const { projectId, databaseId, ...body } = f.preparation;
  for (const patch of [{ image: "latest" }, { password: "private" }, { publishedPort: 5432 }, { execute: true }]) expect((await f.post({ ...body, ...patch })).statusCode).toBe(400);
  expect((await f.post(body, "project-a", "")).statusCode).toBe(400); expect(f.secrets.find).not.toHaveBeenCalled();
});
it("refuses stale profile, environment or foreign encrypted row without claims", async () => {
  for (const change of ["plan", "environment", "row"] as const) {
    const f = await fixture(); const { projectId, databaseId, ...body } = f.preparation;
    if (change === "plan") body.planDigest = "f".repeat(64);
    if (change === "environment") body.environmentFingerprint = "f".repeat(32);
    if (change === "row") f.secrets.find.mockResolvedValue({ ...[...f.rows.values()][0]!, projectId: "foreign" });
    expect((await f.post(body)).statusCode).toBe(503); expect(f.controls.claimProjectUpdate).not.toHaveBeenCalled(); expect(f.transport.dispatch).not.toHaveBeenCalled();
  }
});
it("replays completed original evidence without current profiles or credentials", async () => {
  const f = await fixture(); expect((await f.post()).statusCode).toBe(200); f.rows.clear(); f.profiles.clear(); f.secrets.find.mockClear();
  const response = await f.post(); expect(response.statusCode).toBe(200); expect(response.json().data.idempotent).toBe(true);
  expect(f.secrets.find).not.toHaveBeenCalled(); expect(f.transport.dispatch).toHaveBeenCalledTimes(1);
});
it("fences secret-read revocation and bounds a stalled credential store", async () => {
  const revoked = await fixture(); const row = [...revoked.rows.values()][0]!;
  revoked.secrets.find.mockImplementation(async () => { revoked.grants.mockResolvedValue([]); return row; });
  expect((await revoked.post()).statusCode).toBe(503); expect(revoked.transport.dispatch).not.toHaveBeenCalled();
  const stalled = await fixture({ deadlineMs: 10 }); stalled.secrets.find.mockImplementation(() => new Promise(() => {}));
  expect((await stalled.post()).statusCode).toBe(503); expect(stalled.controls.claimProjectUpdate).not.toHaveBeenCalled();
});
it("registers the apply route in the real API and authenticates before mutation", async () => {
  const app = await buildApiApp({ env: { NODE_ENV: "test", DEPLOYLITE_BCRYPT_COST: "10", DATABASE_URL: undefined,
    DEPLOYLITE_AGENT_URL: undefined, DEPLOYLITE_AGENT_TRUST_KEY: undefined } });
  try {
    const f = await fixture(); const { projectId, databaseId, ...body } = f.preparation;
    const response = await app.inject({ method: "POST", url: "/api/v1/projects/project-a/databases/orders/runtime/apply", headers: { "idempotency-key": "apply-orders" }, payload: body });
    expect(response.statusCode).toBe(401);
  } finally { await app.close(); }
});
it("withholds generic command payloads and fences profile changes during encrypted reads", async () => {
  const hidden = await fixture(); hidden.controls.completeProjectUpdate.mockImplementation(async command => {
    const completed = { ...command, status: "completed" as const }; Object.assign(completed, { result: { private: "private-command-payload" } }); return completed;
  });
  const response = await hidden.post(); expect(response.statusCode).toBe(200); expect(response.body).not.toContain("private-command-payload");
  expect(response.json().data.command).not.toHaveProperty("projectExecutionAuthority");
  const changed = await fixture(), row = [...changed.rows.values()][0]!;
  changed.secrets.find.mockImplementation(async () => { changed.profiles.delete("postgres"); return row; });
  expect((await changed.post()).statusCode).toBe(503); expect(changed.transport.dispatch).not.toHaveBeenCalled();
});
it("requires configured project admission before fresh materialization or claims", async () => {
  const f = await fixture(); Object.assign(f.configuration, { projectIds: new Set(["foreign"]) });
  expect((await f.post()).statusCode).toBe(503); expect(f.secrets.find).not.toHaveBeenCalled(); expect(f.controls.claimProjectUpdate).not.toHaveBeenCalled();
});
