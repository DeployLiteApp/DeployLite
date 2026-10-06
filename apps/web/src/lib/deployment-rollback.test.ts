// Prospective rollback behavior; replies are source-derived API v2 mocks.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRollbackAttempt, runDeploymentRollback } from "./deployment-rollback";
import { metadataApiPaths } from "./auth-boundary";
import { advance, CONTEXT, deferred, execution, H_HASH, record, requestBody, requestHeader, SERVER_R, serverReply, watchdog, type RecordedRequest } from "@/lib/deployment-rollback.test-fixtures";

afterEach(() => vi.useRealTimers());
const options = { apiBaseUrl: "https://api.test" };
const capture = (key = "same-key") => createRollbackAttempt(execution("A"), execution("H", true), "A", key)!;

describe("rollback explicit A and historical H", () => {
  it("captures A separately from H's canonical snapshot and preserves immutable input", () => {
    const A = execution("A"), H = execution("H", true);
    const attempt = createRollbackAttempt(A, H, "A", "same-key");
    expect(attempt).toMatchObject({ activeDeploymentId: "A", historicalDeploymentId: "H", snapshotHash: H_HASH, snapshotOriginId: "origin-H", idempotencyKey: "same-key" });
    expect(Object.isFrozen(attempt)).toBe(true);
    H.snapshotHash = "e".repeat(64); H.executionReceipt!.containerId = "changed";
    A.id = "changed-A";
    expect(attempt).toMatchObject({ activeDeploymentId: "A", historicalDeploymentId: "H", snapshotHash: H_HASH });
  });
  it.each(["different-A", "cross-project", "legacy-H", "failed-H", "wrong-proof", "wrong-origin", "wrong-host"])("rejects %s before any request", (fault) => {
    const A = execution("A"), H = execution("H", true);
    if (fault === "cross-project") H.projectId = "other";
    if (fault === "legacy-H") delete H.executionReceipt;
    if (fault === "failed-H") H.status = "failed";
    if (fault === "wrong-proof") H.executionReceipt!.deploymentId = "other";
    if (fault === "wrong-origin") H.snapshotOriginId = "other";
    if (fault === "wrong-host") H.agentId = "other";
    expect(createRollbackAttempt(A, H, fault === "different-A" ? "other-A" : "A", "key")).toBeNull();
  });
  it("performs no request without API configuration", async () => {
    const fetchImpl = vi.fn();
    expect(await runDeploymentRollback(capture(), { apiBaseUrl: null, fetchImpl })).toMatchObject({ kind: "error", retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("encodes the explicit expected-A route without turning it into another URL", () => {
    expect(metadataApiPaths.deploymentRollback("A/part?x")).toBe("/api/v1/deployments/A%2Fpart%3Fx/rollback");
  });
});

describe("rollback request and confirmed binding", () => {
  it("uses explicit A in the path and strict H/hash body with one key and server confirmation", async () => {
    const calls: RecordedRequest[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      record(calls, url, init);
      return serverReply(calls.length === 1 ? "prepared" : "pending", { key: "same-key" });
    });
    expect(await runDeploymentRollback(capture(), { ...options, fetchImpl })).toMatchObject({ kind: "pending", deploymentId: SERVER_R, correlationId: CONTEXT.correlationId });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).toBe("https://api.test/api/v1/deployments/A/rollback");
      expect(call.init.method).toBe("POST"); expect(call.init.credentials).toBe("include");
      expect(requestBody(call)).toEqual({ historicalDeploymentId: "H", snapshotHash: H_HASH });
      expect(requestHeader(call, "x-control-idempotency-key")).toBe("same-key");
    }
    expect(requestHeader(calls[0]!, "x-control-confirmation-id")).toBeNull();
    expect(requestHeader(calls[1]!, "x-control-confirmation-id")).toBe(CONTEXT.confirmationId);
    // A lost first preparation response recovers the original token and R on the same key.
    const recovered = capture("recovered-key");
    await runDeploymentRollback(recovered, { ...options, fetchImpl: vi.fn().mockRejectedValueOnce(new Error("lost first 202")) });
    const retryCalls: RecordedRequest[] = [];
    const retry = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      record(retryCalls, url, init);
      return serverReply(retryCalls.length === 1 ? "pending-confirmation" : "pending", { key: "recovered-key" });
    });
    expect(await runDeploymentRollback(recovered, { ...options, fetchImpl: retry })).toMatchObject({ kind: "pending", deploymentId: SERVER_R });
    expect(retryCalls).toHaveLength(2);
    expect(recovered.confirmation).toMatchObject({ id: CONTEXT.confirmationId, commandId: CONTEXT.commandId, correlationId: CONTEXT.correlationId });
    expect(requestHeader(retryCalls[1]!, "x-control-confirmation-id")).toBe(CONTEXT.confirmationId);
    for (const call of retryCalls) {
      expect(requestHeader(call, "x-control-idempotency-key")).toBe("recovered-key");
      expect(requestBody(call)).toEqual({ historicalDeploymentId: "H", snapshotHash: H_HASH });
    }
    // Running/dispatching pending has no new token and performs no second submission.
    const cacheOnly = capture("cache-key"), pendingOnly = vi.fn(async () => serverReply("pending", { key: "cache-key" }));
    expect(await runDeploymentRollback(cacheOnly, { ...options, fetchImpl: pendingOnly })).toMatchObject({ kind: "pending", deploymentId: SERVER_R });
    expect(cacheOnly.confirmation.id).toBeUndefined(); expect(pendingOnly).toHaveBeenCalledOnce();
  });
  it("keeps captured A/H/hash when source objects change during preparation", async () => {
    const A = execution("A"), H = execution("H", true);
    const attempt = createRollbackAttempt(A, H, "A", "same-key")!;
    const calls: RecordedRequest[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      record(calls, url, init);
      A.id = "changed-A"; H.id = "changed-H"; H.snapshotHash = "e".repeat(64);
      return serverReply(calls.length === 1 ? "prepared" : "pending", { key: "same-key" });
    });
    await runDeploymentRollback(attempt, { ...options, fetchImpl });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toContain("/A/rollback");
    expect(requestBody(calls[1]!)).toEqual({ historicalDeploymentId: "H", snapshotHash: H_HASH });
  });
  it("retains an unknown confirmed attempt through authorization loss and exact retry", async () => {
    const attempt = capture();
    const lost = vi.fn().mockResolvedValueOnce(serverReply("prepared", { key: "same-key" })).mockRejectedValueOnce(new Error("lost reply"));
    expect(await runDeploymentRollback(attempt, { ...options, fetchImpl: lost })).toMatchObject({ kind: "error", retryable: true });
    const calls: RecordedRequest[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => { record(calls, url, init); return serverReply("forbidden", { key: "same-key" }); });
    const denied = await runDeploymentRollback(attempt, { ...options, fetchImpl });
    expect(denied).toMatchObject({ kind: "error", retryable: true });
    expect(denied.message).toMatch(/access|authorization/i); expect(denied.message).toMatch(/unresolved/i);
    expect(denied.message).not.toMatch(/unchanged|no changes|no effects/i);
    expect(requestHeader(calls[0]!, "x-control-confirmation-id")).toBe(CONTEXT.confirmationId);
    expect(requestBody(calls[0]!)).toEqual({ historicalDeploymentId: "H", snapshotHash: H_HASH });
    expect(attempt).toMatchObject({ idempotencyKey: "same-key", confirmation: { commandId: CONTEXT.commandId, correlationId: CONTEXT.correlationId, unresolved: true } });
  });
});

