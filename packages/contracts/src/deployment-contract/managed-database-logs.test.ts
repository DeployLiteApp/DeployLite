import {expect, it} from "vitest";
import {managedDatabaseLogsAgentQuerySchema, managedDatabaseLogsObservationSchema} from "./managed-database-logs.js";
function fixture() {
  const base = {schemaVersion: 1, projectId: "p1", databaseId: "orders", engine: "postgres", profileId: "approved", planDigest: "a".repeat(64), environmentFingerprint: "b".repeat(32)};
  const originalReceipt = {...base, action: "database.runtime", agentId: "agent-a", commandId: "creation-a", inputDigest: "a".repeat(64), correlationId: "creation-correlation",
    containerId: "c".repeat(64), imageId: "sha256:" + "d".repeat(64), volumeName: "dl-" + base.environmentFingerprint + "-vol-db-orders",
    networkName: "dl-" + base.environmentFingerprint + "-net-db-orders", networkId: "e".repeat(64), volumeCreatedAt: "2026-10-10T00:00:00Z",
    observedAt: 1000, status: "ready", health: "passed", storage: "verified", idempotent: false, redacted: true};
  delete (originalReceipt as Partial<typeof originalReceipt>).profileId;
  const query = {...base, originalReceipt, originalReplayFingerprint: "f".repeat(64), action: "database.runtime.logs", agentId: "agent-a",
    requiredCapabilities: ["database.runtime.logs.v1"], context: {requestId: "log-request", correlationId: "log-correlation"}, timeoutMs: 5000,
    selection: {tail: 100, since: "1970-01-01T00:00:00.500Z"}};
  const {commandId: originalCommandId, inputDigest: _digest, correlationId: _correlation, status: _status, health: _health, idempotent: _idem, ...physical} = originalReceipt;
  const observation = {...physical, action: "database.runtime.logs", originalCommandId, profileId: base.profileId, context: query.context,
    state: "running", health: "healthy", uid: 999, observedAt: 2000, logs: {stdout: "ready\n", stderr: "notice\n", redacted: true}, logsObservedAt: 1900};
  return {query, observation};
}
for (const engine of ["postgres", "mysql", "mariadb", "mongodb", "redis"] as const) {
  it(`accepts bounded ${engine} logs bound to immutable creation`, () => {
    const f = fixture();
    expect(managedDatabaseLogsAgentQuerySchema.safeParse({...f.query, engine, originalReceipt: {...f.query.originalReceipt, engine}}).success).toBe(true);
    expect(managedDatabaseLogsObservationSchema.safeParse({...f.observation, engine}).success).toBe(true);
  });
}
it("accepts retained logs of a stopped original container", () => {
  const f = fixture();
  expect(managedDatabaseLogsObservationSchema.safeParse({...f.observation, state: "stopped", health: "not-running", uid: null}).success).toBe(true);
});
it("requires bounded explicit tail and canonical UTC selectors", () => {
  const f = fixture();
  for (const selection of [{tail: 0}, {tail: -1}, {tail: 1.5}, {tail: 5001}, {tail: 100, since: "1m"}, {tail: 100, since: "1970-01-01T00:00:00"}, {tail: 100, password: "private"}]) {
    expect(managedDatabaseLogsAgentQuerySchema.safeParse({...f.query, selection}).success).toBe(false);
  }
  for (const tail of [100, 300, 500, 1000, 5000]) expect(managedDatabaseLogsAgentQuerySchema.safeParse({...f.query, selection: {tail}}).success).toBe(true);
});
it("rejects detached queries, plaintext environment and private effects", () => {
  const f = fixture();
  for (const patch of [{agentId: "foreign"}, {projectId: "foreign"}, {action: "database.runtime.health"}, {requiredCapabilities: ["database.runtime.health.v1"]}, {authority: {}}, {sealedEnvironment: "private"}, {argv: ["--all"]}, {timeoutMs: 60001}]) {
    expect(managedDatabaseLogsAgentQuerySchema.safeParse({...f.query, ...patch}).success).toBe(false);
  }
});
it("requires strict redacted bounded streams and sampled time", () => {
  const f = fixture();
  for (const patch of [{logs: null}, {logsObservedAt: null}, {logsObservedAt: -1}, {logsObservedAt: 2001}, {logsObservedAt: Number.MAX_SAFE_INTEGER + 1}, {password: "private"}, {uid: 0},
    {logs: {...f.observation.logs, password: "private"}}, {logs: {...f.observation.logs, redacted: false}}, {logs: {...f.observation.logs, stdout: "x".repeat(1048577)}}]) {
    expect(managedDatabaseLogsObservationSchema.safeParse({...f.observation, ...patch}).success).toBe(false);
  }
});
