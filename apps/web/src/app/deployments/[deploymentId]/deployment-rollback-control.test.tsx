// @vitest-environment jsdom
// Prospective rollback behavior; no actual API or runtime call.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeploymentRollbackControl } from "./deployment-rollback-control";
import { advance, CONTEXT, deferred, execution, H_HASH, record, requestBody, requestHeader, SERVER_R, serverReply, tick, watchdog, type RecordedRequest } from "@/lib/deployment-rollback.test-fixtures";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
const props = () => ({ deployment: execution("A"), expectedActiveDeploymentId: "A", historicalDeployments: [execution("H", true)], role: "operator" as const, apiBaseUrl: "https://api.test" });
afterEach(() => { cleanup(); refresh.mockClear(); vi.useRealTimers(); });
async function selectAndOpen(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(screen.getByRole("combobox", { name: "Historical execution" }), "H");
  await user.click(screen.getByRole("button", { name: "Rollback to snapshot" }));
}

describe("rollback explicit selection and accessible confirmation", () => {
  it("requires an explicit H choice and does not substitute a newer success for selected A", async () => {
    const fetchImpl = vi.fn(), user = userEvent.setup(), selected = props();
    render(<DeploymentRollbackControl {...selected} historicalDeployments={[execution("newer-success"), ...selected.historicalDeployments]} fetchImpl={fetchImpl} />);
    expect((screen.getByRole("combobox", { name: "Historical execution" }) as HTMLSelectElement).value).toBe("");
    expect((screen.getByRole("button", { name: "Rollback to snapshot" }) as HTMLButtonElement).disabled).toBe(true);
    await selectAndOpen(user);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(/Expected execution: A/)).toBeTruthy();
    expect(screen.getByText(/Historical execution: H/)).toBeTruthy();
    expect(screen.getByText(H_HASH)).toBeTruthy(); expect(screen.queryByText(/Current active:/)).toBeNull();
    await user.keyboard("{Escape}"); expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("keeps cross-project and legacy choices ineligible and protects mutation roles", () => {
    const selected = props(), cross = { ...execution("cross", true), projectId: "other" };
    const legacy = { ...execution("legacy", true), executionReceipt: undefined };
    const { rerender } = render(<DeploymentRollbackControl {...selected} historicalDeployments={[cross, legacy]} />);
    expect(screen.queryByRole("option", { name: /cross/ })).toBeNull();
    const legacyOption = screen.queryByRole("option", { name: /legacy/ }) as HTMLOptionElement | null;
    expect(legacyOption === null || legacyOption.disabled).toBe(true);
    rerender(<DeploymentRollbackControl {...selected} role="read-only" />);
    expect(screen.queryByRole("button", { name: "Rollback to snapshot" })).toBeNull();
    rerender(<DeploymentRollbackControl {...selected} expectedActiveDeploymentId="different-A" />);
    expect(screen.queryByRole("button", { name: "Rollback to snapshot" })).toBeNull();
  });
  it("suppresses duplicate keyboard submission and announces authoritative denial safely", async () => {
    const held = deferred<Response>(), fetchImpl = vi.fn(() => held.promise), user = userEvent.setup();
    render(<DeploymentRollbackControl {...props()} fetchImpl={fetchImpl} />); await selectAndOpen(user);
    const confirm = screen.getByRole("button", { name: "Confirm rollback" }); confirm.focus();
    await user.keyboard("{Enter}{Enter}"); expect(fetchImpl).toHaveBeenCalledOnce();
    expect(screen.getByRole("dialog").getAttribute("aria-busy")).toBe("true");
    held.resolve(serverReply("forbidden", { key: "from-recorded-request" }));
    await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/access|authorization/i));
    expect(screen.queryByText("secret-never-display")).toBeNull(); expect(refresh).not.toHaveBeenCalled();
  });
  it("announces pending request/correlation and links server-reserved R without rewriting history", async () => {
    const A = execution("A"), H = execution("H", true), before = structuredClone([A, H]);
    const calls: RecordedRequest[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      record(calls, url, init); const key = requestHeader(calls[0]!, "x-control-idempotency-key")!;
      return serverReply(calls.length === 1 ? "prepared" : "pending", { key });
    });
    const user = userEvent.setup(); render(<DeploymentRollbackControl {...props()} deployment={A} historicalDeployments={[H]} fetchImpl={fetchImpl} />);
    await selectAndOpen(user); await user.click(screen.getByRole("button", { name: "Confirm rollback" }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("status").textContent).toMatch(/pending/i);
    expect(screen.getByRole("status").textContent).toContain(CONTEXT.requestId);
    expect(screen.getByRole("status").textContent).toContain(CONTEXT.correlationId);
    expect(screen.getByRole("link", { name: "View execution evidence" }).getAttribute("href")).toBe(`/deployments/${SERVER_R}`);
    expect([A, H]).toEqual(before);
    await user.click(screen.getByRole("button", { name: "Check same request" }));
    expect(calls).toHaveLength(3);
    expect(requestHeader(calls[2]!, "x-control-idempotency-key")).toBe(requestHeader(calls[0]!, "x-control-idempotency-key"));
    expect(requestHeader(calls[2]!, "x-control-confirmation-id")).toBe(CONTEXT.confirmationId);
  });
});

