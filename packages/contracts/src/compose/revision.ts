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

export const composeRevisionHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0)
}).strict();
export const composeRevisionMetadataSchema = z.object({
  schemaVersion: z.literal(1), id, projectId: id, composeId: id,
  number: z.number().int().min(1).max(2_147_483_647), createdBy: id,
  createdAt: z.string().datetime({ offset: true }),
  configDigest: z.string().regex(/^[a-f0-9]{64}$/), policyVersion: z.string().min(1).max(200),
  serviceCount: z.number().int().min(1).max(32), networkCount: z.number().int().min(0).max(33), volumeCount: z.number().int().min(0).max(32),
  executionAllowed: z.literal(false)
}).strict();
export const composeRevisionHistoryPageSchema = z.object({
  revisions: z.array(composeRevisionMetadataSchema).max(100), total: z.number().int().min(0).max(2_147_483_647),
  limit: z.number().int().min(1).max(100), offset: z.number().int().min(0).max(1_000_000)
}).strict();
export type ComposeRevisionMetadataV1 = z.infer<typeof composeRevisionMetadataSchema>;
export type ComposeRevisionHistoryPageV1 = z.infer<typeof composeRevisionHistoryPageSchema>;
