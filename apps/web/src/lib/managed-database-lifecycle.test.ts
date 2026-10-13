import { expect, it, vi } from "vitest";
import { applyManagedDatabase, prepareManagedDatabase, startManagedDatabase, stopManagedDatabase } from "./managed-database-lifecycle";
function fixture(engine: "postgres" | "mysql" | "mariadb" | "mongodb" | "redis" = "postgres") {
  const preparation = {schemaVersion: 1 as const, projectId: "project-a", databaseId: "orders", engine, profileId: "profile-a", planDigest: "a".repeat(64), environmentFingerprint: "b".repeat(32)};
  const receipt = {...preparation, action: "database.runtime" as const, agentId: "agent-a", commandId: "command-a", inputDigest: "c".repeat(64), correlationId: "create-correlation",
    containerId: "d".repeat(64), imageId: "sha256:" + "e".repeat(64), networkId: "f".repeat(64), volumeName: "dl-" + "1".repeat(32) + "-vol-db-orders",
    networkName: "dl-" + "1".repeat(32) + "-net-db-orders", volumeCreatedAt: "2026-01-01T00:00:00.000Z", observedAt: 1000,
    status: "ready" as const, health: "passed" as const, storage: "verified" as const, idempotent: false, redacted: true as const};
  const {profileId: _profile, ...originalReceipt} = receipt;
  const source = {...preparation, originalReceipt, originalReplayFingerprint: "2".repeat(64)};
  const {action: _action, status: _status, health: _health, ...runtime} = receipt;
  const {idempotent: _stopReplay, ...stopRuntime} = runtime;
  const stopped = {...stopRuntime, action: "database.runtime.stop", originalCommandId: "command-a", commandId: "stop-a", inputDigest: "3".repeat(64), correlationId: "stop-correlation", observedAt: 2000, status: "stopped"};
  const started = {...runtime, action: "database.runtime.start", originalCommandId: "command-a", originalStopCommandId: "stop-a", commandId: "start-a", inputDigest: "4".repeat(64), correlationId: "start-correlation", observedAt: 3000, status: "ready", health: "passed"};
  const startSource = {...source, originalStopReceipt: stopped, originalStopReplayFingerprint: "5".repeat(64)};
  const command = (value: Pick<typeof receipt, "commandId" | "projectId" | "inputDigest" | "correlationId">) => ({id: value.commandId, status: "completed", action: "project.update", scope: {kind: "project", projectId: value.projectId},
    inputDigest: value.inputDigest, idempotencyKey: "operation-a", correlationId: value.correlationId, expiresAt: "2026-01-01T00:00:00.000Z"});
  const response = (data: unknown) => new Response(JSON.stringify({data, error: null, requestId: "request-a"}));
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response({command: command(receipt), receipt: originalReceipt, applied: true, idempotent: false, originalReplayFingerprint: source.originalReplayFingerprint}));
  const connection = {...preparation, availability: "planned", exposure: "internal", hostname: "db-orders", networkName: receipt.networkName, port: {postgres: 5432, mysql: 3306, mariadb: 3306, mongodb: 27017, redis: 6379}[engine], databaseName: engine === "redis" ? "0" : "orders", username: "orders_owner", authenticationDatabase: engine === "mongodb" ? "admin" : null};
  const {environmentFingerprint: _fingerprint, ...publicConnection} = connection;
  return {preparation, receipt: originalReceipt, source, startSource, stopped, started, command, response, fetchImpl, options: {apiBaseUrl: "https://api.example.test", fetchImpl}, connection: publicConnection, plan: {...preparation, operation: "database.profile.preview", executionAllowed: false, image: "registry.example.test/" + engine + "@sha256:" + "e".repeat(64), containerPort: publicConnection.port, credentialKeys: ["DATABASE_PASSWORD"], backupStrategy: engine === "redis" ? "volume-quiesced" : "engine-native", volume: {key: "db-orders", runtimeName: receipt.volumeName, target: "/data"}, network: {key: "db-orders", runtimeName: receipt.networkName, internal: true}, policyVersion: "images-1"}};
}
it.each(["postgres", "mysql", "mariadb", "mongodb", "redis"] as const)("prepares %s credentials and public internal connection without exposing the private plan", async engine => {
  const f = fixture(engine), input = {schemaVersion: 1, projectId: "project-a", databaseId: "orders", engine};
  f.fetchImpl.mockResolvedValueOnce(f.response({credentials: {...input, secretRefId: "secret-a", credentialKey: "db-creds-orders", credentialsConfigured: true, redacted: true}}));
  f.fetchImpl.mockResolvedValueOnce(f.response({preparation: f.preparation, plan: Object.fromEntries(Object.entries(f.plan).filter(([key]) => key !== "environmentFingerprint")), connection: f.connection, credentialRef: {secretRefId: "secret-a", redacted: true}}));
  expect(await prepareManagedDatabase(input, f.options)).toEqual({kind: "ready", preparation: f.preparation, connection: f.connection});
  expect(f.fetchImpl).toHaveBeenCalledTimes(2);
});
it("creates only with an explicit stable key and returns the original public selector", async () => {
  const f = fixture(); expect(await applyManagedDatabase(f.preparation, f.options, "operation-a")).toEqual({kind: "ready", preparation: f.source});
  const init = f.fetchImpl.mock.calls[0]![1]!; expect(new Headers(init.headers).get("idempotency-key")).toBe("operation-a");
  expect(init).toMatchObject({credentials: "include", redirect: "error", cache: "no-store"});
});
it("uses STOP evidence to prepare START and preserves the original resource on START", async () => {
  const f = fixture(); f.fetchImpl.mockResolvedValueOnce(f.response({command: f.command(f.stopped), receipt: f.stopped, stopped: true, idempotent: false, originalStopReplayFingerprint: "5".repeat(64)}));
  expect(await stopManagedDatabase(f.source, f.options, "operation-a")).toEqual({kind: "ready", preparation: f.startSource});
  f.fetchImpl.mockResolvedValueOnce(f.response({command: f.command(f.started), receipt: f.started, ready: true, idempotent: false}));
  expect(await startManagedDatabase(f.startSource, f.options, "operation-a")).toEqual({kind: "ready", receipt: f.started});
});
it("rejects malformed inputs and keys before network", async () => {
  const f = fixture();
  for (const key of ["", "bad key", "x".repeat(201)]) expect((await applyManagedDatabase(f.preparation, f.options, key)).kind).toBe("error");
  expect((await applyManagedDatabase({...f.preparation, password: "private"}, f.options, "operation-a")).kind).toBe("error");
  expect((await prepareManagedDatabase({...f.preparation, databaseId: "../foreign"}, f.options)).kind).toBe("error");
  expect(f.fetchImpl).not.toHaveBeenCalled();
});
it("withholds foreign scope, private authority, missing selectors and unmatched command keys", async () => {
  const f = fixture();
  for (const patch of [{receipt: {...f.receipt, projectId: "foreign"}}, {originalReplayFingerprint: undefined},
    {command: {...f.command(f.receipt), projectExecutionAuthority: {private: true}}}, {command: {...f.command(f.receipt), idempotencyKey: "foreign"}},
    {command: {...f.command(f.receipt), inputDigest: "0".repeat(64)}}, {receipt: {...f.receipt, containerId: null}}]) {
    f.fetchImpl.mockResolvedValueOnce(f.response({command: f.command(f.receipt), receipt: f.receipt, applied: true, idempotent: false, originalReplayFingerprint: "2".repeat(64), ...patch}));
    expect(await applyManagedDatabase(f.preparation, f.options, "operation-a")).toEqual({kind: "error", message: "Database operation is unavailable."});
  }
});
it("does not retry an ambiguous effect automatically and permits an explicit identical key retry", async () => {
  const f = fixture(); f.fetchImpl.mockRejectedValueOnce(new Error("lost private reply"));
  expect((await applyManagedDatabase(f.preparation, f.options, "operation-a")).kind).toBe("error"); expect(f.fetchImpl).toHaveBeenCalledOnce();
  expect((await applyManagedDatabase(f.preparation, f.options, "operation-a")).kind).toBe("ready");
  expect(f.fetchImpl.mock.calls.map(call => new Headers(call[1]?.headers).get("idempotency-key"))).toEqual(["operation-a", "operation-a"]);
});

