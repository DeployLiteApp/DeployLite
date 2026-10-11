import { afterEach, expect, it, vi } from "vitest";
import { MANAGED_DATABASE_RUNTIME_CAPABILITY, type ManagedDatabaseStopReceiptV1 } from "@deploylite/contracts";
import { composeRuntimeResourceName, createControlCommand, managedDatabaseRuntimeExecutionBinding,
  managedDatabaseRuntimeReplayFingerprintDigest, resolveControlCommandInMemory, planManagedDatabaseProfile,
  type ControlCommand, type ProjectUpdateControlRepository } from "@deploylite/domain";
import Fastify, { type FastifyReply } from "fastify";
import { registerManagedDatabaseStopRoute } from "./managed-database-stop-route.js";
import { buildApiApp } from "./app.js";
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

async function fixture(settings: { engine?: "postgres" | "mysql" | "mariadb" | "mongodb" | "redis"; allowed?: boolean; anonymous?: boolean; deadlineMs?: number; enabled?: boolean } = {}) {
  let now = 1000;
  const ledger = new Map<string, ControlCommand>(), cache = new Map<string, ManagedDatabaseStopReceiptV1>();
  const engine = settings.engine ?? "postgres";
  const paths = { postgres: "/var/lib/postgresql", mysql: "/var/lib/mysql", mariadb: "/var/lib/mysql", mongodb: "/data/db", redis: "/data" };
  const ports = { postgres: 5432, mysql: 3306, mariadb: 3306, mongodb: 27017, redis: 6379 };
  const profile = { schemaVersion: 1 as const, profileId: "profile-" + engine, engine,
    image: "registry.example.com/" + engine + "@sha256:" + "a".repeat(64), dataPath: paths[engine], containerPort: ports[engine],
    credentialKeys: ["DATABASE_PASSWORD"], backupStrategy: engine === "redis" ? "volume-quiesced" as const : "engine-native" as const };
  const imagePolicy = { policyVersion: "images-1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true };
  const plan = planManagedDatabaseProfile({ schemaVersion: 1, projectId: "project-a", databaseId: "orders", engine }, profile, imagePolicy);
  const base = { schemaVersion: 1 as const, projectId: "project-a", databaseId: "orders", engine,
    profileId: profile.profileId, planDigest: plan.planDigest, environmentFingerprint: "b".repeat(32) };
  const authorityFor = (command: ControlCommand) => ({ schemaVersion: 1 as const, projectId: base.projectId,
    commandId: command.id, action: "project.update" as const, inputDigest: command.inputDigest,
    projectLease: { leaseId: "lease-" + command.id, projectId: base.projectId, fence: 1, expiresAt: command.expiresAt.getTime() } });
  const seed = createControlCommand({ actorId: "original-operator", action: "project.update",
    scope: { kind: "project", projectId: base.projectId }, input: managedDatabaseRuntimeExecutionBinding(base),
    idempotencyKey: "original-create", correlationId: "original-correlation", expiresAt: new Date(2000) });
  const original: ControlCommand = { ...seed, status: "completed", projectExecutionAuthority: authorityFor(seed) };
  const { profileId: _profile, ...receiptBase } = base;
  const originalReceipt = { ...receiptBase, action: "database.runtime" as const, agentId: "agent-a", commandId: original.id,
    inputDigest: original.inputDigest, correlationId: original.correlationId, containerId: "c".repeat(64),
    imageId: "sha256:" + "d".repeat(64), volumeName: composeRuntimeResourceName(base.projectId, "volume", "db-orders"),
    networkName: composeRuntimeResourceName(base.projectId, "network", "db-orders"), networkId: "e".repeat(64),
    volumeCreatedAt: "2026-10-10T00:00:00Z", observedAt: 1000, status: "ready" as const, health: "passed" as const,
    storage: "verified" as const, idempotent: false, redacted: true as const };
  const originalQuery = { ...base, action: "database.runtime", operation: "database.runtime.apply", agentId: "agent-a",
    commandId: original.id, inputDigest: original.inputDigest, idempotencyKey: original.idempotencyKey,
    requiredCapabilities: [MANAGED_DATABASE_RUNTIME_CAPABILITY], authority: original.projectExecutionAuthority,
    lease: original.projectExecutionAuthority!.projectLease, context: { requestId: "original-request", correlationId: original.correlationId }, timeoutMs: 1000 };
  const preparation = { ...base, originalReceipt, originalReplayFingerprint: managedDatabaseRuntimeReplayFingerprintDigest(originalQuery) };
  const save = (command: ControlCommand) => {
    const key = [...ledger].find(([, value]) => value.id === command.id)![0];
    ledger.set(key, structuredClone(command)); return structuredClone(command);
  };
  const controls = {
    resolve: vi.fn(async (command: ControlCommand) => resolveControlCommandInMemory(ledger, command)),
    complete: vi.fn(async (command: ControlCommand) => save(command)),
    findProjectUpdateById: vi.fn(async () => structuredClone(original) as ControlCommand | null),
    findProjectUpdateByIdempotency: vi.fn(async () => structuredClone([...ledger.values()][0] ?? null)),
    claimProjectUpdate: vi.fn(async (command: ControlCommand) => {
      const authority = authorityFor(command), claimed = save({ ...command, status: "dispatching", projectExecutionAuthority: authority });
      return { command: claimed, claimed: true, authority };
    }),
    validateProjectUpdateAuthority: vi.fn(async () => {}),
    completeProjectUpdate: vi.fn(async (command: ControlCommand) => save({ ...command, status: "completed" }))
  } satisfies ProjectUpdateControlRepository;
  const receiptFor = (command: ControlCommand): ManagedDatabaseStopReceiptV1 => ({ ...base, action: "database.runtime.stop",
    agentId: "agent-a", commandId: command.id, originalCommandId: original.id, inputDigest: command.inputDigest,
    correlationId: command.correlationId, containerId: originalReceipt.containerId, imageId: originalReceipt.imageId,
    volumeName: originalReceipt.volumeName, networkName: originalReceipt.networkName, networkId: originalReceipt.networkId,
    volumeCreatedAt: originalReceipt.volumeCreatedAt, observedAt: now, status: "stopped", storage: "verified", redacted: true });
  const transport = { available: vi.fn(() => true),
    readReceipt: vi.fn(async (prepared: { command: ControlCommand }) => cache.get(prepared.command.id) ?? null),
    dispatch: vi.fn(async (prepared: { command: ControlCommand }) => { const receipt = receiptFor(prepared.command); cache.set(prepared.command.id, receipt); return receipt; }) };
  const originalTransport = { available: vi.fn(() => true), readReceipt: vi.fn(async () => structuredClone(originalReceipt)),
    dispatch: vi.fn(async () => { throw new Error("original execution forbidden"); }) };
  const authorize = vi.fn(async () => true), current = vi.fn(() => true), admit = vi.fn(async () => {});
  const options = { controls, transport, originalTransport, agentId: "agent-a", now: () => now, commandTtlMs: 1000, deadlineMs: settings.deadlineMs ?? 1000 };
  const input = { preparation, actorId: "current-operator", idempotencyKey: "stop-orders",
    context: { requestId: "stop-request", correlationId: "stop-correlation" }, authorize, current, admit };
  const app = Fastify(); apps.push(app);
  const executions = new Map(settings.enabled === false ? [] : [[base.projectId, options]]);
  const grants = vi.fn(async () => settings.allowed === false ? [] : [{ id: "grant-a", actorId: "current-operator",
    action: "project.update" as const, scope: { kind: "project" as const, projectId: base.projectId } }]);
  const projects = vi.fn(async (id: string) => ({ id, name: "fixture", repoUrl: "https://example.test/repo", defaultBranch: "main",
    buildCommand: null, runCommand: null, port: null, description: null, imageTag: null }));
  const secrets = { find: vi.fn(async () => { throw new Error("secret access forbidden"); }),
    createIfAbsent: vi.fn(async () => { throw new Error("credential replacement forbidden"); }) };
  const configuration = { profiles: new Map([[engine, profile]]), deadlineMs: options.deadlineMs };
  const routeOptions = { prefix: "/api/v1", configuration, secrets, imagePolicy, executions,
    projects: { findById: projects }, grants: { listForActor: grants },
    requireAuth: async (request: unknown, reply: FastifyReply) => {
      if (settings.anonymous) return reply.code(401).send({ error: "unauthenticated" });
      Object.assign(request as object, { auth: { user: { id: "current-operator", role: "operator" } },
        correlationContext: { requestId: "stop-request", correlationId: "stop-correlation" } });
    }, requireRole: async () => {}, ok: (_request: unknown, data: unknown) => ({ data }),
    error: (_request: unknown, code: string) => ({ error: { code } }) };
  registerManagedDatabaseStopRoute(app, routeOptions);
  const { projectId: _project, databaseId: _database, ...body } = preparation;
  const call = (payload: unknown = body, key = "stop-orders") => app.inject({ method: "POST",
    url: "/api/v1/projects/project-a/databases/orders/runtime/stop", headers: { "idempotency-key": key }, payload: payload as Record<string, unknown> });
  return { app, call, body, preparation, routeOptions, original, controls, transport, originalTransport, secrets, profile, projects, grants,
    options, executions, advance: () => { now = 4000; } };
}

it("stops each of the five engines through project authorization without reading credentials", async () => {
  for (const engine of ["postgres", "mysql", "mariadb", "mongodb", "redis"] as const) {
    const f = await fixture({ engine }), response = await f.call(); expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ stopped: true, command: { status: "completed" }, receipt: { engine, status: "stopped" } });
  expect(response.json().data.originalStopReplayFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(response.json().data.command).not.toHaveProperty("projectExecutionAuthority");
    expect(f.transport.dispatch).toHaveBeenCalledTimes(1); expect(f.originalTransport.dispatch).not.toHaveBeenCalled();
    expect(f.secrets.find).not.toHaveBeenCalled(); expect(f.secrets.createIfAbsent).not.toHaveBeenCalled();
  }
});
it("replays completed stop after expiry and profile removal without original or credential access", async () => {
  const f = await fixture(); expect((await f.call()).statusCode).toBe(200); f.advance();
  Object.assign(f.routeOptions, { configuration: undefined }); f.controls.findProjectUpdateById.mockClear();
  const replay = await f.call(); expect(replay.statusCode).toBe(200); expect(replay.json().data.idempotent).toBe(true);
  expect(f.controls.findProjectUpdateById).not.toHaveBeenCalled(); expect(f.transport.dispatch).toHaveBeenCalledTimes(1);
  expect(f.secrets.find).not.toHaveBeenCalled();
});
it("requires authentication and a current project grant before reading commands", async () => {
  for (const anonymous of [false, true]) { const f = await fixture({ anonymous, allowed: false });
    expect((await f.call()).statusCode).toBe(anonymous ? 401 : 403);
    expect(f.controls.findProjectUpdateByIdempotency).not.toHaveBeenCalled(); expect(f.projects).not.toHaveBeenCalled();
  }
});
it("refuses execution without explicit per-project stop access", async () => {
  const f = await fixture({ enabled: false }); expect((await f.call()).statusCode).toBe(503);
  expect(f.transport.dispatch).not.toHaveBeenCalled();
});
it("rejects extra secret, execution and detached original fields at the public boundary", async () => {
  for (const extra of [{ password: "private" }, { stopGraceSeconds: 30 }, { command: ["docker"] },
    { originalReceipt: { ...(await fixture()).body.originalReceipt, projectId: "other" } }]) {
    const f = await fixture(); expect((await f.call({ ...f.body, ...extra })).statusCode).toBe(400);
    expect(f.controls.findProjectUpdateByIdempotency).not.toHaveBeenCalled();
  }
});
it("rejects malformed or missing idempotency keys before command reads", async () => {
  const f = await fixture(); expect((await f.call(f.body, "bad key")).statusCode).toBe(400);
  const missing = await f.app.inject({ method: "POST", url: "/api/v1/projects/project-a/databases/orders/runtime/stop", payload: f.body });
  expect(missing.statusCode).toBe(400); expect(f.controls.findProjectUpdateByIdempotency).not.toHaveBeenCalled();
});
it("rejects missing or detached current project metadata before fresh stop", async () => {
  const f = await fixture(); f.projects.mockResolvedValue({ ...(await f.projects("project-a")), id: "other" });
  expect((await f.call()).statusCode).toBe(503); expect(f.transport.dispatch).not.toHaveBeenCalled();
});
it("rejects stale trusted profile before creating or claiming stop", async () => {
  const f = await fixture(); f.profile.image = "registry.example.com/postgres@sha256:" + "f".repeat(64);
  expect((await f.call()).statusCode).toBe(503); expect(f.controls.resolve).not.toHaveBeenCalled();
});
it("bounds stalled project authorization without runtime effects", async () => {
  const f = await fixture({ deadlineMs: 10 }); f.grants.mockImplementation(() => new Promise(() => {}));
  expect((await f.call()).statusCode).toBe(503); expect(f.transport.dispatch).not.toHaveBeenCalled();
});
it("rejects absent original command without claim or audit", async () => {
  const f = await fixture(); f.controls.findProjectUpdateById.mockResolvedValue(null);
  expect((await f.call()).statusCode).toBe(503); expect(f.controls.claimProjectUpdate).not.toHaveBeenCalled();
  expect(f.controls.completeProjectUpdate).not.toHaveBeenCalled();
});
it("registers the operator stop route in the actual API bootstrap with authentication", async () => {
  const f = await fixture(), app = await buildApiApp({ env: { NODE_ENV: "test" } }); apps.push(app);
  const response = await app.inject({ method: "POST", url: "/api/v1/projects/project-a/databases/orders/runtime/stop", payload: f.body, headers: { "idempotency-key": "stop-orders" } });
  expect(response.statusCode).toBe(401);
});
