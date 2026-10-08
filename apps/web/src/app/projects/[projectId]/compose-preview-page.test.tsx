import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { loadRequestAuthSession, loadRequestProjectDetailMetadata, loadRequestProjectEnvValues } from "@/lib/server-auth";
import { loadAuditEvents } from "@/lib/auth-boundary";
import ProjectDetailPage from "./page";

const observed = vi.hoisted(() => ({ card: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("@/lib/server-auth", () => ({ loadRequestAuthSession: vi.fn(), loadRequestProjectDetailMetadata: vi.fn(), loadRequestProjectEnvValues: vi.fn() }));
vi.mock("@/lib/auth-boundary", () => ({ getAuthApiBaseUrl: () => "https://api.example.test", loadAuditEvents: vi.fn() }));
vi.mock("@/components/app-shell", () => ({ AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main> }));
vi.mock("./project-config-edit-form", () => ({ ProjectConfigEditForm: () => null }));
vi.mock("./project-detail-actions", () => ({ ProjectDetailActions: () => null }));
vi.mock("./project-audit-history-panel", () => ({ ProjectAuditHistoryPanel: () => null }));
vi.mock("./runtime-configuration-card", () => ({ RuntimeConfigurationCard: () => null }));
vi.mock("@/components/project-delete-dialog", () => ({ ProjectDeleteDialog: () => null }));
vi.mock("@/components/project-env-values-table", () => ({ ProjectEnvValuesTable: () => null }));
vi.mock("./compose-preview-card", () => ({ ComposePreviewCard: (props: { projectId: string; apiBaseUrl: string | null }) => { observed.card(props); return <h2>Compose preview</h2>; } }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(cookies).mockResolvedValue({ getAll: () => [{ name: "deploylite_session", value: "opaque-fixture" }] } as never);
  vi.mocked(loadRequestProjectDetailMetadata).mockResolvedValue({ kind: "ready", requestId: "request-1", data: {
    project: { id: "project-1", name: "Example app", repoUrl: "https://github.com/example/app", defaultBranch: "main", buildCommand: null, runCommand: null, port: null, imageTag: null, description: null },
    deployments: [], envVariables: [] } });
  vi.mocked(loadRequestProjectEnvValues).mockResolvedValue({ kind: "ready", requestId: "request-1", data: { envValues: [] } });
  vi.mocked(loadAuditEvents).mockResolvedValue({ kind: "ready", requestId: "request-1", data: { events: [], total: 0, offset: 0, limit: 50 } });
});
function renderPage() { return ProjectDetailPage({ params: Promise.resolve({ projectId: "project-1" }) }).then(renderToStaticMarkup); }
function authenticate(role: "admin" | "operator" | "read-only") {
  vi.mocked(loadRequestAuthSession).mockResolvedValue({ kind: "authenticated", user: { id: "user-1", email: "operator@example.test", role, status: "active" } });
}
describe("project preview entry point", () => {
  it.each(["admin", "operator"] as const)("offers a preview to %s without passing a session cookie to the new client component", async (role) => {
    authenticate(role);
    expect(await renderPage()).toContain("Compose preview");
    expect(observed.card).toHaveBeenCalledExactlyOnceWith({ projectId: "project-1", apiBaseUrl: "https://api.example.test" });
  });
  it("keeps read-only project reading without offering the privileged preview", async () => {
    authenticate("read-only");
    const html = await renderPage(); expect(html).toContain("Example app"); expect(html).not.toContain("Compose preview");
    expect(observed.card).not.toHaveBeenCalled();
  });
  it("does not offer preview without authentication or when the project is missing", async () => {
    vi.mocked(loadRequestAuthSession).mockResolvedValue({ kind: "unauthenticated", reason: "missing-cookie" });
    expect(await renderPage()).toContain("Sign in required");
    authenticate("admin");
    vi.mocked(loadRequestProjectDetailMetadata).mockResolvedValue({ kind: "error", reason: "api-rejected", status: 404 });
    expect(await renderPage()).toContain("Project not found"); expect(observed.card).not.toHaveBeenCalled();
  });
});