it("rejects unsafe STOP receipt time before exposing a START preparation", async () => {
  const f = fixture(), receipt = {...f.stopped, observedAt: 10000000000000000};
  f.fetchImpl.mockResolvedValueOnce(f.response({command: f.command(receipt), receipt, stopped: true, idempotent: false, originalStopReplayFingerprint: "5".repeat(64)}));
  expect(await stopManagedDatabase(f.source, f.options, "operation-a")).toEqual({kind: "error", message: "Database operation is unavailable."});
});
it("rejects foreign credential acknowledgements before requesting preview", async () => {
  const f = fixture(), input = {schemaVersion: 1, projectId: "project-a", databaseId: "orders", engine: "postgres"};
  f.fetchImpl.mockResolvedValueOnce(f.response({credentials: {...input, projectId: "foreign", secretRefId: "secret-a", credentialKey: "db-creds-orders", credentialsConfigured: true, redacted: true}}));
  expect((await prepareManagedDatabase(input, f.options)).kind).toBe("error"); expect(f.fetchImpl).toHaveBeenCalledOnce();
});
it("withholds private plans, foreign connections and detached secret references", async () => {
  const f = fixture(), input = {schemaVersion: 1, projectId: "project-a", databaseId: "orders", engine: "postgres"};
  const plan = Object.fromEntries(Object.entries(f.plan).filter(([key]) => key !== "environmentFingerprint"));
  for (const patch of [{plan: {...plan, password: "private"}}, {connection: {...f.connection, projectId: "foreign"}},
    {connection: {...f.connection, port: 1}}, {credentialRef: {secretRefId: "foreign", redacted: true}}]) {
    f.fetchImpl.mockResolvedValueOnce(f.response({credentials: {...input, secretRefId: "secret-a", credentialKey: "db-creds-orders", credentialsConfigured: true, redacted: true}}));
    f.fetchImpl.mockResolvedValueOnce(f.response({preparation: f.preparation, plan, connection: f.connection, credentialRef: {secretRefId: "secret-a", redacted: true}, ...patch}));
    expect(await prepareManagedDatabase(input, f.options)).toEqual({kind: "error", message: "Database operation is unavailable."});
  }
});
