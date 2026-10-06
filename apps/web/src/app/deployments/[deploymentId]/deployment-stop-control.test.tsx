// @vitest-environment jsdom
import { setTimeout as nativeFixtureTimer, clearTimeout as nativeFixtureClear, setImmediate as nativeFixtureTick } from "node:timers";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Deployment } from "@deploylite/contracts";
import { DeploymentStopControl, runDeploymentStop } from "./deployment-stop-control";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const deployment: Deployment = { id: "dep-1", projectId: "project-1", agentId: "agent-1", status: "running", commitSha: "abcdef1", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: null, stopTarget: { candidateId: "dep-1:candidate:cmd", effectiveImage: `registry.example.com/team/app@sha256:${"a".repeat(64)}` } };
// Native Request snapshots cannot consume a jsdom AbortSignal; retain the actual fetch input separately.
const originalFetchInit = new WeakMap<Request, RequestInit | undefined>();
function recordFetchRequest(url: RequestInfo | URL, init?: RequestInit): Request {
  const request = new Request(String(url), { ...init, signal: undefined });
  originalFetchInit.set(request, init);
  return request;
}

afterEach(() => { cleanup(); vi.useRealTimers(); });
const envelope = (data: unknown) => {
  const body = JSON.stringify({ data, error: null, requestId: "req-1" });
  const response = new Response(body, { status: 202 });
  response.json = async () => JSON.parse(body);
  return response;
};

