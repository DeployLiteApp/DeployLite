import { z } from "zod";
import { COMPOSE_PREVIEW_MAX_BYTES, composePreviewRequestSchema, composePreviewSchema, composeRevisionSaveRequestSchema, composeRevisionSavedSchema, composeResourcePageSchema, composeRevisionHistoryPageSchema, composeRevisionSchema, type ComposeRevisionSaved, type ComposeResourcePage, type ComposeRevisionHistoryPageV1, type ComposeRevisionV1, type ComposePreviewV1 } from "@deploylite/contracts";

type Options = { projectId: string; apiBaseUrl: string | null; document: string; fetchImpl?: typeof fetch; signal?: AbortSignal };
export type ComposePreviewResult = { kind: "ready"; preview: ComposePreviewV1 } | { kind: "error"; message: string };
const envelope = z.object({ data: z.object({ preview: composePreviewSchema }).strict(), error: z.null(), requestId: z.string() }).strict();
const invalid = () => ({ kind: "error" as const, message: "The API returned an invalid Compose preview." });
const reference = /^[A-Z_][A-Z0-9_]{0,127}$/;

export async function previewProjectCompose({ projectId, apiBaseUrl, document, fetchImpl = fetch, signal }: Options): Promise<ComposePreviewResult> {
  if (!apiBaseUrl) return { kind: "error", message: "Compose preview is unavailable until the project API is configured." };
  if (!composePreviewRequestSchema.safeParse({ document }).success || new TextEncoder().encode(document).length > COMPOSE_PREVIEW_MAX_BYTES) {
    return { kind: "error", message: "Enter a Compose YAML or JSON document of at most 64 KiB." };
  }
  try {
    const response = await fetchImpl(new URL(`/api/v1/projects/${encodeURIComponent(projectId)}/compose/preview`, apiBaseUrl), {
      method: "POST", credentials: "include", redirect: "error", cache: "no-store", signal,
      headers: { "content-type": "application/json" }, body: JSON.stringify({ document })
    });
    if (!response.ok) {
      const message = response.status === 401 ? "Sign in again to preview Compose."
        : response.status === 403 ? "Compose preview requires project deploy permission."
        : response.status === 404 ? "This project is unavailable."
        : "Compose preview was rejected. Check supported fields, digest-pinned images and secret references.";
      return { kind: "error", message };
    }
    let payload: unknown;
    try { payload = await response.json(); } catch { return invalid(); }
    const parsed = envelope.safeParse(payload);
    if (!parsed.success) return invalid();
    const preview = parsed.data.data.preview;
    if (preview.projectId !== projectId || [...preview.networks, ...preview.volumes].some((resource) => resource.projectId !== projectId)
      || preview.services.some((service) => service.secretRefs.some((ref) => !reference.test(ref.key) || !reference.test(ref.secretRefId)))) return invalid();
    return { kind: "ready", preview };
  } catch { return { kind: "error", message: "The project API is unreachable. Try the preview again." }; }
}


type ComposeReadOptions = { projectId: string; apiBaseUrl: string | null; fetchImpl?: typeof fetch; signal?: AbortSignal };
type PageOptions = ComposeReadOptions & { limit?: number; offset?: number };
type ComposeResult<T> = { kind: "ready"; data: T } | { kind: "error"; message: string };
type SaveOptions = Options & { expectedPreviewDigest: string; composeId: string | null; expectedRevisionId: string | null; idempotencyKey: string };
const invalidSaved = () => ({ kind: "error" as const, message: "The API returned invalid saved Compose data." });

async function requestSaved<T>({ projectId, apiBaseUrl, fetchImpl = fetch, signal }: ComposeReadOptions, suffix: string, schema: z.ZodType<T>, init?: RequestInit): Promise<ComposeResult<T>> {
  if (!apiBaseUrl) return { kind: "error", message: "Saved Compose is unavailable until the project API is configured." };
  try {
    const response = await fetchImpl(new URL(`/api/v1/projects/${encodeURIComponent(projectId)}/compose${suffix}`, apiBaseUrl), {
      ...init, credentials: "include", redirect: "error", cache: "no-store", signal
    });
    if (!response.ok) return { kind: "error", message: response.status === 401 ? "Sign in again to access saved Compose."
      : response.status === 403 ? `Saved Compose requires project ${init?.method === "POST" ? "update" : "deploy"} permission.`
      : response.status === 404 ? "The saved Compose resource is unavailable."
      : response.status === 409 ? "The configuration changed or conflicts with a previous save. Refresh its history and preview again."
      : response.status === 503 ? "Compose storage is unavailable. Try again."
      : "The Compose request was rejected. Review the document and preview again." };
    const envelope = z.object({ data: z.unknown(), error: z.null(), requestId: z.string() }).strict().safeParse(await response.json());
    if (!envelope.success) return invalidSaved();
    const result = schema.safeParse(envelope.data.data);
    return result.success ? { kind: "ready", data: result.data } : invalidSaved();
  } catch { return { kind: "error", message: "The project API is unreachable. Try again." }; }
}

