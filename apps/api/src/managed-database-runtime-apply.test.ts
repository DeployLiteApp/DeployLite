import { expect, it, vi } from "vitest";
import { composeRuntimeResourceName, managedDatabaseRuntimeReplayFingerprintDigest, resolveControlCommandInMemory, type ControlCommand, type ProjectUpdateControlRepository } from "@deploylite/domain";
import type { ProjectControlAuthorityV1, ManagedDatabaseRuntimeReceiptV1 } from "@deploylite/contracts";
import { applyManagedDatabaseRuntime } from "./managed-database-runtime-apply.js";
function fixture() {
  const ledger = new Map<string, ControlCommand>(), cache = new Map<string, ManagedDatabaseRuntimeReceiptV1>();
  let now = 1000;
  const preparation = { schemaVersion: 1 as const, projectId: "project-a", databaseId: "orders", engine: "postgres" as const,
    profileId: "profile-a", planDigest: "a".repeat(64), environmentFingerprint: "b".repeat(32) };
  const authorityFor = (command: ControlCommand): ProjectControlAuthorityV1 => ({ schemaVersion: 1, projectId: preparation.projectId,
    commandId: command.id, action: "project.update", inputDigest: command.inputDigest,
    projectLease: { leaseId: "lease-a", projectId: preparation.projectId, fence: 1, expiresAt: command.expiresAt.getTime() } });
  const save = (command: ControlCommand) => { const key = [...ledger].find(([, value]) => value.id === command.id)![0]; ledger.set(key, structuredClone(command)); return structuredClone(command); };
  const controls = {
    resolve: vi.fn(async (command: ControlCommand) => resolveControlCommandInMemory(ledger, command)),
    complete: vi.fn(async (command: ControlCommand) => save(command)),
    findProjectUpdateByIdempotency: vi.fn(async () => structuredClone([...ledger.values()][0] ?? null)),
    claimProjectUpdate: vi.fn(async (command: ControlCommand) => {
      const current = [...ledger.values()].find(value => value.id === command.id)!;
      if (current.status !== "eligible") return { command: structuredClone(current), claimed: false, authority: current.projectExecutionAuthority };
      const authority = authorityFor(current), claimed = save({ ...current, status: "dispatching", projectExecutionAuthority: authority });
      return { command: claimed, claimed: true, authority };
    }),
    validateProjectUpdateAuthority: vi.fn(async (authority: ProjectControlAuthorityV1) => { if (authority.projectLease.expiresAt <= now) throw new Error("expired"); }),
    completeProjectUpdate: vi.fn(async (command: ControlCommand) => save({ ...command, status: "completed" }))
  } satisfies ProjectUpdateControlRepository;
  const receiptFor = (command: ControlCommand): ManagedDatabaseRuntimeReceiptV1 => ({ schemaVersion: 1, action: "database.runtime", agentId: "agent-a", commandId: command.id,
    projectId: preparation.projectId, databaseId: preparation.databaseId, engine: preparation.engine, inputDigest: command.inputDigest,
    planDigest: preparation.planDigest, environmentFingerprint: preparation.environmentFingerprint, correlationId: command.correlationId,
    containerId: "c".repeat(64), imageId: `sha256:${"d".repeat(64)}`,
    volumeName: composeRuntimeResourceName(preparation.projectId, "volume", "db-orders"), networkName: composeRuntimeResourceName(preparation.projectId, "network", "db-orders"),
    networkId: "e".repeat(64), volumeCreatedAt: "2026-10-10T00:00:00Z", observedAt: now, status: "ready", health: "passed", storage: "verified", idempotent: false, redacted: true });
  const transport = { available: vi.fn(() => true), readReceipt: vi.fn(async (prepared: { command: ControlCommand }) => cache.get(prepared.command.id) ?? null),
    dispatch: vi.fn(async (prepared: { command: ControlCommand }) => { const receipt = receiptFor(prepared.command); cache.set(prepared.command.id, receipt); return receipt; }) };
  const authorize = vi.fn(async () => true), current = vi.fn(() => true), environment = vi.fn(async () => ({ POSTGRES_PASSWORD: "private-fixture" }));
  const options = { controls, transport, agentId: "agent-a", now: () => now, commandTtlMs: 1000, deadlineMs: 1000 };
  const input = { preparation, actorId: "actor-a", idempotencyKey: "create-orders", context: { requestId: "request-a", correlationId: "correlation-a" }, authorize, current, environment };
  return { ledger, cache, controls, transport, receiptFor, options, input, authorize, current, environment, advance: () => { now = 3000; } };
}
it("claims once, dispatches once and atomically records only the original public receipt", async () => {
  const f = fixture(), outcome = await applyManagedDatabaseRuntime(f.options, f.input);
  expect(outcome.command.status).toBe("completed"); expect(outcome.receipt.networkId).toBe("e".repeat(64));
  expect(f.controls.claimProjectUpdate).toHaveBeenCalledTimes(1); expect(f.transport.dispatch).toHaveBeenCalledTimes(1);
  expect(f.controls.completeProjectUpdate).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
    action: "database.runtime.applied", actorUserId: "actor-a", correlationId: "correlation-a", metadata: expect.objectContaining({ receipt: outcome.receipt }) }));
  expect(JSON.stringify(f.controls.completeProjectUpdate.mock.calls)).not.toContain("private-fixture");
});
it("recovers a lost dispatch reply only through cache without a second execution", async () => {
  const f = fixture(); f.transport.dispatch.mockImplementation(async prepared => { f.cache.set(prepared.command.id, f.receiptFor(prepared.command)); throw new Error("lost-private"); });
  expect((await applyManagedDatabaseRuntime(f.options, f.input)).command.status).toBe("completed");
  expect(f.transport.dispatch).toHaveBeenCalledTimes(1); expect(f.transport.readReceipt).toHaveBeenCalledTimes(2);
});
it("replays completed original evidence after expiry without reading or replacing credentials", async () => {
  const f = fixture(); await applyManagedDatabaseRuntime(f.options, f.input); f.advance(); f.environment.mockClear(); f.transport.dispatch.mockClear();
  f.input.context.requestId = "new-request";
  expect((await applyManagedDatabaseRuntime(f.options, f.input)).idempotent).toBe(true);
  expect(f.environment).not.toHaveBeenCalled(); expect(f.transport.dispatch).not.toHaveBeenCalled();
});
it("repairs failed atomic completion from cache while original authority remains live", async () => {
  const f = fixture(); f.controls.completeProjectUpdate.mockRejectedValueOnce(new Error("private-audit"));
  await expect(applyManagedDatabaseRuntime(f.options, f.input)).rejects.toThrow("Database native apply is unavailable");
  expect((await applyManagedDatabaseRuntime(f.options, f.input)).command.status).toBe("completed");
  expect(f.transport.dispatch).toHaveBeenCalledTimes(1); expect(f.environment).toHaveBeenCalledTimes(1);
});
it("never redispatches an unresolved original command when its cache is absent or expired", async () => {
  for (const expired of [false, true]) {
    const f = fixture(); f.transport.dispatch.mockRejectedValue(new Error("unknown-private"));
    await expect(applyManagedDatabaseRuntime(f.options, f.input)).rejects.toThrow("Database native apply is unavailable");
    if (expired) f.advance();
    await expect(applyManagedDatabaseRuntime(f.options, f.input)).rejects.toThrow("Database native apply is unavailable");
    expect(f.transport.dispatch).toHaveBeenCalledTimes(1); expect(f.controls.completeProjectUpdate).not.toHaveBeenCalled();
  }
});
it("denies revoked access and changed preparation before any new runtime effects", async () => {
  const denied = fixture(); denied.authorize.mockResolvedValue(false);
  await expect(applyManagedDatabaseRuntime(denied.options, denied.input)).rejects.toThrow();
  expect(denied.controls.findProjectUpdateByIdempotency).not.toHaveBeenCalled(); expect(denied.environment).not.toHaveBeenCalled();
  const changed = fixture(); await applyManagedDatabaseRuntime(changed.options, changed.input);
  changed.input.preparation.planDigest = "f".repeat(64);
  await expect(applyManagedDatabaseRuntime(changed.options, changed.input)).rejects.toThrow();
  expect(changed.transport.dispatch).toHaveBeenCalledTimes(1); expect(changed.environment).toHaveBeenCalledTimes(1);
});
it("rejects custom transport evidence from a foreign scope before completion", async () => {
  for (const patch of [{ agentId: "foreign" }, { commandId: "foreign" }, { networkName: "foreign" }, { environmentFingerprint: "f".repeat(32) }]) {
    const f = fixture(); f.transport.dispatch.mockImplementation(async prepared => ({ ...f.receiptFor(prepared.command), ...patch }));
    await expect(applyManagedDatabaseRuntime(f.options, f.input)).rejects.toThrow(); expect(f.controls.completeProjectUpdate).not.toHaveBeenCalled();
  }
});
it("fences configuration and grant changes after environment reads and after agent effects", async () => {
  for (const stage of ["environment", "dispatch"] as const) {
    const f = fixture();
    if (stage === "environment") f.environment.mockImplementation(async () => { f.current.mockReturnValue(false); return { POSTGRES_PASSWORD: "private-fixture" }; });
    else f.transport.dispatch.mockImplementation(async prepared => { f.authorize.mockResolvedValue(false); return f.receiptFor(prepared.command); });
    await expect(applyManagedDatabaseRuntime(f.options, f.input)).rejects.toThrow(); expect(f.controls.completeProjectUpdate).not.toHaveBeenCalled();
    if (stage === "environment") expect(f.transport.dispatch).not.toHaveBeenCalled();
  }
});
it("bounds uncooperative authorization and refuses canceled or invalid deadlines", async () => {
  const stalled = fixture(); stalled.options.deadlineMs = 10; stalled.authorize.mockImplementation(() => new Promise(() => {}));
  await expect(applyManagedDatabaseRuntime(stalled.options, stalled.input)).rejects.toThrow();
  const invalid = fixture(); invalid.options.commandTtlMs = 0;
  await expect(applyManagedDatabaseRuntime(invalid.options, invalid.input)).rejects.toThrow(); expect(invalid.controls.resolve).not.toHaveBeenCalled();
  const canceled = fixture(); const controller = new AbortController(); controller.abort();
  await expect(applyManagedDatabaseRuntime(canceled.options, { ...canceled.input, signal: controller.signal })).rejects.toThrow();
  expect(canceled.controls.findProjectUpdateByIdempotency).not.toHaveBeenCalled();
});
it("admits one concurrent owner while preserving an unresolved loser", async () => {
  const f = fixture(); const results = await Promise.allSettled([applyManagedDatabaseRuntime(f.options, f.input), applyManagedDatabaseRuntime(f.options, f.input)]);
  expect(results.some(result => result.status === "fulfilled")).toBe(true); expect(f.transport.dispatch).toHaveBeenCalledTimes(1);
});
it("does not complete an expired unresolved command even when its original cache exists", async () => {
  const f = fixture(); f.controls.completeProjectUpdate.mockRejectedValueOnce(new Error("audit"));
  await expect(applyManagedDatabaseRuntime(f.options, f.input)).rejects.toThrow(); f.advance(); f.controls.completeProjectUpdate.mockClear();
  await expect(applyManagedDatabaseRuntime(f.options, f.input)).rejects.toThrow();
  expect(f.controls.completeProjectUpdate).not.toHaveBeenCalled(); expect(f.transport.dispatch).toHaveBeenCalledTimes(1);
});
it("rejects claim substitution and a changed transport configuration before dispatch", async () => {
  const changed = fixture(); changed.environment.mockImplementation(async () => { changed.options.agentId = "other-agent"; return { POSTGRES_PASSWORD: "private-fixture" }; });
  await expect(applyManagedDatabaseRuntime(changed.options, changed.input)).rejects.toThrow(); expect(changed.transport.dispatch).not.toHaveBeenCalled();
  const replaced = fixture(); const originalClaim = replaced.controls.claimProjectUpdate.getMockImplementation()!;
  replaced.controls.claimProjectUpdate.mockImplementation(async command => { const result = await originalClaim(command); return { ...result, command: { ...result.command, id: "foreign" } }; });
  await expect(applyManagedDatabaseRuntime(replaced.options, replaced.input)).rejects.toThrow(); expect(replaced.transport.dispatch).not.toHaveBeenCalled();
});
it("bounds stalled receipt and completion ports without creating acceptance evidence", async () => {
  for (const stage of ["cache", "complete"] as const) {
    const f = fixture(); f.options.deadlineMs = 10;
    if (stage === "cache") f.transport.readReceipt.mockImplementation(() => new Promise(() => {}));
    else f.controls.completeProjectUpdate.mockImplementation(() => new Promise(() => {}));
    await expect(applyManagedDatabaseRuntime(f.options, f.input)).rejects.toThrow("Database native apply is unavailable");
    if (stage === "cache") expect(f.transport.dispatch).not.toHaveBeenCalled();
  }
});

it("returns the existing opaque creation selector and preserves it on expired cache-only replay", async () => {
  const f = fixture(), outcome = await applyManagedDatabaseRuntime(f.options, f.input);
  const command = outcome.command;
  const expected = managedDatabaseRuntimeReplayFingerprintDigest({ ...f.input.preparation, action: "database.runtime", operation: "database.runtime.apply",
    agentId: f.options.agentId, commandId: command.id, idempotencyKey: command.idempotencyKey, inputDigest: command.inputDigest,
    requiredCapabilities: ["database.runtime.v1"], authority: command.projectExecutionAuthority, lease: command.projectExecutionAuthority!.projectLease,
    context: f.input.context, timeoutMs: f.options.deadlineMs });
  expect(outcome).toHaveProperty("originalReplayFingerprint", expected);
  f.advance(); f.input.context = { requestId: "new-request", correlationId: "new-correlation" };
  f.environment.mockClear(); f.transport.dispatch.mockClear();
  const replay = await applyManagedDatabaseRuntime(f.options, f.input);
  expect(replay).toHaveProperty("originalReplayFingerprint", expected);
  expect(f.environment).not.toHaveBeenCalled(); expect(f.transport.dispatch).not.toHaveBeenCalled();
});