describe("DeploymentStopControl", () => {
  it("limits visibility to queued/running admin and operator users", () => {
    const { rerender } = render(<DeploymentStopControl deployment={deployment} role="read-only" apiBaseUrl="https://api.test" />);
    expect(screen.queryByTestId("deployment-stop-trigger")).toBeNull();
    rerender(<DeploymentStopControl deployment={{ ...deployment, status: "queued" }} role="admin" apiBaseUrl="https://api.test" />);
    expect(screen.queryByTestId("deployment-stop-trigger")).toBeNull();
    rerender(<DeploymentStopControl deployment={{ ...deployment, status: "succeeded" }} role="admin" apiBaseUrl="https://api.test" />);
    expect(screen.queryByTestId("deployment-stop-trigger")).toBeNull();
    rerender(<DeploymentStopControl deployment={deployment} role="operator" apiBaseUrl="https://api.test" />);
    expect(screen.getByRole("button", { name: "Stop deployment" })).toBeTruthy();
  });

  it("supports keyboard confirmation and sends the exact two-request contract once", async () => {
    const user = userEvent.setup(); const calls: Request[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => { calls.push(recordFetchRequest(_url, init)); return calls.length === 1 ? envelope({ commandId: "cmd-1", confirmationId: "confirm-1", confirmationRequired: true }) : new Response(JSON.stringify({ data: { deployment }, error: null, requestId: "req-2" }), { status: 200 }); });
    render(<DeploymentStopControl deployment={deployment} role="admin" apiBaseUrl="https://api.test" fetchImpl={fetchImpl} />);
    await user.click(screen.getByRole("button", { name: "Stop deployment" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Stop deployment" }));
    await user.click(screen.getByRole("button", { name: "Confirm stop deployment" }));
    await vi.waitFor(() => expect(screen.getByTestId("deployment-stop-result")).toBeTruthy());
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(calls[0]!.headers.get("x-control-idempotency-key")).toBe(calls[1]!.headers.get("x-control-idempotency-key"));
    expect(calls[1]!.headers.get("x-control-confirmation-id")).toBe("confirm-1");
  });

  it("suppresses duplicate submission while pending and keeps failure feedback", async () => {
    let resolve!: (response: Response) => void; const fetchImpl = vi.fn(() => new Promise<Response>((done) => { resolve = done; }));
    const user = userEvent.setup(); render(<DeploymentStopControl deployment={deployment} role="admin" apiBaseUrl="https://api.test" fetchImpl={fetchImpl} />);
    await user.click(screen.getByRole("button", { name: "Stop deployment" }));
    await user.click(screen.getByRole("button", { name: "Confirm stop deployment" }));
    await user.click(screen.getByRole("button", { name: "Stopping deployment…" }));
    expect(fetchImpl).toHaveBeenCalledTimes(1); resolve(new Response("", { status: 403 }));
    await vi.waitFor(() => expect(screen.getByTestId("deployment-stop-result")).toBeTruthy());
    expect(screen.getByText("You are not authorized to stop this deployment. Refresh your session or access.")).toBeTruthy();
  });

  it("keeps a final pending response in progress and rejects malformed success envelopes", async () => {
    const pending = await runDeploymentStop({ deploymentId: "dep-1", apiBaseUrl: "https://api.test", idempotencyKey: "pending", fetchImpl: async () => new Response(JSON.stringify({ data: { commandId: "cmd-1", confirmationId: "confirm-1", confirmationRequired: true }, error: null, requestId: "req-1" }), { status: 202 }) });
    expect(pending.kind).toBe("error");
    const finalPending = await runDeploymentStop({ deploymentId: "dep-1", apiBaseUrl: "https://api.test", idempotencyKey: "pending", fetchImpl: vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: { commandId: "cmd-1", confirmationId: "confirm-1", confirmationRequired: true }, error: null, requestId: "req-1" }), { status: 202 })).mockResolvedValueOnce(new Response(JSON.stringify({ data: { commandId: "cmd-1", pending: true }, error: null, requestId: "req-2" }), { status: 202 })) });
    expect(finalPending).toMatchObject({ kind: "pending", message: "Stop request is pending. Refresh deployment evidence for the final status." });
    const malformed = await runDeploymentStop({ deploymentId: "dep-1", apiBaseUrl: "https://api.test", idempotencyKey: "bad", fetchImpl: async () => new Response(JSON.stringify({ data: { deployment }, error: null, requestId: "req-1" }), { status: 200 }) });
    expect(malformed.message).toBe("The stop response was invalid. Check the same request and refresh deployment evidence.");
  });

  it("classifies explicit 409 outcomes and accepts an already-stopped receipt", async () => {
    const conflict = (code: string) => runDeploymentStop({ deploymentId: "dep-1", apiBaseUrl: "https://api.test", idempotencyKey: code, fetchImpl: async () => new Response(JSON.stringify({ data: null, error: { code, message: "request rejected", correlationId: "corr-1" }, requestId: "req-1" }), { status: 409 }) });
    await expect(conflict("CONFIRMATION_EXPIRED")).resolves.toMatchObject({ message: "Confirmation was rejected or expired. Refresh deployment evidence before preparing another request." });
    await expect(conflict("IDEMPOTENCY_CONFLICT")).resolves.toMatchObject({ message: "This stop attempt conflicts with another request. Refresh deployment evidence." });
    await expect(conflict("COMMAND_PENDING")).resolves.toMatchObject({ kind: "error", message: "Stop request is pending. Refresh deployment evidence for the final status." });
    await expect(conflict("DEPLOYMENT_TERMINAL")).resolves.toMatchObject({ message: "This deployment is already terminal. Refresh deployment evidence to reconcile the current status." });
    const alreadyStopped = await runDeploymentStop({ deploymentId: "dep-1", apiBaseUrl: "https://api.test", idempotencyKey: "already", fetchImpl: async () => new Response(JSON.stringify({ data: { deployment: { ...deployment, status: "canceled", finishedAt: "2026-01-01T00:01:00.000Z" }, receipt: { schemaVersion: 1, action: "deployment.stop", agentId: "agent-1", commandId: "cmd-1", projectId: "project-1", deploymentId: "dep-1", candidateId: deployment.stopTarget!.candidateId, effectiveImage: deployment.stopTarget!.effectiveImage, status: "already-stopped", redacted: true, correlationId: "corr-1", reason: null }, command: { commandId: "cmd-1", action: "deployment.stop", projectId: "project-1", deploymentId: "dep-1", status: "completed", correlationId: "corr-1", reason: "already-stopped" } }, error: null, requestId: "req-1" }), { status: 200 }) });
    expect(alreadyStopped).toMatchObject({ kind: "success", message: "The deployment was already stopped. Refreshing deployment evidence." });
  });

  it("accepts only the completed idempotent replay envelope", async () => {
    const replay = { deployment: { ...deployment, status: "canceled" as const, finishedAt: "2026-01-01T00:01:00.000Z" }, command: { commandId: "cmd-1", action: "deployment.stop" as const, projectId: "project-1", deploymentId: "dep-1", status: "completed" as const, correlationId: "corr-1", reason: null }, idempotent: true };
    await expect(runDeploymentStop({ deploymentId: "dep-1", apiBaseUrl: "https://api.test", idempotencyKey: "replay", fetchImpl: async () => new Response(JSON.stringify({ data: replay, error: null, requestId: "req-1" }), { status: 200 }) })).resolves.toMatchObject({ kind: "success", message: "Stop was already confirmed by the server. Refreshing deployment evidence." });
    for (const data of [
      { ...replay, command: { ...replay.command, status: "eligible" } },
      { ...replay, deployment: { ...replay.deployment, status: "running" } },
      { ...replay, extra: "unexpected" }
    ]) {
      await expect(runDeploymentStop({ deploymentId: "dep-1", apiBaseUrl: "https://api.test", idempotencyKey: "malformed", fetchImpl: async () => new Response(JSON.stringify({ data, error: null, requestId: "req-1" }), { status: 200 }) })).resolves.toMatchObject({ kind: "error", message: "The stop response was invalid. Check the same request and refresh deployment evidence." });
    }
  });
});

