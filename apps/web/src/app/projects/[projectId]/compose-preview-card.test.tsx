// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComposePreviewV1 } from "@deploylite/contracts";
import { ComposePreviewCard } from "./compose-preview-card";
import { previewProjectCompose } from "./compose-preview-client";

const props = { projectId: "project-1", apiBaseUrl: "https://api.example.test" };
const document = JSON.stringify({ services: { web: { image: "registry.example.test/app@sha256:" + "a".repeat(64) } } });
const preview: ComposePreviewV1 = {
  schemaVersion: 1, projectId: props.projectId, status: "preview", executionAllowed: false, policyVersion: "policy-v1",
  configDigest: "b".repeat(64), canonicalDocument: "{}",
  services: [{ name: "web", image: "registry.example.test/app@sha256:" + "a".repeat(64), networks: ["front"],
    volumes: [{ source: "data", target: "/var/lib/app", readOnly: false }], secretRefs: [{ key: "TOKEN", secretRefId: "APP_TOKEN" }] }],
  networks: [{ key: "front", projectId: props.projectId, runtimeName: "dl-scoped-net-front", attachedServices: ["web"], driver: "bridge", internal: false }],
  volumes: [{ key: "data", projectId: props.projectId, runtimeName: "dl-scoped-vol-data", attachedServices: ["web"], driver: "local" }]
};
function response(value: unknown = preview) { return new Response(JSON.stringify({ data: { preview: value }, error: null, requestId: "request-1" })); }
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("project Compose preview request", () => {
  it("submits only the document to the scoped preview endpoint with browser credentials and no redirect", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response());
    const result = await previewProjectCompose({ ...props, document, fetchImpl });
    expect(result).toEqual({ kind: "ready", preview });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.example.test/api/v1/projects/project-1/compose/preview");
    expect(init).toMatchObject({ method: "POST", credentials: "include", redirect: "error", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ document }) });
    expect(new Headers(init?.headers).has("cookie")).toBe(false);
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
  });
  it.each(["", "x".repeat(65_537), "é".repeat(32_769)])("rejects empty or oversized UTF8 input before transport %#", async (document) => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect((await previewProjectCompose({ ...props, document, fetchImpl })).kind).toBe("error");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("reports an unavailable API with useful configuration guidance", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await previewProjectCompose({ ...props, apiBaseUrl: null, document, fetchImpl });
    expect(result).toEqual({ kind: "error", message: "Compose preview is unavailable until the project API is configured." });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([[401, "Sign in"], [403, "permission"], [404, "unavailable"], [400, "rejected"], [500, "rejected"]])("reports status %s without echoing an API error body", async (status, hint) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { message: "literal-secret-from-error" } }), { status: Number(status) }));
    const result = await previewProjectCompose({ ...props, document, fetchImpl });
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.message).toContain(String(hint));
    expect(JSON.stringify(result)).not.toContain("literal-secret-from-error");
  });
  it.each([
    { ...preview, executionAllowed: true }, { ...preview, schemaVersion: 2 }, { ...preview, projectId: "other-project" },
    { ...preview, networks: [{ ...preview.networks[0], projectId: "other-project" }] },
    { ...preview, volumes: [{ ...preview.volumes[0], projectId: "other-project" }] },
    { ...preview, services: [{ ...preview.services[0], secretRefs: [{ key: "TOKEN", secretRefId: "literal secret with spaces" }] }] }
  ])("rejects mismatched, executable or unsafe preview data %#", async (value) => {
    const result = await previewProjectCompose({ ...props, document, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response(value)) });
    expect(result).toEqual({ kind: "error", message: "The API returned an invalid Compose preview." });
  });
  it("handles invalid JSON and transport failures without echoing source or thrown errors", async () => {
    const malformed = await previewProjectCompose({ ...props, document, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response("literal-secret")) });
    const unavailable = await previewProjectCompose({ ...props, document, fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error("literal-secret")) });
    expect(malformed).toEqual({ kind: "error", message: "The API returned an invalid Compose preview." });
    expect(unavailable).toEqual({ kind: "error", message: "The project API is unreachable. Try the preview again." });
  });
});

