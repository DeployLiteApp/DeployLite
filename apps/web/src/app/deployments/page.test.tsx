import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DeploymentsPage from "./page.js";
import { loadRequestAuthSession, loadRequestDashboardMetadata } from "@/lib/server-auth";
vi.mock("@/lib/server-auth", () => ({ loadRequestAuthSession: vi.fn(), loadRequestDashboardMetadata: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
const authenticated = { kind: "authenticated" as const, user: { id: "user-1", email: "admin@example.test", role: "admin" as const, status: "active" as const } };
const deployment = { id: "dep-1", projectId: "project-1", agentId: "agent-1", status: "running" as const, commitSha: "abcdef1", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: null };
beforeEach(() => { vi.mocked(loadRequestAuthSession).mockReset(); vi.mocked(loadRequestDashboardMetadata).mockReset(); });
describe("DeploymentsPage route composition", () => {
  it("keeps unauthenticated and loader error states outside the client boundary", async () => {
    vi.mocked(loadRequestAuthSession).mockResolvedValue({ kind: "unauthenticated", reason: "missing-cookie" });
    expect(renderToStaticMarkup(await DeploymentsPage())).toContain("Sign in required");
    vi.mocked(loadRequestAuthSession).mockResolvedValue(authenticated); vi.mocked(loadRequestDashboardMetadata).mockResolvedValue({ kind: "error", reason: "api-unreachable" });
    expect(renderToStaticMarkup(await DeploymentsPage())).toContain("Unable to load deployments");
  });
  it("passes loaded history to the filter while preserving log links", async () => {
    vi.mocked(loadRequestAuthSession).mockResolvedValue(authenticated); vi.mocked(loadRequestDashboardMetadata).mockResolvedValue({ kind: "ready", data: { agents: [], projects: [], deployments: [deployment] }, requestId: "req-1" });
    const html = renderToStaticMarkup(await DeploymentsPage());
    expect(html).toContain("Filter by status"); expect(html).toContain("Showing 1 deployment record."); expect(html).toContain('href="/deployments/dep-1"');
  });
});
