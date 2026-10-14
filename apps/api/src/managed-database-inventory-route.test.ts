import Fastify, {type FastifyReply} from "fastify";
import {afterEach, expect, it, vi} from "vitest";
import {createEnvSecretCipher} from "@deploylite/config";
import type {ApprovedManagedDatabaseProfileV1, ManagedDatabaseEngineV1} from "@deploylite/contracts";
import {ensureManagedDatabaseCredentials, type AuditEventInput, type EncryptedEnvSecretValueRecord, type EnvSecretValueInput} from "@deploylite/domain";
import {registerManagedDatabaseInventoryRoute} from "./managed-database-inventory-route.js";
import {buildApiApp} from "./app.js";
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {await Promise.all(apps.splice(0).map(app => app.close()));});
const engines = ["postgres", "mysql", "mariadb", "mongodb", "redis"] as const;
async function fixture(settings: {anonymous?: boolean; role?: string; allowed?: boolean; enabled?: boolean; deadlineMs?: number} = {}) {
  const app = Fastify(); apps.push(app);
  const cipher = createEnvSecretCipher(Buffer.alloc(32, 7)), rows: EncryptedEnvSecretValueRecord[] = [];
  const imagePolicy = {policyVersion: "inventory-1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true};
  const profiles = new Map<ManagedDatabaseEngineV1, ApprovedManagedDatabaseProfileV1>();
  const secrets = {find: vi.fn(async (projectId: string, key: string) => rows.find(row => row.projectId === projectId && row.key === key)),
    createIfAbsent: vi.fn(async (record: EnvSecretValueInput) => {const row = {...record, id: `secret-${rows.length}`, valuePresent: true,
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()}; rows.push(row); return row;})};
  for (const engine of engines) {
    const profile: ApprovedManagedDatabaseProfileV1 = {schemaVersion: 1, engine, profileId: `profile-${engine}`, image: `registry.example.com/${engine}@sha256:${"a".repeat(64)}`,
      dataPath: "/database/data", containerPort: engine === "postgres" ? 5432 : engine === "mongodb" ? 27017 : engine === "redis" ? 6379 : 3306,
      credentialKeys: ["DATABASE_PASSWORD"], backupStrategy: engine === "redis" ? "volume-quiesced" : "engine-native"};
    profiles.set(engine, profile);
    await ensureManagedDatabaseCredentials({schemaVersion: 1, projectId: "project-a", databaseId: `orders_${engine}`, engine}, profile,
      {cipher, imagePolicy, secrets, authorize: async () => true, entropy: () => Buffer.alloc(32, 9)});
  }
  secrets.createIfAbsent.mockClear(); secrets.find.mockClear();
  const inventory = {listEncryptedByProject: vi.fn(async (_projectId: string) => rows)};
  const controls = {findProjectUpdatesByInputDigest: vi.fn(async () => []), findProjectUpdateByIdempotency: vi.fn(),
    resolve: vi.fn(), complete: vi.fn(), claimProjectUpdate: vi.fn(), validateProjectUpdateAuthority: vi.fn(), completeProjectUpdate: vi.fn()};
  const originalTransport = {available: vi.fn(() => true), readReceipt: vi.fn(async () => null), dispatch: vi.fn()};
  const stopTransport = {available: vi.fn(() => true), readReceipt: vi.fn(async () => null), dispatch: vi.fn()};
  const runtime = {controls, transport: originalTransport, agentId: "agent-a", now: Date.now, commandTtlMs: 1000, deadlineMs: 1000};
  const stop = {...runtime, transport: stopTransport, originalTransport};
  const runtimeExecutions = new Map(settings.enabled === false ? [] : [["project-a", runtime]]), stopExecutions = new Map([["project-a", stop]]);
  const grants = vi.fn(async () => settings.allowed === false ? [] : [{id: "grant-a", actorId: "current-operator", action: "project.update" as const, scope: {kind: "project" as const, projectId: "project-a"}}]);
  const projects = vi.fn(async (id: string) => ({id, name: "fixture", repoUrl: "https://example.test/repo", defaultBranch: "main", buildCommand: null, runCommand: null, port: null, description: null, imageTag: null}));
  const append = vi.fn(async (input: AuditEventInput) => ({id: "audit-a", actorId: input.actorUserId ?? "system", action: input.action, targetType: input.targetType,
    targetId: input.targetId, requestId: input.requestId, correlationId: input.correlationId, timestamp: new Date(0).toISOString()}));
  const options = {prefix: "/api/v1", configuration: {profiles, deadlineMs: settings.deadlineMs ?? 1000}, cipher, imagePolicy, secrets, inventory,
    runtimeExecutions, stopExecutions, projects: {findById: projects}, grants: {listForActor: grants}, audit: {append},
    requireAuth: async (request: unknown, reply: FastifyReply) => {if (settings.anonymous) return reply.code(401).send({error: "unauthenticated"});
      Object.assign(request as object, {auth: {user: {id: "current-operator", role: settings.role ?? "operator"}}, correlationContext: {requestId: "inventory-request", correlationId: "inventory-correlation"}});},
    requireRole: async (_request: unknown, reply: FastifyReply) => {if (settings.role === "read-only") return reply.code(403).send({error: "forbidden"});},
    ok: (_request: unknown, data: unknown) => ({data}), error: (_request: unknown, code: string) => ({error: {code}})};
  registerManagedDatabaseInventoryRoute(app, options);
  const call = (suffix = "") => app.inject({method: "GET", url: "/api/v1/projects/project-a/databases" + suffix});
  return {app, call, rows, profiles, options, inventory, secrets, controls, originalTransport, stopTransport, grants, projects, append};
}
it("recovers five configured engines with only public metadata and immutable source preparations", async () => {
  const f = await fixture(), response = await f.call(); expect(response.statusCode).toBe(200);
  const data = response.json().data; expect(data.databases).toHaveLength(5);
  expect(data.databases.map((entry: any) => entry.preparation.engine).sort()).toEqual([...engines].sort());
  for (const entry of data.databases) expect(entry).toMatchObject({source: null, startPreparation: null, connection: {exposure: "internal", availability: "planned"}});
  expect(response.body).not.toMatch(/090909|encryptedValue|DATABASE_PASSWORD|projectExecutionAuthority|sealedEnvironment/);
  expect(f.inventory.listEncryptedByProject).toHaveBeenCalledWith("project-a");
  expect(f.controls.findProjectUpdatesByInputDigest).toHaveBeenCalledTimes(5);
  expect(f.secrets.createIfAbsent).not.toHaveBeenCalled(); expect(f.originalTransport.dispatch).not.toHaveBeenCalled(); expect(f.stopTransport.dispatch).not.toHaveBeenCalled();
  expect(f.append).toHaveBeenCalledWith(expect.objectContaining({action: "database.inventory.read", targetId: "project-a", requestId: "inventory-request", correlationId: "inventory-correlation", metadata: {databaseCount: 5, redacted: true}}));
});
it("requires authentication, mutation role and current grant before any private inventory/project read", async () => {
  for (const settings of [{anonymous: true}, {role: "read-only"}, {allowed: false}]) {
    const f = await fixture(settings); expect((await f.call()).statusCode).toBe(settings.anonymous ? 401 : 403);
    expect(f.projects).not.toHaveBeenCalled(); expect(f.inventory.listEncryptedByProject).not.toHaveBeenCalled();
  }
});
it("rejects private or mutating query fields before reading scoped inventory", async () => {
  const f = await fixture();
  for (const field of ["password", "authority", "execute", "includeSecrets", "projectId"]) expect((await f.call(`?${field}=private`)).statusCode).toBe(400);
  expect(f.inventory.listEncryptedByProject).not.toHaveBeenCalled();
});
it("requires explicit coherent execution configuration and the original lookup port", async () => {
  for (const mode of ["disabled", "agent", "controls", "reader"]) {
    const f = await fixture({enabled: mode !== "disabled"}), runtime = f.options.runtimeExecutions.get("project-a");
    if (mode === "agent") f.options.stopExecutions.get("project-a")!.agentId = "foreign-agent";
    if (mode === "controls") f.options.stopExecutions.get("project-a")!.controls = {...f.controls};
    if (mode === "reader") Object.assign(runtime!.controls, {findProjectUpdatesByInputDigest: undefined});
    expect((await f.call()).statusCode).toBe(503); expect(f.inventory.listEncryptedByProject).not.toHaveBeenCalled();
  }
});
it("rejects corrupt, foreign or stale stored bundles rather than silently dropping a database", async () => {
  for (const mode of ["foreign", "corrupt", "profile"]) {
    const f = await fixture();
    if (mode === "foreign") f.rows[0]!.projectId = "foreign";
    if (mode === "corrupt") f.rows[0]!.encryptedValue = Buffer.from("private-broken-envelope");
    if (mode === "profile") f.profiles.delete("redis");
    const response = await f.call(); expect(response.statusCode).toBe(503); expect(response.body).not.toContain("private-broken-envelope");
  }
});
it("withholds inventory when the selected credential store disagrees with the persisted original row", async () => {
  const f = await fixture(); f.secrets.find.mockImplementation(async () => ({...f.rows[0]!, id: "other-row"}));
  expect((await f.call()).statusCode).toBe(503); expect(f.originalTransport.readReceipt).not.toHaveBeenCalled();
});
it("revalidates grant, profile and encrypted inventory after the correlated read audit", async () => {
  for (const mode of ["grant", "profile", "ciphertext"]) {
    const f = await fixture(), append = f.append.getMockImplementation()!;
    f.append.mockImplementation(async input => {const result = await append(input); if (mode === "grant") f.grants.mockResolvedValue([]); else if (mode === "profile") f.profiles.clear(); else f.rows[0]!.encryptedValue = Buffer.from("changed"); return result;});
    expect((await f.call()).statusCode).toBe(503);
  }
});
it("bounds private inventory reads that ignore cancellation and hides their errors", async () => {
  const f = await fixture({deadlineMs: 5}); f.inventory.listEncryptedByProject.mockImplementation(() => new Promise(() => {}));
  expect((await f.call()).statusCode).toBe(503);
});
it("returns a stable empty inventory without commands when there are no stored native slots", async () => {
  const f = await fixture(); f.rows.splice(0);
  const response = await f.call(); expect(response.statusCode).toBe(200); expect(response.json().data.databases).toEqual([]);
  expect(f.controls.findProjectUpdatesByInputDigest).not.toHaveBeenCalled(); expect(f.secrets.find).not.toHaveBeenCalled();
});
it("registers inventory in the actual API bootstrap behind authentication", async () => {
  const app = await buildApiApp({env: {NODE_ENV: "test"}}); apps.push(app);
  expect((await app.inject({method: "GET", url: "/api/v1/projects/project-a/databases"})).statusCode).toBe(401);
});

async function readyInventory() {
  const f = await fixture();
  const preparation = (await f.call()).json().data.databases[0].preparation;
  const {createControlCommand, managedDatabaseRuntimeExecutionBinding, composeRuntimeResourceName, createConfirmation, managedDatabaseDeleteExecutionBinding} = await import("@deploylite/domain");
  const command = createControlCommand({actorId: "creator", action: "project.update", scope: {kind: "project", projectId: "project-a"}, input: managedDatabaseRuntimeExecutionBinding(preparation), idempotencyKey: "original", correlationId: "original", expiresAt: new Date(Date.now() + 60000)});
  const authority = {schemaVersion: 1 as const, projectId: "project-a", commandId: command.id, action: "project.update" as const, inputDigest: command.inputDigest, projectLease: {leaseId: "lease-original", projectId: "project-a", fence: 1, expiresAt: command.expiresAt.getTime()}};
  const {profileId: _profile, ...base} = preparation;
  const receipt = {...base, action: "database.runtime", agentId: "agent-a", commandId: command.id, inputDigest: command.inputDigest, correlationId: command.correlationId, containerId: "c".repeat(64), imageId: "sha256:" + "d".repeat(64), volumeName: composeRuntimeResourceName("project-a", "volume", "db-" + preparation.databaseId), networkName: composeRuntimeResourceName("project-a", "network", "db-" + preparation.databaseId), networkId: "e".repeat(64), volumeCreatedAt: "2026-10-10T00:00:00Z", observedAt: Date.now() - 1000, status: "ready", health: "passed", storage: "verified", idempotent: false, redacted: true};
  f.controls.findProjectUpdatesByInputDigest.mockImplementation(async (...args: unknown[]) => args[1] === command.inputDigest ? [{...command, status: "completed", projectExecutionAuthority: authority}] as never : []);
  f.originalTransport.readReceipt.mockResolvedValue(receipt as never);
  Object.assign(f.controls, {findManagedDatabaseRemovals: async () => []});
  const source = (await f.call()).json().data.databases.find((entry: any) => entry.preparation.databaseId === preparation.databaseId).source;
  const removal = createControlCommand({actorId: "deleter", action: "project.update", scope: {kind: "project", projectId: "project-a"}, input: managedDatabaseDeleteExecutionBinding(source), idempotencyKey: "remove", correlationId: "remove", expiresAt: command.expiresAt});
  const nonce = createConfirmation({command: removal, classification: "destructive"});
  const {health: _health, idempotent: _idempotent, ...physical} = receipt;
  const completed = {...removal, status: "completed", projectExecutionAuthority: {...authority, commandId: removal.id, inputDigest: removal.inputDigest}, result: {...physical, action: "database.runtime.delete", profileId: preparation.profileId, commandId: removal.id, inputDigest: removal.inputDigest, correlationId: removal.correlationId, originalCommandId: command.id, originalStopCommandId: null, confirmationId: nonce.id, observedAt: Date.now(), status: "removed", storage: "retained"}};
  const history = vi.fn(async (_projectId: string) => [completed]);
  Object.assign(f.controls, {findManagedDatabaseRemovals: history});
  f.append.mockClear();
  return {...f, history, completed};
}
it("retires the exact original from inventory while preserving encrypted rows and history", async () => {
  const f = await readyInventory(), before = f.rows.map(row => ({...row, encryptedValue: Buffer.from(row.encryptedValue)}));
  const response = await f.call(); expect(response.statusCode).toBe(200); expect(response.json().data.databases).toHaveLength(4);
  expect(f.rows).toEqual(before); expect(f.history).toHaveBeenCalledTimes(2); expect(f.history).toHaveBeenCalledWith("project-a");
  expect(f.append).toHaveBeenCalledWith(expect.objectContaining({metadata: {databaseCount: 4, redacted: true}}));
});
it("requires retirement history for an existing original and rejects foreign history", async () => {
  for (const mode of ["missing", "foreign"]) {
    const f = await readyInventory();
    if (mode === "missing") Object.assign(f.controls, {findManagedDatabaseRemovals: undefined});
    else f.history.mockResolvedValue([{...f.completed, scope: {kind: "project", projectId: "foreign"}}]);
    expect((await f.call()).statusCode).toBe(503);
  }
});
it("withholds inventory when immutable retirement history changes during read audit", async () => {
  const f = await readyInventory(), append = f.append.getMockImplementation()!;
  f.append.mockImplementation(async input => {const result = await append(input); f.history.mockResolvedValue([]); return result;});
  expect((await f.call()).statusCode).toBe(503);
});
