// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComposePreviewV1, ComposeResourceCleanupInput, ComposeResourceInspectionViewV1 } from "@deploylite/contracts";
import { ComposePreviewCard } from "./compose-preview-card";
import { confirmProjectComposeCleanup, previewProjectComposeCleanup } from "./compose-resource-cleanup-client";

const props = { projectId: "project-1", apiBaseUrl: "https://api.example.test" };
const image = "registry.example.test/app@sha256:" + "a".repeat(64);
const document = JSON.stringify({ services: { web: { image, networks: ["front"] } }, networks: { front: {} } });
const preview: ComposePreviewV1 = { schemaVersion: 1, projectId: "project-1", status: "preview", executionAllowed: false, policyVersion: "policy-1",
  configDigest: "b".repeat(64), canonicalDocument: "{}", services: [{ name: "web", image, networks: ["front"], volumes: [], secretRefs: [] }],
  networks: [{ key: "front", projectId: "project-1", runtimeName: "dl-scoped-net-front", attachedServices: ["web"], driver: "bridge", internal: false }], volumes: [] };
const observation: ComposeResourceInspectionViewV1 = { schemaVersion: 1, status: "observed", executionAllowed: false, projectId: "project-1", kind: "network", key: "front",
  configDigest: preview.configDigest, stateDigest: "c".repeat(64), observedAt: 1000, containers: [{ service: "web", running: false, attached: false }] };
const cleanupPreview = { schemaVersion: 1, operation: "compose.resource.cleanup", status: "preview", executionAllowed: false, requiresConfirmation: true,
  projectId: "project-1", kind: "network", key: "front", configDigest: preview.configDigest, stateDigest: observation.stateDigest, confirmationTtlMs: 900_000 } as const;
const pendingReceipt = { commandId: "command-1", confirmationId: "confirmation-1", expiresAt: "2030-01-01T00:00:00.000Z", status: "pending_confirmation", idempotent: false, preview: cleanupPreview } as const;
const admittedReceipt = { ...pendingReceipt, status: "eligible" as const, idempotent: false };
const cleanupInput: ComposeResourceCleanupInput = { document, projectId: "project-1", kind: "network", key: "front", expectedConfigDigest: preview.configDigest, expectedStateDigest: observation.stateDigest };
const wrap = (name: string, value: unknown) => new Response(JSON.stringify({ data: { [name]: value }, error: null, requestId: "request-1" }));

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function openCleanup(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>) {
  vi.stubGlobal("fetch", fetchImpl);
  const mounted = render(<ComposePreviewCard {...props} />);
  fireEvent.change(screen.getByLabelText("Compose document (YAML or JSON)"), { target: { value: document } });
  fireEvent.click(screen.getByRole("button", { name: "Preview Compose" }));
  await screen.findByRole("heading", { name: "Proposed resources" });
  fireEvent.click(screen.getByRole("button", { name: "Inspect resource" }));
  await screen.findByRole("heading", { name: "Observed resource use" });
  return mounted;
}

function fixtureFetch(observed = observation) {
  return vi.fn<typeof fetch>()
    .mockResolvedValueOnce(wrap("preview", preview))
    .mockResolvedValueOnce(wrap("inspection", observed));
}

