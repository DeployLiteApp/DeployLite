// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Deployment } from "@deploylite/contracts";
import { DeploymentStopControl, runDeploymentStop } from "./deployment-stop-control";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const deployment: Deployment = { id: "dep-1", projectId: "project-1", agentId: "agent-1", status: "running", commitSha: "abcdef1", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: null, stopTarget: { candidateId: "dep-1:candidate:cmd", effectiveImage: `registry.example.com/team/app@sha256:${"a".repeat(64)}` } };
afterEach(() => cleanup());
const envelope = (data: unknown) => new Response(JSON.stringify({ data, error: null, requestId: "req-1" }), { status: 202 });

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
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => { calls.push(new Request(String(_url), init)); return calls.length === 1 ? envelope({ commandId: "cmd-1", confirmationId: "confirm-1", confirmationRequired: true }) : new Response(JSON.stringify({ data: { deployment }, error: null, requestId: "req-2" }), { status: 200 }); });
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
    expect(screen.getByText("You are not authorized to stop this deployment. The deployment status was not changed.")).toBeTruthy();
  });

  it("keeps a final pending response in progress and rejects malformed success envelopes", async () => {
    const pending = await runDeploymentStop({ deploymentId: "dep-1", apiBaseUrl: "https://api.test", idempotencyKey: "pending", fetchImpl: async () => new Response(JSON.stringify({ data: { commandId: "cmd-1", confirmationId: "confirm-1", confirmationRequired: true }, error: null, requestId: "req-1" }), { status: 202 }) });
    expect(pending.kind).toBe("error");
    const finalPending = await runDeploymentStop({ deploymentId: "dep-1", apiBaseUrl: "https://api.test", idempotencyKey: "pending", fetchImpl: vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: { commandId: "cmd-1", confirmationId: "confirm-1", confirmationRequired: true }, error: null, requestId: "req-1" }), { status: 202 })).mockResolvedValueOnce(new Response(JSON.stringify({ data: { commandId: "cmd-1", pending: true }, error: null, requestId: "req-2" }), { status: 202 })) });
    expect(finalPending).toEqual({ kind: "pending", message: "Stop request is already being reconciled. Refresh deployment evidence for the final status." });
    const malformed = await runDeploymentStop({ deploymentId: "dep-1", apiBaseUrl: "https://api.test", idempotencyKey: "bad", fetchImpl: async () => new Response(JSON.stringify({ data: { deployment }, error: null, requestId: "req-1" }), { status: 200 }) });
    expect(malformed.message).toBe("The stop response was invalid. Refresh deployment evidence before trying again.");
  });

  it("classifies explicit 409 outcomes and accepts an already-stopped receipt", async () => {
    const conflict = (code: string) => runDeploymentStop({ deploymentId: "dep-1", apiBaseUrl: "https://api.test", idempotencyKey: code, fetchImpl: async () => new Response(JSON.stringify({ data: null, error: { code, message: "request rejected", correlationId: "corr-1" }, requestId: "req-1" }), { status: 409 }) });
    await expect(conflict("CONFIRMATION_EXPIRED")).resolves.toMatchObject({ message: "Confirmation was rejected or expired. The deployment status was not changed." });
    await expect(conflict("IDEMPOTENCY_CONFLICT")).resolves.toMatchObject({ message: "This stop attempt conflicts with another request. The deployment status was not changed." });
    await expect(conflict("COMMAND_PENDING")).resolves.toMatchObject({ kind: "error", message: "Stop request is already being reconciled. Refresh deployment evidence for the final status." });
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
      await expect(runDeploymentStop({ deploymentId: "dep-1", apiBaseUrl: "https://api.test", idempotencyKey: "malformed", fetchImpl: async () => new Response(JSON.stringify({ data, error: null, requestId: "req-1" }), { status: 200 }) })).resolves.toMatchObject({ kind: "error", message: "The stop response was invalid. Refresh deployment evidence before trying again." });
    }
  });
});