export async function saveProjectCompose(options: SaveOptions): Promise<ComposeResult<ComposeRevisionSaved>> {
  const { document, expectedPreviewDigest, composeId, expectedRevisionId, idempotencyKey } = options;
  const body = { document, expectedPreviewDigest, composeId, expectedRevisionId };
  if (!composeRevisionSaveRequestSchema.safeParse(body).success || new TextEncoder().encode(document).length > COMPOSE_PREVIEW_MAX_BYTES
    || !/^[A-Za-z0-9_-]{1,200}$/.test(idempotencyKey)) return { kind: "error", message: "Preview a supported Compose document before saving." };
  const result = await requestSaved(options, "", composeRevisionSavedSchema, {
    method: "POST", headers: { "content-type": "application/json", "x-control-idempotency-key": idempotencyKey }, body: JSON.stringify(body)
  });
  if (result.kind === "ready") {
    const { revision, commandId } = result.data;
    if (revision.projectId !== options.projectId || revision.id !== commandId || revision.preview.configDigest !== expectedPreviewDigest
      || (composeId !== null && revision.composeId !== composeId)) return invalidSaved();
  }
  return result;
}

function page(options: PageOptions): { limit: number; offset: number; query: string } | null {
  const { limit = 20, offset = 0 } = options;
  return Number.isInteger(limit) && limit >= 1 && limit <= 100 && Number.isInteger(offset) && offset >= 0 && offset <= 1_000_000
    ? { limit, offset, query: `?limit=${limit}&offset=${offset}` } : null;
}
function validPage(value: { limit: number; offset: number; total: number }, expected: { limit: number; offset: number }, length: number): boolean {
  return value.limit === expected.limit && value.offset === expected.offset && length <= value.limit && length <= Math.max(0, value.total - value.offset);
}
export async function listProjectComposes(options: PageOptions): Promise<ComposeResult<ComposeResourcePage>> {
  const paging = page(options); if (!paging) return invalidSaved();
  const result = await requestSaved(options, paging.query, composeResourcePageSchema);
  if (result.kind === "ready" && (!validPage(result.data, paging, result.data.resources.length)
    || result.data.resources.some((resource) => resource.projectId !== options.projectId)
    || new Set(result.data.resources.map((resource) => resource.id)).size !== result.data.resources.length)) return invalidSaved();
  return result;
}
export async function readProjectComposeHistory(options: PageOptions & { composeId: string }): Promise<ComposeResult<ComposeRevisionHistoryPageV1>> {
  const paging = page(options); if (!paging) return invalidSaved();
  const result = await requestSaved(options, `/${encodeURIComponent(options.composeId)}/revisions${paging.query}`, composeRevisionHistoryPageSchema);
  if (result.kind === "ready" && (!validPage(result.data, paging, result.data.revisions.length)
    || result.data.revisions.some((item) => item.projectId !== options.projectId || item.composeId !== options.composeId)
    || new Set(result.data.revisions.map((item) => item.id)).size !== result.data.revisions.length)) return invalidSaved();
  return result;
}
export async function readProjectComposeRevision(options: ComposeReadOptions & { composeId: string; revisionId: string }): Promise<ComposeResult<ComposeRevisionV1>> {
  const result = await requestSaved(options, `/${encodeURIComponent(options.composeId)}/revisions/${encodeURIComponent(options.revisionId)}`,
    z.object({ revision: composeRevisionSchema }).strict());
  if (result.kind === "error") return result;
  const revision = result.data.revision;
  return revision.projectId === options.projectId && revision.composeId === options.composeId && revision.id === options.revisionId
    ? { kind: "ready", data: revision } : invalidSaved();
}
