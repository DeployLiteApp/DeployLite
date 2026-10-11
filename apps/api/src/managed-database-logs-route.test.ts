import {afterEach, expect, it, vi} from "vitest";
import Fastify, {type FastifyReply} from "fastify";
import {MANAGED_DATABASE_RUNTIME_CAPABILITY} from "@deploylite/contracts";
import {createControlCommand, managedDatabaseRuntimeExecutionBinding, managedDatabaseRuntimeReplayFingerprintDigest, planManagedDatabaseProfile, type ControlCommand} from "@deploylite/domain";
import {registerManagedDatabaseLogsRoute} from "./managed-database-logs-route.js";
import {buildApiApp} from "./app.js";
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {await Promise.all(apps.splice(0).map(app => app.close()));});
async function fixture(settings: {engine?: "postgres" | "mysql" | "mariadb" | "mongodb" | "redis"; allowed?: boolean; anonymous?: boolean; enabled?: boolean; deadlineMs?: number} = {}) {
  let now = 1000; const engine = settings.engine ?? "postgres";
  const imagePolicy = {policyVersion: "images-1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true};
  const profile = {schemaVersion: 1 as const, profileId: "profile-" + engine, engine, image: "registry.example.com/" + engine + "@sha256:" + "a".repeat(64),
    dataPath: {postgres: "/var/lib/postgresql", mysql: "/var/lib/mysql", mariadb: "/var/lib/mysql", mongodb: "/data/db", redis: "/data"}[engine],
    containerPort: {postgres: 5432, mysql: 3306, mariadb: 3306, mongodb: 27017, redis: 6379}[engine], credentialKeys: ["DATABASE_PASSWORD"], backupStrategy: engine === "redis" ? "volume-quiesced" as const : "engine-native" as const};
  const request = {schemaVersion: 1 as const, projectId: "project-a", databaseId: "orders", engine}, plan = planManagedDatabaseProfile(request, profile, imagePolicy);
  const base = {...request, profileId: profile.profileId, planDigest: plan.planDigest, environmentFingerprint: "b".repeat(32)};
  const seed = createControlCommand({actorId: "original-operator", action: "project.update", scope: {kind: "project", projectId: base.projectId}, input: managedDatabaseRuntimeExecutionBinding(base),
    idempotencyKey: "original-create", correlationId: "original-correlation", expiresAt: new Date(2000)});
  const authority = {schemaVersion: 1 as const, projectId: base.projectId, commandId: seed.id, action: "project.update" as const, inputDigest: seed.inputDigest,
    projectLease: {leaseId: "lease-" + seed.id, projectId: base.projectId, fence: 1, expiresAt: seed.expiresAt.getTime()}};
  const original: ControlCommand = {...seed, status: "completed", projectExecutionAuthority: authority};
  const {profileId: _profile, ...physicalBase} = base;
  const originalReceipt = {...physicalBase, action: "database.runtime" as const, agentId: "agent-a", commandId: original.id, inputDigest: original.inputDigest, correlationId: original.correlationId,
    containerId: "c".repeat(64), imageId: "sha256:" + "d".repeat(64), volumeName: plan.volume.runtimeName, networkName: plan.network.runtimeName, networkId: "e".repeat(64),
    volumeCreatedAt: "2026-10-10T00:00:00Z", observedAt: 1000, status: "ready" as const, health: "passed" as const, storage: "verified" as const, idempotent: false, redacted: true as const};
  const originalQuery = {...base, action: "database.runtime", operation: "database.runtime.apply", agentId: "agent-a", commandId: original.id, idempotencyKey: original.idempotencyKey, inputDigest: original.inputDigest,
    requiredCapabilities: [MANAGED_DATABASE_RUNTIME_CAPABILITY], authority, lease: authority.projectLease, context: {requestId: "original-request", correlationId: original.correlationId}, timeoutMs: 1000};
  const preparation = {...base, originalReceipt, originalReplayFingerprint: managedDatabaseRuntimeReplayFingerprintDigest(originalQuery), selection: {tail: 100}};
  const {commandId: originalCommandId, inputDigest: _digest, correlationId: _correlation, status: _status, health: _health, idempotent: _idem, ...physical} = originalReceipt;
  const controls = {findProjectUpdateById: vi.fn(async () => structuredClone(original)), resolve: vi.fn(), claimProjectUpdate: vi.fn(), completeProjectUpdate: vi.fn()};
  const originalTransport = {available: vi.fn(() => true), readReceipt: vi.fn(async () => structuredClone(originalReceipt)), dispatch: vi.fn()};
  const transport = {available: vi.fn(() => true), observe: vi.fn(async (_preparation: unknown, context: {requestId: string; correlationId: string}) => ({...physical,
    action: "database.runtime.logs", originalCommandId, profileId: profile.profileId, context: {requestId: context.requestId, correlationId: context.correlationId}, state: "running", health: "healthy", uid: 999, observedAt: now,
    logs: {stdout: "ready\n", stderr: "notice\n", redacted: true}, logsObservedAt: now}))};
  const execution = {controls, originalTransport, transport, agentId: "agent-a", now: () => now, deadlineMs: settings.deadlineMs ?? 1000};
  const executions = new Map(settings.enabled === false ? [] : [[base.projectId, execution]]), grants = vi.fn(async () => settings.allowed === false ? [] : [{id: "grant-a", actorId: "current-operator", action: "project.update", scope: {kind: "project", projectId: base.projectId}}]);
  const projects = vi.fn(async (id: string) => ({id, name: "fixture", repoUrl: "https://example.test/repo", defaultBranch: "main", buildCommand: null, runCommand: null, port: null, description: null, imageTag: null}));
  const secrets = {find: vi.fn(), createIfAbsent: vi.fn()}, configuration = {profiles: new Map([[engine, profile]]), deadlineMs: execution.deadlineMs};
  const app = Fastify(); apps.push(app);
  const options = {prefix: "/api/v1", configuration, secrets, imagePolicy, executions, projects: {findById: projects}, grants: {listForActor: grants},
    requireAuth: async (value: unknown, reply: FastifyReply) => {if (settings.anonymous) return reply.code(401).send({error: "unauthenticated"});
      Object.assign(value as object, {auth: {user: {id: "current-operator", role: "operator"}}, correlationContext: {requestId: "logs-request", correlationId: "logs-correlation"}});},
    requireRole: async () => {}, ok: (_value: unknown, data: unknown) => ({data}), error: (_value: unknown, code: string, message: string) => ({error: {code, message}})};
  registerManagedDatabaseLogsRoute(app, options as never);
  const {projectId: _project, databaseId: _database, ...body} = preparation;
  const call = (payload: Record<string, unknown> = body) => app.inject({method: "POST", url: "/api/v1/projects/project-a/databases/orders/runtime/logs", payload});
  return {body, call, controls, transport, originalTransport, grants, projects, secrets, profile, options, advance: () => {now = 3000;}};
}
it("reads each approved engine logs without secret reads, new commands or idempotency keys", async () => {
  for (const engine of ["postgres", "mysql", "mariadb", "mongodb", "redis"] as const) {
    const f = await fixture({engine}), response = await f.call(); expect(response.statusCode).toBe(200); expect(response.json().data.observation).toMatchObject({engine, logs: {stdout: "ready\n", redacted: true}});
    expect(f.controls.resolve).not.toHaveBeenCalled(); expect(f.controls.claimProjectUpdate).not.toHaveBeenCalled(); expect(f.controls.completeProjectUpdate).not.toHaveBeenCalled(); expect(f.secrets.find).not.toHaveBeenCalled(); expect(f.originalTransport.dispatch).not.toHaveBeenCalled();
  }
});
it("requires authentication and current project grant before original reads", async () => {
  for (const anonymous of [false, true]) {const f = await fixture({anonymous, allowed: false}); expect((await f.call()).statusCode).toBe(anonymous ? 401 : 403); expect(f.projects).not.toHaveBeenCalled(); expect(f.controls.findProjectUpdateById).not.toHaveBeenCalled();}
});
it("rejects mutating/private fields and unbounded tail before original reads", async () => {
  const f = await fixture(); for (const patch of [{password: "private"}, {commandId: "new"}, {authority: {}}, {sealedEnvironment: {}}, {selection: {tail: -1}}]) expect((await f.call({...f.body, ...patch})).statusCode).toBe(400);
  expect(f.controls.findProjectUpdateById).not.toHaveBeenCalled();
});
it("requires explicit execution maps and bounded deadlines", async () => {
  for (const settings of [{enabled: false}, {deadlineMs: 0}, {deadlineMs: 60001}]) {const f = await fixture(settings); expect((await f.call()).statusCode).toBe(503); expect(f.transport.observe).not.toHaveBeenCalled();}
});
it("rejects removed or changed approved profile before cache lookup", async () => {
  for (const mode of ["removed", "changed"]) {const f = await fixture(); if (mode === "removed") f.options.configuration.profiles.clear(); else f.profile.profileId = "changed";
    expect((await f.call()).statusCode).toBe(503); expect(f.controls.findProjectUpdateById).not.toHaveBeenCalled();}
});
it("withholds late logs after current grant revocation", async () => {
  const f = await fixture(), observe = f.transport.observe.getMockImplementation()!; f.transport.observe.mockImplementation(async (...args) => {const value = await observe(...args); f.grants.mockResolvedValue([]); return value;}); expect((await f.call()).statusCode).toBe(503);
});
it("reads fresh logs after original lease expiry without dispatch", async () => {
  const f = await fixture(); f.advance(); expect((await f.call()).statusCode).toBe(200); expect(f.transport.observe).toHaveBeenCalledOnce(); expect(f.originalTransport.dispatch).not.toHaveBeenCalled();
});
it("registers authenticated logs in actual API bootstrap", async () => {
  const f = await fixture(), app = await buildApiApp({env: {NODE_ENV: "test"}}); apps.push(app);
  expect((await app.inject({method: "POST", url: "/api/v1/projects/project-a/databases/orders/runtime/logs", payload: f.body})).statusCode).toBe(401);
});
