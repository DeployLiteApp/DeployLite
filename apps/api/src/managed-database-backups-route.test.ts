import Fastify, {type FastifyReply, type FastifyRequest} from "fastify";
import {afterEach, expect, it, vi} from "vitest";
import {composeVolumeBackupReceiptSchema, managedDatabaseBackupReceiptSchema, type ManagedDatabaseEngineV1} from "@deploylite/contracts";
import {composeRuntimeResourceName, type BackupInventoryRecord} from "@deploylite/domain";
import {registerManagedDatabaseBackupsRoute} from "./managed-database-backups-route.js";
import {buildApiApp} from "./app.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {await Promise.all(apps.splice(0).map(app => app.close()));});
const engines = ["postgres", "mysql", "mariadb", "mongodb", "redis"] as const;
function receipt(engine: ManagedDatabaseEngineV1) {
  const formats = {postgres: "postgres-custom-gzip", mysql: "mysql-sql-gzip", mariadb: "mariadb-sql-gzip", mongodb: "mongodb-archive-gzip", redis: "volume-tar"};
  const consistency = {postgres: "native-snapshot", mysql: "global-read-lock", mariadb: "global-read-lock", mongodb: "quiesced-writes", redis: "all-consumers-stopped"};
  return managedDatabaseBackupReceiptSchema.parse({schemaVersion: 1, projectId: "project-a", databaseId: "orders", engine,
    profileId: "profile-" + engine, action: "database.runtime.backup", agentId: "agent-a", commandId: "backup-" + engine,
    originalCommandId: "original-" + engine, inputDigest: "a".repeat(64), planDigest: "b".repeat(64), environmentFingerprint: "c".repeat(32),
    correlationId: "original-backup-correlation", containerId: "d".repeat(64), imageId: "sha256:" + "e".repeat(64),
    volumeName: composeRuntimeResourceName("project-a", "volume", "db-orders"), networkName: composeRuntimeResourceName("project-a", "network", "db-orders"),
    networkId: "f".repeat(64), volumeCreatedAt: "2026-10-10T00:00:00Z", volumeKey: "db-orders", observedAt: 2000,
    destinationId: "destination-a", sourceDigest: "a".repeat(64), archiveId: "backup_" + "b".repeat(32), archiveBytes: 2048,
    archiveSha256: "c".repeat(64), manifestSha256: "d".repeat(64), format: formats[engine], consistency: consistency[engine],
    status: "created", idempotent: false, storage: "verified", redacted: true});
}
function fixture(engine: ManagedDatabaseEngineV1 = "postgres", settings: {anonymous?: boolean; readOnly?: boolean; denied?: boolean} = {}) {
  const app = Fastify(); apps.push(app);
  const rows: BackupInventoryRecord[] = [{schemaVersion: 1, receipt: receipt(engine), createdAtMs: 2001}];
  const inventory = {available: vi.fn(() => true), list: vi.fn(async (_project: string, _volume: string, _destination: string) => structuredClone(rows))};
  const profile = {owner: "deploylite", agentId: "agent-a", projectId: "project-a", profileId: "destination-profile",
    destinationId: "destination-a", maxBytes: 10000, maxEntries: 100, maxDurationMs: 1000, planTtlMs: 1000};
  const execution = {agentId: "agent-a", inventory, now: () => 3000, maxBytes: 8000, deadlineMs: 1000};
  const planning = {profiles: new Map([[profile.destinationId, profile]]), store: {available: vi.fn(() => true)}};
  const grants = vi.fn(async () => settings.denied ? [] : [{id: "grant-a", actorId: "operator-a", action: "project.update" as const, scope: {kind: "project" as const, projectId: "project-a"}}]);
  const projects = vi.fn(async (id: string) => ({id, name: "Fixture", repoUrl: "https://example.test/repo", defaultBranch: "main",
    buildCommand: null, runCommand: null, port: null, description: null, imageTag: null}));
  const append = vi.fn(async (_event: unknown) => undefined);
  const options = {prefix: "/api/v1", executions: new Map([["project-a", execution]]), planning: new Map([["project-a", planning]]),
    projects: {findById: projects}, grants: {listForActor: grants}, audit: {append},
    requireAuth: async (request: FastifyRequest, reply: FastifyReply) => {if (settings.anonymous) return reply.code(401).send({error: "unauthenticated"});
      Object.assign(request, {auth: {user: {id: "operator-a", role: "operator"}}, correlationContext: {requestId: "backups-request", correlationId: "backups-correlation"}});},
    requireRole: async (_request: FastifyRequest, reply: FastifyReply) => {if (settings.readOnly) return reply.code(403).send({error: "forbidden"});},
    ok: (_request: unknown, data: unknown) => ({data}), error: (_request: unknown, code: string) => ({error: {code}})};
  registerManagedDatabaseBackupsRoute(app, options);
  return {app, options, rows, inventory, grants, projects, append, execution, planning, profile,
    call: (query = "") => app.inject({method: "GET", url: "/api/v1/projects/project-a/databases/orders/backups" + query})};
}
it("returns only explicit public destination IDs and intersected byte limits before selection", async () => {
  const f = fixture(), response = await f.call();
  expect(response.statusCode).toBe(200);
  expect(response.json().data).toEqual({destinations: [{destinationId: "destination-a", maxBytes: 8000}], backups: []});
  expect(f.inventory.list).not.toHaveBeenCalled();
  expect(response.body).not.toMatch(/privatePath|sourceRoots|encryptedValue|password|authority/i);
});
it.each(engines)("reads immutable scoped %s backup evidence with one correlated read audit", async engine => {
  const f = fixture(engine), before = structuredClone(f.rows), response = await f.call("?destinationId=destination-a");
  expect(response.statusCode).toBe(200);
  expect(response.json().data.backups).toEqual(before);
  expect(f.inventory.list).toHaveBeenCalledWith("project-a", "db-orders", "destination-a");
  expect(f.rows).toEqual(before);
  expect(f.append).toHaveBeenCalledOnce();
  expect(f.append).toHaveBeenCalledWith(expect.objectContaining({action: "database.backups.read", targetId: "project-a",
    requestId: "backups-request", correlationId: "backups-correlation", metadata: {destinationId: "destination-a", backupCount: 1, redacted: true}}));
});
it("rejects clock arithmetic beyond the safe integer range before private reads", async () => {
  const f = fixture(); f.execution.now = () => Number.MAX_SAFE_INTEGER;
  expect((await f.call("?destinationId=destination-a")).statusCode).toBe(503);
  expect(f.inventory.list).not.toHaveBeenCalled(); expect(f.append).not.toHaveBeenCalled();
});
it("requires session role and current grant before private project or inventory reads", async () => {
  for (const settings of [{anonymous: true}, {readOnly: true}, {denied: true}]) {
    const f = fixture("postgres", settings);
    expect((await f.call("?destinationId=destination-a")).statusCode).toBe(settings.anonymous ? 401 : 403);
    expect(f.projects).not.toHaveBeenCalled(); expect(f.inventory.list).not.toHaveBeenCalled(); expect(f.append).not.toHaveBeenCalled();
  }
});
it("rejects unconfigured and private selectors without returning configuration or reading inventory", async () => {
  const f = fixture();
  for (const query of ["?password=private", "?includeSecrets=true", "?projectId=foreign", "?destinationId=../../private"]) {
    expect((await f.call(query)).statusCode).toBe(400);
  }
  expect((await f.call("?destinationId=foreign")).statusCode).toBe(503);
  expect(f.inventory.list).not.toHaveBeenCalled(); expect(f.append).not.toHaveBeenCalled();
});
it("refuses foreign destination owners agents and unavailable inventory before its private read", async () => {
  for (const mode of ["owner", "agent", "project", "unavailable", "disabled"]) {
    const f = fixture();
    if (mode === "owner") f.profile.owner = "foreign";
    if (mode === "agent") f.profile.agentId = "foreign";
    if (mode === "project") f.profile.projectId = "foreign";
    if (mode === "unavailable") f.inventory.available.mockReturnValue(false);
    if (mode === "disabled") f.execution.maxBytes = 0;
    expect((await f.call("?destinationId=destination-a")).statusCode).toBe(503);
    expect(f.inventory.list).not.toHaveBeenCalled(); expect(f.append).not.toHaveBeenCalled();
  }
});
it("withholds corrupt foreign duplicate and future stored evidence instead of dropping records", async () => {
  for (const mode of ["scope", "agent", "duplicate", "future", "private"]) {
    const f = fixture();
    if (mode === "scope") f.rows[0]!.receipt = {...managedDatabaseBackupReceiptSchema.parse(f.rows[0]!.receipt), databaseId: "foreign"};
    if (mode === "agent") f.rows[0]!.receipt.agentId = "foreign";
    if (mode === "duplicate") f.rows.push(structuredClone(f.rows[0]!));
    if (mode === "future") f.rows[0]!.createdAtMs = 3001;
    if (mode === "private") Object.assign(f.rows[0]!.receipt, {privatePath: "private-sentinel"});
    const response = await f.call("?destinationId=destination-a"); expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("private-sentinel"); expect(f.append).not.toHaveBeenCalled();
  }
});
it("withholds evidence when inventory changes after its single read audit", async () => {
  const f = fixture(); f.append.mockImplementation(async () => {f.rows[0]!.receipt.archiveSha256 = "e".repeat(64);});
  expect((await f.call("?destinationId=destination-a")).statusCode).toBe(503); expect(f.append).toHaveBeenCalledOnce();
});
it("refuses lost grants or substituted inventory methods across the private await", async () => {
  for (const mode of ["grant", "reader", "profile"]) {
    const f = fixture(); const original = structuredClone(f.rows);
    f.inventory.list.mockImplementationOnce(async () => {
      if (mode === "grant") f.grants.mockResolvedValue([]);
      if (mode === "reader") f.inventory.list = vi.fn(async () => original);
      if (mode === "profile") f.profile.maxBytes--;
      return original;
    });
    expect((await f.call("?destinationId=destination-a")).statusCode).toBe(503); expect(f.append).not.toHaveBeenCalled();
  }
});
it("does not return success when the correlated audit cannot be persisted", async () => {
  const f = fixture(); f.append.mockRejectedValue(new Error("private-audit-sentinel"));
  const response = await f.call("?destinationId=destination-a"); expect(response.statusCode).toBe(503);
  expect(response.body).not.toContain("private-audit-sentinel"); expect(f.append).toHaveBeenCalledOnce();
});
it("registers the real API metadata route behind authentication without enabling any runtime", async () => {
  const app = await buildApiApp({env: {NODE_ENV: "test"}, authConfig: {cookieName: "backup_view_fixture", cookieSecure: false, sessionTtlSeconds: 60}});
  apps.push(app);
  expect((await app.inject({method: "GET", url: "/api/v1/projects/project-a/databases/orders/backups"})).statusCode).toBe(401);
});
it("bounds a stalled inventory read without publishing metadata or an accepted read audit", async () => {
  const f = fixture(); f.execution.deadlineMs = 5;
  f.inventory.list.mockImplementation(() => new Promise(() => {}));
  expect((await f.call("?destinationId=destination-a")).statusCode).toBe(503);
  expect(f.inventory.list).toHaveBeenCalledOnce(); expect(f.append).not.toHaveBeenCalled();
});
function legacyRecord(): BackupInventoryRecord {
  return {schemaVersion: 1, createdAtMs: 2001, receipt: composeVolumeBackupReceiptSchema.parse({schemaVersion: 1,
    action: "compose.volume.backup", agentId: "agent-a", commandId: "legacy-backup", projectId: "project-a", inputDigest: "a".repeat(64),
    correlationId: "legacy-correlation", volumeKey: "db-orders", destinationId: "destination-a", archiveId: "legacy-archive",
    status: "created", consistency: "stopped", archiveBytes: 1024, entries: 1, archiveSha256: "b".repeat(64), manifestSha256: "c".repeat(64),
    idempotent: false, redacted: true})};
}
it("preserves legitimate Compose history while selecting only native engine backups", async () => {
  const f = fixture(), native = structuredClone(f.rows); f.rows.push(legacyRecord()); const before = structuredClone(f.rows);
  const response = await f.call("?destinationId=destination-a"); expect(response.statusCode).toBe(200);
  expect(response.json().data.backups).toEqual(native); expect(f.rows).toEqual(before); expect(f.append).toHaveBeenCalledOnce();
});
it("rejects foreign Compose history instead of hiding corrupt input behind the native projection", async () => {
  const f = fixture(), legacy = legacyRecord(); legacy.receipt.projectId = "foreign"; f.rows.push(legacy);
  expect((await f.call("?destinationId=destination-a")).statusCode).toBe(503); expect(f.append).not.toHaveBeenCalled();
});
it("fences the complete inventory even when only the legacy Compose evidence changes", async () => {
  const f = fixture(), legacy = legacyRecord(); f.rows.push(legacy);
  f.append.mockImplementation(async () => {legacy.receipt.archiveSha256 = "e".repeat(64);});
  expect((await f.call("?destinationId=destination-a")).statusCode).toBe(503); expect(f.append).toHaveBeenCalledOnce();
});
