import {expect, it} from "vitest";
import {composeRuntimeResourceName} from "./compose-preview.js";
import {managedDatabaseRuntimeExecutionDigest} from "./managed-database-runtime-binding.js";
import {managedDatabaseLogsSourceBinding, managedDatabaseLogsObservationMatches} from "./managed-database-logs-binding.js";
function fixture() {
  const base = {schemaVersion: 1, projectId: "p1", databaseId: "orders", engine: "postgres", profileId: "approved", planDigest: "a".repeat(64), environmentFingerprint: "b".repeat(32)};
  const originalReceipt = {schemaVersion: 1, projectId: base.projectId, databaseId: base.databaseId, engine: base.engine, action: "database.runtime", agentId: "agent-a",
    commandId: "creation-a", inputDigest: managedDatabaseRuntimeExecutionDigest(base), planDigest: base.planDigest, environmentFingerprint: base.environmentFingerprint,
    correlationId: "creation-correlation", containerId: "c".repeat(64), imageId: "sha256:" + "d".repeat(64), volumeName: composeRuntimeResourceName("p1", "volume", "db-orders"),
    networkName: composeRuntimeResourceName("p1", "network", "db-orders"), networkId: "e".repeat(64), volumeCreatedAt: "2026-10-10T00:00:00Z",
    observedAt: 1000, status: "ready", health: "passed", storage: "verified", idempotent: false, redacted: true};
  const query = {...base, originalReceipt, originalReplayFingerprint: "f".repeat(64), action: "database.runtime.logs", agentId: "agent-a",
    requiredCapabilities: ["database.runtime.logs.v1"], context: {requestId: "log-request", correlationId: "log-correlation"}, timeoutMs: 5000,
    selection: {tail: 100, since: "1970-01-01T00:00:00.500Z"}};
  const {commandId: originalCommandId, inputDigest: _digest, correlationId: _correlation, status: _status, health: _health, idempotent: _idem, ...physical} = originalReceipt;
  const observation = {...physical, action: "database.runtime.logs", originalCommandId, profileId: base.profileId, context: query.context,
    state: "running", health: "healthy", uid: 999, observedAt: 2000, logs: {stdout: "ready\n", stderr: "notice\n", redacted: true}, logsObservedAt: 1900};
  return {query, observation};
}
it("binds immutable original creation without creating a command", () => {
  const f = fixture(); expect(managedDatabaseLogsSourceBinding(f.query)).toEqual(f.query);
});
it("matches full running and stopped original identity inside the current window", () => {
  const f = fixture(); expect(managedDatabaseLogsObservationMatches(f.query, f.observation, 1500, 2100)).toBe(true);
  expect(managedDatabaseLogsObservationMatches(f.query, {...f.observation, state: "stopped", health: "not-running", uid: null}, 1500, 2100)).toBe(true);
});
it("rejects forged creation digests and identities without mutating source", () => {
  const f = fixture(), copy = structuredClone(f.query);
  for (const patch of [{inputDigest: "0".repeat(64)}, {projectId: "foreign"}, {status: "failed", health: "not-run"}]) {
    expect(() => managedDatabaseLogsSourceBinding({...f.query, originalReceipt: {...f.query.originalReceipt, ...patch}})).toThrow(/^Database logs source is unavailable\.$/);
  }
  expect(f.query).toEqual(copy);
});
it("rejects detached public scopes and unsanitized logs even with a true flag", () => {
  const f = fixture();
  for (const patch of [{agentId: "foreign"}, {originalCommandId: "foreign"}, {containerId: "0".repeat(64)}, {networkId: "0".repeat(64)}, {context: {requestId: "other", correlationId: "log-correlation"}},
    {logs: {...f.observation.logs, stdout: "password=tiny"}}, {logs: {...f.observation.logs, stderr: "api_key=tiny"}}]) {
    expect(managedDatabaseLogsObservationMatches(f.query, {...f.observation, ...patch}, 1500, 2100)).toBe(false);
  }
});
it("rejects detached log samples, unsafe clocks and future since selectors", () => {
  const f = fixture();
  for (const logsObservedAt of [1499, 2101, null]) expect(managedDatabaseLogsObservationMatches(f.query, {...f.observation, logsObservedAt}, 1500, 2100)).toBe(false);
  for (const [before, after] of [[2101, 2100], [1500, 6500], [Number.NaN, 2100], [1500, Number.MAX_SAFE_INTEGER + 1]]) {
    expect(managedDatabaseLogsObservationMatches(f.query, f.observation, before, after)).toBe(false);
  }
  expect(managedDatabaseLogsObservationMatches({...f.query, selection: {tail: 100, since: "1970-01-01T00:00:01.501Z"}}, f.observation, 1500, 2100)).toBe(false);
});
