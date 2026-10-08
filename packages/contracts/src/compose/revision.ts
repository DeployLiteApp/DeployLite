import { z } from "zod";
import { composeDocumentSchema, composePreviewSchema } from "./preview.js";

const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
function safeCanonicalDocument(document: string): boolean {
  try {
    const decoded: unknown = JSON.parse(document);
    // Machine-generated JSON only: no duplicate-key/whitespace source retention.
    return JSON.stringify(decoded) === document && composeDocumentSchema.safeParse(decoded).success;
  } catch { return false; }
}

/** Saved intent metadata only; this is never an execution or observed-owner proof. */
export const composeRevisionSchema = z.object({
  schemaVersion: z.literal(1),
  id,
  projectId: id,
  composeId: id,
  number: z.number().int().min(1).max(2_147_483_647),
  createdBy: id,
  createdAt: z.string().datetime({ offset: true }),
  preview: composePreviewSchema.extend({ canonicalDocument: z.string().max(262_144).refine(safeCanonicalDocument) })
}).strict().refine((revision) => revision.preview.projectId === revision.projectId
  && [...revision.preview.networks, ...revision.preview.volumes].every((resource) => resource.projectId === revision.projectId));
export type ComposeRevisionV1 = z.infer<typeof composeRevisionSchema>;
