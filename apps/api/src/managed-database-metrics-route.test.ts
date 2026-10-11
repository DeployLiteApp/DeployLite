import { afterEach, expect, it, vi } from "vitest";
import { MANAGED_DATABASE_RUNTIME_CAPABILITY, MANAGED_DATABASE_STOP_CAPABILITY, type ManagedDatabaseStopReceiptV1, type ManagedDatabaseStartReceiptV1 } from "@deploylite/contracts";
import { composeRuntimeResourceName, createControlCommand, managedDatabaseRuntimeExecutionBinding,
  managedDatabaseRuntimeReplayFingerprintDigest, managedDatabaseStopExecutionBinding, managedDatabaseStopReplayFingerprintDigest, resolveControlCommandInMemory, planManagedDatabaseProfile,
  type ControlCommand, type ProjectUpdateControlRepository } from "@deploylite/domain";
import Fastify, { type FastifyReply } from "fastify";
import { registerManagedDatabaseMetricsRoute } from "./managed-database-metrics-route.js";
import { buildApiApp } from "./app.js";
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

async function fixture(settings: { engine?: "postgres" | "mysql" | "mariadb" | "mongodb" | "redis"; allowed?: boolean; anonymous?: boolean; deadlineMs?: number; enabled?: boolean } = {}) {
  let now = 1000;
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
  const stopPreparation={...base,originalReceipt,originalReplayFingerprint:managedDatabaseRuntimeReplayFingerprintDigest(originalQuery)};
  const preparation=stopPreparation;
  const controls={findProjectUpdateById:vi.fn(async()=>structuredClone(original)),resolve:vi.fn(),claimProjectUpdate:vi.fn(),completeProjectUpdate:vi.fn()};
  const {commandId:originalCommandId,inputDigest:_digest,correlationId:_correlation,status:_status,health:_health,idempotent:_idem,...physical}=originalReceipt;
  const transport={available:vi.fn(()=>true),observe:vi.fn(async(_preparation:unknown,context:{requestId:string;correlationId:string})=>({...physical,action:"database.runtime.metrics",originalCommandId,profileId:profile.profileId,context:{requestId:context.requestId,correlationId:context.correlationId},state:"running",health:"healthy",uid:999,observedAt:now,metrics:{cpuPercent:0.25,memoryUsage:"5.629MiB / 512MiB",memoryPercent:1.1,networkIO:"916B / 0B",blockIO:"147kB / 0B",pids:9},metricsObservedAt:now}))};
  const originalTransport = { available: vi.fn(() => true), readReceipt: vi.fn(async () => structuredClone(originalReceipt)),
    dispatch: vi.fn(async () => { throw new Error("original execution forbidden"); }) };
  const authorize = vi.fn(async () => true), current = vi.fn(() => true), admit = vi.fn(async () => {});
  const options={controls:controls as unknown as ProjectUpdateControlRepository,transport:transport as unknown as import("./managed-database-metrics-transport.js").ManagedDatabaseMetricsTransport,originalTransport,agentId:"agent-a",now:()=>now,deadlineMs:settings.deadlineMs??1000};
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
        correlationContext: { requestId: "start-request", correlationId: "start-correlation" } });
    }, requireRole: async () => {}, ok: (_request: unknown, data: unknown) => ({ data }),
    error: (_request: unknown, code: string) => ({ error: { code } }) };
  registerManagedDatabaseMetricsRoute(app, routeOptions);
  const { projectId: _project, databaseId: _database, ...body } = preparation;
  const call = (payload: unknown = body, key = "start-orders") => app.inject({ method: "POST",
    url: "/api/v1/projects/project-a/databases/orders/runtime/metrics", payload: payload as Record<string, unknown> });
  return { app, call, body, preparation, routeOptions, original, controls, transport, originalTransport, secrets, profile, projects, grants,
    options, executions, advance: () => { now = 4000; } };
}

it("reports current health for all five engines without secret reads, commands or idempotency key",async()=>{for(const engine of ["postgres","mysql","mariadb","mongodb","redis"] as const){const f=await fixture({engine}),response=await f.call();expect(response.statusCode).toBe(200);expect(response.json().data).toMatchObject({observation:{engine,state:"running",health:"healthy",uid:999}});expect(f.controls.resolve).not.toHaveBeenCalled();expect(f.controls.claimProjectUpdate).not.toHaveBeenCalled();expect(f.controls.completeProjectUpdate).not.toHaveBeenCalled();expect(f.secrets.find).not.toHaveBeenCalled();expect(f.originalTransport.dispatch).not.toHaveBeenCalled();}});
it("requires authentication/current project grant before original reads",async()=>{for(const anonymous of [false,true]){const f=await fixture({anonymous,allowed:false});expect((await f.call()).statusCode).toBe(anonymous?401:403);expect(f.projects).not.toHaveBeenCalled();expect(f.controls.findProjectUpdateById).not.toHaveBeenCalled();expect(f.transport.observe).not.toHaveBeenCalled();}});
it("rejects private or mutating health request fields before any original read",async()=>{const f=await fixture();for(const patch of [{password:"private"},{commandId:"new-command"},{authority:{}},{sealedEnvironment:{}},{argv:[]}])expect((await f.call({...f.body,...patch})).statusCode).toBe(400);expect(f.controls.findProjectUpdateById).not.toHaveBeenCalled();});
it("requires explicit project execution and safe deadlines",async()=>{for(const settings of [{enabled:false},{deadlineMs:0},{deadlineMs:60001}]){const f=await fixture(settings);expect((await f.call()).statusCode).toBe(503);expect(f.transport.observe).not.toHaveBeenCalled();}});
it("rejects removed or changed approved profile before original cache access",async()=>{for(const mode of ["removed","changed"]){const f=await fixture();if(mode==="removed")f.routeOptions.configuration.profiles.clear();else Object.assign(f.profile,{profileId:"changed"});expect((await f.call()).statusCode).toBe(503);expect(f.controls.findProjectUpdateById).not.toHaveBeenCalled();expect(f.secrets.find).not.toHaveBeenCalled();}});
it("rejects late grant revocation after live health rather than returning stale access",async()=>{const f=await fixture(),observe=f.transport.observe.getMockImplementation()!;f.transport.observe.mockImplementation(async(...args)=>{const observation=await observe(...args);f.grants.mockResolvedValue([]);return observation;});expect((await f.call()).statusCode).toBe(503);});
it("reads fresh health after original lease expiry without execution or cache replay claims",async()=>{const f=await fixture();f.advance();expect((await f.call()).statusCode).toBe(200);expect(f.transport.observe).toHaveBeenCalledOnce();expect(f.controls.claimProjectUpdate).not.toHaveBeenCalled();});
it("registers health in actual API bootstrap with authentication",async()=>{const f=await fixture(),app=await buildApiApp({env:{NODE_ENV:"test"}});apps.push(app);expect((await app.inject({method:"POST",url:"/api/v1/projects/project-a/databases/orders/runtime/metrics",payload:f.body})).statusCode).toBe(401);});