describe("project Compose preview interaction", () => {
  function enter(value = document) { fireEvent.change(screen.getByLabelText("Compose document (YAML or JSON)"), { target: { value } }); }
  it("starts empty and never requests a preview before deliberate submission", () => {
    const fetchImpl = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", fetchImpl);
    render(<ComposePreviewCard {...props} />);
    expect(screen.getByRole("heading", { name: "Compose preview" })).toBeTruthy();
    expect((screen.getByLabelText("Compose document (YAML or JSON)") as HTMLTextAreaElement).value).toBe("");
    expect((screen.getByRole("button", { name: "Preview Compose" }) as HTMLButtonElement).disabled).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("renders a scoped proposal, attachments and references, then invalidates it when input changes", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response()); vi.stubGlobal("fetch", fetchImpl);
    render(<ComposePreviewCard {...props} />); enter();
    fireEvent.click(screen.getByRole("button", { name: "Preview Compose" }));
    expect(await screen.findByRole("heading", { name: "Proposed resources" })).toBeTruthy();
    expect(screen.getByText(preview.configDigest)).toBeTruthy();
    expect(screen.getByText("dl-scoped-net-front")).toBeTruthy();
    expect(screen.getByText("dl-scoped-vol-data")).toBeTruthy();
    expect(screen.getByText(/data → \/var\/lib\/app/)).toBeTruthy();
    expect(screen.getByText(/TOKEN → APP_TOKEN/)).toBeTruthy();
    expect(screen.getByText("Preview only. No resources were created and no deployment was started.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /deploy|create|apply|delete/i })).toBeNull();
    enter(document + " ");
    expect(screen.queryByRole("heading", { name: "Proposed resources" })).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("blocks duplicate submissions and discards a response for an edited document", async () => {
    let resolve!: (value: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => new Promise((done) => { resolve = done; })); vi.stubGlobal("fetch", fetchImpl);
    render(<ComposePreviewCard {...props} />); enter();
    fireEvent.click(screen.getByRole("button", { name: "Preview Compose" }));
    expect((screen.getByRole("button", { name: "Previewing..." }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(screen.getByRole("button", { name: "Previewing..." }).closest("form")!);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    enter(document + " ");
    await act(async () => { resolve(response()); });
    await waitFor(() => expect((screen.getByRole("button", { name: "Preview Compose" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole("heading", { name: "Proposed resources" })).toBeNull();
  });
  it("clears draft and preview on demand without a mutation or browser persistence", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response()); vi.stubGlobal("fetch", fetchImpl);
    const storage = vi.spyOn(Storage.prototype, "setItem");
    render(<ComposePreviewCard {...props} />); enter();
    fireEvent.click(screen.getByRole("button", { name: "Preview Compose" }));
    await screen.findByRole("heading", { name: "Proposed resources" });
    fireEvent.click(screen.getByRole("button", { name: "Clear draft" }));
    expect((screen.getByLabelText("Compose document (YAML or JSON)") as HTMLTextAreaElement).value).toBe("");
    expect(screen.queryByRole("heading", { name: "Proposed resources" })).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(storage).not.toHaveBeenCalled();
  });
  it("shows generic policy rejection and permits correction without rendering the submitted source", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { message: "secret-reflection" } }), { status: 400 })));
    render(<ComposePreviewCard {...props} />); enter("secret-reflection");
    fireEvent.click(screen.getByRole("button", { name: "Preview Compose" }));
    expect((await screen.findByRole("alert")).textContent).toContain("rejected");
    expect(screen.getByRole("alert").textContent).not.toContain("secret-reflection");
    expect(screen.queryByRole("heading", { name: "Proposed resources" })).toBeNull();
    enter(); expect(screen.queryByRole("alert")).toBeNull();
  });
});
