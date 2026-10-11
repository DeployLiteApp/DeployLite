import {expect, it, vi} from "vitest";
import {readManagedDatabaseInventory} from "./managed-database-inventory";
function entry(engine: "postgres" | "mysql" | "mariadb" | "mongodb" | "redis" = "postgres") {
  const preparation = {schemaVersion: 1 as const, projectId: "project-a", databaseId: `orders_${engine}`, engine, profileId: `profile-${engine}`, planDigest: "a".repeat(64), environmentFingerprint: "b".repeat(32)};
  const {environmentFingerprint: _fingerprint, ...base} = preparation;
  const connection = {...base, availability: "planned", exposure: "internal", hostname: `db-${preparation.databaseId}`, networkName: `dl-${"1".repeat(32)}-net-db-${preparation.databaseId}`,
    port: {postgres: 5432, mysql: 3306, mariadb: 3306, mongodb: 27017, redis: 6379}[engine], databaseName: engine === "redis" ? "0" : preparation.databaseId,
    username: engine === "redis" ? "default" : "dl_123456789abc", authenticationDatabase: engine === "mongodb" ? "admin" : null};
  const {profileId: _profile, ...receiptBase} = preparation;
  const originalReceipt = {...receiptBase, action: "database.runtime", agentId: "agent-a", commandId: "create-a", inputDigest: "c".repeat(64), correlationId: "create-correlation",
    containerId: "d".repeat(64), imageId: `sha256:${"e".repeat(64)}`, networkId: "f".repeat(64), volumeName: `dl-${"1".repeat(32)}-vol-db-${preparation.databaseId}`,
    networkName: connection.networkName, volumeCreatedAt: "2026-01-01T00:00:00.000Z", observedAt: 1000, status: "ready", health: "passed", storage: "verified", idempotent: false, redacted: true};
  const source = {...preparation, originalReceipt, originalReplayFingerprint: "2".repeat(64)};
  const {health: _health, idempotent: _idem, ...physical} = originalReceipt;
  const originalStopReceipt = {...physical, action: "database.runtime.stop", status: "stopped", profileId: preparation.profileId, commandId: "stop-a", originalCommandId: "create-a",
    inputDigest: "3".repeat(64), correlationId: "stop-correlation", observedAt: 2000};
  const startPreparation = {...source, originalStopReceipt, originalStopReplayFingerprint: "4".repeat(64)};
  return {preparation, connection, source, startPreparation};
}
const response = (databases: unknown) => new Response(JSON.stringify({data: {databases}, error: null, requestId: "request-a"}));
const unavailable = {kind: "error", message: "Database inventory is unavailable."};
function fixture(databases: unknown = [entry()]) {
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response(databases));
  return {fetchImpl, options: {apiBaseUrl: "https://api.example.test", fetchImpl}};
}
it("reads all five configured engines through authenticated GET without body, command key or retries", async () => {
  const databases = (["postgres", "mysql", "mariadb", "mongodb", "redis"] as const).map(engine => ({...entry(engine), source: null, startPreparation: null}));
  const f = fixture(databases); expect(await readManagedDatabaseInventory("project-a", f.options)).toEqual({kind: "ready", databases});
  expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  const [url, init] = f.fetchImpl.mock.calls[0]!;
  expect(String(url)).toBe("https://api.example.test/api/v1/projects/project-a/databases");
  expect(init).toMatchObject({method: "GET", credentials: "include", redirect: "error", cache: "no-store"});
  expect(init).not.toHaveProperty("body"); expect(new Headers(init?.headers).has("idempotency-key")).toBe(false);
});
it("recovers public original creation and STOP controls without treating historical receipts as live health", async () => {
  const databases = [entry()], f = fixture(databases);
  expect(await readManagedDatabaseInventory("project-a", f.options)).toEqual({kind: "ready", databases});
});
it("returns a genuine empty server inventory without creating or preparing anything", async () => {
  const f = fixture([]); expect(await readManagedDatabaseInventory("project-a", f.options)).toEqual({kind: "ready", databases: []}); expect(f.fetchImpl).toHaveBeenCalledTimes(1);
});
it("rejects foreign project scope, duplicate identity and private fields generically", async () => {
  for (const databases of [[{...entry(), preparation: {...entry().preparation, projectId: "foreign"}}], [entry(), entry()],
    [{...entry(), password: "private-value"}], [{...entry(), source: {...entry().source, projectExecutionAuthority: {private: true}}}]]) {
    const f = fixture(databases); expect(await readManagedDatabaseInventory("project-a", f.options)).toEqual(unavailable);
  }
});
it("rejects detached internal connections instead of showing a different database target", async () => {
  for (const patch of [{projectId: "foreign"}, {engine: "redis"}, {profileId: "foreign"}, {port: 6379}, {hostname: "db-foreign"}, {databaseName: "foreign"}, {authenticationDatabase: "admin"}, {username: "https://private:user@foreign"}, {networkName: `dl-${"9".repeat(32)}-net-db-orders_postgres`}]) {
    const f = fixture([{...entry(), connection: {...entry().connection, ...patch}}]); expect(await readManagedDatabaseInventory("project-a", f.options)).toEqual(unavailable);
  }
});
it("requires original source agreement and safe historical clocks before exposing recovered START", async () => {
  for (const patch of [{source: null}, {source: {...entry().source, environmentFingerprint: "9".repeat(32)}},
    {startPreparation: {...entry().startPreparation, originalReplayFingerprint: "9".repeat(64)}},
    {source: {...entry().source, originalReceipt: {...entry().source.originalReceipt, observedAt: Number.MAX_SAFE_INTEGER + 1}}}]) {
    const f = fixture([{...entry(), ...patch}]); expect(await readManagedDatabaseInventory("project-a", f.options)).toEqual(unavailable);
  }
});
it("rejects invalid project, missing API and aborted requests before network access", async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  for (const [projectId, options] of [["../foreign", f.options], ["project-a", {...f.options, apiBaseUrl: null}], ["project-a", {...f.options, signal: controller.signal}]] as const)
    expect(await readManagedDatabaseInventory(projectId, options)).toEqual(unavailable);
  expect(f.fetchImpl).not.toHaveBeenCalled();
});
it("withholds malformed or rejected responses without reflecting details or automatically retrying", async () => {
  for (const reply of [new Response("private-value", {status: 401}), new Response("private-value"), new Response(JSON.stringify({data: {databases: []}, error: null, requestId: "request-a", cookie: "private-value"}))]) {
    const f = fixture(); f.fetchImpl.mockResolvedValue(reply);
    expect(await readManagedDatabaseInventory("project-a", f.options)).toEqual(unavailable); expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  }
});
