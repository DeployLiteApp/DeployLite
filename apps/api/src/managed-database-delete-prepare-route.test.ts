import { afterEach, expect, it, vi } from "vitest";
import { MANAGED_DATABASE_RUNTIME_CAPABILITY, type ManagedDatabaseStopReceiptV1 } from "@deploylite/contracts";
import { composeRuntimeResourceName, createControlCommand, managedDatabaseRuntimeExecutionBinding,
  managedDatabaseRuntimeReplayFingerprintDigest, resolveControlCommandInMemory, planManagedDatabaseProfile,
  createConfirmation, type ControlCommand, type ProjectUpdateControlRepository } from "@deploylite/domain";
import Fastify, { type FastifyReply } from "fastify";
import { registerManagedDatabaseDeletePrepareRoute } from "./managed-database-delete-prepare-route.js";
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
    resolveProjectUpdateConfirmation: vi.fn(async(command:ControlCommand)=>createConfirmation({command,classification:"destructive"})),
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
  registerManagedDatabaseDeletePrepareRoute(app, routeOptions);
  const { projectId: _project, databaseId: _database, ...body } = preparation;
  const call = (payload: unknown = body, key = "stop-orders") => app.inject({ method: "POST",
    url: "/api/v1/projects/project-a/databases/orders/runtime/delete/prepare", headers: { "idempotency-key": key }, payload: payload as Record<string, unknown> });
  return { app, call, body, preparation, routeOptions, original, controls, transport, originalTransport, secrets, profile, projects, grants,
    options, executions, advance: () => { now = 4000; } };
}

it("prepares all five engines with a destructive nonce and no runtime or secret effect",async()=>{
 for(const engine of ["postgres","mysql","mariadb","mongodb","redis"] as const){const f=await fixture({engine}),response=await f.call();expect(response.statusCode).toBe(200);
  expect(response.json().data).toMatchObject({command:{status:"pending_confirmation"},confirmation:{classification:"destructive",consumedAt:null},storagePolicy:"retain-original"});
  expect(response.json().data.command).not.toHaveProperty("projectExecutionAuthority");expect(response.json().data.confirmation).not.toHaveProperty("actorId");
  expect(f.controls.claimProjectUpdate).not.toHaveBeenCalled();expect(f.transport.dispatch).not.toHaveBeenCalled();expect(f.originalTransport.dispatch).not.toHaveBeenCalled();expect(f.secrets.find).not.toHaveBeenCalled();
 }
});
it("requires authentication and current project grant before any private read",async()=>{
 for(const anonymous of [false,true]){const f=await fixture({anonymous,allowed:false});expect((await f.call()).statusCode).toBe(anonymous?401:403);expect(f.projects).not.toHaveBeenCalled();expect(f.controls.findProjectUpdateByIdempotency).not.toHaveBeenCalled();}
});
it("rejects unconfigured access or stale approved profile without persisting intent",async()=>{
 const disabled=await fixture({enabled:false});expect((await disabled.call()).statusCode).toBe(503);
 const f=await fixture();f.profile.image="registry.example.com/postgres@sha256:"+"f".repeat(64);expect((await f.call()).statusCode).toBe(503);expect(f.controls.resolve).not.toHaveBeenCalled();
});
it("rejects caller credentials, cleanup flags and malformed keys before private reads",async()=>{
 for(const extra of [{password:"private"},{deleteVolumes:true},{force:true},{confirmationId:"caller"}]){const f=await fixture();expect((await f.call({...f.body,...extra})).statusCode).toBe(400);expect(f.projects).not.toHaveBeenCalled();}
 const f=await fixture();expect((await f.call(f.body,"bad key")).statusCode).toBe(400);expect(f.projects).not.toHaveBeenCalled();
});
it("bounds grant lookup without private reads or execution",async()=>{
 const f=await fixture({deadlineMs:5});f.grants.mockImplementation(()=>new Promise(()=>{}));expect((await f.call()).statusCode).toBe(503);expect(f.controls.resolve).not.toHaveBeenCalled();expect(f.transport.dispatch).not.toHaveBeenCalled();
});
it("registers the authenticated preparation path in the actual API bootstrap",async()=>{
 const f=await fixture(),app=await buildApiApp({env:{NODE_ENV:"test"}});apps.push(app);expect((await app.inject({method:"POST",url:"/api/v1/projects/project-a/databases/orders/runtime/delete/prepare",payload:f.body,headers:{"idempotency-key":"prepare"}})).statusCode).toBe(401);
});
