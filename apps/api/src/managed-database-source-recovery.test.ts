import { expect, it, vi } from "vitest";
import { MANAGED_DATABASE_RUNTIME_CAPABILITY, MANAGED_DATABASE_STOP_CAPABILITY } from "@deploylite/contracts";
import { composeRuntimeResourceName, createControlCommand, managedDatabaseRuntimeExecutionBinding, managedDatabaseRuntimeReplayFingerprintDigest,
  managedDatabaseStopExecutionBinding, managedDatabaseStopReplayFingerprintDigest, type ControlCommand } from "@deploylite/domain";
import { recoverManagedDatabaseSources } from "./managed-database-source-recovery.js";
function fixture() {
  let now = 3000;
  const base = {schemaVersion: 1 as const, projectId: "project-a", databaseId: "orders", engine: "postgres" as const, profileId: "profile-a", planDigest: "a".repeat(64), environmentFingerprint: "b".repeat(32)};
  const authority = (command: ControlCommand) => ({schemaVersion: 1 as const, projectId: base.projectId, commandId: command.id, action: "project.update" as const,
    inputDigest: command.inputDigest, projectLease: {leaseId: "lease-" + command.id, projectId: base.projectId, fence: 1, expiresAt: command.expiresAt.getTime()}});
  const create = (input: unknown, key: string): ControlCommand => {
    const seed = createControlCommand({actorId: "original-operator", action: "project.update", scope: {kind: "project", projectId: base.projectId}, input, idempotencyKey: key, correlationId: `original-${key}`, expiresAt: new Date(2000)});
    return {...seed, status: "completed", projectExecutionAuthority: authority(seed)};
  };
  const original = create(managedDatabaseRuntimeExecutionBinding(base), "create-orders");
  const {profileId: _profile, ...receiptBase} = base;
  const receipt = {...receiptBase, action: "database.runtime" as const, agentId: "agent-a", commandId: original.id, inputDigest: original.inputDigest, correlationId: original.correlationId,
    containerId: "c".repeat(64), imageId: "sha256:" + "d".repeat(64), volumeName: composeRuntimeResourceName(base.projectId, "volume", "db-orders"),
    networkName: composeRuntimeResourceName(base.projectId, "network", "db-orders"), networkId: "e".repeat(64), volumeCreatedAt: "2026-10-10T00:00:00Z", observedAt: 1000,
    status: "ready" as const, health: "passed" as const, storage: "verified" as const, idempotent: false, redacted: true as const};
  const originalQuery = {...base, action: "database.runtime", operation: "database.runtime.apply", agentId: "agent-a", commandId: original.id, inputDigest: original.inputDigest,
    idempotencyKey: original.idempotencyKey, requiredCapabilities: [MANAGED_DATABASE_RUNTIME_CAPABILITY], authority: original.projectExecutionAuthority,
    lease: original.projectExecutionAuthority!.projectLease, context: {requestId: "original-request", correlationId: original.correlationId}, timeoutMs: 1000};
  const source = {...base, originalReceipt: receipt, originalReplayFingerprint: managedDatabaseRuntimeReplayFingerprintDigest(originalQuery)};
  const stopped = create(managedDatabaseStopExecutionBinding(source), "stop-orders");
  const {commandId: originalCommandId, inputDigest: _digest, correlationId: _correlation, health: _health, idempotent: _idem, ...physical} = receipt;
  const stopReceipt = {...physical, profileId: base.profileId, action: "database.runtime.stop" as const, status: "stopped" as const,
    commandId: stopped.id, originalCommandId, inputDigest: stopped.inputDigest, correlationId: stopped.correlationId, observedAt: 1500};
  const stopQuery = {...source, action: "database.runtime.stop", operation: "database.runtime.stop", agentId: "agent-a", commandId: stopped.id, inputDigest: stopped.inputDigest,
    idempotencyKey: stopped.idempotencyKey, requiredCapabilities: [MANAGED_DATABASE_STOP_CAPABILITY], authority: stopped.projectExecutionAuthority,
    lease: stopped.projectExecutionAuthority!.projectLease, context: {requestId: "stop-request", correlationId: stopped.correlationId}, timeoutMs: 1000};
  const startPreparation = {...source, originalStopReceipt: stopReceipt, originalStopReplayFingerprint: managedDatabaseStopReplayFingerprintDigest(stopQuery)};
  const controls = {findProjectUpdatesByInputDigest: vi.fn(async (_project: string, digest: string) => digest === original.inputDigest ? [structuredClone(original)] : [structuredClone(stopped)]),
    resolve: vi.fn(), claimProjectUpdate: vi.fn(), completeProjectUpdate: vi.fn(), validateProjectUpdateAuthority: vi.fn()};
  const originalTransport = {available: vi.fn(() => true), readReceipt: vi.fn(async () => structuredClone(receipt)), dispatch: vi.fn()};
  const stopTransport = {available: vi.fn(() => true), readReceipt: vi.fn(async () => structuredClone(stopReceipt)), dispatch: vi.fn()};
  const authorize = vi.fn(async () => true), current = vi.fn(() => true);
  const options = {controls, originalTransport, stopTransport, agentId: "agent-a", deadlineMs: 1000, now: () => now};
  const input = {preparation: base, context: {requestId: "reloaded-request", correlationId: "current-correlation"}, authorize, current};
  return {create, base, original, stopped, receipt, stopReceipt, source, startPreparation, controls, originalTransport, stopTransport, options, input, authorize, current, advance: () => {now += 2000;}};
}
it("recovers the exact original creation and STOP selectors after reload without effects or renewed historical leases", async () => {
  const f = fixture();
  expect(await recoverManagedDatabaseSources(f.options, f.input)).toEqual({source: f.source, startPreparation: f.startPreparation});
  expect(f.controls.findProjectUpdatesByInputDigest).toHaveBeenNthCalledWith(1, "project-a", f.original.inputDigest);
  expect(f.controls.findProjectUpdatesByInputDigest).toHaveBeenNthCalledWith(2, "project-a", f.stopped.inputDigest);
  for (const effect of [f.controls.resolve, f.controls.claimProjectUpdate, f.controls.completeProjectUpdate, f.controls.validateProjectUpdateAuthority, f.originalTransport.dispatch, f.stopTransport.dispatch]) expect(effect).not.toHaveBeenCalled();
});
it("preserves opaque selectors across a fresh request context", async () => {
  const f = fixture(), first = await recoverManagedDatabaseSources(f.options, f.input);
  expect(first).toEqual({source: f.source, startPreparation: f.startPreparation});
  f.input.context = {requestId: "other-request", correlationId: "other-current"};
  expect(await recoverManagedDatabaseSources(f.options, f.input)).toEqual(first);
});
it("returns no original source for configured credentials without completed execution history", async () => {
  const f = fixture(); f.controls.findProjectUpdatesByInputDigest.mockResolvedValue([]);
  expect(await recoverManagedDatabaseSources(f.options, f.input)).toEqual({source: null, startPreparation: null});
  expect(f.controls.findProjectUpdatesByInputDigest).toHaveBeenCalledTimes(1);
  expect(f.originalTransport.readReceipt).not.toHaveBeenCalled(); expect(f.stopTransport.readReceipt).not.toHaveBeenCalled();
});
it("returns creation evidence without START preparation when there is no completed STOP", async () => {
  const f = fixture(); f.controls.findProjectUpdatesByInputDigest.mockResolvedValueOnce([f.original]).mockResolvedValueOnce([]);
  expect(await recoverManagedDatabaseSources(f.options, f.input)).toEqual({source: f.source, startPreparation: null});
});
it("rejects detached or pending original rows before querying immutable agent cache", async () => {
  for (const patch of [{status: "dispatching"}, {inputDigest: "0".repeat(64)}, {scope: {kind: "project", projectId: "foreign"}}, {projectExecutionAuthority: undefined}]) {
    const f = fixture(); f.controls.findProjectUpdatesByInputDigest.mockResolvedValueOnce([{...f.original, ...patch} as ControlCommand]);
    await expect(recoverManagedDatabaseSources(f.options, f.input)).rejects.toThrow("Database original sources are unavailable.");
    expect(f.originalTransport.readReceipt).not.toHaveBeenCalled();
  }
});
it("rejects missing, detached, unsafe or future original receipts without fabricating public proof", async () => {
  for (const patch of [null, {projectId: "foreign"}, {commandId: "other"}, {inputDigest: "0".repeat(64)}, {observedAt: Number.MAX_SAFE_INTEGER + 1}, {observedAt: 3001}]) {
    const f = fixture(); f.originalTransport.readReceipt.mockResolvedValueOnce((patch === null ? null : {...f.receipt, ...patch}) as any);
    await expect(recoverManagedDatabaseSources(f.options, f.input)).rejects.toThrow("Database original sources are unavailable.");
  }
});
it("rejects multiple ready creation sources rather than choosing an arbitrary original", async () => {
  const f = fixture(), second = f.create(managedDatabaseRuntimeExecutionBinding(f.base), "second-create");
  f.controls.findProjectUpdatesByInputDigest.mockResolvedValueOnce([f.original, second]);
  f.originalTransport.readReceipt.mockImplementation(async (...args: unknown[]) => {const prepared = args[0] as {command: ControlCommand}; return {...f.receipt, commandId: prepared.command.id, correlationId: prepared.command.correlationId};});
  await expect(recoverManagedDatabaseSources(f.options, f.input)).rejects.toThrow("Database original sources are unavailable.");
});
it("rejects missing or detached STOP receipts instead of returning a stale START control", async () => {
  for (const patch of [null, {containerId: "0".repeat(64)}, {observedAt: 999}, {observedAt: 3001}, {observedAt: Number.MAX_SAFE_INTEGER + 1}]) {
    const f = fixture(); f.stopTransport.readReceipt.mockResolvedValueOnce((patch === null ? null : {...f.stopReceipt, ...patch}) as any);
    await expect(recoverManagedDatabaseSources(f.options, f.input)).rejects.toThrow("Database original sources are unavailable.");
  }
});
it("requires current project access before reading any private history", async () => {
  const f = fixture(); f.authorize.mockResolvedValue(false);
  await expect(recoverManagedDatabaseSources(f.options, f.input)).rejects.toThrow("Database original sources are unavailable.");
  expect(f.controls.findProjectUpdatesByInputDigest).not.toHaveBeenCalled();
});
it("withholds recovery if current grant or configuration changes during immutable cache reads", async () => {
  for (const kind of ["grant", "configuration"]) {
    const f = fixture(); f.originalTransport.readReceipt.mockImplementationOnce(async () => {if (kind === "grant") f.authorize.mockResolvedValue(false); else f.current.mockReturnValue(false); return f.receipt;});
    await expect(recoverManagedDatabaseSources(f.options, f.input)).rejects.toThrow("Database original sources are unavailable.");
  }
});
it("bounds a history reader that ignores cancellation and masks its diagnostics", async () => {
  const f = fixture(); f.options.deadlineMs = 5; f.controls.findProjectUpdatesByInputDigest.mockImplementation(() => new Promise(() => {}));
  await expect(recoverManagedDatabaseSources(f.options, f.input)).rejects.toThrow(/^Database original sources are unavailable\.$/);
});
