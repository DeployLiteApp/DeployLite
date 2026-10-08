import { z } from "zod";
import { validateImageReference } from "../deployment-contract/source-intent.js";
import { composeDocumentSchema, composePreviewSchema } from "./preview.js";

const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
// Archived shape validation only. Admission still uses the real configured policy in the factory.
function canonicalDigestImage(reference: string): boolean {
  try {
    const candidateHost = reference.slice(0, reference.indexOf("/"));
    return validateImageReference(reference, { policyVersion: "compose-revision-shape", trustedHosts: [candidateHost], allowTags: false, allowDigests: true }).reference === reference;
  } catch { return false; }
}
const referenceIdentifier = /^[A-Z_][A-Z0-9_]{0,127}$/;
function safeCanonicalDocument(document: string): boolean {
  try {
    const decoded: unknown = JSON.parse(document);
    // Machine-generated JSON only: no duplicate-key/whitespace source retention.
    const parsed = composeDocumentSchema.safeParse(decoded);
    return JSON.stringify(decoded) === document && parsed.success
      && Object.values(parsed.data.services).every((service) => canonicalDigestImage(service.image));
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
    .refine((preview) => preview.services.every((service) => canonicalDigestImage(service.image)
      && service.secretRefs.every((ref) => referenceIdentifier.test(ref.key) && referenceIdentifier.test(ref.secretRefId))))
}).strict().refine((revision) => revision.preview.projectId === revision.projectId
  && [...revision.preview.networks, ...revision.preview.volumes].every((resource) => resource.projectId === revision.projectId));
export type ComposeRevisionV1 = z.infer<typeof composeRevisionSchema>;

const composeResourceKind = z.enum(["network", "volume"]);
const composeResourceKey = composePreviewSchema.shape.networks.element.shape.key;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
/** Exact logical owner derived from the current saved Compose revision; it is not physical-runtime proof. */
export const composeResourceOwnershipQuerySchema = z.object({
  projectId: id, kind: composeResourceKind, key: composeResourceKey, expectedConfigDigest: sha256
}).strict();
export type ComposeResourceOwnershipQueryV1 = z.infer<typeof composeResourceOwnershipQuerySchema>;
export const composeResourceOwnershipSchema = z.object({
  schemaVersion: z.literal(1), projectId: id, composeId: id, ownerUserId: id, revisionId: id,
  revisionNumber: z.number().int().min(1).max(2_147_483_647), kind: composeResourceKind, key: composeResourceKey,
  runtimeName: z.string().max(160).regex(/^dl-[a-f0-9]{32}-(?:net|vol)-[a-z][a-z0-9_-]*$/), configDigest: sha256
}).strict().superRefine((owner, context) => {
  const resourceKind = owner.kind === "network" ? "net" : "vol";
  if (!owner.runtimeName.endsWith(`-${resourceKind}-${owner.key}`)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["runtimeName"], message: "Resource identity mismatch" });
});
export type ComposeResourceOwnershipV1 = z.infer<typeof composeResourceOwnershipSchema>;

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

export const composeRevisionSaveRequestSchema = z.object({
  document: z.string().min(1).max(65_536), expectedPreviewDigest: z.string().regex(/^[a-f0-9]{64}$/),
  composeId: id.nullable(), expectedRevisionId: id.nullable()
}).strict().refine((input) => (input.composeId === null) === (input.expectedRevisionId === null));
export const composeRevisionSaveCommandResultSchema = z.object({
  commandId: id, action: z.literal("project.update"), operation: z.literal("compose.revision.save"), projectId: id,
  composeId: id, revisionId: id, revisionNumber: z.number().int().min(1).max(2_147_483_647),
  configDigest: z.string().regex(/^[a-f0-9]{64}$/), correlationId: z.string().min(1).max(200), status: z.literal("completed")
}).strict();
export const composeRevisionSavedSchema = z.object({ revision: composeRevisionSchema, commandId: id, idempotent: z.boolean() }).strict();
export const composeResourceMetadataSchema = z.object({
  id, projectId: id, latestRevisionId: id, latestNumber: z.number().int().min(1).max(2_147_483_647),
  updatedAt: z.string().datetime({ offset: true }), serviceNames: z.array(composePreviewSchema.shape.services.element.shape.name).min(1).max(32)
}).strict();
export const composeResourcePageSchema = z.object({
  resources: z.array(composeResourceMetadataSchema).max(100), total: z.number().int().min(0).max(2_147_483_647),
  limit: z.number().int().min(1).max(100), offset: z.number().int().min(0).max(1_000_000)
}).strict();
export type ComposeRevisionSaveCommandResult = z.infer<typeof composeRevisionSaveCommandResultSchema>;
export type ComposeRevisionSaved = z.infer<typeof composeRevisionSavedSchema>;
export type ComposeResourceMetadata = z.infer<typeof composeResourceMetadataSchema>;
export type ComposeResourcePage = z.infer<typeof composeResourcePageSchema>;