function advanceClientClock(milliseconds: number): Promise<void> {
  vi.advanceTimersByTime(milliseconds);
  return new Promise((resolve) => nativeFixtureTick(resolve));
}
const flushFixture = () => new Promise<void>((resolve) => nativeFixtureTick(resolve));
function fixtureWait<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const watchdog = new Promise<never>((_, reject) => { timer = nativeFixtureTimer(() => reject(new Error("Invalid fake-clock fixture stalled")), 2_000); });
  return Promise.race([work, watchdog]).finally(() => nativeFixtureClear(timer));
}

describe("review correction: bounded Stop and preserved attempt", () => {
  it.each([
    ["preparation", "fetch"], ["preparation", "body"],
    ["confirmed", "fetch"], ["confirmed", "body"]
  ])("bounds stalled %s %s without mistaking browser abort for an outcome", async (phase, stage) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const confirmation = {}; const calls: Request[] = []; let release!: () => void; let settled: unknown;
    const preparation = envelope({ commandId: "cmd-1", confirmationId: "confirm-1", confirmationRequired: true });
    const late = phase === "preparation" ? preparation : stopSuccess(); const raw = await fixtureWait(late.json());
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(recordFetchRequest(url, init));
      if (phase === "confirmed" && calls.length === 1) return preparation;
      if (calls.length > (phase === "confirmed" ? 2 : 1)) return stopSuccess();
      if (stage === "fetch") return new Promise<Response>((resolve) => { release = () => resolve(late); });
      const response = new Response("", { status: late.status });
      response.json = () => new Promise<unknown>((resolve) => { release = () => resolve(raw); });
      return response;
    });
    const options = { deploymentId: deployment.id, expectedDeployment: successfulDeployment, apiBaseUrl: "https://api.test", idempotencyKey: "bounded-stop", confirmation, fetchImpl };
    const job = runDeploymentStop(options).then((value) => { settled = value; return value; });
    try {
      await fixtureWait(advanceClientClock(150_000)); expect(settled).toBeUndefined();
      await fixtureWait(advanceClientClock(30_000));
      expect(settled).toMatchObject({ kind: "error", retryable: true, message: expect.stringContaining("unresolved") });
      expect(originalFetchInit.get(calls.at(-1)!)?.signal?.aborted).toBe(true);
      if (phase === "confirmed") expect(settled).toMatchObject({ requestId: "req-1" });
      const bounded = settled; release(); await fixtureWait(advanceClientClock(0)); expect(settled).toBe(bounded);
      const retryCalls: Request[] = [];
      await runDeploymentStop({ ...options, fetchImpl: async (url, init) => {
        retryCalls.push(recordFetchRequest(url, init));
        return phase === "preparation" && retryCalls.length === 1 ? envelope({ commandId: "cmd-1", confirmationId: "confirm-1", confirmationRequired: true }) : stopStoredReplay("bounded-stop");
      } });
      expect(retryCalls[0]!.headers.get("x-control-idempotency-key")).toBe("bounded-stop");
      expect(retryCalls[0]!.url).toBe(calls[0]!.url); expect(await retryCalls[0]!.json()).toEqual({});
      expect(retryCalls.at(-1)!.headers.get("x-control-confirmation-id")).toBe("confirm-1");
    } finally { release?.(); await fixtureWait(job); vi.useRealTimers(); }
  });

  it("releases Stop controls on the total cross-step deadline and ignores late success", async () => {
    const user = userEvent.setup();
    let preparation!: (value: Response) => void, confirmed!: (value: Response) => void;
    const calls: Request[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(recordFetchRequest(url, init));
      if (calls.length === 1) return new Promise<Response>((resolve) => { preparation = resolve; });
      if (calls.length === 2) return new Promise<Response>((resolve) => { confirmed = resolve; });
      return stopStoredReplay(calls[0]!.headers.get("x-control-idempotency-key")!);
    });
    render(<DeploymentStopControl deployment={successfulDeployment} expectedDeploymentId="dep-1" role="operator" apiBaseUrl="https://api.test" fetchImpl={fetchImpl} />);
    try {
      await fixtureWait(user.click(screen.getByRole("button", { name: "Stop deployment" })));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
      fireEvent.click(screen.getByRole("button", { name: "Confirm stop deployment" }));
      await act(() => fixtureWait(advanceClientClock(0)));
      await act(() => fixtureWait(advanceClientClock(150_000)));
      preparation(envelope({ commandId: "cmd-1", confirmationId: "confirm-1", confirmationRequired: true }));
      await act(() => fixtureWait(advanceClientClock(0))); expect(calls).toHaveLength(2);
      await act(() => fixtureWait(advanceClientClock(30_000)));
      expect(originalFetchInit.get(calls[1]!)?.signal).toBeInstanceOf(AbortSignal);
      expect(originalFetchInit.get(calls[1]!)?.signal?.aborted).toBe(true);
      expect(screen.getByRole("status").textContent).toContain("unresolved");
      expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(false);
      vi.useRealTimers();
      await user.keyboard("{Escape}"); expect(screen.queryByRole("dialog")).toBeNull();
      confirmed(stopSuccess()); await act(() => fixtureWait(flushFixture()));
      expect(screen.getByRole("status").textContent).toContain("unresolved");
      await fixtureWait(user.click(screen.getByRole("button", { name: "Check same stop request" })));
      expect(calls[2]!.headers.get("x-control-idempotency-key")).toBe(calls[0]!.headers.get("x-control-idempotency-key"));
      expect(calls[2]!.headers.get("x-control-confirmation-id")).toBe("confirm-1");
    } finally {
      preparation?.(envelope({ commandId: "cmd-1", confirmationId: "confirm-1", confirmationRequired: true }));
      await act(() => fixtureWait(flushFixture())); confirmed?.(stopSuccess());
      await act(() => fixtureWait(flushFixture())); vi.useRealTimers();
    }
  });

  it.each([401, 403])("keeps the unknown attempt after a lost confirmed reply followed by HTTP%s", async (status) => {
    const calls: Request[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(recordFetchRequest(url, init));
      if (calls.length === 1) return envelope({ commandId: "cmd-1", confirmationId: "confirm-1", confirmationRequired: true });
      if (calls.length === 2) throw new Error("lost confirmed reply");
      if (calls.length === 3) return new Response(JSON.stringify({ data: null, error: { code: "SCOPE_DENIED", message: "redacted", correlationId: "denied-corr" }, requestId: "denied" }), { status });
      return stopStoredReplay(calls[0]!.headers.get("x-control-idempotency-key")!);
    });
    const user = userEvent.setup(); render(<DeploymentStopControl deployment={successfulDeployment} expectedDeploymentId="dep-1" role="operator" apiBaseUrl="https://api.test" fetchImpl={fetchImpl} />);
    await fixtureWait(user.click(screen.getByRole("button", { name: "Stop deployment" }))); await fixtureWait(user.click(screen.getByRole("button", { name: "Confirm stop deployment" })));
    await vi.waitFor(() => expect(screen.getByRole("status").textContent).toContain("unresolved"));
    await fixtureWait(user.click(screen.getByRole("button", { name: "Check same stop request" })));
    await vi.waitFor(() => expect(screen.getByRole("status").textContent).toContain("authorized"));
    expect(screen.getByRole("status").textContent).toContain("unresolved");
    expect(screen.getByRole("status").textContent).not.toContain("status was not changed");
    expect(screen.queryByRole("button", { name: "Prepare new stop request" })).toBeNull();
    await fixtureWait(user.click(screen.getByRole("button", { name: "Check same stop request" })));
    expect(calls).toHaveLength(4);
    for (const request of calls.slice(1)) {
      expect(request.headers.get("x-control-idempotency-key")).toBe(calls[0]!.headers.get("x-control-idempotency-key"));
      expect(request.headers.get("x-control-confirmation-id")).toBe("confirm-1");
    }
  });

  it.each(["CONFIRMATION_EXPIRED", "CONFIRMATION_REJECTED"])("offers explicit fresh Stop preparation after conclusive %s", async (code) => {
    const calls: Request[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(recordFetchRequest(url, init));
      if (calls.length === 1) return envelope({ commandId: "cmd-1", confirmationId: "confirm-1", confirmationRequired: true });
      if (calls.length === 2) return new Response(JSON.stringify({ data: null, error: { code, message: "redacted", correlationId: "corr-1" }, requestId: "rejected" }), { status: 409 });
      if (calls.length === 3) return envelope({ commandId: "cmd-next", confirmationId: "confirm-next", confirmationRequired: true });
      const success = await stopSuccess().json(); success.data.command.commandId = "cmd-next"; success.data.receipt.commandId = "cmd-next";
      return new Response(JSON.stringify(success), { status: 200 });
    });
    const user = userEvent.setup(); render(<DeploymentStopControl deployment={successfulDeployment} expectedDeploymentId="dep-1" role="operator" apiBaseUrl="https://api.test" fetchImpl={fetchImpl} />);
    await fixtureWait(user.click(screen.getByRole("button", { name: "Stop deployment" }))); await fixtureWait(user.click(screen.getByRole("button", { name: "Confirm stop deployment" })));
    await vi.waitFor(() => expect(screen.getByRole("status").textContent).toContain("rejected"));
    expect((screen.getByRole("button", { name: "Confirm stop deployment" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Prepare new stop request" })); expect(calls).toHaveLength(2);
    await fixtureWait(user.click(screen.getByRole("button", { name: "Confirm stop deployment" })));
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    expect(calls[2]!.headers.get("x-control-idempotency-key")).not.toBe(calls[0]!.headers.get("x-control-idempotency-key"));
    expect(calls[2]!.headers.has("x-control-confirmation-id")).toBe(false);
    expect(calls[3]!.headers.get("x-control-confirmation-id")).toBe("confirm-next"); expect(calls[2]!.url).toBe(calls[0]!.url);
  });

  it("keeps a prior unknown Stop attempt after a later confirmation rejection", async () => {
    const confirmation = {};
    const options = { deploymentId: deployment.id, apiBaseUrl: "https://api.test", idempotencyKey: "same-stop", confirmation };
    await runDeploymentStop({ ...options, fetchImpl: vi.fn().mockResolvedValueOnce(envelope({ commandId: "cmd-1", confirmationId: "confirm-1", confirmationRequired: true })).mockRejectedValueOnce(new Error("lost")) });
    const denied = await runDeploymentStop({ ...options, fetchImpl: async () => new Response(JSON.stringify({ data: null, error: { code: "CONFIRMATION_EXPIRED", message: "redacted", correlationId: "corr-1" }, requestId: "retry" }), { status: 409 }) });
    expect(denied).toMatchObject({ kind: "error", retryable: true, message: expect.stringContaining("unresolved") });
    expect(denied).not.toHaveProperty("canPrepareNew", true);
    expect(confirmation).toMatchObject({ id: "confirm-1", commandId: "cmd-1" });
  });
});

const successfulDeployment: Deployment = { ...deployment, status: "succeeded", finishedAt: "2026-01-01T00:01:00.000Z", snapshotOriginId: "origin", snapshotHash: "a".repeat(64), executionReceipt: { schemaVersion: 1, deploymentId: deployment.id, projectId: deployment.projectId, candidateId: deployment.stopTarget!.candidateId, snapshotOriginId: "origin", snapshotHash: "a".repeat(64), effectiveImageDigest: `sha256:${"a".repeat(64)}`, runtimeHost: deployment.agentId!, container: "deploylite-active-dep-1", containerId: "physical-A", hostPort: 49170, containerPort: 8080, network: null } };
const stopResult = { commandId: "cmd-1", action: "deployment.stop" as const, projectId: deployment.projectId, deploymentId: deployment.id, status: "completed" as const, correlationId: "corr-1", reason: "stopped" };
const stopSuccess = (containerId = "physical-A") => { const body = JSON.stringify({ data: { deployment: successfulDeployment, receipt: { schemaVersion: 1, action: "deployment.stop", agentId: deployment.agentId, commandId: "cmd-1", projectId: deployment.projectId, deploymentId: deployment.id, candidateId: deployment.stopTarget!.candidateId, effectiveImage: deployment.stopTarget!.effectiveImage, containerId, status: "stopped", redacted: true, correlationId: "corr-1", reason: null }, command: stopResult }, error: null, requestId: "req-1" }); const response = new Response(body, { status: 200 }); response.json = async () => JSON.parse(body); return response; };
function stopStoredReplay(key: string, reason = "stopped") { return new Response(JSON.stringify({ data: { deployment: successfulDeployment, command: { id: "cmd-1", actorId: "actor", action: "deployment.stop", scope: { kind: "deployment", projectId: deployment.projectId, deploymentId: deployment.id }, idempotencyKey: key, inputDigest: "b".repeat(64), status: "completed", correlationId: "corr-1", expiresAt: "2026-01-01T00:15:00.000Z", result: { ...stopResult, reason } }, idempotent: true }, error: null, requestId: "req-1" }), { status: 200 }); }

describe("selected successful-workload Stop contract", () => {
  it("offers a request for properly bound succeeded metadata without claiming active ownership", () => {
    const { rerender } = render(<DeploymentStopControl deployment={successfulDeployment} expectedDeploymentId="dep-1" role="operator" apiBaseUrl="https://api.test" />);
    expect(screen.getByRole("button", { name: "Stop deployment" })).toBeTruthy();
    rerender(<DeploymentStopControl deployment={successfulDeployment} expectedDeploymentId="other" role="operator" apiBaseUrl="https://api.test" />); expect(screen.queryByRole("button", { name: "Stop deployment" })).toBeNull();
    rerender(<DeploymentStopControl deployment={{ ...successfulDeployment, executionReceipt: undefined }} expectedDeploymentId="dep-1" role="operator" apiBaseUrl="https://api.test" />); expect(screen.queryByRole("button", { name: "Stop deployment" })).toBeNull();
    rerender(<DeploymentStopControl deployment={successfulDeployment} expectedDeploymentId="dep-1" role="auditor" apiBaseUrl="https://api.test" />); expect(screen.queryByRole("button", { name: "Stop deployment" })).toBeNull();
  });
  it("accepts inspected Stop evidence while succeeded history and proof remain unchanged", async () => {
    const before = structuredClone(successfulDeployment);
    const outcome = await runDeploymentStop({ deploymentId: deployment.id, expectedDeployment: successfulDeployment, apiBaseUrl: "https://api.test", idempotencyKey: "stop-key", fetchImpl: async () => stopSuccess() });
    expect(outcome.kind).toBe("success"); expect(successfulDeployment).toEqual(before); expect(successfulDeployment.status).toBe("succeeded");
  });
  it("accepts the actual completed command replay preserving succeeded history, but no failed-stop replay", async () => {
    await expect(runDeploymentStop({ deploymentId: deployment.id, expectedDeployment: successfulDeployment, apiBaseUrl: "https://api.test", idempotencyKey: "stop-key", fetchImpl: async () => stopStoredReplay("stop-key") })).resolves.toMatchObject({ kind: "success" });
    await expect(runDeploymentStop({ deploymentId: deployment.id, expectedDeployment: successfulDeployment, apiBaseUrl: "https://api.test", idempotencyKey: "stop-key", fetchImpl: async () => stopStoredReplay("stop-key", "capability_unavailable") })).resolves.toMatchObject({ kind: "error" });
    await expect(runDeploymentStop({ deploymentId: deployment.id, expectedDeployment: successfulDeployment, apiBaseUrl: "https://api.test", idempotencyKey: "different-key", fetchImpl: async () => stopStoredReplay("stop-key") })).resolves.toMatchObject({ kind: "error" });
  });
  it("rejects a copied label with the wrong observed physical container identity", async () => {
    await expect(runDeploymentStop({ deploymentId: deployment.id, expectedDeployment: successfulDeployment, apiBaseUrl: "https://api.test", idempotencyKey: "stop-key", fetchImpl: async () => stopSuccess("copied-other-container") })).resolves.toMatchObject({ kind: "error" });
  });
  it.each(["transport-loss", "HTTP502"])("reports %s as unresolved without promising no effects", async (fault) => {
    const outcome = await runDeploymentStop({ deploymentId: deployment.id, apiBaseUrl: "https://api.test", idempotencyKey: "stop-key", fetchImpl: async () => { if (fault === "transport-loss") throw new Error("fixture secret"); return new Response(JSON.stringify({ data: null, error: { code: "DEPLOY_STOP_OUTCOME_UNKNOWN", message: "fixture secret", correlationId: "corr" }, requestId: "req" }), { status: 502 }); } });
    expect(outcome.kind).toBe("error"); expect(outcome.message).toContain("unresolved"); expect(outcome.message).not.toContain("status was not changed"); expect(outcome.message).not.toContain("fixture secret");
  });
  it("retains one attempt key and confirmation across a lost reply and explicit retry", async () => {
    const calls: Request[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => { calls.push(recordFetchRequest(url, init)); if (calls.length === 1) return envelope({ commandId: "cmd-1", confirmationId: "confirm-1", confirmationRequired: true }); if (calls.length === 2) throw new Error("lost reply"); return stopStoredReplay(calls[0]!.headers.get("x-control-idempotency-key")!); });
    const user = userEvent.setup(); render(<DeploymentStopControl deployment={successfulDeployment} expectedDeploymentId="dep-1" role="operator" apiBaseUrl="https://api.test" fetchImpl={fetchImpl} />);
    await user.click(screen.getByRole("button", { name: "Stop deployment" })); await user.click(screen.getByRole("button", { name: "Confirm stop deployment" }));
    await vi.waitFor(() => expect(screen.getByRole("status").textContent).toContain("unresolved"));
    await user.click(screen.getByRole("button", { name: "Check same stop request" })); expect(calls).toHaveLength(3);
    expect(calls[2]!.headers.get("x-control-idempotency-key")).toBe(calls[0]!.headers.get("x-control-idempotency-key")); expect(calls[2]!.headers.get("x-control-confirmation-id")).toBe("confirm-1"); expect(calls[2]!.url).toBe(calls[0]!.url);
  });
});

describe("actual API stored Stop response compatibility", () => {
  async function stored(status: "dispatching" | "completed") {
    const body = await stopStoredReplay("stop-key").json();
    return { ...body.data.command, status, result: status === "completed" ? body.data.command.result : null };
  }
  const context = () => ({ id: "confirm-1", commandId: "cmd-1", requestId: "old-req", correlationId: "prior-request-corr", unresolved: true });
  it.each([true, false])("accepts actual cached pending command without outer correlation and retains the same attempt (selected=%s)", async (selected) => {
    const confirmation = context(), command = await stored("dispatching"), calls: Request[] = [];
    const outcome = await runDeploymentStop({ deploymentId: deployment.id, expectedDeployment: selected ? deployment : undefined, apiBaseUrl: "https://api.test", idempotencyKey: "stop-key", confirmation,
      fetchImpl: async (url, init) => { calls.push(recordFetchRequest(url, init)); return new Response(JSON.stringify({ data: { command, pending: true }, error: null, requestId: "pending-req" }), { status: 202 }); } });
    expect(outcome).toMatchObject({ kind: "pending", retryable: true, requestId: "pending-req", correlationId: "corr-1" });
    expect(confirmation).toEqual({ ...context(), requestId: "pending-req", correlationId: "corr-1" });
    expect(calls).toHaveLength(1); expect(calls[0]!.headers.get("x-control-idempotency-key")).toBe("stop-key"); expect(calls[0]!.headers.get("x-control-confirmation-id")).toBe("confirm-1");
  });
  it.each([true, false])("accepts actual completed stored command without inventing stopped deployment metadata (selected=%s)", async (selected) => {
    const before = structuredClone(deployment), command = await stored("completed"), fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: { command, idempotent: true }, error: null, requestId: "replay-req" }), { status: 200 }));
    const outcome = await runDeploymentStop({ deploymentId: deployment.id, expectedDeployment: selected ? deployment : undefined, apiBaseUrl: "https://api.test", idempotencyKey: "stop-key", confirmation: context(), fetchImpl });
    expect(outcome).toMatchObject({ kind: "success", retryable: false, requestId: "replay-req", correlationId: "corr-1", message: "Stop was already confirmed by the server. Refreshing deployment evidence." });
    expect(deployment).toEqual(before); expect(deployment.status).toBe("running"); expect(outcome).not.toHaveProperty("deployment"); expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each(["pending", "replay"] as const)("rejects unbound or conflicting %s stored commands", async (kind) => {
    for (const fault of ["project", "target", "key", "command", "correlation", "action"] as const) {
      const command = await stored(kind === "pending" ? "dispatching" : "completed");
      if (fault === "project") command.scope.projectId = "other-project";
      if (fault === "target") command.scope.deploymentId = "other-deployment";
      if (fault === "key") command.idempotencyKey = "other-key";
      if (fault === "command") command.id = "other-command";
      if (fault === "correlation") command.correlationId = kind === "pending" ? "" : "other-correlation";
      if (fault === "action") command.action = "deployment.redeploy";
      const data = kind === "pending" ? { command, pending: true } : { command, idempotent: true };
      await expect(runDeploymentStop({ deploymentId: deployment.id, expectedDeployment: deployment, apiBaseUrl: "https://api.test", idempotencyKey: "stop-key", confirmation: context(),
        fetchImpl: async () => new Response(JSON.stringify({ data, error: null, requestId: "conflicting-req" }), { status: kind === "pending" ? 202 : 200 }) })).resolves.toMatchObject({ kind: "error", retryable: true });
    }
  });
  it("rejects result-only replay and conflicting stored result identities", async () => {
    const command = await stored("completed");
    for (const value of [command.result, { ...command, result: { ...command.result, commandId: "other-command" } }, { ...command, result: { ...command.result, correlationId: "other-correlation" } }, { ...command, result: { ...command.result, projectId: "other-project" } }, { ...command, result: { ...command.result, reason: "capability_unavailable" } }]) {
      await expect(runDeploymentStop({ deploymentId: deployment.id, expectedDeployment: deployment, apiBaseUrl: "https://api.test", idempotencyKey: "stop-key", confirmation: context(),
        fetchImpl: async () => new Response(JSON.stringify({ data: { command: value, idempotent: true }, error: null, requestId: "conflicting-result" }), { status: 200 }) })).resolves.toMatchObject({ kind: "error", retryable: true });
    }
  });
});
