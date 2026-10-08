// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComposePreviewV1, ComposeRevisionV1 } from "@deploylite/contracts";
import { ComposePreviewCard } from "./compose-preview-card";
import * as client from "./compose-preview-client";
const props = { projectId: "project-1", apiBaseUrl: "https://api.example.test" };
const image = `registry.example.com/app@sha256:${"a".repeat(64)}`;
const document = JSON.stringify({ services: { web: { image, networks: ["default"], volumes: [], environment: { TOKEN: "${APP_TOKEN}" } } }, networks: { default: { driver: "bridge", internal: false } }, volumes: {} });
const preview: ComposePreviewV1 = { schemaVersion: 1, projectId: props.projectId, status: "preview", executionAllowed: false, policyVersion: "ui-fixture", configDigest: "b".repeat(64), canonicalDocument: document,
  services: [{ name: "web", image, networks: ["default"], volumes: [], secretRefs: [{ key: "TOKEN", secretRefId: "APP_TOKEN" }] }],
  networks: [{ key: "default", projectId: props.projectId, runtimeName: `dl-${"a".repeat(32)}-net-default`, attachedServices: ["web"], driver: "bridge", internal: false }], volumes: [] };
const revision: ComposeRevisionV1 = { schemaVersion: 1, id: "revision-1", projectId: props.projectId, composeId: "compose-1", number: 1, createdBy: "actor-1", createdAt: "2026-10-08T04:00:00Z", preview };
const saved = { revision, commandId: revision.id, idempotent: false };
const resource = { id: "compose-1", projectId: props.projectId, latestRevisionId: "revision-2", latestNumber: 2, updatedAt: revision.createdAt, serviceNames: ["web"] };
const metadata = (id: string, number: number) => ({ schemaVersion: 1, id, projectId: props.projectId, composeId: resource.id, number, createdBy: revision.createdBy, createdAt: revision.createdAt, configDigest: preview.configDigest, policyVersion: preview.policyVersion, serviceCount: 1, networkCount: 1, volumeCount: 0, executionAllowed: false });
const response = (data: unknown, status = 200) => new Response(JSON.stringify({ data, error: null, requestId: "ui-request" }), { status });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function button(name: string): HTMLButtonElement { const value = screen.queryByRole("button", { name }); expect(value).not.toBeNull(); return value as HTMLButtonElement; }
function enter(value = document) { fireEvent.change(screen.getByLabelText("Compose document (YAML or JSON)"), { target: { value } }); }
async function plan() { enter(); fireEvent.click(screen.getByRole("button", { name: "Preview Compose" })); await screen.findByRole("heading", { name: "Proposed resources" }); }
const saveOptions = { ...props, document, expectedPreviewDigest: preview.configDigest, composeId: null, expectedRevisionId: null, idempotencyKey: "browser-save-key" };
describe("Compose save client boundary", () => {
  it("sends only declared save intent and the shared idempotency header with browser credentials/no redirect", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(saved, 201)); const result = await client.saveProjectCompose({ ...saveOptions, fetchImpl }); expect(result).toEqual({ kind: "ready", data: saved });
    const [url, init] = fetchImpl.mock.calls[0]!; expect(String(url)).toBe("https://api.example.test/api/v1/projects/project-1/compose");
    expect(init).toMatchObject({ method: "POST", credentials: "include", redirect: "error", cache: "no-store", headers: { "content-type": "application/json", "x-control-idempotency-key": "browser-save-key" } });
    expect(JSON.parse(String(init?.body))).toEqual({ document, expectedPreviewDigest: preview.configDigest, composeId: null, expectedRevisionId: null }); expect(new Headers(init?.headers).has("cookie")).toBe(false);
  });
  it.each(["foreign", "executable", "credential"])("refuses %s saved data without a user-visible source excerpt", async (variant) => {
    const value = variant === "foreign" ? { ...revision, projectId: "foreign" } : variant === "executable" ? { ...revision, preview: { ...preview, executionAllowed: true } }
      : { ...revision, preview: { ...preview, services: [{ ...preview.services[0], image: "fixture_literal_secret@registry.example.com/app@sha256:" + "a".repeat(64) }] } };
    const result = await client.saveProjectCompose({ ...saveOptions, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response({ ...saved, revision: value })) }); expect(result.kind).toBe("error"); expect(JSON.stringify(result)).not.toContain("fixture_literal_secret");
  });
  it("reports a concurrent-change409 and never echoes an API error body", async () => { const result = await client.saveProjectCompose({ ...saveOptions, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response("fixture_literal_secret", { status: 409 })) }); expect(result.kind).toBe("error"); if (result.kind !== "error") throw new Error("Expected conflict refusal."); expect(result.message).toMatch(/changed|conflict/i); expect(result.message).not.toContain("fixture_literal_secret"); });
});
describe("Compose save and revision-history interaction", () => {
  it("keeps save disabled before a deliberate successful preview and performs no automatic request", () => { const fetchImpl = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", fetchImpl); render(<ComposePreviewCard {...props} />); expect(button("Save revision").disabled).toBe(true); expect(fetchImpl).not.toHaveBeenCalled(); });
  it("saves a new logical resource after preview and prevents an unchanged duplicate save", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ preview })).mockResolvedValueOnce(response(saved, 201)); vi.stubGlobal("fetch", fetchImpl); const storage = vi.spyOn(Storage.prototype, "setItem");
    render(<ComposePreviewCard {...props} />); await plan(); fireEvent.click(button("Save revision")); await screen.findByText(/Revision 1 saved/); expect(button("Save revision").disabled).toBe(true);
    const body = JSON.parse(String(fetchImpl.mock.calls[1]![1]?.body)); expect(body).toEqual({ document, expectedPreviewDigest: preview.configDigest, composeId: null, expectedRevisionId: null }); expect(storage).not.toHaveBeenCalled();
  });
  it("retries an ambiguous save failure using the same key and blocks duplicate clicks while pending", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ preview })).mockResolvedValueOnce(new Response("fixture_literal_secret", { status: 503 })).mockResolvedValueOnce(response({ ...saved, idempotent: true })); vi.stubGlobal("fetch", fetchImpl);
    render(<ComposePreviewCard {...props} />); await plan(); fireEvent.click(button("Save revision")); fireEvent.click(button("Saving..."));
    await screen.findByRole("alert"); expect(screen.getByRole("alert").textContent).not.toContain("fixture_literal_secret"); fireEvent.click(button("Save revision")); await screen.findByText(/Revision 1 saved/);
    expect(new Headers(fetchImpl.mock.calls[1]![1]?.headers).get("x-control-idempotency-key")).toBe(new Headers(fetchImpl.mock.calls[2]![1]?.headers).get("x-control-idempotency-key")); expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it("does not overwrite a changed draft or restore an old proposal after a late save result", async () => {
    let resolve!: (value: Response) => void; const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ preview })).mockImplementationOnce(() => new Promise((done) => { resolve = done; })); vi.stubGlobal("fetch", fetchImpl);
    render(<ComposePreviewCard {...props} />); await plan(); fireEvent.click(button("Save revision")); const changed = document + " "; enter(changed); await act(async () => { resolve(response(saved)); });
    expect((screen.getByLabelText("Compose document (YAML or JSON)") as HTMLTextAreaElement).value).toBe(changed); expect(screen.queryByRole("heading", { name: "Proposed resources" })).toBeNull(); expect(button("Save revision").disabled).toBe(true);
  });
  it("loads historical intent into a draft, requires a new preview and saves against the actual latest revision", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/preview")) return response({ preview });
      if (init?.method === "POST") return response({ ...saved, commandId: "revision-3", revision: { ...revision, id: "revision-3", number: 3 } }, 201);
      if (path.endsWith("/revisions/revision-1")) return response({ revision });
      if (path.endsWith("/revisions")) return response({ revisions: [metadata("revision-2", 2), metadata("revision-1", 1)], total: 2, limit: 20, offset: 0 });
      return response({ resources: [resource], total: 1, limit: 20, offset: 0 });
    }); vi.stubGlobal("fetch", fetchImpl); render(<ComposePreviewCard {...props} />);
    fireEvent.click(button("Browse saved Compose")); fireEvent.click(await screen.findByRole("button", { name: "web · revision 2" })); fireEvent.click(await screen.findByRole("button", { name: "Load revision 1" }));
    await waitFor(() => expect((screen.getByLabelText("Compose document (YAML or JSON)") as HTMLTextAreaElement).value).toBe(document)); expect(button("Save revision").disabled).toBe(true);
    fireEvent.click(button("Preview Compose")); await screen.findByRole("heading", { name: "Proposed resources" }); fireEvent.click(button("Save revision")); await screen.findByText(/Revision 3 saved/);
    const call = fetchImpl.mock.calls.find(([url, init]) => String(url).endsWith("/compose") && init?.method === "POST")!; expect(JSON.parse(String(call[1]?.body))).toMatchObject({ composeId: "compose-1", expectedRevisionId: "revision-2" });
  });
  it("refuses a saved-list403 without rendering the raw error or a previous document", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("fixture_literal_secret", { status: 403 }))); render(<ComposePreviewCard {...props} />); fireEvent.click(button("Browse saved Compose"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/permission/i); expect(screen.getByRole("alert").textContent).not.toContain("fixture_literal_secret");
  });
});
