import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { loadRequestAuthSession, loadRequestProjectDetailMetadata, loadRequestProjectEnvValues } from "@/lib/server-auth";
import { loadAuditEvents } from "@/lib/auth-boundary";
import ProjectDetailPage from "./page";
const observed = vi.hoisted(() => ({card: vi.fn(), inventory: vi.fn()}));
vi.mock("next/headers", () => ({cookies: vi.fn()}));
vi.mock("@/lib/server-auth", () => ({loadRequestAuthSession: vi.fn(), loadRequestProjectDetailMetadata: vi.fn(), loadRequestProjectEnvValues: vi.fn()}));
vi.mock("@/lib/auth-boundary", () => ({getAuthApiBaseUrl: () => "https://api.example.test", loadAuditEvents: vi.fn()}));
vi.mock("@/components/app-shell", () => ({AppShell: ({children}: {children: ReactNode}) => <main>{children}</main>}));
vi.mock("./project-config-edit-form", () => ({ProjectConfigEditForm: () => null}));
vi.mock("./project-detail-actions", () => ({ProjectDetailActions: () => null}));
vi.mock("./project-audit-history-panel", () => ({ProjectAuditHistoryPanel: () => null}));
vi.mock("./runtime-configuration-card", () => ({RuntimeConfigurationCard: () => null}));
vi.mock("@/components/project-delete-dialog", () => ({ProjectDeleteDialog: () => null}));
vi.mock("@/components/project-env-values-table", () => ({ProjectEnvValuesTable: () => null}));
vi.mock("./compose-preview-card", () => ({ComposePreviewCard: () => null}));
vi.mock("@/components/managed-database-operator-card", () => ({ManagedDatabaseOperatorCard: (props: unknown) => {observed.card(props); return <h2>Native database operators</h2>;}}));
vi.mock("@/components/managed-database-inventory-panel", () => ({ManagedDatabaseInventoryPanel: (props: unknown) => {observed.inventory(props); return <h2>Stored native databases</h2>;}}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(cookies).mockResolvedValue({getAll: () => [{name: "deploylite_session", value: "opaque-fixture"}]} as never);
  vi.mocked(loadRequestProjectDetailMetadata).mockResolvedValue({kind: "ready", requestId: "request-1", data: {
    project: {id: "project-1", name: "Example app", repoUrl: "https://github.com/example/app", defaultBranch: "main", buildCommand: null, runCommand: null, port: null, imageTag: null, description: null}, deployments: [], envVariables: []}});
  vi.mocked(loadRequestProjectEnvValues).mockResolvedValue({kind: "ready", requestId: "request-1", data: {envValues: []}});
  vi.mocked(loadAuditEvents).mockResolvedValue({kind: "ready", requestId: "request-1", data: {events: [], total: 0, offset: 0, limit: 50}});
});
function authenticate(role: "admin" | "operator" | "read-only") {
  vi.mocked(loadRequestAuthSession).mockResolvedValue({kind: "authenticated", user: {id: "user-1", email: "operator@example.test", role, status: "active"}});
}
async function page() {return renderToStaticMarkup(await ProjectDetailPage({params: Promise.resolve({projectId: "project-1"})}));}
it.each(["admin", "operator"] as const)("offers native creation/control to %s without giving the component a session cookie", async role => {
  authenticate(role); expect(await page()).toContain("Native database operators");
  expect(observed.card).toHaveBeenCalledExactlyOnceWith({projectId: "project-1", apiBaseUrl: "https://api.example.test", onCreated: expect.any(Function)});
});
it("preserves readonly project viewing without privileged native controls", async () => {
  authenticate("read-only"); expect(await page()).not.toContain("Native database operators"); expect(observed.card).not.toHaveBeenCalled();
});
it("withholds native controls without authentication or a resolved project", async () => {
  vi.mocked(loadRequestAuthSession).mockResolvedValue({kind: "unauthenticated", reason: "missing-cookie"});
  expect(await page()).toContain("Sign in required"); authenticate("admin");
  vi.mocked(loadRequestProjectDetailMetadata).mockResolvedValue({kind: "error", reason: "api-rejected", status: 404});
  expect(await page()).toContain("Project not found"); expect(observed.card).not.toHaveBeenCalled();
});

it("activates scoped stored inventory for operators without forwarding server credentials", async () => {
  authenticate("operator"); expect(await page()).toContain("Stored native databases");
  expect(observed.inventory).toHaveBeenCalledExactlyOnceWith({actorId: "user-1", projectId: "project-1", apiBaseUrl: "https://api.example.test", refreshKey: 0, selectedDatabaseId: "", onSelect: expect.any(Function)});
});
