import {expect, it, vi} from "vitest";
import {managedDatabaseBackupReceiptSchema, managedDatabaseHealthPreparationSchema, type ManagedDatabaseEngineV1} from "@deploylite/contracts";
import {backupManagedDatabase, readManagedDatabaseBackups} from "./managed-database-backup";
const engines = ["postgres", "mysql", "mariadb", "mongodb", "redis"] as const;
function fixture(engine: ManagedDatabaseEngineV1 = "postgres") {
  const now = Date.now(), base = {schemaVersion: 1, projectId: "project-a", databaseId: "orders", engine, profileId: "profile-a",
    planDigest: "a".repeat(64), environmentFingerprint: "b".repeat(32)};
  const {profileId: _profile, ...runtime} = base;
  const original = {...runtime, action: "database.runtime", agentId: "agent-a", commandId: "original-a", inputDigest: "c".repeat(64),
    correlationId: "original-correlation", containerId: "d".repeat(64), imageId: "sha256:" + "e".repeat(64),
    volumeName: "dl-" + "1".repeat(32) + "-vol-db-orders", networkName: "dl-" + "1".repeat(32) + "-net-db-orders",
    networkId: "f".repeat(64), volumeCreatedAt: new Date(now - 3000).toISOString(), observedAt: now - 2000,
    status: "ready", health: "passed", storage: "verified", idempotent: false, redacted: true};
  const source = managedDatabaseHealthPreparationSchema.parse({...base, originalReceipt: original, originalReplayFingerprint: "2".repeat(64)});
  const formats = {postgres: "postgres-custom-gzip", mysql: "mysql-sql-gzip", mariadb: "mariadb-sql-gzip", mongodb: "mongodb-archive-gzip", redis: "volume-tar"};
  const consistency = {postgres: "native-snapshot", mysql: "global-read-lock", mariadb: "global-read-lock", mongodb: "quiesced-writes", redis: "all-consumers-stopped"};
  const receipt = managedDatabaseBackupReceiptSchema.parse({...base, action: "database.runtime.backup", agentId: "agent-a", commandId: "backup-a",
    originalCommandId: original.commandId, inputDigest: "3".repeat(64), correlationId: "backup-correlation", containerId: original.containerId,
    imageId: original.imageId, volumeName: original.volumeName, networkName: original.networkName, networkId: original.networkId,
    volumeCreatedAt: original.volumeCreatedAt, volumeKey: "db-orders", destinationId: "destination-a", sourceDigest: "4".repeat(64),
    archiveId: "backup_" + "5".repeat(32), archiveBytes: 2048, archiveSha256: "6".repeat(64), manifestSha256: "7".repeat(64),
    format: formats[engine], consistency: consistency[engine], observedAt: now - 1000, status: "created", idempotent: false, storage: "verified", redacted: true});
  const inventory = {schemaVersion: 1, receipt, createdAtMs: now - 999};
  const preparation = {...source, destinationId: "destination-a", maxBytes: 4096};
  const command = {id: receipt.commandId, action: "project.update", status: "completed", scope: {kind: "project", projectId: base.projectId},
    inputDigest: receipt.inputDigest, correlationId: receipt.correlationId, idempotencyKey: "backup-key", expiresAt: new Date(now + 60000).toISOString()};
  const response = (data: unknown) => new Response(JSON.stringify({data, error: null, requestId: "backup-request"}));
  const outcome = {command, receipt, inventory, originalBackupReplayFingerprint: "8".repeat(64), backupCreated: true, idempotent: false};
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response(outcome));
  return {source, preparation, receipt, inventory, command, outcome, response, fetchImpl,
    options: {apiBaseUrl: "https://api.example.test", actorId: "operator-a", fetchImpl}};
}
it.each(engines)("confirms one original source-bound manual %s backup without transporting archive bytes", async engine => {
  const f = fixture(engine), result = await backupManagedDatabase(f.preparation, f.options, "backup-key");
  expect(result).toMatchObject({kind: "ready", receipt: f.receipt, inventory: f.inventory, originalBackupReplayFingerprint: "8".repeat(64)});
  expect(f.fetchImpl).toHaveBeenCalledOnce();
  const [url, init] = f.fetchImpl.mock.calls[0]!;
  expect(String(url)).toBe("https://api.example.test/api/v1/projects/project-a/databases/orders/runtime/backup");
  expect(new Headers(init!.headers).get("x-deploylite-expected-actor-id")).toBe("operator-a");
  expect(new Headers(init!.headers).get("idempotency-key")).toBe("backup-key");
  const {projectId: _project, databaseId: _database, ...body} = f.preparation;
  expect(JSON.parse(String(init!.body))).toEqual(body);
  expect(String(init!.body)).not.toMatch(/privatePath|archiveBytes|sealedEnvironment|password/i);
});
it("reads scoped public destinations and immutable inventory using only a bodyless authenticated GET", async () => {
  const f = fixture(); f.fetchImpl.mockImplementation(async () => f.response({destinations: [{destinationId: "destination-a", maxBytes: 4096}], backups: [f.inventory]}));
  expect(await readManagedDatabaseBackups({projectId: "project-a", databaseId: "orders"}, f.options, "destination-a"))
    .toMatchObject({kind: "ready", destinations: [{destinationId: "destination-a", maxBytes: 4096}], backups: [f.inventory]});
  const [url, init] = f.fetchImpl.mock.calls[0]!;
  expect(String(url)).toBe("https://api.example.test/api/v1/projects/project-a/databases/orders/backups?destinationId=destination-a");
  expect(init).toMatchObject({method: "GET", credentials: "include", cache: "no-store"});
  expect(init!.body).toBeUndefined(); expect(new Headers(init!.headers).has("idempotency-key")).toBe(false);
  expect(new Headers(init!.headers).get("x-deploylite-expected-actor-id")).toBe("operator-a");
});
it("retains the caller's original key and receipt when an explicit retry recovers an unknown response", async () => {
  const f = fixture(); f.fetchImpl.mockRejectedValueOnce(new Error("private transport sentinel"));
  expect(await backupManagedDatabase(f.preparation, f.options, "backup-key")).toEqual({kind: "error", message: "Backup could not be confirmed."});
  expect(f.fetchImpl).toHaveBeenCalledOnce();
  f.fetchImpl.mockImplementation(async () => f.response({...f.outcome, idempotent: true}));
  expect(await backupManagedDatabase(f.preparation, f.options, "backup-key")).toMatchObject({kind: "ready", receipt: f.receipt, idempotent: true});
  expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  for (const [, init] of f.fetchImpl.mock.calls) expect(new Headers(init!.headers).get("idempotency-key")).toBe("backup-key");
});
it("rejects detached command source resource budget audit and inventory evidence", async () => {
  for (const mode of ["key", "command", "digest", "correlation", "project", "original", "container", "destination", "budget", "inventory", "future", "private"]) {
    const f = fixture(), data = structuredClone(f.outcome);
    data.inventory = {...data.inventory, receipt: structuredClone(data.inventory.receipt)};
    if (mode === "key") data.command.idempotencyKey = "foreign";
    if (mode === "command") data.command.id = "foreign";
    if (mode === "digest") data.command.inputDigest = "a".repeat(64);
    if (mode === "correlation") data.command.correlationId = "foreign";
    if (mode === "project") data.command.scope.projectId = "foreign";
    if (mode === "original") data.receipt.originalCommandId = "foreign";
    if (mode === "container") data.receipt.containerId = "a".repeat(64);
    if (mode === "destination") data.receipt.destinationId = "foreign";
    if (mode === "budget") data.receipt.archiveBytes = 4097;
    if (mode === "inventory") data.inventory.receipt.archiveSha256 = "a".repeat(64);
    if (mode === "future") data.inventory.createdAtMs = Date.now() + 60000;
    if (mode === "private") Object.assign(data.command, {executionAuthority: {secret: "private-sentinel"}});
    f.fetchImpl.mockImplementation(async () => f.response(data));
    expect(await backupManagedDatabase(f.preparation, f.options, "backup-key")).toEqual({kind: "error", message: "Backup could not be confirmed."});
    expect(f.fetchImpl).toHaveBeenCalledOnce();
  }
});
it("refuses invalid actors keys private inputs and already cancelled callers before any RPC", async () => {
  for (const mode of ["actor", "key", "private", "cancelled"]) {
    const f = fixture(), controller = new AbortController();
    if (mode === "cancelled") controller.abort();
    if (mode === "actor") f.options.actorId = "../foreign";
    if (mode === "private") Object.assign(f.preparation, {sealedEnvironment: "private-sentinel"});
    expect(await backupManagedDatabase(f.preparation, {...f.options, signal: controller.signal}, mode === "key" ? "bad key" : "backup-key"))
      .toEqual({kind: "error", message: "Backup could not be confirmed."});
    expect(f.fetchImpl).not.toHaveBeenCalled();
  }
});
it("snapshots source and actor before the await so caller substitutions cannot redirect the request", async () => {
  const f = fixture();
  f.fetchImpl.mockImplementation(async () => {f.preparation.destinationId = "foreign"; f.options.actorId = "foreign"; return f.response(f.outcome);});
  expect(await backupManagedDatabase(f.preparation, f.options, "backup-key")).toMatchObject({kind: "ready", receipt: f.receipt});
  const [, init] = f.fetchImpl.mock.calls[0]!;
  expect(new Headers(init!.headers).get("x-deploylite-expected-actor-id")).toBe("operator-a");
  expect(JSON.parse(String(init!.body)).destinationId).toBe("destination-a");
});
it("refuses duplicate detached future or private metadata instead of silently discarding records", async () => {
  for (const mode of ["duplicate", "scope", "destination", "future", "private"]) {
    const f = fixture(), view = {destinations: [{destinationId: "destination-a", maxBytes: 4096}], backups: [structuredClone(f.inventory)]};
    if (mode === "duplicate") view.backups.push(structuredClone(view.backups[0]!));
    if (mode === "scope") view.backups[0]!.receipt.databaseId = "foreign";
    if (mode === "destination") view.backups[0]!.receipt.destinationId = "foreign";
    if (mode === "future") view.backups[0]!.createdAtMs = Date.now() + 60000;
    if (mode === "private") Object.assign(view.backups[0]!, {privatePath: "private-sentinel"});
    f.fetchImpl.mockImplementation(async () => f.response(view));
    expect(await readManagedDatabaseBackups({projectId: "project-a", databaseId: "orders"}, f.options, "destination-a"))
      .toEqual({kind: "error", message: "Backups are unavailable."});
    expect(f.fetchImpl).toHaveBeenCalledOnce();
  }
});
