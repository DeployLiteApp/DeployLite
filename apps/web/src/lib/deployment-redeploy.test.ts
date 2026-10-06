import { setTimeout as nativeFixtureTimer, clearTimeout as nativeFixtureClear, setImmediate as nativeFixtureTick } from "node:timers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Deployment } from "@deploylite/contracts";
import { createRedeployAttempt, runDeploymentRedeploy, type RedeployAttempt } from "./deployment-redeploy";

const hash = "a".repeat(64), digest = `sha256:${"b".repeat(64)}`, image = `registry.example.com/team/app@${digest}`;
function source(): Deployment {
  return { id: "dep-A", projectId: "project", agentId: "agent", status: "succeeded", commitSha: "abcdef1", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:01:00.000Z", snapshotOriginId: "dep-A", snapshotHash: hash,
    stopTarget: { candidateId: "dep-A:candidate:command", effectiveImage: image },
    executionReceipt: { schemaVersion: 1, deploymentId: "dep-A", projectId: "project", candidateId: "dep-A:candidate:command", snapshotOriginId: "dep-A", snapshotHash: hash, effectiveImageDigest: digest, runtimeHost: "agent", container: "deploylite-active-dep-A", containerId: "physical-A", hostPort: 49170, containerPort: 8080, network: null } };
}
const attempt = (): RedeployAttempt => ({ sourceDeploymentId: "dep-A", projectId: "project", snapshotHash: hash, snapshotOriginId: "dep-A", runtimeHost: "agent", effectiveImageDigest: digest, idempotencyKey: "key", confirmation: {} });
const envelope = (data: unknown, status = 200) => {
  const body = JSON.stringify({ data, error: null, requestId: "req" });
  const response = new Response(body, { status });
  response.json = async () => JSON.parse(body); // No native stream wait under the prospective fake clock.
  return response;
};
const prepared = () => envelope({ commandId: "cmd", confirmationId: "confirm", confirmationRequired: true, correlationId: "corr" }, 202);
const result = (reason: string | null = null) => ({ commandId: "cmd", action: "deployment.redeploy", projectId: "project", sourceDeploymentId: "dep-A", deploymentId: "dep-B", snapshotHash: hash, status: "completed", correlationId: "corr", reason });
const stored = (status = "completed") => ({ id: "cmd", actorId: "actor", action: "deployment.redeploy", scope: { kind: "deployment", projectId: "project", deploymentId: "dep-A" }, inputDigest: hash, idempotencyKey: "key", correlationId: "corr", status, expiresAt: "2026-01-01T00:15:00.000Z", result: { ...result(), status: status === "completed" ? "completed" : "eligible" } });
const replay = () => ({ command: stored(), deploymentId: "dep-B", snapshotHash: hash, idempotent: true });
function terminal(status: "succeeded" | "failed" | "canceled" = "succeeded") {
  const A = source(), B = { ...A, id: "dep-B", status, sourceDeploymentId: A.id, stopTarget: { ...A.stopTarget!, candidateId: "dep-B:candidate:command" }, executionReceipt: status === "succeeded" ? { ...A.executionReceipt!, deploymentId: "dep-B", candidateId: "dep-B:candidate:command", containerId: "physical-B", container: "deploylite-active-dep-B" } : undefined };
  return { deployment: B, command: result(status === "succeeded" ? null : `agent-${status}`), snapshotHash: hash, sourceDeploymentId: A.id,
    execution: { deploymentId: B.id, projectId: B.projectId, sourceDeploymentId: A.id, snapshotHash: hash, correlationId: "corr", candidateId: B.stopTarget.candidateId, effectiveImage: image, runtimePort: 8080, runtimeConfig: { hostPort: 49170, containerPort: 8080 }, terminalStatus: status, health: status === "succeeded" ? "passed" : "failed", proven: status === "succeeded", executionReceipt: B.executionReceipt, rollback: { target: status === "succeeded" ? null : image, result: status === "succeeded" ? "not-required" : "restored" } } };
}

