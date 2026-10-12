import {expect, it, vi} from "vitest";
import {signAgentTransport} from "@deploylite/config";
import {MANAGED_DATABASE_LOGS_CAPABILITY, MANAGED_DATABASE_LOGS_PATH} from "@deploylite/contracts";
import {composeRuntimeResourceName, managedDatabaseRuntimeExecutionDigest} from "@deploylite/domain";
import {AuthenticatedManagedDatabaseLogsTransport} from "./managed-database-logs-transport.js";
function fixture() {
  const base = {schemaVersion: 1, projectId: "p1", databaseId: "orders", engine: "postgres", profileId: "approved", planDigest: "a".repeat(64), environmentFingerprint: "b".repeat(32)};
  const originalReceipt = {schemaVersion: 1, projectId: base.projectId, databaseId: base.databaseId, engine: base.engine, action: "database.runtime", agentId: "agent-a",
    commandId: "creation-a", inputDigest: managedDatabaseRuntimeExecutionDigest(base), planDigest: base.planDigest, environmentFingerprint: base.environmentFingerprint,
    correlationId: "creation-correlation", containerId: "c".repeat(64), imageId: "sha256:" + "d".repeat(64), volumeName: composeRuntimeResourceName("p1", "volume", "db-orders"),
    networkName: composeRuntimeResourceName("p1", "network", "db-orders"), networkId: "e".repeat(64), volumeCreatedAt: "2026-10-10T00:00:00Z", observedAt: 1000,
    status: "ready", health: "passed", storage: "verified", idempotent: false, redacted: true};
  const preparation = {...base, originalReceipt, originalReplayFingerprint: "f".repeat(64), selection: {tail: 100}};
  const context = {requestId: "logs-request", correlationId: "logs-correlation"};
  const {commandId: originalCommandId, inputDigest: _digest, correlationId: _correlation, status: _status, health: _health, idempotent: _idem, ...physical} = originalReceipt;
  const observation = {...physical, action: "database.runtime.logs", originalCommandId, profileId: base.profileId, state: "running", health: "healthy", uid: 999,
    context, observedAt: 2000, logs: {stdout: "ready\n", stderr: "notice\n", redacted: true}, logsObservedAt: 2000};
  const trustKey = "test-logs-key-" + "x".repeat(64);
  const fetchResponse: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/capabilities")) return new Response(JSON.stringify({schemaVersion: 1, agentId: "agent-a", capabilities: [MANAGED_DATABASE_LOGS_CAPABILITY], protocolVersions: [1]}),
      {headers: {"x-deploylite-request-signature": String((init?.headers as Record<string, string>)["x-deploylite-signature"])}});
    const text = JSON.stringify(observation);
    return new Response(text, {headers: {"x-deploylite-response-signature": signAgentTransport(`POST ${MANAGED_DATABASE_LOGS_PATH}\n${init?.body}\n${text}`, trustKey)}});
  };
  const fetcher = vi.fn(fetchResponse), options = {endpoint: "https://agent.test", agentId: "agent-a", trustKey, fetch: fetcher, timeoutMs: 5000, now: () => 2000};
  const read = () => new AuthenticatedManagedDatabaseLogsTransport(options).observe(preparation as any, context);
  return {preparation, context, observation, fetcher, fetchResponse, options, read};
}
it("negotiates scoped logs and binds both signatures to exact path/request without effects", async () => {
  const f = fixture(); await expect(f.read()).resolves.toEqual(f.observation); const [url, init] = f.fetcher.mock.calls[1]!;
  expect(url).toBe("https://agent.test" + MANAGED_DATABASE_LOGS_PATH); expect(init?.redirect).toBe("error");
  expect((init?.headers as Record<string, string>)["x-deploylite-signature"]).toBe(signAgentTransport(`POST ${MANAGED_DATABASE_LOGS_PATH}\n${init?.body}`, f.options.trustKey));
  const query = JSON.parse(String(init?.body)); expect(query.selection).toEqual({tail: 100});
  for (const key of ["commandId", "authority", "lease", "sealedEnvironment", "argv"]) expect(query).not.toHaveProperty(key);
});
it("uses existing explicit secure endpoint/deadline admission", () => {
  const f = fixture(); expect(new AuthenticatedManagedDatabaseLogsTransport(f.options).available()).toBe(true);
  for (const patch of [{endpoint: "http://public.test"}, {endpoint: "https://user:password@agent.test"}, {endpoint: "https://agent.test?q=1"}, {timeoutMs: 0}, {timeoutMs: 60001}]) expect(new AuthenticatedManagedDatabaseLogsTransport({...f.options, ...patch}).available()).toBe(false);
});
it("rejects response signature substitution and missing logs capability", async () => {
  const f = fixture(); f.fetcher.mockImplementation(async (url, init) => String(url).endsWith("/capabilities") ? f.fetchResponse(url, init) : new Response(JSON.stringify(f.observation), {headers: {"x-deploylite-response-signature": "invalid"}}));
  await expect(f.read()).rejects.toThrow(/^Database logs transport is unavailable\.$/);
  const g = fixture(); g.fetcher.mockImplementation(async (_url, init) => new Response(JSON.stringify({schemaVersion: 1, agentId: "agent-a", capabilities: [], protocolVersions: [1]}), {headers: {"x-deploylite-request-signature": String((init?.headers as Record<string, string>)["x-deploylite-signature"])}}));
  await expect(g.read()).rejects.toThrow(); expect(g.fetcher).toHaveBeenCalledTimes(1);
});
it("withholds signed private, detached, stale or unsanitized log streams", async () => {
  for (const patch of [{password: "private"}, {containerId: "0".repeat(64)}, {observedAt: 1000}, {uid: 0}, {logs: {...fixture().observation.logs, stderr: "password=tiny"}}]) {
    const f = fixture(); f.fetcher.mockImplementation(async (url, init) => {
      if (String(url).endsWith("/capabilities")) return f.fetchResponse(url, init);
      const text = JSON.stringify({...f.observation, ...patch}); return new Response(text, {headers: {"x-deploylite-response-signature": signAgentTransport(`POST ${MANAGED_DATABASE_LOGS_PATH}\n${init?.body}\n${text}`, f.options.trustKey)}});
    }); await expect(f.read()).rejects.toThrow();
  }
});
it("rejects forged source, future since and unbounded tails before network", async () => {
  for (const patch of [{originalReceipt: {...fixture().preparation.originalReceipt, inputDigest: "0".repeat(64)}}, {selection: {tail: -1}}, {selection: {tail: 100, since: "1970-01-01T00:00:02.001Z"}}]) {
    const f = fixture(); await expect(new AuthenticatedManagedDatabaseLogsTransport(f.options).observe({...f.preparation, ...patch} as any, f.context)).rejects.toThrow(); expect(f.fetcher).not.toHaveBeenCalled();
  }
});
it("bounds hung fetch and pre-aborted calls", async () => {
  const f = fixture(); f.fetcher.mockImplementation(() => new Promise(() => {})); await expect(new AuthenticatedManagedDatabaseLogsTransport({...f.options, timeoutMs: 5}).observe(f.preparation as any, f.context)).rejects.toThrow();
  const g = fixture(), controller = new AbortController(); controller.abort(); await expect(new AuthenticatedManagedDatabaseLogsTransport(g.options).observe(g.preparation as any, {...g.context, signal: controller.signal})).rejects.toThrow(); expect(g.fetcher).not.toHaveBeenCalled();
});
