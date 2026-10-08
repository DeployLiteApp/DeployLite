import { z } from "zod";
import { COMPOSE_PREVIEW_MAX_BYTES, composeResourceCleanupInputSchema, composeResourceCleanupReceiptSchema,
  type ComposeResourceCleanupInput, type ComposeResourceCleanupReceiptV1 } from "@deploylite/contracts";

type Transport = { apiBaseUrl: string | null; fetchImpl?: typeof fetch; signal?: AbortSignal };
export type ComposeResourceCleanupOptions = ComposeResourceCleanupInput & Transport & { idempotencyKey: string };
export type ComposeResourceCleanupConfirmationOptions = ComposeResourceCleanupOptions & { confirmationId: string; commandId: string };
type Failure = { kind: "error"; message: string; recoverable: boolean; stale: boolean };
export type ComposeResourceCleanupResult = { kind: "ready"; receipt: ComposeResourceCleanupReceiptV1 } | Failure;

const identity = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const responseEnvelope = z.object({ data: z.object({ cleanup: composeResourceCleanupReceiptSchema }).strict(), error: z.null(), requestId: identity }).strict();
const invalid = (): Failure => ({ kind: "error", message: "The API returned an invalid cleanup result. Retry the exact request to recover its status.", recoverable: true, stale: false });
const failed = (message: string, recoverable = false, stale = false): Failure => ({ kind: "error", message, recoverable, stale });

function configured(value: string | null): URL | null {
  try {
    const url = new URL(value ?? "");
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash ? url : null;
  } catch { return null; }
}

function statusMessage(status: number): string {
  if (status === 401) return "Sign in again to review cleanup admission.";
  if (status === 403) return "Cleanup admission requires project delete permission.";
  if (status === 404) return "This project is unavailable.";
  if (status === 409) return "The resource state changed or the request expired. Inspect it again before continuing.";
  return "Cleanup admission is not available for this project.";
}

async function request(mode: "preview" | "confirm", options: ComposeResourceCleanupOptions, commandId?: string,
  confirmationId?: string): Promise<ComposeResourceCleanupResult> {
  const base = configured(options.apiBaseUrl);
  if (!base) return failed("Cleanup admission is unavailable until the project API is configured.");
  if (!identity.safeParse(options.idempotencyKey).success || (mode === "confirm" && (!identity.safeParse(confirmationId).success || !identity.safeParse(commandId).success)))
    return failed("Review the project resource and preview it again before continuing.");
  const parsed = composeResourceCleanupInputSchema.safeParse({ document: options.document, projectId: options.projectId, kind: options.kind, key: options.key,
    expectedConfigDigest: options.expectedConfigDigest, expectedStateDigest: options.expectedStateDigest });
  if (!parsed.success || new TextEncoder().encode(parsed.data.document).length > COMPOSE_PREVIEW_MAX_BYTES)
    return failed("Inspect this exact project resource before requesting cleanup admission.");
  const { projectId, ...body } = parsed.data;
  const headers: Record<string, string> = { "content-type": "application/json", "idempotency-key": options.idempotencyKey };
  if (mode === "confirm") headers["x-control-confirmation-id"] = confirmationId!;
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(new URL(`/api/v1/projects/${encodeURIComponent(projectId)}/compose/resources/cleanup/${mode}`, base), {
      method: "POST", credentials: "include", redirect: "error", cache: "no-store", signal: options.signal, headers, body: JSON.stringify(body)
    });
  } catch { return failed("The cleanup request returned no response. Recover the exact request before starting another preview.", true); }
  if (!response.ok) {
    const recoverable = response.status >= 500;
    return failed(statusMessage(response.status), recoverable, response.status === 409);
  }
  let payload: unknown;
  try { payload = await response.json(); } catch { return invalid(); }
  const envelope = responseEnvelope.safeParse(payload);
  if (!envelope.success) return invalid();
  const receipt = envelope.data.data.cleanup;
  if (receipt.preview.projectId !== projectId || receipt.preview.kind !== body.kind || receipt.preview.key !== body.key
    || receipt.preview.configDigest !== body.expectedConfigDigest || receipt.preview.stateDigest !== body.expectedStateDigest
    || (mode === "confirm" && (receipt.commandId !== commandId || receipt.confirmationId !== confirmationId || receipt.status !== "eligible"))) return invalid();
  return { kind: "ready", receipt };
}

export function previewProjectComposeCleanup(options: ComposeResourceCleanupOptions): Promise<ComposeResourceCleanupResult> {
  return request("preview", options);
}

export function confirmProjectComposeCleanup(options: ComposeResourceCleanupConfirmationOptions): Promise<ComposeResourceCleanupResult> {
  return request("confirm", options, options.commandId, options.confirmationId);
}
