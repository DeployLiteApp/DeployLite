import { expect, it, vi } from "vitest";
import { readManagedDatabaseTelemetry } from "./managed-database-telemetry";
function fixture() {
  const preparation = {schemaVersion: 1 as const, projectId: "project-a", databaseId: "orders", engine: "postgres" as const,
    profileId: "profile-a", planDigest: "a".repeat(64), environmentFingerprint: "b".repeat(32), originalReplayFingerprint: "c".repeat(64),
    originalReceipt: {schemaVersion: 1 as const, projectId: "project-a", databaseId: "orders", engine: "postgres" as const, action: "database.runtime" as const,
      agentId: "agent-a", commandId: "command-a", inputDigest: "d".repeat(64), planDigest: "a".repeat(64), environmentFingerprint: "b".repeat(32),
      correlationId: "create-correlation", containerId: "e".repeat(64), imageId: "sha256:" + "f".repeat(64), networkId: "1".repeat(64),
      volumeName: "dl-" + "2".repeat(32) + "-vol-db-orders", networkName: "dl-" + "2".repeat(32) + "-net-db-orders",
      volumeCreatedAt: "2026-01-01T00:00:00.000Z", observedAt: 1000, status: "ready" as const, health: "passed" as const,
      storage: "verified" as const, idempotent: false, redacted: true as const}};
  const {commandId, inputDigest: _digest, correlationId: _correlation, status: _status, health: _health, idempotent: _idempotent, ...scope} = preparation.originalReceipt;
  const observation = {...scope, action: "database.runtime.health", originalCommandId: commandId, profileId: "profile-a",
    context: {requestId: "query-a", correlationId: "query-correlation"}, observedAt: 2000, state: "running", health: "healthy", uid: 999};
  const response = (value: unknown) => new Response(JSON.stringify({data: {observation: value}, error: null, requestId: "query-a"}), {headers: {"content-type": "application/json"}});
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response(observation));
  const options = {preparation, apiBaseUrl: "https://api.example.test", fetchImpl};
  return {options, observation, response, fetchImpl};
}
it("reads health for the original scope using the authenticated readonly endpoint", async () => {
  const f = fixture(); expect(await readManagedDatabaseTelemetry("health", f.options)).toEqual({kind: "ready", observation: f.observation});
  expect(f.fetchImpl).toHaveBeenCalledWith(new URL("https://api.example.test/api/v1/projects/project-a/databases/orders/runtime/health"), expect.objectContaining({method: "POST", credentials: "include", redirect: "error", cache: "no-store"}));
  const init = f.fetchImpl.mock.calls[0]![1] as RequestInit;
  expect(new Headers(init.headers).has("idempotency-key")).toBe(false);
  expect(JSON.parse(init.body as string)).not.toHaveProperty("projectId");
});
it("accepts stopped metrics absence and retained logs with explicit tail and UTC selection", async () => {
  const f = fixture(), stopped = {...f.observation, state: "stopped", health: "not-running", uid: null};
  const metrics = {...stopped, action: "database.runtime.metrics", metrics: null, metricsObservedAt: null};
  f.fetchImpl.mockResolvedValueOnce(f.response(metrics));
  expect(await readManagedDatabaseTelemetry("metrics", f.options)).toEqual({kind: "ready", observation: metrics});
  const logs = {...stopped, action: "database.runtime.logs", logs: {stdout: "old retained log\n", stderr: "", redacted: true}, logsObservedAt: 1999};
  f.fetchImpl.mockResolvedValueOnce(f.response(logs));
  const selection = {tail: 100, since: "1970-01-01T00:00:00.500Z"};
  expect(await readManagedDatabaseTelemetry("logs", f.options, selection)).toEqual({kind: "ready", observation: logs});
});
it("rejects missing configuration, invalid sources and selections before network", async () => {
  const f = fixture();
  for (const options of [{...f.options, apiBaseUrl: null}, {...f.options, preparation: {...f.options.preparation, originalReplayFingerprint: "private"}}])
    expect((await readManagedDatabaseTelemetry("health", options)).kind).toBe("error");
  for (const selection of [{tail: -1}, {tail: 5001}, {tail: 100, since: "yesterday"}, {tail: 100, since: "2999-01-01T00:00:00.000Z"}, {tail: 100, password: "private"}])
    expect((await readManagedDatabaseTelemetry("logs", f.options, selection)).kind).toBe("error");
  expect(f.fetchImpl).not.toHaveBeenCalled();
});
it("withholds detached, private, cross-action and malformed observations", async () => {
  const f = fixture();
  for (const patch of [{projectId: "foreign"}, {containerId: "f".repeat(64)}, {profileId: "foreign"}, {originalCommandId: "foreign"},
    {observedAt: 999}, {password: "private"}, {action: "database.runtime.metrics"}, {uid: 0}, {context: {requestId: "foreign", correlationId: "query-correlation"}}]) {
    f.fetchImpl.mockResolvedValueOnce(f.response({...f.observation, ...patch}));
    expect((await readManagedDatabaseTelemetry("health", f.options)).kind).toBe("error");
  }
});
it("returns only a generic failure for rejected or malformed responses", async () => {
  const f = fixture();
  for (const response of [new Response("private failure", {status: 503}), new Response("not JSON"), new Response(JSON.stringify({private: "payload"}))]) {
    f.fetchImpl.mockResolvedValueOnce(response);
    expect(await readManagedDatabaseTelemetry("health", f.options)).toEqual({kind: "error", message: "Database observation is unavailable."});
  }
  f.fetchImpl.mockRejectedValueOnce(new Error("private transport failure"));
  expect(await readManagedDatabaseTelemetry("health", f.options)).toEqual({kind: "error", message: "Database observation is unavailable."});
});
it("refuses cancelled requests and bounds response bytes", async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  expect((await readManagedDatabaseTelemetry("health", {...f.options, signal: controller.signal})).kind).toBe("error"); expect(f.fetchImpl).not.toHaveBeenCalled();
  f.fetchImpl.mockResolvedValueOnce(new Response("x".repeat(2097153)));
  expect((await readManagedDatabaseTelemetry("health", f.options)).kind).toBe("error");
});

