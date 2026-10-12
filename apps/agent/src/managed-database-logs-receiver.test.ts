import {expect, it, vi} from "vitest";
import {signAgentTransport} from "@deploylite/config";
import {MANAGED_DATABASE_LOGS_CAPABILITY, MANAGED_DATABASE_LOGS_PATH, managedDatabaseLogsObservationSchema} from "@deploylite/contracts";
import {composeRuntimeResourceName, managedDatabaseRuntimeExecutionDigest} from "@deploylite/domain";
import {AuthenticatedAgentCommandReceiver} from "./agent-transport.js";
function fixture() {
  const base = {schemaVersion: 1, projectId: "p1", databaseId: "orders", engine: "postgres", profileId: "approved", planDigest: "a".repeat(64), environmentFingerprint: "b".repeat(32)};
  const originalReceipt = {schemaVersion: 1, projectId: base.projectId, databaseId: base.databaseId, engine: base.engine, action: "database.runtime", agentId: "agent-a",
    commandId: "creation-a", inputDigest: managedDatabaseRuntimeExecutionDigest(base), planDigest: base.planDigest, environmentFingerprint: base.environmentFingerprint,
    correlationId: "creation-correlation", containerId: "c".repeat(64), imageId: "sha256:" + "d".repeat(64), volumeName: composeRuntimeResourceName("p1", "volume", "db-orders"),
    networkName: composeRuntimeResourceName("p1", "network", "db-orders"), networkId: "e".repeat(64), volumeCreatedAt: "2026-10-10T00:00:00Z", observedAt: 1000,
    status: "ready", health: "passed", storage: "verified", idempotent: false, redacted: true};
  const query = {...base, originalReceipt, originalReplayFingerprint: "f".repeat(64), action: "database.runtime.logs", agentId: "agent-a", requiredCapabilities: ["database.runtime.logs.v1"],
    context: {requestId: "logs-request", correlationId: "logs-correlation"}, timeoutMs: 5000, selection: {tail: 100}};
  const {commandId: originalCommandId, inputDigest: _digest, correlationId: _correlation, status: _status, health: _health, idempotent: _idem, ...physical} = originalReceipt;
  const observation = {...physical, action: "database.runtime.logs", originalCommandId, profileId: base.profileId, state: "running", health: "healthy", uid: 999,
    context: query.context, observedAt: 2000, logs: {stdout: "ready\n", stderr: "notice\n", redacted: true}, logsObservedAt: 2000};
  const trustKey = "test-log-key-" + "x".repeat(64);
  const store = {durable: true, lookupByFingerprintDigest: vi.fn(async () => structuredClone(originalReceipt)), claim: vi.fn(), wait: vi.fn(), complete: vi.fn(), release: vi.fn()};
  const observe = vi.fn(async () => managedDatabaseLogsObservationSchema.parse(structuredClone(observation)));
  const options = {agentId: "agent-a", trustKey, capabilities: [MANAGED_DATABASE_LOGS_CAPABILITY], dispatcher: {dispatch: async () => {throw new Error("unused");}},
    replayStore: store, managedDatabaseLogs: {observe}, now: () => 2000};
  const receiver = new AuthenticatedAgentCommandReceiver(options);
  const read = (value: unknown = query, signature = signAgentTransport(`POST ${MANAGED_DATABASE_LOGS_PATH}\n${JSON.stringify(value)}`, trustKey), signal?: AbortSignal) => receiver.observeManagedDatabaseLogs(value, signature, signal);
  return {query, observation, store, observe, options, receiver, read};
}
it("reads fresh signed scoped logs twice without command/cache ledger writes", async () => {
  const f = fixture(); await expect(f.read()).resolves.toEqual(f.observation); await expect(f.read()).resolves.toEqual(f.observation);
  expect(f.observe).toHaveBeenCalledTimes(2); expect(f.store.lookupByFingerprintDigest).toHaveBeenCalledWith(f.query.originalReceipt.commandId, f.query.originalReplayFingerprint);
  for (const port of [f.store.claim, f.store.wait, f.store.complete, f.store.release]) expect(port).not.toHaveBeenCalled();
});
it("withholds logs capability without reader and durable opaque original proof", () => {
  const f = fixture();
  for (const patch of [{managedDatabaseLogs: undefined}, {replayStore: {...f.store, durable: false}}, {replayStore: {...f.store, lookupByFingerprintDigest: undefined}}]) {
    expect(new AuthenticatedAgentCommandReceiver({...f.options, ...patch} as never).capabilities).not.toContain(MANAGED_DATABASE_LOGS_CAPABILITY);
  }
});
it("rejects invalid signatures before original proof lookup", async () => {
  const f = fixture(); await expect(f.read(f.query, "invalid")).rejects.toThrow(); expect(f.store.lookupByFingerprintDigest).not.toHaveBeenCalled(); expect(f.observe).not.toHaveBeenCalled();
});
it("rejects missing or detached opaque creation before reading logs", async () => {
  for (const value of [null, {...fixture().query.originalReceipt, containerId: "0".repeat(64)}]) {
    const f = fixture(); f.store.lookupByFingerprintDigest.mockResolvedValue(value as any); await expect(f.read()).rejects.toThrow(); expect(f.observe).not.toHaveBeenCalled();
  }
});
it("rejects detached, stale, private or unsanitized log observations", async () => {
  for (const patch of [{containerId: "0".repeat(64)}, {observedAt: 1000}, {password: "private"}, {uid: 0}, {logs: {...fixture().observation.logs, stderr: "password=tiny"}}]) {
    const f = fixture(); f.observe.mockResolvedValue({...f.observation, ...patch} as any); await expect(f.read()).rejects.toThrow(/^Database logs source is unavailable\.$/);
  }
});
it("bounds hung original lookup without reading logs", async () => {
  const f = fixture(); f.store.lookupByFingerprintDigest.mockImplementation(() => new Promise(() => {}));
  await expect(f.read({...f.query, timeoutMs: 5})).rejects.toThrow(); expect(f.observe).not.toHaveBeenCalled();
});
it("rejects aborted requests and future since before all ports", async () => {
  const f = fixture(), controller = new AbortController(); controller.abort(); await expect(f.read(f.query, undefined, controller.signal)).rejects.toThrow();
  await expect(f.read({...f.query, selection: {tail: 100, since: "1970-01-01T00:00:02.001Z"}})).rejects.toThrow(); expect(f.store.lookupByFingerprintDigest).not.toHaveBeenCalled();
});
it("fences reader replacement during original proof lookup", async () => {
  const f = fixture(); f.store.lookupByFingerprintDigest.mockImplementation(async () => {
    f.options.managedDatabaseLogs.observe = vi.fn(async () => managedDatabaseLogsObservationSchema.parse(f.observation)); return f.query.originalReceipt;
  });
  await expect(f.read()).rejects.toThrow(); expect(f.observe).not.toHaveBeenCalled();
});