describe("redeploy selected-source and authenticated request boundary", () => {
  it("captures only supported bound metadata for the explicit source, without asserting active ownership", () => {
    const A = source(); const captured = createRedeployAttempt(A, "dep-A", "key");
    expect(captured).toMatchObject(attempt());
    A.snapshotHash = "c".repeat(64); A.executionReceipt!.containerId = "changed";
    expect(captured!.snapshotHash).toBe(hash); expect(Object.isFrozen(captured)).toBe(true);
  });
  it.each(["legacy", "different-source", "status", "origin", "project", "host", "candidate", "digest", "version"])("fails closed for %s metadata", (fault) => {
    const A = source(); let expected = "dep-A";
    if (fault === "legacy") delete A.executionReceipt;
    if (fault === "different-source") expected = "dep-other";
    if (fault === "status") A.status = "running";
    if (fault === "origin") A.snapshotOriginId = "other";
    if (fault === "project") A.executionReceipt!.projectId = "other";
    if (fault === "host") A.agentId = "other";
    if (fault === "candidate") A.stopTarget!.candidateId = "other";
    if (fault === "digest") A.stopTarget!.effectiveImage = image.replace(digest, `sha256:${"d".repeat(64)}`);
    if (fault === "version") Object.assign(A.executionReceipt!, { schemaVersion: 2 });
    expect(createRedeployAttempt(A, expected, "key")).toBeNull();
  });
  it("prepares and confirms exactly the same encoded source/hash/key using session credentials", async () => {
    const captured = attempt(); const calls: Request[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => { calls.push(new Request(String(url), init)); return calls.length === 1 ? prepared() : envelope(terminal()); });
    const outcome = await runDeploymentRedeploy(captured, { apiBaseUrl: "https://api.test", fetchImpl });
    expect(outcome).toMatchObject({ kind: "completed", deploymentId: "dep-B", requestId: "req", correlationId: "corr" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const request of calls) { expect(request.url).toBe("https://api.test/api/v1/deployments/dep-A/redeploy"); expect(request.credentials).toBe("include"); expect(request.headers.get("x-control-idempotency-key")).toBe("key"); expect(await request.json()).toEqual({ snapshotHash: hash }); }
    expect(calls[0]!.headers.has("x-control-confirmation-id")).toBe(false); expect(calls[1]!.headers.get("x-control-confirmation-id")).toBe("confirm");
    const odd = { ...attempt(), sourceDeploymentId: "dep/A?x" }; const encoded = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => envelope(replay()));
    await runDeploymentRedeploy(odd, { apiBaseUrl: "https://api.test", fetchImpl: encoded });
    expect(String(encoded.mock.calls[0]?.[0])).toContain("dep%2FA%3Fx/redeploy");
  });
  it("captures input before awaits and retains confirmation for a same-request uncertain retry", async () => {
    const captured = attempt(); const calls: Request[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(String(url), init));
      if (calls.length === 1) { Object.assign(captured, { sourceDeploymentId: "changed", snapshotHash: "c".repeat(64), idempotencyKey: "changed" }); return prepared(); }
      throw new Error("fixture-only transport lost reply");
    });
    expect(await runDeploymentRedeploy(captured, { apiBaseUrl: "https://api.test", fetchImpl })).toMatchObject({ kind: "error", retryable: true });
    expect(calls).toHaveLength(2); expect(calls[1]!.url).toContain("dep-A/redeploy"); expect(await calls[1]!.json()).toEqual({ snapshotHash: hash }); expect(calls[1]!.headers.get("x-control-idempotency-key")).toBe("key");
    const stable = createRedeployAttempt(source(), "dep-A", "key")!;
    const lost = vi.fn().mockResolvedValueOnce(prepared()).mockRejectedValueOnce(new Error("lost"));
    expect(await runDeploymentRedeploy(stable, { apiBaseUrl: "https://api.test", fetchImpl: lost })).toMatchObject({ requestId: "req", correlationId: "corr", retryable: true });
    const retry = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => envelope(replay()));
    expect(await runDeploymentRedeploy(stable, { apiBaseUrl: "https://api.test", fetchImpl: retry })).toMatchObject({ kind: "completed", deploymentId: "dep-B" });
    expect(retry).toHaveBeenCalledTimes(1); expect(new Headers(retry.mock.calls[0]?.[1]?.headers).get("x-control-confirmation-id")).toBe("confirm");
  });
  it.each([false, true])("accepts stored pending with optional execution=%s, without claiming terminal success", async (withDeployment) => {
    const data = { command: stored("dispatching"), pending: true, correlationId: "request-corr", ...(withDeployment ? { deployment: { ...terminal().deployment, status: "running", finishedAt: null, executionReceipt: undefined } } : {}) };
    const fetchImpl = vi.fn(async () => envelope(data, 202));
    expect(await runDeploymentRedeploy(attempt(), { apiBaseUrl: "https://api.test", fetchImpl })).toMatchObject({ kind: "pending", deploymentId: "dep-B", correlationId: "corr", retryable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each(["succeeded", "failed", "canceled"] as const)("reports received terminal %s truthfully, preserving historical input", async (status) => {
    const A = source(); const before = structuredClone(A);
    const outcome = await runDeploymentRedeploy(attempt(), { apiBaseUrl: "https://api.test", fetchImpl: async () => envelope(terminal(status)) });
    expect(outcome.kind).toBe("completed"); expect(outcome.message).toContain(status); expect(outcome.deploymentId).toBe("dep-B"); expect(A).toEqual(before);
  });
  it("accepts completed stored replay as a command result, without inferring runtime success", async () => {
    const fetchImpl = vi.fn(async () => envelope(replay()));
    const outcome = await runDeploymentRedeploy(attempt(), { apiBaseUrl: "https://api.test", fetchImpl });
    expect(outcome).toMatchObject({ kind: "completed", deploymentId: "dep-B" }); expect(outcome.message).not.toContain("succeeded"); expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each(["scope", "key", "hash", "result-id", "status", "extra", "proof"])("rejects mismatched or malformed %s response", async (fault) => {
    const data = replay(); let payload: unknown = data;
    if (fault === "scope") data.command.scope.deploymentId = "other";
    if (fault === "key") data.command.idempotencyKey = "other";
    if (fault === "hash") data.snapshotHash = "c".repeat(64);
    if (fault === "result-id") data.command.result.deploymentId = "other";
    if (fault === "status") data.command.status = "eligible";
    if (fault === "extra") payload = { ...data, unsupported: "secret-never-display" };
    if (fault === "proof") { const value = terminal(); value.deployment.executionReceipt!.snapshotOriginId = "other"; payload = value; }
    const outcome = await runDeploymentRedeploy(attempt(), { apiBaseUrl: "https://api.test", fetchImpl: async () => envelope(payload) });
    expect(outcome).toMatchObject({ kind: "error", retryable: true }); expect(outcome.message).toContain("invalid"); expect(outcome.message).not.toContain("secret-never-display");
  });
  it.each([401, 403, 409, 502, 503])("uses safe authoritative error feedback for HTTP%s", async (status) => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: null, error: { code: status === 409 ? "CONFIRMATION_EXPIRED" : "REDEPLOY_OUTCOME_UNKNOWN", message: "secret-never-display", correlationId: "error-corr" }, requestId: "error-req" }), { status }));
    const outcome = await runDeploymentRedeploy(attempt(), { apiBaseUrl: "https://api.test", fetchImpl });
    expect(outcome).toMatchObject({ kind: "error", requestId: "error-req", correlationId: "error-corr", retryable: status >= 500 });
    expect(outcome.message).not.toContain("secret-never-display"); expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("performs no request without API configuration and treats unreadable responses as uncertain", async () => {
    const fetchImpl = vi.fn(); expect(await runDeploymentRedeploy(attempt(), { apiBaseUrl: null, fetchImpl })).toMatchObject({ kind: "error", retryable: false }); expect(fetchImpl).not.toHaveBeenCalled();
    const unreadable = await runDeploymentRedeploy(attempt(), { apiBaseUrl: "https://api.test", fetchImpl: async () => new Response("not-json", { status: 200 }) });
    expect(unreadable).toMatchObject({ kind: "error", retryable: true });
  });
});

afterEach(() => vi.useRealTimers());
function advanceClientClock(milliseconds: number): Promise<void> {
  vi.advanceTimersByTime(milliseconds);
  return new Promise((resolve) => nativeFixtureTick(resolve));
}
function fixtureWait<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const watchdog = new Promise<never>((_, reject) => { timer = nativeFixtureTimer(() => reject(new Error("Invalid fake-clock fixture stalled")), 2_000); });
  return Promise.race([work, watchdog]).finally(() => nativeFixtureClear(timer));
}

