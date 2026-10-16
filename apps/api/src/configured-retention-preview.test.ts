import Fastify, {type FastifyRequest} from "fastify";
import {afterEach, expect, it, vi} from "vitest";
import {managedDatabaseBackupReceiptSchema, composeVolumeBackupReceiptSchema, type ManagedDatabaseEngineV1} from "@deploylite/contracts";
import {composeRuntimeResourceName, managedDatabaseNativeImagePolicy, parseManagedDatabaseRuntimeConfiguration, planManagedDatabaseProfile, type BackupInventoryRecord} from "@deploylite/domain";
import * as configuration from "./managed-database-runtime-configuration.js";
import {registerBackupRetentionPreviewRoute} from "./backup-retention-preview-route.js";
import {buildApiApp} from "./app.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {await Promise.all(apps.splice(0).map(app => app.close())); vi.restoreAllMocks();});
const engines = ["postgres", "mysql", "mariadb", "mongodb", "redis"] as const;
function fixture(engine: ManagedDatabaseEngineV1 = "postgres") {
  const paths = {postgres: "/var/lib/postgresql", mysql: "/var/lib/mysql", mariadb: "/var/lib/mysql", mongodb: "/data/db", redis: "/data"};
  const ports = {postgres: 5432, mysql: 3306, mariadb: 3306, mongodb: 27017, redis: 6379};
  const profiles = Object.fromEntries(engines.map(value => [value, {schemaVersion: 1, profileId: "profile-" + value, engine: value,
    image: `docker.io/library/${value}@sha256:${"a".repeat(64)}`, dataPath: paths[value], containerPort: ports[value],
    credentialKeys: ["DATABASE_PASSWORD"], backupStrategy: value === "redis" ? "volume-quiesced" : "engine-native"}]));
  const parsed = {configuration: parseManagedDatabaseRuntimeConfiguration(JSON.stringify({profiles, limits: {deadlineMs: 1000,
    backupMaxBytes: 10000, maxOutputBytes: 131072, maxContainers: 64, pollIntervalMs: 100, cpus: 1, memoryBytes: 536870912, pidsLimit: 256}}))!,
    bindings: [{projectId: "project-a", agentId: "agent-a"}]};
  const policy = managedDatabaseNativeImagePolicy(), profile = parsed.configuration.profiles[engine]!;
  const plan = planManagedDatabaseProfile({schemaVersion: 1, projectId: "project-a", databaseId: "orders", engine}, profile, policy);
  const formats = {postgres: "postgres-custom-gzip", mysql: "mysql-sql-gzip", mariadb: "mariadb-sql-gzip", mongodb: "mongodb-archive-gzip", redis: "volume-tar"};
  const consistency = {postgres: "native-snapshot", mysql: "global-read-lock", mariadb: "global-read-lock", mongodb: "quiesced-writes", redis: "all-consumers-stopped"};
  const native = managedDatabaseBackupReceiptSchema.parse({schemaVersion: 1, projectId: "project-a", databaseId: "orders", engine,
    profileId: profile.profileId, action: "database.runtime.backup", agentId: "agent-a", commandId: "backup-native", originalCommandId: "original-native",
    inputDigest: "a".repeat(64), planDigest: plan.planDigest, environmentFingerprint: "c".repeat(32), correlationId: "original-correlation",
    containerId: "d".repeat(64), imageId: "sha256:" + "e".repeat(64), volumeName: composeRuntimeResourceName("project-a", "volume", "db-orders"),
    networkName: composeRuntimeResourceName("project-a", "network", "db-orders"), networkId: "f".repeat(64), volumeCreatedAt: "2026-10-10T00:00:00Z",
    volumeKey: "db-orders", observedAt: 2, destinationId: "destination-a", sourceDigest: "a".repeat(64), archiveId: "backup_" + "b".repeat(32),
    archiveBytes: 2048, archiveSha256: "c".repeat(64), manifestSha256: "d".repeat(64), format: formats[engine], consistency: consistency[engine],
    status: "created", idempotent: false, storage: "verified", redacted: true});
  const compose = (archiveId: string, createdAtMs: number): BackupInventoryRecord => ({schemaVersion: 1, createdAtMs,
    receipt: composeVolumeBackupReceiptSchema.parse({schemaVersion: 1, action: "compose.volume.backup", agentId: "agent-a", commandId: "compose-" + archiveId,
      projectId: "project-a", inputDigest: "a".repeat(64), correlationId: "compose-correlation", volumeKey: "db-orders", destinationId: "destination-a",
      archiveId, archiveBytes: 1024, entries: 1, archiveSha256: "b".repeat(64), manifestSha256: "c".repeat(64), consistency: "stopped",
      status: "created", idempotent: false, redacted: true})});
  const oldId = "backup_" + "a".repeat(32);
  const rows: BackupInventoryRecord[] = [{schemaVersion: 1, createdAtMs: 1, receipt: {...native, archiveId: oldId, commandId: "old-native", observedAt: 1}}, {schemaVersion: 1, receipt: native, createdAtMs: 2}, compose("new-compose", 3)];
  const inventory = {available: vi.fn(() => true), list: vi.fn(async () => structuredClone(rows)), recordAuthenticatedReceipt: vi.fn()};
  const protection = {available: vi.fn(() => true), list: vi.fn(async () => [oldId]), protect: vi.fn()};
  const destination = {owner: "deploylite", agentId: "agent-a", projectId: "project-a", profileId: "destination-profile",
    destinationId: "destination-a", maxBytes: 10000, maxEntries: 100, maxDurationMs: 1000, planTtlMs: 1000};
  const planning = new Map([["project-a", {profiles: new Map([["destination-a", destination]]), store: {available: vi.fn(() => true)} as never}]]);
  const controls = {resolve: vi.fn(), complete: vi.fn(), findProjectUpdateByIdempotency: vi.fn(), findProjectUpdateById: vi.fn(),
    claimProjectUpdate: vi.fn(), validateProjectUpdateAuthority: vi.fn(), completeProjectUpdate: vi.fn(), resolveProjectUpdateConfirmation: vi.fn()};
  const secrets = {find: vi.fn(), createIfAbsent: vi.fn()};
  const project = {id: "project-a", name: "Fixture", repoUrl: "https://example.test/repo", defaultBranch: "main", buildCommand: null,
    runCommand: null, port: null, description: null, imageTag: null};
  const input = {parsed, projects: {findById: vi.fn(async () => project)}, controls, secrets,
    agent: {endpoint: "http://agent:4000", agentId: "agent-a", trustKey: "test-agent-key-" + "x".repeat(64)},
    backupInventory: vi.fn(() => inventory), restoreProtection: vi.fn(() => protection), backupPlanning: planning};
  return {input, rows, inventory, protection, controls, secrets, planning, destination, compose, native, oldId};
}
async function routeFixture(engine: ManagedDatabaseEngineV1 = "postgres") {
  const f = fixture(engine), configured = await configuration.createConfiguredManagedDatabaseApi(f.input);
  const access = Reflect.get(configured, "backupRetentionPreviews") as Parameters<typeof registerBackupRetentionPreviewRoute>[1]["access"];
  const grants = vi.fn(async () => [{id: "grant-a", actorId: "actor-a", action: "project.update" as const, scope: {kind: "project" as const, projectId: "project-a"}}]);
  const audit = {append: vi.fn(async (_event: unknown) => undefined)};
  const app = Fastify(); apps.push(app);
  registerBackupRetentionPreviewRoute(app, {prefix: "/api/v1", projects: f.input.projects as never, grants: {listForActor: grants}, audit: audit as never,
    access, requireAuth: async (request: FastifyRequest) => {Object.assign(request, {auth: {user: {id: "actor-a", role: "operator"}},
      correlationContext: {requestId: "request-a", correlationId: "correlation-a"}});}, requireRole: async () => {},
    ok: (_request, data) => ({data}), error: (_request, code) => ({error: {code}})});
  const body = {schemaVersion: 1, volumeKey: "db-orders", destinationId: "destination-a", keepNewest: 1};
  return {...f, configured, access, grants, audit, body, call: (payload: unknown = body) => app.inject({method: "POST",
    url: "/api/v1/projects/project-a/backups/retention/preview", payload: payload as Record<string, unknown>})};
}
it.each(engines)("composes %s count preview with the complete scoped union and protected old archive, without effects", async engine => {
  const f = await routeFixture(engine), before = structuredClone(f.rows), response = await f.call();
  expect(response.statusCode).toBe(200);
  expect(response.json().data.plan).toMatchObject({executionAllowed: false, keepNewest: 1,
    retainedArchiveIds: ["new-compose", f.oldId], protectedArchiveIds: [f.oldId], deletionCandidates: [{archiveId: f.native.archiveId}]});
  expect(f.rows).toEqual(before); expect(f.inventory.list).toHaveBeenCalledWith("project-a", "db-orders", "destination-a");
  expect(f.protection.list).toHaveBeenCalledWith("project-a", "db-orders", "destination-a");
  expect(f.audit.append).toHaveBeenCalledOnce();
  for (const effect of [f.secrets.find, f.secrets.createIfAbsent, f.inventory.recordAuthenticatedReceipt, f.protection.protect, f.controls.claimProjectUpdate]) expect(effect).not.toHaveBeenCalled();
});
it("does not compose native preview without all available inventory, protection and planning readers", async () => {
  for (const missing of ["inventory-list", "protection-list", "protection-available", "planning"] as const) {
    const f = fixture();
    if (missing === "inventory-list") Object.assign(f.inventory, {list: undefined});
    if (missing === "protection-list") Object.assign(f.protection, {list: undefined});
    if (missing === "protection-available") f.protection.available.mockReturnValue(false);
    const configured = await configuration.createConfiguredManagedDatabaseApi({...f.input, ...(missing === "planning" ? {backupPlanning: undefined} : {})});
    expect(configured).toHaveProperty("backupRetentionPreviews", new Map());
    expect(f.inventory.recordAuthenticatedReceipt).not.toHaveBeenCalled(); expect(f.protection.protect).not.toHaveBeenCalled();
  }
});
it.each([{backups: []}, {protectedArchiveIds: []}, {execute: true}, {keepNewest: 0}, {keepNewest: 10001}])("refuses caller authority or invalid count %#", async extra => {
  const f = await routeFixture(); expect((await f.call({...f.body, ...extra})).statusCode).toBe(400); expect(f.inventory.list).not.toHaveBeenCalled();
});
it.each(["volume", "destination", "agent", "profile", "planning", "project-set"])("withholds changed native %s before inventory/protection reads", async field => {
  const f = await routeFixture();
  if (field === "volume") f.body.volumeKey = "data";
  if (field === "destination") f.body.destinationId = "foreign";
  if (field === "agent") f.destination.agentId = "foreign";
  if (field === "planning") f.planning.clear();
  if (field === "project-set") Object.assign(f.configured.credentials, {projectIds: new Set<string>()});
  if (field === "profile") f.configured.credentials.profiles.get("postgres")!.image = "untrusted:latest";
  expect((await f.call()).statusCode).toBe(503); expect(f.inventory.list).not.toHaveBeenCalled(); expect(f.protection.list).not.toHaveBeenCalled();
});
it.each(["foreign-native", "foreign-compose", "detached-profile"])("rejects %s inventory instead of filtering the union", async field => {
  const f = await routeFixture();
  if (field === "detached-profile") f.native.planDigest = "f".repeat(64);
  else f.rows[field === "foreign-native" ? 1 : 2]!.receipt.agentId = "foreign";
  expect((await f.call()).statusCode).toBe(503); expect(f.audit.append).not.toHaveBeenCalledWith(expect.objectContaining({action: "backup.retention.preview"}));
});
it("withholds a protection snapshot that changes between reads", async () => {
  const f = await routeFixture(); f.protection.list.mockResolvedValueOnce([f.oldId]).mockResolvedValueOnce([]);
  expect((await f.call()).statusCode).toBe(409);
});
it.each(["grant", "destination", "profile", "protection-method"])("withholds post-audit native %s changes", async field => {
  const f = await routeFixture(); f.audit.append.mockImplementation(async event => {
    if ((event as {action: string}).action !== "backup.retention.preview") return;
    if (field === "grant") f.grants.mockResolvedValue([]);
    if (field === "destination") f.destination.maxBytes++;
    if (field === "profile") f.configured.credentials.profiles.get("postgres")!.profileId = "replaced";
    if (field === "protection-method") f.protection.list = vi.fn(async () => []);
  }); expect((await f.call()).statusCode).toBe(503);
});
it("wires configured previews into the real application while preserving explicit P3 project access", async () => {
  const f = fixture(), configured = await configuration.createConfiguredManagedDatabaseApi(f.input);
  const compose = vi.spyOn(configuration, "createConfiguredManagedDatabaseApi").mockResolvedValue(configured);
  const explicit = {agentId: "agent-a", inventory: {available: () => true, list: vi.fn(async () => [f.compose("explicit-p3", 1)])},
    protections: {available: () => true, list: vi.fn(async () => [])}, deadlineMs: 1000};
  const make = async (backupRetentionPreviews?: NonNullable<Parameters<typeof buildApiApp>[0]>["backupRetentionPreviews"], audit?: {append(event: unknown): Promise<unknown>}) => {
    const app = await buildApiApp({env: {NODE_ENV: "test", DEPLOYLITE_BCRYPT_COST: "10",
      DEPLOYLITE_MANAGED_DATABASE_RUNTIME: JSON.stringify(f.input.parsed.configuration),
      DEPLOYLITE_MANAGED_DATABASE_PROJECT_AGENTS_JSON: JSON.stringify(f.input.parsed.bindings)},
      auth: audit ? {audit: audit as never} : undefined, state: {projects: {findById: f.input.projects.findById, save: vi.fn(async (value: unknown) => value), list: vi.fn(async () => [])} as never, controlGrants: {listForActor: async actorId => [{id: "grant-admin", actorId, action: "project.update", scope: {kind: "project", projectId: "project-a"}}]}}, composeVolumeBackupPlans: f.planning, backupRetentionPreviews}); apps.push(app);
    const login = await app.inject({method: "POST", url: "/api/v1/auth/login", payload: {email: "admin@example.test", password: "deploylite-admin-password"}});
    expect(login.statusCode).toBe(200); const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    return app.inject({method: "POST", url: "/api/v1/projects/project-a/backups/retention/preview", headers: {cookie},
      payload: {schemaVersion: 1, volumeKey: "db-orders", destinationId: "destination-a", keepNewest: 1}});
  };
  expect((await make()).statusCode).toBe(200);
  expect(compose).toHaveBeenCalledWith(expect.objectContaining({backupPlanning: f.planning}));
  const response = await make(new Map([["project-a", explicit]])); expect(response.statusCode).toBe(200);
  expect(response.json().data.plan.retainedArchiveIds).toEqual(["explicit-p3"]); expect(explicit.inventory.list).toHaveBeenCalled();
  const injected = new Map([["project-a", explicit]]);
  const audit = {append: async (event: unknown): Promise<unknown> => {
    if ((event as {action: string}).action === "backup.retention.preview") injected.set("project-a", {...explicit, agentId: "replaced"});
    return undefined;
  }};
  expect((await make(injected, audit)).statusCode).toBe(503);
});

