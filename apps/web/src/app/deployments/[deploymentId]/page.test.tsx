// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Deployment } from "@deploylite/contracts";
import DeploymentPage from "./page";
import { execution } from "@/lib/deployment-rollback.test-fixtures";
import { loadRequestAuthSession, loadRequestDeploymentLogMetadata, loadRequestProjectDetailMetadata } from "@/lib/server-auth";
vi.mock("@/lib/server-auth", () => ({ loadRequestAuthSession: vi.fn(), loadRequestDeploymentLogMetadata: vi.fn(), loadRequestProjectDetailMetadata: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/app-shell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock("./deployment-log-inspector", () => ({ DeploymentLogInspector: () => <section>Log evidence</section> }));
const hash = "a".repeat(64), digest = `sha256:${"b".repeat(64)}`;
const deployment: Deployment = { id: "dep-A", projectId: "project", agentId: "agent", status: "succeeded", commitSha: "abcdef1", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:01:00.000Z", snapshotOriginId: "origin", snapshotHash: hash, sourceDeploymentId: "prior",
  stopTarget: { candidateId: "dep-A:candidate:cmd", effectiveImage: `registry.example.com/team/app@${digest}` }, executionReceipt: { schemaVersion: 1, deploymentId: "dep-A", projectId: "project", candidateId: "dep-A:candidate:cmd", snapshotOriginId: "origin", snapshotHash: hash, effectiveImageDigest: digest, runtimeHost: "agent", container: "deploylite-active-dep-A", containerId: "physical-A", hostPort: 49170, containerPort: 8080, network: null } };
const authenticated = { kind: "authenticated" as const, user: { id: "operator", email: "operator@example.test", role: "operator" as const, status: "active" as const } };
beforeEach(() => { vi.mocked(loadRequestAuthSession).mockReset().mockResolvedValue(authenticated); vi.mocked(loadRequestDeploymentLogMetadata).mockReset(); vi.mocked(loadRequestProjectDetailMetadata).mockReset().mockResolvedValue({ kind: "error", reason: "api-rejected", status: 403 }); vi.stubEnv("DEPLOYLITE_WEB_API_BASE_URL", "https://api.test"); });
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });
const page = (id = "dep-A") => DeploymentPage({ params: Promise.resolve({ deploymentId: id }) });
const metadata = (value: Deployment) => vi.mocked(loadRequestDeploymentLogMetadata).mockResolvedValue({ kind: "ready", data: { deployment: value, events: [] }, requestId: "req" });
describe("deployment detail redeploy composition", () => {
  it("authenticates before loading any deployment metadata", async () => {
    vi.mocked(loadRequestAuthSession).mockResolvedValue({ kind: "unauthenticated", reason: "missing-cookie" }); render(await page());
    expect(screen.getByText("Sign in required")).toBeTruthy(); expect(loadRequestDeploymentLogMetadata).not.toHaveBeenCalled(); expect(screen.queryByRole("button", { name: "Redeploy snapshot" })).toBeNull();
  });
  it("mounts the real control for the explicit selected source and displays read-only lineage", async () => {
    metadata(deployment); render(await page()); expect(screen.getByRole("button", { name: "Redeploy snapshot" })).toBeTruthy();
    expect(screen.getByText(hash)).toBeTruthy(); expect(screen.getByRole("link", { name: "prior" }).getAttribute("href")).toBe("/deployments/prior"); expect(screen.getByRole("link", { name: "origin" }).getAttribute("href")).toBe("/deployments/origin"); expect(screen.queryByText("Active")).toBeNull();
  });
  it("keeps legacy and mismatched selected metadata redeploy-ineligible while preserving existing running Stop", async () => {
    metadata({ ...deployment, executionReceipt: undefined }); const view = render(await page()); expect(screen.queryByRole("button", { name: "Redeploy snapshot" })).toBeNull(); view.unmount();
    metadata(deployment); const mismatch = render(await page("different")); expect(screen.queryByRole("button", { name: "Redeploy snapshot" })).toBeNull(); mismatch.unmount();
    metadata({ ...deployment, status: "running", finishedAt: null, executionReceipt: undefined }); render(await page()); expect(screen.getByRole("button", { name: "Stop deployment" })).toBeTruthy(); expect(screen.queryByRole("button", { name: "Redeploy snapshot" })).toBeNull();
  });
});

describe("detail page rollback selection and preserved history", () => {
const project = { id: "project", name: "Project", repoUrl: "https://github.com/example/project", defaultBranch: "main", buildCommand: null, runCommand: null, port: 8080, description: null, imageTag: null };
const rollbackPage = (id = "A") => DeploymentPage({ params: Promise.resolve({ deploymentId: id }) });
beforeEach(() => {
  vi.mocked(loadRequestAuthSession).mockReset().mockResolvedValue({ kind: "authenticated", user: { id: "operator", email: "operator@example.test", role: "operator", status: "active" } });
  vi.mocked(loadRequestDeploymentLogMetadata).mockReset().mockResolvedValue({ kind: "ready", data: { deployment: execution("A"), events: [] }, requestId: "request-A" });
  vi.mocked(loadRequestProjectDetailMetadata).mockReset().mockResolvedValue({ kind: "ready", data: { project, envVariables: [], deployments: [execution("H", true)] }, requestId: "request-history" });
  vi.stubEnv("DEPLOYLITE_WEB_API_BASE_URL", "https://api.test");
});

  it("authenticates before any selected detail or historical choice load", async () => {
    vi.mocked(loadRequestAuthSession).mockResolvedValue({ kind: "unauthenticated", reason: "missing-cookie" });
    render(await rollbackPage()); expect(screen.getByText("Sign in required")).toBeTruthy();
    expect(loadRequestDeploymentLogMetadata).not.toHaveBeenCalled(); expect(loadRequestProjectDetailMetadata).not.toHaveBeenCalled();
  });
  it("loads H from selected A's project without auto-selecting a latest success", async () => {
    vi.mocked(loadRequestProjectDetailMetadata).mockResolvedValue({ kind: "ready", data: { project, envVariables: [], deployments: [execution("newer-success"), execution("H", true), { ...execution("cross", true), projectId: "other" }] }, requestId: "history" });
    render(await rollbackPage()); expect(loadRequestDeploymentLogMetadata).toHaveBeenCalledWith("A");
    expect(loadRequestProjectDetailMetadata).toHaveBeenCalledWith("project");
    expect((screen.getByRole("combobox", { name: "Historical execution" }) as HTMLSelectElement).value).toBe("");
    expect(screen.queryByRole("option", { name: /cross/ })).toBeNull();
    expect(screen.queryByText("Active")).toBeNull(); expect(screen.getAllByText("succeeded")[0]).toBeTruthy();
  });
  it.each(["read-failure", "wrong-project", "wrong-selected-A"])("keeps detail evidence readable while rejecting %s choices", async (fault) => {
    if (fault === "read-failure") vi.mocked(loadRequestProjectDetailMetadata).mockResolvedValue({ kind: "error", reason: "api-rejected", status: 403 });
    if (fault === "wrong-project") vi.mocked(loadRequestProjectDetailMetadata).mockResolvedValue({ kind: "ready", data: { project: { ...project, id: "other" }, envVariables: [], deployments: [execution("H", true)] }, requestId: "history" });
    render(await rollbackPage(fault === "wrong-selected-A" ? "different-A" : "A"));
    expect(screen.getByText("Log evidence")).toBeTruthy(); expect(screen.queryByRole("button", { name: "Rollback to snapshot" })).toBeNull();
  });
  it("does not mutate selected A or historical H metadata while composing controls", async () => {
    const A = execution("A"), H = execution("H", true), before = structuredClone([A, H]);
    vi.mocked(loadRequestDeploymentLogMetadata).mockResolvedValue({ kind: "ready", data: { deployment: A, events: [] }, requestId: "selected" });
    vi.mocked(loadRequestProjectDetailMetadata).mockResolvedValue({ kind: "ready", data: { project, envVariables: [], deployments: [H] }, requestId: "history" });
    render(await rollbackPage()); expect([A, H]).toEqual(before);
    expect(screen.getByText(A.snapshotHash!)).toBeTruthy();
    expect(screen.getByRole("link", { name: "origin-A" }).getAttribute("href")).toBe("/deployments/origin-A");
  });
});
