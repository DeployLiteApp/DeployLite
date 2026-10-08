import { z } from "zod";
import { COMPOSE_PREVIEW_MAX_BYTES, composePreviewRequestSchema, composePreviewSchema, type ComposePreviewV1 } from "@deploylite/contracts";

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
