// @vitest-environment jsdom
import { setTimeout as nativeFixtureTimer, clearTimeout as nativeFixtureClear, setImmediate as nativeFixtureTick } from "node:timers";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Deployment } from "@deploylite/contracts";
import { DeploymentRedeployControl } from "./deployment-redeploy-control";
const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() })); vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
const hash = "a".repeat(64), digest = `sha256:${"b".repeat(64)}`;
const deployment: Deployment = { id: "dep-A", projectId: "project", agentId: "agent", status: "succeeded", commitSha: "abcdef1", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:01:00.000Z", snapshotOriginId: "dep-A", snapshotHash: hash,
  stopTarget: { candidateId: "dep-A:candidate:cmd", effectiveImage: `registry.example.com/team/app@${digest}` }, executionReceipt: { schemaVersion: 1, deploymentId: "dep-A", projectId: "project", candidateId: "dep-A:candidate:cmd", snapshotOriginId: "dep-A", snapshotHash: hash, effectiveImageDigest: digest, runtimeHost: "agent", container: "deploylite-active-dep-A", containerId: "physical-A", hostPort: 49170, containerPort: 8080, network: null } };
const props = { deployment, expectedSourceDeploymentId: "dep-A", role: "operator" as const, apiBaseUrl: "https://api.test" };
const response = (data: unknown, status = 202) => {
  const body = JSON.stringify({ data, error: null, requestId: "req" });
  const value = new Response(body, { status });
  value.json = async () => JSON.parse(body);
  return value;
};
const prepare = () => response({ commandId: "cmd", confirmationId: "confirm", confirmationRequired: true, correlationId: "corr" });
function pending(key: string) { return response({ command: { id: "cmd", actorId: "actor", action: "deployment.redeploy", scope: { kind: "deployment", projectId: "project", deploymentId: "dep-A" }, idempotencyKey: key, inputDigest: hash, status: "dispatching", correlationId: "corr" }, pending: true, correlationId: "corr" }); }
// Native Request snapshots cannot consume a jsdom AbortSignal; retain the actual fetch input separately.
const originalFetchInit = new WeakMap<Request, RequestInit | undefined>();
function recordFetchRequest(url: RequestInfo | URL, init?: RequestInit): Request {
  const request = new Request(String(url), { ...init, signal: undefined });
  originalFetchInit.set(request, init);
  return request;
}

afterEach(() => { cleanup(); refresh.mockClear(); vi.useRealTimers(); });
async function confirm(user: ReturnType<typeof userEvent.setup>) { await user.click(screen.getByRole("button", { name: "Redeploy snapshot" })); await user.click(screen.getByRole("button", { name: "Confirm redeploy" })); }