describe("cleanup admission review UI", () => {
  it("maps conflicts to a fresh-inspection requirement and 5xx responses to exact recovery", async () => {
    const options = { ...cleanupInput, apiBaseUrl: props.apiBaseUrl, idempotencyKey: "cleanup-key" };
    expect(await previewProjectComposeCleanup({ ...options, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response("private diagnostic", { status: 409 })) }))
      .toEqual({ kind: "error", message: "The resource state changed or the request expired. Inspect it again before continuing.", recoverable: false, stale: true });
    expect(await previewProjectComposeCleanup({ ...options, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response("private diagnostic", { status: 503 })) }))
      .toEqual({ kind: "error", message: "Cleanup admission is not available for this project.", recoverable: true, stale: false });
  });

  it("rejects a foreign target receipt and does not expose API diagnostics", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(wrap("cleanup", { ...pendingReceipt, preview: { ...cleanupPreview, key: "foreign" }, error: "private diagnostic" }));
    expect(await previewProjectComposeCleanup({ ...cleanupInput, apiBaseUrl: props.apiBaseUrl, idempotencyKey: "cleanup-key", fetchImpl }))
      .toEqual({ kind: "error", message: "The API returned an invalid cleanup result. Retry the exact request to recover its status.", recoverable: true, stale: false });
  });

  it("confirms only with a well-formed exact confirmation pair", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(wrap("cleanup", admittedReceipt));
    expect(await confirmProjectComposeCleanup({ ...cleanupInput, apiBaseUrl: props.apiBaseUrl, idempotencyKey: "cleanup-key", commandId: "command-1", confirmationId: "confirmation-1", fetchImpl }))
      .toEqual({ kind: "ready", receipt: admittedReceipt });
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(new Headers(init?.headers).get("idempotency-key")).toBe("cleanup-key");
    expect(new Headers(init?.headers).get("x-control-confirmation-id")).toBe("confirmation-1");
    expect(await confirmProjectComposeCleanup({ ...cleanupInput, apiBaseUrl: props.apiBaseUrl, idempotencyKey: "cleanup-key", commandId: "foreign/command", confirmationId: "confirmation-1", fetchImpl: vi.fn<typeof fetch>() }))
      .toEqual({ kind: "error", message: "Review the project resource and preview it again before continuing.", recoverable: false, stale: false });
  });

  it("binds preview and confirmation to one exact observation and keeps the editor locked until admission", async () => {
    let sequence = 0;
    vi.stubGlobal("crypto", { randomUUID: () => `idempotency-${++sequence}` });
    const fetchImpl = fixtureFetch().mockResolvedValueOnce(wrap("cleanup", pendingReceipt)).mockResolvedValueOnce(wrap("cleanup", admittedReceipt));
    await openCleanup(fetchImpl);
    fireEvent.click(screen.getByRole("button", { name: "Preview cleanup admission" }));
    await screen.findByRole("button", { name: "Confirm exact admission" });
    expect((screen.getByLabelText("Compose document (YAML or JSON)") as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Clear draft" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Resource to inspect") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Preview attachment" }) as HTMLButtonElement).disabled).toBe(true);
    const [previewUrl, previewInit] = fetchImpl.mock.calls[2]!;
    expect(String(previewUrl)).toBe("https://api.example.test/api/v1/projects/project-1/compose/resources/cleanup/preview");
    expect(JSON.parse(String(previewInit?.body))).toEqual({ document, kind: "network", key: "front", expectedConfigDigest: preview.configDigest, expectedStateDigest: observation.stateDigest });
    const previewHeaders = new Headers(previewInit?.headers);
    expect(previewHeaders.get("idempotency-key")).toBe("idempotency-1");
    expect(previewHeaders.has("authorization")).toBe(false);
    expect(previewHeaders.has("cookie")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Confirm exact admission" }));
    await screen.findByText("Cleanup admission is recorded. No network or volume was removed.");
    const [confirmUrl, confirmInit] = fetchImpl.mock.calls[3]!;
    expect(String(confirmUrl)).toBe("https://api.example.test/api/v1/projects/project-1/compose/resources/cleanup/confirm");
    expect(JSON.parse(String(confirmInit?.body))).toEqual(JSON.parse(String(previewInit?.body)));
    expect(new Headers(confirmInit?.headers).get("idempotency-key")).toBe(previewHeaders.get("idempotency-key"));
    expect(new Headers(confirmInit?.headers).get("x-control-confirmation-id")).toBe("confirmation-1");
    expect(screen.getByRole("button", { name: "Dismiss receipt" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /delete|remove|execute|apply/i })).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("recovers a lost confirmation by replaying the exact command and confirmation", async () => {
    let sequence = 0;
    vi.stubGlobal("crypto", { randomUUID: () => `recovery-${++sequence}` });
    const fetchImpl = fixtureFetch().mockResolvedValueOnce(wrap("cleanup", pendingReceipt))
      .mockRejectedValueOnce(new Error("private transport diagnostic"))
      .mockResolvedValueOnce(wrap("cleanup", admittedReceipt));
    await openCleanup(fetchImpl);
    fireEvent.click(screen.getByRole("button", { name: "Preview cleanup admission" }));
    await screen.findByRole("button", { name: "Confirm exact admission" });
    fireEvent.click(screen.getByRole("button", { name: "Confirm exact admission" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Recover the exact request");
    expect(screen.getByRole("alert").textContent).not.toContain("private transport diagnostic");
    fireEvent.click(screen.getByRole("button", { name: "Recover exact confirmation" }));
    await screen.findByText("Cleanup admission is recorded. No network or volume was removed.");
    const first = fetchImpl.mock.calls[3]!, retry = fetchImpl.mock.calls[4]!;
    expect(JSON.stringify(retry[0])).toBe(JSON.stringify(first[0]));
    expect(retry[1]?.body).toBe(first[1]?.body);
    expect(new Headers(retry[1]?.headers).get("idempotency-key")).toBe(new Headers(first[1]?.headers).get("idempotency-key"));
    expect(new Headers(retry[1]?.headers).get("x-control-confirmation-id")).toBe("confirmation-1");
  });

  it("makes cancel local, leaves a pending server confirmation unused, then unlocks the draft", async () => {
    const fetchImpl = fixtureFetch().mockResolvedValueOnce(wrap("cleanup", pendingReceipt));
    await openCleanup(fetchImpl);
    fireEvent.click(screen.getByRole("button", { name: "Preview cleanup admission" }));
    await screen.findByRole("button", { name: "Confirm exact admission" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel confirmation" }));
    expect(await screen.findByText(/server-side admission may still be pending or recorded/i)).toBeTruthy();
    expect((screen.getByLabelText("Compose document (YAML or JSON)") as HTMLTextAreaElement).disabled).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole("button", { name: "Confirm exact admission" })).toBeNull();
  });

  it("does not offer admission when the observed resource is attached", async () => {
    const attached = { ...observation, containers: [{ service: "web", running: false, attached: true }] };
    const fetchImpl = fixtureFetch(attached);
    await openCleanup(fetchImpl);
    expect(screen.getByText("This resource is attached to an observed container. Inspect again after it is detached.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Preview cleanup admission" }) as HTMLButtonElement).disabled).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries a preview with the same idempotency key after an ambiguous response", async () => {
    let sequence = 0;
    vi.stubGlobal("crypto", { randomUUID: () => `preview-retry-${++sequence}` });
    const fetchImpl = fixtureFetch().mockRejectedValueOnce(new Error("private transport diagnostic")).mockResolvedValueOnce(wrap("cleanup", pendingReceipt));
    await openCleanup(fetchImpl);
    fireEvent.click(screen.getByRole("button", { name: "Preview cleanup admission" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Recover the exact request");
    fireEvent.click(screen.getByRole("button", { name: "Retry exact preview" }));
    await screen.findByRole("button", { name: "Confirm exact admission" });
    expect(new Headers(fetchImpl.mock.calls[2]![1]?.headers).get("idempotency-key")).toBe("preview-retry-1");
    expect(new Headers(fetchImpl.mock.calls[3]![1]?.headers).get("idempotency-key")).toBe("preview-retry-1");
    expect(fetchImpl.mock.calls[3]![1]?.body).toBe(fetchImpl.mock.calls[2]![1]?.body);
  });

  it("discards cleanup state and unlocks if a fresh resource observation arrives", async () => {
    const fetchImpl = fixtureFetch().mockResolvedValueOnce(wrap("cleanup", pendingReceipt))
      .mockResolvedValueOnce(wrap("inspection", { ...observation, observedAt: 2000 }));
    await openCleanup(fetchImpl);
    fireEvent.click(screen.getByRole("button", { name: "Preview cleanup admission" }));
    await screen.findByRole("button", { name: "Confirm exact admission" });
    fireEvent.click(screen.getByRole("button", { name: "Inspect resource" }));
    expect(await screen.findByText(/fresh resource observation replaced this cleanup review/i)).toBeTruthy();
    expect((screen.getByLabelText("Compose document (YAML or JSON)") as HTMLTextAreaElement).disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Confirm exact admission" })).toBeNull();
  });
});