it("withholds protection data changed by the audit even when reader identity stays the same", async () => {
  const f = await routeFixture(); f.audit.append.mockImplementation(async event => {
    if ((event as {action: string}).action === "backup.retention.preview") f.protection.list.mockResolvedValue([]);
  }); expect((await f.call()).statusCode).toBe(409);
});

it("withholds inventory data changed by audit without rewriting the immutable input", async () => {
  const f = await routeFixture(); f.audit.append.mockImplementation(async event => {
    if ((event as {action: string}).action === "backup.retention.preview") f.rows[2]!.receipt.archiveSha256 = "e".repeat(64);
  }); expect((await f.call()).statusCode).toBe(409);
});

it("composes readonly count access without destructive-confirmation ports or restore activation", async () => {
  const f = fixture(); Reflect.deleteProperty(f.controls, "resolveProjectUpdateConfirmation");
  const configured = await configuration.createConfiguredManagedDatabaseApi(f.input);
  expect(configured.restorePreparations.size).toBe(0); expect(configured.restoreExecutions.size).toBe(0);
  expect([...configured.backupRetentionPreviews.keys()]).toEqual(["project-a"]);
  expect(configured.backupRetentionPreviews.get("project-a")!.protections).toBe(f.protection);
  expect(f.protection.protect).not.toHaveBeenCalled(); expect(f.inventory.list).not.toHaveBeenCalled(); expect(f.controls.claimProjectUpdate).not.toHaveBeenCalled();
});