describe("rollback finite wait and conclusive-only fresh preparation", () => {
  it("uses one total budget across preparation and confirmed submission", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const prepare = deferred<Response>(), confirm = deferred<Response>();
    const fetchImpl = vi.fn().mockImplementationOnce(() => prepare.promise).mockImplementationOnce(() => confirm.promise);
    let settled: unknown;
    const job = runDeploymentRollback(capture(), { ...options, fetchImpl }).then((outcome) => { settled = outcome; });
    try {
      await watchdog(advance(150_000)); prepare.resolve(serverReply("prepared", { key: "same-key" }));
      await watchdog(advance(0)); expect(fetchImpl).toHaveBeenCalledTimes(2);
      await watchdog(advance(29_999)); expect(settled).toBeUndefined();
      await watchdog(advance(1)); expect(settled).toMatchObject({ kind: "error", retryable: true, correlationId: CONTEXT.correlationId });
    } finally { prepare.resolve(serverReply("prepared", { key: "same-key" })); confirm.resolve(serverReply("pending", { key: "same-key" })); await watchdog(job); }
  });
  it.each([
    ["preparation", "fetch"], ["preparation", "body"],
    ["confirmed", "fetch"], ["confirmed", "body"]
  ])("settles ignored-abort %s %s at 180s and discards the late reply", async (phase, stage) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const attempt = capture(), late = deferred<Response>(), body = deferred<unknown>();
    const calls: RecordedRequest[] = [];
    const lateReply = serverReply(phase === "preparation" ? "prepared" : "completed-replay", { key: "same-key" });
    const lateRaw = await lateReply.json(); // Fixtures must override json immediately; no native stream.
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      record(calls, url, init);
      if (phase === "confirmed" && calls.length === 1) return serverReply("prepared", { key: "same-key" });
      if (stage === "fetch") return late.promise;
      lateReply.json = () => body.promise; return lateReply;
    });
    let settled: unknown;
    const job = runDeploymentRollback(attempt, { ...options, fetchImpl }).then((outcome) => { settled = outcome; });
    try {
      await watchdog(advance(150_000)); expect(settled).toBeUndefined();
      await watchdog(advance(30_000));
      expect(settled).toMatchObject({ kind: "error", retryable: true });
      expect(calls.at(-1)!.init.signal?.aborted).toBe(true);
      if (phase === "confirmed") expect(settled).toMatchObject({ correlationId: CONTEXT.correlationId });
      const boundedOutcome = settled; late.resolve(lateReply); body.resolve(lateRaw);
      await watchdog(advance(0)); expect(settled).toBe(boundedOutcome);
      expect(fetchImpl).toHaveBeenCalledTimes(phase === "confirmed" ? 2 : 1);
      expect(attempt).toMatchObject({ activeDeploymentId: "A", historicalDeploymentId: "H", idempotencyKey: "same-key", confirmation: { unresolved: true } });
      if (phase === "confirmed") expect(attempt.confirmation.id).toBe(CONTEXT.confirmationId);
    } finally { late.resolve(lateReply); body.resolve(lateRaw); await watchdog(job); }
  });
  it.each(["expired", "rejected"] as const)("allows an explicit new preparation only after conclusive %s", async (kind) => {
    const attempt = capture();
    const fetchImpl = vi.fn().mockResolvedValueOnce(serverReply("prepared", { key: "same-key" })).mockResolvedValueOnce(serverReply(kind, { key: "same-key" }));
    expect(await runDeploymentRollback(attempt, { ...options, fetchImpl })).toMatchObject({ kind: "error", retryable: false, canPrepareNew: true });
  });
  it("preserves unknown identity when later confirmation expires", async () => {
    const attempt = capture();
    await runDeploymentRollback(attempt, { ...options, fetchImpl: vi.fn().mockResolvedValueOnce(serverReply("prepared", { key: "same-key" })).mockRejectedValueOnce(new Error("lost")) });
    const outcome = await runDeploymentRollback(attempt, { ...options, fetchImpl: async () => serverReply("expired", { key: "same-key" }) });
    expect(outcome).toMatchObject({ retryable: true }); expect(outcome.canPrepareNew).not.toBe(true);
    expect(attempt).toMatchObject({ activeDeploymentId: "A", historicalDeploymentId: "H", snapshotHash: H_HASH, idempotencyKey: "same-key", confirmation: { id: CONTEXT.confirmationId } });
  });
});