describe("DeploymentRedeployControl", () => {
  it("mounts only for supported explicitly selected metadata and mutation roles", () => {
    const { rerender } = render(<DeploymentRedeployControl {...props} role="read-only" />); expect(screen.queryByRole("button", { name: "Redeploy snapshot" })).toBeNull();
    rerender(<DeploymentRedeployControl {...props} deployment={{ ...deployment, executionReceipt: undefined }} />); expect(screen.queryByRole("button", { name: "Redeploy snapshot" })).toBeNull();
    rerender(<DeploymentRedeployControl {...props} expectedSourceDeploymentId="other" />); expect(screen.queryByRole("button", { name: "Redeploy snapshot" })).toBeNull();
    rerender(<DeploymentRedeployControl {...props} />); expect(screen.getByRole("button", { name: "Redeploy snapshot" })).toBeTruthy();
  });
  it("supports keyboard focus/Escape and displays the selected source/hash before any request", async () => {
    const user = userEvent.setup(), fetchImpl = vi.fn(); render(<DeploymentRedeployControl {...props} fetchImpl={fetchImpl} />);
    await user.tab(); await user.keyboard("{Enter}"); expect(screen.getByRole("dialog")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" })); expect(screen.getByText(hash)).toBeTruthy(); expect(screen.getByText(/Source execution: dep-A/)).toBeTruthy();
    await user.keyboard("{Escape}"); expect(screen.queryByRole("dialog")).toBeNull(); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("suppresses duplicate requests and dialog dismissal until the server response, then announces denial", async () => {
    let resolve!: (value: Response) => void; const fetchImpl = vi.fn(() => new Promise<Response>((done) => { resolve = done; })); const user = userEvent.setup(); render(<DeploymentRedeployControl {...props} fetchImpl={fetchImpl} />);
    await confirm(user); expect(screen.getByRole("dialog").getAttribute("aria-busy")).toBe("true");
    await user.click(screen.getByRole("button", { name: "Submitting redeploy…" })); await user.keyboard("{Escape}"); expect(screen.getByRole("dialog")).toBeTruthy(); expect(fetchImpl).toHaveBeenCalledTimes(1);
    resolve(new Response(JSON.stringify({ data: null, error: { code: "SCOPE_DENIED", message: "fixture secret", correlationId: "corr" }, requestId: "req" }), { status: 403 }));
    await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toContain("authorization")); expect(screen.queryByText("fixture secret")).toBeNull(); expect(refresh).not.toHaveBeenCalled();
  });
  it("announces pending with correlated evidence and checks the same key rather than creating another command", async () => {
    const calls: Request[] = []; const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => { const req = recordFetchRequest(url, init); calls.push(req); return calls.length === 1 ? prepare() : pending(req.headers.get("x-control-idempotency-key")!); });
    const user = userEvent.setup(); render(<DeploymentRedeployControl {...props} fetchImpl={fetchImpl} />); await confirm(user);
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull()); expect(screen.getByRole("status").textContent).toContain("pending"); expect(screen.getByRole("status").textContent).toContain("corr"); expect(refresh).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Check same request" })); expect(calls).toHaveLength(3);
    for (const req of calls) { expect(req.headers.get("x-control-idempotency-key")).toBe(calls[0]!.headers.get("x-control-idempotency-key")); expect(await req.json()).toEqual({ snapshotHash: hash }); }
    expect(calls[2]!.headers.get("x-control-confirmation-id")).toBe("confirm");
  });
  it("keeps the same source/hash/key/confirmation when a confirmed reply is lost and props change during the await", async () => {
    const calls: Request[] = []; let resolve!: (value: Response) => void;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => { const req = recordFetchRequest(url, init); calls.push(req); if (calls.length === 1) return new Promise<Response>((done) => { resolve = done; }); if (calls.length === 2) throw new Error("reply lost"); return pending(req.headers.get("x-control-idempotency-key")!); });
    const user = userEvent.setup(); const { rerender } = render(<DeploymentRedeployControl {...props} fetchImpl={fetchImpl} />); await confirm(user);
    rerender(<DeploymentRedeployControl {...props} deployment={{ ...deployment, snapshotHash: "c".repeat(64), executionReceipt: { ...deployment.executionReceipt!, snapshotHash: "c".repeat(64) } }} fetchImpl={fetchImpl} />); resolve(prepare());
    await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toContain("not received")); expect(calls[1]!.url).toContain("dep-A/redeploy"); expect(await calls[1]!.json()).toEqual({ snapshotHash: hash });
    await user.click(screen.getByRole("button", { name: "Check same request" }));
    expect(calls).toHaveLength(3); expect(calls[2]!.headers.get("x-control-idempotency-key")).toBe(calls[0]!.headers.get("x-control-idempotency-key")); expect(await calls[2]!.json()).toEqual({ snapshotHash: hash }); expect(calls[2]!.headers.get("x-control-confirmation-id")).toBe("confirm");
  });
  it("keeps configuration absent without submission", () => {
    const fetchImpl = vi.fn(); render(<DeploymentRedeployControl {...props} apiBaseUrl={null} fetchImpl={fetchImpl} />);
    expect((screen.getByRole("button", { name: "Redeploy snapshot" }) as HTMLButtonElement).disabled).toBe(true); expect(fetchImpl).not.toHaveBeenCalled();
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

describe("review correction: bounded redeploy controls", () => {
  const completedData = (key: string) => ({ command: { id: "cmd", action: "deployment.redeploy", scope: { kind: "deployment", projectId: "project", deploymentId: "dep-A" }, idempotencyKey: key, inputDigest: hash, status: "completed", correlationId: "corr", result: { commandId: "cmd", action: "deployment.redeploy", projectId: "project", sourceDeploymentId: "dep-A", deploymentId: "dep-B", snapshotHash: hash, status: "completed", correlationId: "corr", reason: null } }, deploymentId: "dep-B", snapshotHash: hash, idempotent: true });
  it.each(["fetch", "body"])("releases a stalled confirmed %s and retains the exact retry after late success", async (stage) => {
    const user = userEvent.setup();
    const calls: Request[] = []; let release!: () => void;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(recordFetchRequest(url, init));
      if (calls.length === 1) return prepare();
      if (calls.length > 2) return pending(calls[0]!.headers.get("x-control-idempotency-key")!);
      if (stage === "fetch") return new Promise<Response>((resolve) => { release = () => resolve(response(completedData(calls[0]!.headers.get("x-control-idempotency-key")!), 200)); });
      const stalled = new Response("", { status: 200 });
      stalled.json = () => new Promise<unknown>((resolve) => { release = () => resolve({ data: completedData(calls[0]!.headers.get("x-control-idempotency-key")!), error: null, requestId: "req" }); });
      return stalled;
    });
    const { rerender } = render(<DeploymentRedeployControl {...props} fetchImpl={fetchImpl} />);
    try {
      await fixtureWait(user.click(screen.getByRole("button", { name: "Redeploy snapshot" })));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
      fireEvent.click(screen.getByRole("button", { name: "Confirm redeploy" }));
      await act(() => fixtureWait(advanceClientClock(0)));
      await act(() => fixtureWait(advanceClientClock(150_000)));
      expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
      await act(() => fixtureWait(advanceClientClock(30_000)));
      expect(screen.getByRole("dialog").getAttribute("aria-busy")).toBe("false");
      expect(originalFetchInit.get(calls[1]!)?.signal).toBeInstanceOf(AbortSignal);
      expect(originalFetchInit.get(calls[1]!)?.signal?.aborted).toBe(true);
      expect(screen.getByRole("alert").textContent).toContain("unresolved");
      expect(screen.getByRole("alert").textContent).toContain("corr");
      expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(false);
      vi.useRealTimers();
      await user.keyboard("{Escape}"); expect(screen.queryByRole("dialog")).toBeNull();
      release(); await act(() => fixtureWait(flushFixture()));
      expect(screen.getByRole("alert").textContent).toContain("unresolved"); expect(refresh).not.toHaveBeenCalled();
      rerender(<DeploymentRedeployControl {...props} deployment={{ ...deployment, snapshotHash: "c".repeat(64), executionReceipt: { ...deployment.executionReceipt!, snapshotHash: "c".repeat(64) } }} fetchImpl={fetchImpl} />);
      await fixtureWait(user.click(screen.getByRole("button", { name: "Check same request" })));
      expect(calls).toHaveLength(3);
      expect(calls[2]!.url).toBe(calls[0]!.url); expect(await calls[2]!.json()).toEqual({ snapshotHash: hash });
      expect(calls[2]!.headers.get("x-control-idempotency-key")).toBe(calls[0]!.headers.get("x-control-idempotency-key"));
      expect(calls[2]!.headers.get("x-control-confirmation-id")).toBe("confirm");
      expect(screen.queryByRole("button", { name: "Prepare new redeploy request" })).toBeNull();
    } finally { release?.(); await act(() => fixtureWait(flushFixture())); vi.useRealTimers(); }
  });

  it.each(["CONFIRMATION_EXPIRED", "CONFIRMATION_REJECTED"])("requires explicit new preparation after %s, with a new key and captured identity", async (code) => {
    const calls: Request[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(recordFetchRequest(url, init));
      if (calls.length === 1) return prepare();
      if (calls.length === 2) return new Response(JSON.stringify({ data: null, error: { code, message: "redacted", correlationId: "corr" }, requestId: "rejected" }), { status: 409 });
      if (calls.length === 3) return response({ commandId: "cmd-next", confirmationId: "confirm-next", confirmationRequired: true, correlationId: "corr-next" });
      return response({ command: { id: "cmd-next", action: "deployment.redeploy", scope: { kind: "deployment", projectId: "project", deploymentId: "dep-A" }, idempotencyKey: calls[2]!.headers.get("x-control-idempotency-key"), inputDigest: hash, status: "dispatching", correlationId: "corr-next" }, pending: true, correlationId: "corr-next" });
    });
    const user = userEvent.setup(); const { rerender } = render(<DeploymentRedeployControl {...props} fetchImpl={fetchImpl} />);
    await fixtureWait(confirm(user)); await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toContain("rejected"));
    expect(calls).toHaveLength(2);
    expect((screen.getByRole("button", { name: "Confirm redeploy" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<DeploymentRedeployControl {...props} deployment={{ ...deployment, snapshotHash: "c".repeat(64), executionReceipt: { ...deployment.executionReceipt!, snapshotHash: "c".repeat(64) } }} fetchImpl={fetchImpl} />);
    await user.click(screen.getByRole("button", { name: "Prepare new redeploy request" }));
    expect(calls).toHaveLength(2); // Explicit reset grants a fresh preparation; it sends nothing until confirmation.
    await user.click(screen.getByRole("button", { name: "Confirm redeploy" }));
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    expect(calls[2]!.headers.get("x-control-idempotency-key")).not.toBe(calls[0]!.headers.get("x-control-idempotency-key"));
    expect(calls[2]!.headers.has("x-control-confirmation-id")).toBe(false);
    expect(calls[3]!.headers.get("x-control-confirmation-id")).toBe("confirm-next");
    expect(calls[2]!.url).toBe(calls[0]!.url); expect(await calls[2]!.json()).toEqual({ snapshotHash: hash });
  });
});

describe("redeploy retry live feedback", () => {
  it("announces a same-request check while the dialog is closed", async () => {
    let resolve!: (value: Response) => void; let key = ""; let count = 0;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => { count++; key = new Headers(init?.headers).get("x-control-idempotency-key")!; if (count === 1) return prepare(); if (count === 2) return pending(key); return new Promise<Response>((done) => { resolve = done; }); });
    const user = userEvent.setup(); render(<DeploymentRedeployControl {...props} fetchImpl={fetchImpl} />); await confirm(user);
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull()); await user.click(screen.getByRole("button", { name: "Check same request" }));
    try { expect(screen.getByRole("status").textContent).toContain("Checking redeploy request"); expect(count).toBe(3); }
    finally { resolve(pending(key)); await vi.waitFor(() => expect(screen.getByRole("status").textContent).toContain("pending")); }
  });
});