describe("review correction: finite total wait and fresh-attempt authority", () => {
  it.each([
    ["preparation", "fetch"], ["preparation", "body"],
    ["confirmed", "fetch"], ["confirmed", "body"]
  ])("bounds stalled %s %s even when abort is ignored, and ignores its late reply", async (phase, stage) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const captured = createRedeployAttempt(source(), "dep-A", "bounded-key")!;
    const calls: Request[] = []; let release!: () => void; let settled: unknown;
    const late = phase === "preparation" ? prepared() : envelope(terminal());
    const lateRaw = await fixtureWait(late.json());
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(String(url), init));
      if (phase === "confirmed" && calls.length === 1) return prepared();
      if (calls.length > (phase === "confirmed" ? 2 : 1)) return envelope(terminal());
      if (stage === "fetch") return new Promise<Response>((resolve) => { release = () => resolve(late); });
      const response = new Response("", { status: late.status });
      response.json = () => new Promise<unknown>((resolve) => { release = () => resolve(lateRaw); });
      return response;
    });
    const job = runDeploymentRedeploy(captured, { apiBaseUrl: "https://api.test", fetchImpl }).then((value) => { settled = value; return value; });
    try {
      await fixtureWait(advanceClientClock(150_000));
      expect(settled).toBeUndefined(); // The client wait accommodates execution plus recovery.
      await fixtureWait(advanceClientClock(30_000));
      expect(settled).toMatchObject({ kind: "error", retryable: true });
      expect(calls.at(-1)!.signal.aborted).toBe(true);
      if (phase === "confirmed") expect(settled).toMatchObject({ requestId: "req", correlationId: "corr" });
      const bounded = settled;
      release(); await fixtureWait(advanceClientClock(0));
      expect(settled).toBe(bounded); expect(fetchImpl).toHaveBeenCalledTimes(phase === "confirmed" ? 2 : 1);
      const retryCalls: Request[] = [];
      const retry = async (url: RequestInfo | URL, init?: RequestInit) => {
        retryCalls.push(new Request(String(url), init));
        if (phase === "preparation" && retryCalls.length === 1) return prepared();
        return envelope({ ...replay(), command: { ...stored(), idempotencyKey: "bounded-key" } });
      };
      expect(await runDeploymentRedeploy(captured, { apiBaseUrl: "https://api.test", fetchImpl: retry })).toMatchObject({ kind: "completed" });
      expect(retryCalls[0]!.headers.get("x-control-idempotency-key")).toBe("bounded-key");
      expect(retryCalls[0]!.url).toBe(calls[0]!.url);
      expect(await retryCalls[0]!.json()).toEqual({ snapshotHash: hash });
      expect(retryCalls.at(-1)!.headers.get("x-control-confirmation-id")).toBe("confirm");
    } finally { release?.(); await fixtureWait(job); vi.useRealTimers(); }
  });

  it("uses one budget across preparation and confirmation rather than restarting its timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    let prepareReply!: (value: Response) => void, confirmedReply!: (value: Response) => void;
    const fetchImpl = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { prepareReply = resolve; }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { confirmedReply = resolve; }));
    let settled: unknown;
    const job = runDeploymentRedeploy(attempt(), { apiBaseUrl: "https://api.test", fetchImpl }).then((value) => { settled = value; });
    try {
      await fixtureWait(advanceClientClock(150_000)); prepareReply(prepared()); await fixtureWait(advanceClientClock(0));
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      await fixtureWait(advanceClientClock(29_999)); expect(settled).toBeUndefined();
      await fixtureWait(advanceClientClock(1)); expect(settled).toMatchObject({ retryable: true, requestId: "req", correlationId: "corr" });
    } finally { prepareReply?.(prepared()); await fixtureWait(advanceClientClock(0)); confirmedReply?.(envelope(terminal())); await fixtureWait(job); vi.useRealTimers(); }
  });

  it.each(["CONFIRMATION_EXPIRED", "CONFIRMATION_REJECTED"])("permits explicit fresh preparation only after conclusive %s", async (code) => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(prepared()).mockResolvedValueOnce(new Response(JSON.stringify({ data: null, error: { code, message: "redacted", correlationId: "corr" }, requestId: "rejected" }), { status: 409 }));
    expect(await runDeploymentRedeploy(attempt(), { apiBaseUrl: "https://api.test", fetchImpl })).toMatchObject({ kind: "error", retryable: false, canPrepareNew: true });
  });

  it("does not turn an unknown attempt into a fresh preparation after a later rejection", async () => {
    const captured = attempt();
    await runDeploymentRedeploy(captured, { apiBaseUrl: "https://api.test", fetchImpl: vi.fn().mockResolvedValueOnce(prepared()).mockRejectedValueOnce(new Error("lost")) });
    const retry = vi.fn(async () => new Response(JSON.stringify({ data: null, error: { code: "CONFIRMATION_EXPIRED", message: "redacted", correlationId: "corr" }, requestId: "retry" }), { status: 409 }));
    const denied = await runDeploymentRedeploy(captured, { apiBaseUrl: "https://api.test", fetchImpl: retry });
    expect(denied).toMatchObject({ kind: "error", retryable: true });
    expect(denied).not.toHaveProperty("canPrepareNew", true);
    expect(captured).toMatchObject({ idempotencyKey: "key", snapshotHash: hash, confirmation: { id: "confirm", commandId: "cmd" } });
  });
});

it("accepts original cached-recovery pending without redundant outer correlation", async () => {
  const captured = attempt();
  Object.assign(captured.confirmation, { id: "confirm", commandId: "cmd", requestId: "prepare-req", correlationId: "corr", unresolved: true });
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => envelope({ command: stored("dispatching"), pending: true }, 202));
  expect(await runDeploymentRedeploy(captured, { apiBaseUrl: "https://api.test", fetchImpl })).toMatchObject({ kind: "pending", retryable: true, requestId: "req", correlationId: "corr", deploymentId: "dep-B" });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const [url, init] = fetchImpl.mock.calls[0]!;
  expect(String(url)).toBe("https://api.test/api/v1/deployments/dep-A/redeploy");
  expect(new Headers(init?.headers).get("x-control-confirmation-id")).toBe("confirm");
  expect(new Headers(init?.headers).get("x-control-idempotency-key")).toBe("key");
  expect(JSON.parse(String(init?.body))).toEqual({ snapshotHash: hash });
  expect(captured).toMatchObject({ sourceDeploymentId: "dep-A", projectId: "project", snapshotHash: hash, idempotencyKey: "key", confirmation: { id: "confirm", commandId: "cmd", requestId: "req", correlationId: "corr", unresolved: true } });
});
