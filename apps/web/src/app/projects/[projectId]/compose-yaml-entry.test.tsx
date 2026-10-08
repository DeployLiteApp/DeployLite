// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposePreviewCard } from "./compose-preview-card";
const image = "registry.example.test/app@sha256:" + "a".repeat(64);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("YAML preview entry", () => {
  it("offers YAML1.2 and JSON with explicit closed syntax guidance", () => {
    render(<ComposePreviewCard projectId="project-1" apiBaseUrl="https://api.example.test" />);
    expect(screen.getByLabelText("Compose document (YAML or JSON)")).toBeTruthy();
    expect(screen.getByText(/YAML 1.2/)).toBeTruthy();
    expect(screen.queryByText(/YAML is not supported/)).toBeNull();
  });
  it("submits the YAML document unchanged and renders the returned proposal", async () => {
    const document = `services:\n  web:\n    image: ${image}\n`;
    const preview = { schemaVersion: 1, projectId: "project-1", status: "preview", executionAllowed: false, policyVersion: "test", configDigest: "b".repeat(64), canonicalDocument: "{}", services: [{ name: "web", image, networks: ["default"], volumes: [], secretRefs: [] }], networks: [{ key: "default", projectId: "project-1", runtimeName: "dl-proposed-net-default", driver: "bridge", internal: false, attachedServices: ["web"] }], volumes: [] };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: { preview }, error: null, requestId: "request-1" }))); vi.stubGlobal("fetch", fetchImpl);
    render(<ComposePreviewCard projectId="project-1" apiBaseUrl="https://api.example.test" />);
    fireEvent.change(screen.getByLabelText("Compose document (YAML or JSON)"), { target: { value: document } }); fireEvent.click(screen.getByRole("button", { name: "Preview Compose" }));
    await screen.findByRole("heading", { name: "Proposed resources" });
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(fetchImpl.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ document }));
    expect(screen.getByText("Preview only. No resources were created and no deployment was started.")).toBeTruthy();
  });
});