describe("rollback unknown attempt, total wait and explicit fresh preparation", () => {
  it.each(["fetch", "body"])("unlocks ignored-abort %s and keeps A/H/key/confirmation after a late reply", async (stage) => {
    const calls: RecordedRequest[] = [], held = deferred<Response>(), body = deferred<unknown>();
    let key = "", late: Response | undefined, lateRaw: unknown;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      record(calls, url, init); key = requestHeader(calls[0]!, "x-control-idempotency-key")!;
      if (calls.length === 1) return serverReply("prepared", { key });
      if (calls.length > 2) return serverReply("pending", { key });
      late = serverReply("completed-replay", { key }); lateRaw = await late.json();
      if (stage === "fetch") return held.promise;
      late.json = () => body.promise; return late;
    });
    const user = userEvent.setup(), selected = props();
    const { rerender } = render(<DeploymentRollbackControl {...selected} fetchImpl={fetchImpl} />);
    try {
      await watchdog(selectAndOpen(user));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
      fireEvent.click(screen.getByRole("button", { name: "Confirm rollback" }));
      await act(() => watchdog(advance(0))); await act(() => watchdog(advance(150_000)));
      expect(screen.getByRole("dialog").getAttribute("aria-busy")).toBe("true");
      await act(() => watchdog(advance(30_000)));
      expect(screen.getByRole("dialog").getAttribute("aria-busy")).toBe("false");
      expect(screen.getByRole("alert").textContent).toMatch(/unresolved/i);
      expect(calls[1]!.init.signal?.aborted).toBe(true);
      vi.useRealTimers(); await user.keyboard("{Escape}");
      held.resolve(late!); body.resolve(lateRaw); await act(() => watchdog(tick()));
      expect(refresh).not.toHaveBeenCalled(); expect(screen.getByRole("alert").textContent).toMatch(/unresolved/i);
      rerender(<DeploymentRollbackControl {...selected} deployment={execution("new-A")} expectedActiveDeploymentId="new-A" historicalDeployments={[execution("new-H", true)]} fetchImpl={fetchImpl} />);
      await user.click(screen.getByRole("button", { name: "Check same request" }));
      expect(calls).toHaveLength(3); expect(calls[2]!.url).toBe(calls[0]!.url);
      expect(requestBody(calls[2]!)).toEqual({ historicalDeploymentId: "H", snapshotHash: H_HASH });
      expect(requestHeader(calls[2]!, "x-control-idempotency-key")).toBe(key);
      expect(requestHeader(calls[2]!, "x-control-confirmation-id")).toBe(CONTEXT.confirmationId);
      expect(screen.queryByRole("button", { name: "Prepare new rollback request" })).toBeNull();
    } finally { if (late) held.resolve(late); body.resolve(lateRaw); await act(() => watchdog(tick())); vi.useRealTimers(); }
  });
  it("preserves the unknown attempt after session denial instead of promising no effects", async () => {
    const calls: RecordedRequest[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      record(calls, url, init); const key = requestHeader(calls[0]!, "x-control-idempotency-key")!;
      if (calls.length === 1) return serverReply("prepared", { key });
      if (calls.length === 2) throw new Error("confirmed reply lost");
      return serverReply("unauthenticated", { key });
    });
    const user = userEvent.setup(); render(<DeploymentRollbackControl {...props()} fetchImpl={fetchImpl} />);
    await selectAndOpen(user); await user.click(screen.getByRole("button", { name: "Confirm rollback" }));
    await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/unresolved/i));
    await user.click(screen.getByRole("button", { name: "Check same request" }));
    await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/session|access|authorization/i));
    expect(screen.getByRole("alert").textContent).toMatch(/unresolved/i);
    expect(screen.getByRole("alert").textContent).not.toMatch(/unchanged|no changes|no effects/i);
    expect(requestHeader(calls[2]!, "x-control-idempotency-key")).toBe(requestHeader(calls[0]!, "x-control-idempotency-key"));
    expect(screen.queryByRole("button", { name: "Prepare new rollback request" })).toBeNull();
  });
  it("requires an explicit fresh preparation after conclusive expiry, retaining selected A/H", async () => {
    const calls: RecordedRequest[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      record(calls, url, init); const key = requestHeader(calls.at(-1)!, "x-control-idempotency-key")!;
      return serverReply(calls.length === 2 ? "expired" : calls.length === 4 ? "pending" : "prepared", { key, nextAttempt: calls.length > 2 });
    });
    const user = userEvent.setup(); render(<DeploymentRollbackControl {...props()} fetchImpl={fetchImpl} />);
    await selectAndOpen(user); await user.click(screen.getByRole("button", { name: "Confirm rollback" }));
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Prepare new rollback request" })).toBeTruthy());
    expect((screen.getByRole("button", { name: "Confirm rollback" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Prepare new rollback request" })); expect(calls).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Confirm rollback" }));
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    expect(requestHeader(calls[2]!, "x-control-idempotency-key")).not.toBe(requestHeader(calls[0]!, "x-control-idempotency-key"));
    expect(requestHeader(calls[2]!, "x-control-confirmation-id")).toBeNull();
    expect(requestHeader(calls[3]!, "x-control-confirmation-id")).toBe("confirmation-next");
    expect(requestBody(calls[2]!)).toEqual({ historicalDeploymentId: "H", snapshotHash: H_HASH });
  });
});


describe("rollback received sparse terminal outcome", () => {
  it.each(["failed", "canceled"] as const)("displays immediate %s and refreshes evidence without rewriting A/H", async (status) => {
    const selected = props(), before = structuredClone([selected.deployment, ...selected.historicalDeployments]);
    const calls: RecordedRequest[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      record(calls, url, init);
      return serverReply(calls.length === 1 ? "prepared" : status, { key: requestHeader(calls[0]!, "x-control-idempotency-key")! });
    });
    const user = userEvent.setup(); render(<DeploymentRollbackControl {...selected} fetchImpl={fetchImpl} />);
    await selectAndOpen(user); await user.click(screen.getByRole("button", { name: "Confirm rollback" }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("status").textContent).toContain(status);
    expect(screen.queryByRole("alert")).toBeNull(); expect(refresh).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "View execution evidence" }).getAttribute("href")).toBe(`/deployments/${SERVER_R}`);
    expect([selected.deployment, ...selected.historicalDeployments]).toEqual(before);
  });
});