describe("rollback received evidence and preserved A/H history", () => {
  it.each(["wrong-A", "wrong-H", "wrong-R", "wrong-project", "wrong-hash", "wrong-origin", "malformed"] as const)("fails closed for %s evidence", async (kind) => {
    const outcome = await runDeploymentRollback(capture(), { ...options, fetchImpl: async () => serverReply(kind, { key: "same-key" }) });
    expect(outcome).toMatchObject({ kind: "error", retryable: true });
    expect(outcome.message).not.toContain("secret-never-display");
  });
  it.each(["succeeded", "failed", "canceled"] as const)("reports R %s without rewriting A or H", async (status) => {
    const A = execution("A"), H = execution("H", true), before = structuredClone([A, H]);
    const attempt = createRollbackAttempt(A, H, "A", "same-key")!;
    const outcome = await runDeploymentRollback(attempt, { ...options, fetchImpl: async () => serverReply(status, { key: "same-key" }) });
    expect(outcome).toMatchObject({ kind: "completed", deploymentId: SERVER_R });
    expect(outcome.message).toContain(status); expect([A, H]).toEqual(before);
    if (status !== "succeeded") {
      expect(outcome.message).not.toMatch(/restored H|H is active/i);
      expect(await runDeploymentRollback(capture(), { ...options, fetchImpl: async () => serverReply(status, { key: "same-key", terminalFault: "valid-extra" }) })).toMatchObject({ kind: "completed" });
      expect(await runDeploymentRollback(capture(), { ...options, fetchImpl: async () => serverReply(status, { key: "same-key", terminalFault: "proven-failure" }) })).toMatchObject({ kind: "error" });
    } else {
      for (const terminalFault of ["missing-candidate", "missing-runtime"] as const) {
        expect(await runDeploymentRollback(capture(), { ...options, fetchImpl: async () => serverReply(status, { key: "same-key", terminalFault }) })).toMatchObject({ kind: "error" });
      }
    }
  });
  it("reports stored replay as command evidence rather than inferred runtime success", async () => {
    const fetchImpl = vi.fn(async () => serverReply("completed-replay", { key: "same-key" }));
    const outcome = await runDeploymentRollback(capture(), { ...options, fetchImpl });
    expect(outcome).toMatchObject({ kind: "completed", deploymentId: SERVER_R });
    expect(outcome.message).not.toContain("succeeded"); expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it("keeps unsupported historical configuration authoritative at the server", async () => {
    const attempt = capture();
    const outcome = await runDeploymentRollback(attempt, { ...options, fetchImpl: async () => serverReply("unsupported-history", { key: "same-key" }) });
    expect(outcome.kind).toBe("error"); expect(outcome.message).not.toMatch(/restored|succeeded/i);
  });
});


describe("rollback source integration corrections", () => {
  it.each([
    ["failed", "candidate"], ["canceled", "candidate"],
    ["failed", "container-port"], ["canceled", "container-port"],
    ["failed", "host-port"], ["canceled", "host-port"],
    ["failed", "network"], ["canceled", "network"]
  ] as const)("validates supplied %s receipt %s against captured bindings", async (status, terminalFault) => {
    expect(await runDeploymentRollback(capture(), { ...options, fetchImpl: async () => serverReply(status, { key: "same-key", terminalFault }) })).toMatchObject({ kind: "error", retryable: true });
  });
  it("recovers the same key after unreserved HTTP500 C1, then binds preparation and terminal C2", async () => {
    const attempt = capture(), calls: RecordedRequest[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      record(calls, url, init);
      return serverReply(calls.length === 1 ? "storage-error" : calls.length === 2 ? "prepared" : "succeeded",
        { key: "same-key", correlationId: calls.length === 1 ? "diagnostic-C1" : "command-C2", requestId: `request-${calls.length}` });
    });
    const error = await runDeploymentRollback(attempt, { ...options, fetchImpl });
    expect(error).toMatchObject({ kind: "error", retryable: true, correlationId: "diagnostic-C1", requestId: "request-1" });
    const unreserved = structuredClone(attempt.confirmation);
    expect(await runDeploymentRollback(attempt, { ...options, fetchImpl })).toMatchObject({ kind: "completed", correlationId: "command-C2", deploymentId: SERVER_R });
    expect(unreserved.correlationId).toBeUndefined(); expect(unreserved.commandId).toBeUndefined();
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.url).toBe("https://api.test/api/v1/deployments/A/rollback");
      expect(requestBody(call)).toEqual({ historicalDeploymentId: "H", snapshotHash: H_HASH });
      expect(requestHeader(call, "x-control-idempotency-key")).toBe("same-key");
    }
    expect(requestHeader(calls[1]!, "x-control-confirmation-id")).toBeNull();
    expect(requestHeader(calls[2]!, "x-control-confirmation-id")).toBe(CONTEXT.confirmationId);
    expect(attempt.confirmation).toMatchObject({ commandId: CONTEXT.commandId, deploymentId: SERVER_R, correlationId: "command-C2", unresolved: true });
  });
  it.each(["completed-replay", "succeeded"] as const)("binds correlation only after valid direct %s evidence", async (kind) => {
    const attempt = capture();
    expect(await runDeploymentRollback(attempt, { ...options, fetchImpl: async () => serverReply(kind, { key: "same-key", correlationId: "command-C2" }) })).toMatchObject({ kind: "completed" });
    expect(attempt.confirmation).toMatchObject({ commandId: CONTEXT.commandId, deploymentId: SERVER_R, correlationId: "command-C2" });
  });
  it.each(["prepared", "pending", "completed-replay", "succeeded"] as const)("rejects changed %s correlation after a bound reservation", async (kind) => {
    const attempt = capture();
    await runDeploymentRollback(attempt, { ...options, fetchImpl: async () => serverReply("pending", { key: "same-key", correlationId: "original-command" }) });
    const outcome = await runDeploymentRollback(attempt, { ...options, fetchImpl: async () => serverReply(kind, { key: "same-key", correlationId: "changed-command" }) });
    expect(outcome).toMatchObject({ kind: "error", retryable: true, correlationId: "original-command" });
    expect(attempt.confirmation).toMatchObject({ commandId: CONTEXT.commandId, deploymentId: SERVER_R, correlationId: "original-command", unresolved: true });
    expect(attempt.confirmation.id).toBeUndefined();
  });
});
