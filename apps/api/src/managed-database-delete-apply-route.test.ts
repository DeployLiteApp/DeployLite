import { afterEach, expect, it, vi } from "vitest";
import { MANAGED_DATABASE_RUNTIME_CAPABILITY, type ManagedDatabaseDeleteReceiptV1 } from "@deploylite/contracts";
import { composeRuntimeResourceName, createControlCommand, managedDatabaseRuntimeExecutionBinding,
  managedDatabaseRuntimeReplayFingerprintDigest, resolveControlCommandInMemory, planManagedDatabaseProfile,
  prepareManagedDatabaseDeleteConfirmation, type ManagedDatabaseDeleteCompletionInput, type ControlConfirmation, type ControlCommand, type ProjectUpdateControlRepository } from "@deploylite/domain";
import Fastify, { type FastifyReply } from "fastify";
import { registerManagedDatabaseDeleteApplyRoute } from "./managed-database-delete-apply-route.js";
import { buildApiApp } from "./app.js";
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

async function fixture(settings: { engine?: "postgres" | "mysql" | "mariadb" | "mongodb" | "redis"; allowed?: boolean; anonymous?: boolean; deadlineMs?: number; enabled?: boolean } = {}) {
  let now = 1000;
  const ledger = new Map<string, ControlCommand>(), cache = new Map<string, ManagedDatabaseDeleteReceiptV1>();
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
  const intent=prepareManagedDatabaseDeleteConfirmation({preparation,actorId:"current-operator",idempotencyKey:"stop-orders",correlationId:"delete-correlation",now,commandTtlMs:1000}),nonce=intent.confirmation;
  resolveControlCommandInMemory(ledger,intent.command);
  const save = (command: ControlCommand) => {
    const key = [...ledger].find(([, value]) => value.id === command.id)![0];
    ledger.set(key, structuredClone(command)); return structuredClone(command);
  };
  const controls = {
    resolveProjectUpdateConfirmation: vi.fn(async()=>structuredClone(nonce)),
    claimConfirmedProjectUpdate: vi.fn(async(command:ControlCommand,confirmation:ControlConfirmation)=>{if(confirmation.id!==nonce.id||nonce.consumedAt)return {command,accepted:false,claimed:false,reason:"confirmation_rejected"};nonce.consumedAt=new Date(now);const authority=authorityFor(command);return {command:save({...command,status:"dispatching",projectExecutionAuthority:authority}),accepted:true,claimed:true,authority,reason:null};}),
    validateConfirmedProjectUpdateAuthority: vi.fn(async()=>{}),
    completeManagedDatabaseDelete: vi.fn(async(input:ManagedDatabaseDeleteCompletionInput)=>save({...input.command,status:"completed",result:input.receipt})),
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
  const receiptFor = (command: ControlCommand): ManagedDatabaseDeleteReceiptV1 => ({ ...base, action: "database.runtime.delete",
    agentId: "agent-a", commandId: command.id, originalCommandId: original.id, inputDigest: command.inputDigest, originalStopCommandId:null, confirmationId:nonce.id,
    correlationId: command.correlationId, containerId: originalReceipt.containerId, imageId: originalReceipt.imageId,
    volumeName: originalReceipt.volumeName, networkName: originalReceipt.networkName, networkId: originalReceipt.networkId,
    volumeCreatedAt: originalReceipt.volumeCreatedAt, observedAt: now, status: "removed", storage: "retained", redacted: true });
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
  registerManagedDatabaseDeleteApplyRoute(app, routeOptions);
  const { projectId: _project, databaseId: _database, ...sourceBody } = preparation;
  const body={...sourceBody,confirmationId:nonce.id};
  const call = (payload: unknown = body, key = "stop-orders") => app.inject({ method: "POST",
    url: "/api/v1/projects/project-a/databases/orders/runtime/delete/apply", headers: { "idempotency-key": key }, payload: payload as Record<string, unknown> });
  return { nonce,app, call, body, preparation, routeOptions, original, controls, transport, originalTransport, secrets, profile, projects, grants,
    options, executions, advance: () => { now = 4000; } };
}

it("applies original confirmation for all five engines without secret reads or new approval",async()=>{
 for(const engine of ["postgres","mysql","mariadb","mongodb","redis"] as const){const f=await fixture({engine}),response=await f.call();expect(response.statusCode).toBe(200);expect(response.json().data).toMatchObject({removed:true,command:{status:"completed"},receipt:{engine,status:"removed",storage:"retained"}});expect(response.json().data.command).not.toHaveProperty("projectExecutionAuthority");expect(f.controls.claimConfirmedProjectUpdate).toHaveBeenCalledOnce();expect(f.controls.resolve).not.toHaveBeenCalled();expect(f.controls.resolveProjectUpdateConfirmation).not.toHaveBeenCalled();expect(f.secrets.find).not.toHaveBeenCalled();expect(f.transport.dispatch).toHaveBeenCalledOnce();}
});
it("requires current authentication and grant before private intent or project lookup",async()=>{
 for(const anonymous of [false,true]){const f=await fixture({anonymous,allowed:false});expect((await f.call()).statusCode).toBe(anonymous?401:403);expect(f.projects).not.toHaveBeenCalled();expect(f.controls.findProjectUpdateByIdempotency).not.toHaveBeenCalled();}
});
it("requires a strict confirmation selector and refuses caller cleanup or secret flags",async()=>{
 for(const extra of [{confirmationId:""},{force:true},{deleteVolumes:true},{password:"private"}]){const f=await fixture();expect((await f.call({...f.body,...extra})).statusCode).toBe(400);expect(f.controls.findProjectUpdateByIdempotency).not.toHaveBeenCalled();}
 const f=await fixture(),{confirmationId:_nonce,...missing}=f.body;expect((await f.call(missing)).statusCode).toBe(400);expect(f.controls.findProjectUpdateByIdempotency).not.toHaveBeenCalled();
});
it("rejects foreign nonce or stale profile before any effect",async()=>{
 const foreign=await fixture();expect((await foreign.call({...foreign.body,confirmationId:"foreign"})).statusCode).toBe(503);expect(foreign.transport.dispatch).not.toHaveBeenCalled();expect(foreign.nonce.consumedAt).toBeNull();
 const f=await fixture();f.profile.image="registry.example.com/postgres@sha256:"+"f".repeat(64);expect((await f.call()).statusCode).toBe(503);expect(f.controls.claimConfirmedProjectUpdate).not.toHaveBeenCalled();expect(f.transport.dispatch).not.toHaveBeenCalled();
});
it("replays completed cache after expiry and profile removal without another claim or effect",async()=>{
 const f=await fixture(),first=await f.call();expect(first.statusCode).toBe(200);f.advance();Object.assign(f.routeOptions,{configuration:undefined});f.controls.findProjectUpdateById.mockClear();const replay=await f.call();expect(replay.statusCode).toBe(200);expect(replay.json().data.receipt).toEqual(first.json().data.receipt);expect(replay.json().data.idempotent).toBe(true);expect(f.controls.claimConfirmedProjectUpdate).toHaveBeenCalledOnce();expect(f.transport.dispatch).toHaveBeenCalledOnce();expect(f.controls.findProjectUpdateById).not.toHaveBeenCalled();
});
it("registers actual API apply path with authentication",async()=>{
 const f=await fixture(),app=await buildApiApp({env:{NODE_ENV:"test"}});apps.push(app);expect((await app.inject({method:"POST",url:"/api/v1/projects/project-a/databases/orders/runtime/delete/apply",payload:f.body,headers:{"idempotency-key":"apply"}})).statusCode).toBe(401);
});
