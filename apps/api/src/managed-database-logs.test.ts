import {expect, it, vi} from "vitest";
import {MANAGED_DATABASE_RUNTIME_CAPABILITY} from "@deploylite/contracts";
import {composeRuntimeResourceName, createControlCommand, managedDatabaseRuntimeExecutionBinding, managedDatabaseRuntimeReplayFingerprintDigest, type ControlCommand} from "@deploylite/domain";
import {observeManagedDatabaseLogs} from "./managed-database-logs.js";
function fixture() {
  const base = {schemaVersion: 1 as const, projectId: "project-a", databaseId: "orders", engine: "postgres" as const, profileId: "profile-a", planDigest: "a".repeat(64), environmentFingerprint: "b".repeat(32)};
  const seed = createControlCommand({actorId: "original-operator", action: "project.update", scope: {kind: "project", projectId: base.projectId},
    input: managedDatabaseRuntimeExecutionBinding(base), idempotencyKey: "original-create", correlationId: "original-correlation", expiresAt: new Date(2000)});
  const authority = {schemaVersion: 1 as const, projectId: base.projectId, commandId: seed.id, action: "project.update" as const, inputDigest: seed.inputDigest,
    projectLease: {leaseId: "lease-" + seed.id, projectId: base.projectId, fence: 1, expiresAt: seed.expiresAt.getTime()}};
  const original: ControlCommand = {...seed, status: "completed", projectExecutionAuthority: authority};
  const {profileId: _profile, ...receiptBase} = base;
  const originalReceipt = {...receiptBase, action: "database.runtime" as const, agentId: "agent-a", commandId: original.id, inputDigest: original.inputDigest, correlationId: original.correlationId,
    containerId: "c".repeat(64), imageId: "sha256:" + "d".repeat(64), volumeName: composeRuntimeResourceName(base.projectId, "volume", "db-orders"), networkName: composeRuntimeResourceName(base.projectId, "network", "db-orders"),
    networkId: "e".repeat(64), volumeCreatedAt: "2026-10-10T00:00:00Z", observedAt: 1000, status: "ready" as const, health: "passed" as const, storage: "verified" as const, idempotent: false, redacted: true as const};
  const originalQuery = {...base, action: "database.runtime", operation: "database.runtime.apply", agentId: "agent-a", commandId: original.id, inputDigest: original.inputDigest, idempotencyKey: original.idempotencyKey,
    requiredCapabilities: [MANAGED_DATABASE_RUNTIME_CAPABILITY], authority, lease: authority.projectLease, context: {requestId: "original-request", correlationId: original.correlationId}, timeoutMs: 1000};
  const preparation = {...base, originalReceipt, originalReplayFingerprint: managedDatabaseRuntimeReplayFingerprintDigest(originalQuery), selection: {tail: 100}};
  const controls = {findProjectUpdateById: vi.fn(async () => structuredClone(original))};
  const originalTransport = {available: vi.fn(() => true), readReceipt: vi.fn(async (_input: {input: unknown}, ..._args: unknown[]) => structuredClone(originalReceipt)), dispatch: vi.fn()};
  const {commandId: originalCommandId, inputDigest: _digest, correlationId: _correlation, status: _status, health: _health, idempotent: _idem, ...physical} = originalReceipt;
  const context = {requestId: "logs-request", correlationId: "logs-correlation"};
  const observation = {...physical, action: "database.runtime.logs", originalCommandId, profileId: base.profileId, context, state: "running", health: "healthy", uid: 999,
    observedAt: 3000, logs: {stdout: "ready\n", stderr: "notice\n", redacted: true}, logsObservedAt: 3000};
  const transport = {available: vi.fn(() => true), observe: vi.fn(async () => structuredClone(observation))};
  const authorize = vi.fn(async () => true), current = vi.fn(() => true), admit = vi.fn(async () => {});
  const options = {controls, originalTransport, transport, agentId: "agent-a", deadlineMs: 1000, now: () => 3000}, input = {preparation, context, authorize, current, admit};
  return {original, originalReceipt, preparation, controls, originalTransport, transport, observation, options, input, authorize, current, admit};
}
it("corroborates expired completed creation/cache then reads fresh logs without renewing authority", async () => {
  const f = fixture(); await expect(observeManagedDatabaseLogs(f.options as any, f.input)).resolves.toEqual(f.observation);
  expect(f.controls.findProjectUpdateById).toHaveBeenCalledWith(f.preparation.projectId, f.original.id); expect(f.originalTransport.readReceipt).toHaveBeenCalledOnce();
  expect(f.transport.observe).toHaveBeenCalledOnce(); expect(f.originalTransport.dispatch).not.toHaveBeenCalled();
  expect(f.originalTransport.readReceipt.mock.calls[0]![0].input).not.toHaveProperty("selection");
});
it("rejects pending or detached original controls before log read", async () => {
  for (const row of [null, {...fixture().original, status: "dispatching"}, {...fixture().original, inputDigest: "0".repeat(64)}]) {
    const f = fixture(); f.controls.findProjectUpdateById.mockResolvedValue(row as any); await expect(observeManagedDatabaseLogs(f.options as any, f.input)).rejects.toThrow(); expect(f.transport.observe).not.toHaveBeenCalled();
  }
});
it("rejects changed original cache or fingerprint before fresh logs", async () => {
  for (const mode of ["cache", "fingerprint"]) {
    const f = fixture(); if (mode === "cache") f.originalTransport.readReceipt.mockResolvedValue({...f.originalReceipt, containerId: "0".repeat(64)}); else f.preparation.originalReplayFingerprint = "0".repeat(64);
    await expect(observeManagedDatabaseLogs(f.options as any, f.input)).rejects.toThrow(); expect(f.transport.observe).not.toHaveBeenCalled();
  }
});
it("withholds late logs after current grants/configuration revoke access", async () => {
  for (const mode of ["grant", "configuration"]) {
    const f = fixture(); f.transport.observe.mockImplementation(async () => {if (mode === "grant") f.authorize.mockResolvedValue(false); else f.current.mockReturnValue(false); return f.observation;});
    await expect(observeManagedDatabaseLogs(f.options as any, f.input)).rejects.toThrow();
  }
});
it("requires current access before any original lookup or admission", async () => {
  const f = fixture(); f.authorize.mockResolvedValue(false); await expect(observeManagedDatabaseLogs(f.options as any, f.input)).rejects.toThrow(); expect(f.controls.findProjectUpdateById).not.toHaveBeenCalled(); expect(f.admit).not.toHaveBeenCalled();
});
it("bounds stalled original reads and masks diagnostics", async () => {
  const f = fixture(); f.controls.findProjectUpdateById.mockImplementation(() => new Promise(() => {}));
  await expect(observeManagedDatabaseLogs({...f.options, deadlineMs: 5} as any, f.input)).rejects.toThrow(/^Database logs is unavailable\.$/); expect(f.transport.observe).not.toHaveBeenCalled();
});
it("fences observation reader substitution during original cache read", async () => {
  const f = fixture(); f.originalTransport.readReceipt.mockImplementation(async () => {f.transport.observe = vi.fn(async () => f.observation); return f.originalReceipt;});
  await expect(observeManagedDatabaseLogs(f.options as any, f.input)).rejects.toThrow();
});