it("cancels stalled fetch and body ports without waiting for their cooperation", async () => {
  for (const body of [false, true]) {
    const f = fixture(), controller = new AbortController();
    if (body) f.fetchImpl.mockResolvedValueOnce(new Response(new ReadableStream({pull: () => new Promise(() => {})})));
    else f.fetchImpl.mockImplementationOnce(() => new Promise(() => {}));
    const reading = readManagedDatabaseTelemetry("health", {...f.options, signal: controller.signal});
    await new Promise<void>(resolve => setImmediate(resolve)); controller.abort();
    expect(await reading).toEqual({kind: "error", message: "Database observation is unavailable."});
  }
});
it("withholds invalid UTF8 and oversized declared content without rendering bytes", async () => {
  const f = fixture();
  for (const response of [new Response(new Uint8Array([255])), new Response("private", {headers: {"content-length": "2097153"}}),
    new Response("private", {headers: {"content-length": "-1"}})]) {
    f.fetchImpl.mockResolvedValueOnce(response);
    expect((await readManagedDatabaseTelemetry("health", f.options)).kind).toBe("error");
  }
});
it("withholds unredacted or oversized log batches and invalid live metrics", async () => {
  const f = fixture();
  for (const logs of [{stdout: "private", stderr: "", redacted: false}, {stdout: "x".repeat(1048577), stderr: "", redacted: true}]) {
    f.fetchImpl.mockResolvedValueOnce(f.response({...f.observation, action: "database.runtime.logs", logs, logsObservedAt: 1999}));
    expect((await readManagedDatabaseTelemetry("logs", f.options, {tail: 100})).kind).toBe("error");
  }
  f.fetchImpl.mockResolvedValueOnce(f.response({...f.observation, action: "database.runtime.metrics", metrics: null, metricsObservedAt: null}));
  expect((await readManagedDatabaseTelemetry("metrics", f.options)).kind).toBe("error");
});
