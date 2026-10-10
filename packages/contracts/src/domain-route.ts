import { z } from "zod";

const domainLabel = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const domainHostnamePattern = new RegExp(`^(?=.{1,253}$)${domainLabel}(?:\\.${domainLabel})+$`);
const id = z.string().min(1).max(256);

export const domainRouteHostnameSchema = z.string().trim().toLowerCase().regex(domainHostnamePattern);

export const domainRouteClaimSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: id,
  deploymentId: id.nullable(),
  domain: domainRouteHostnameSchema
}).strict();

export const domainRouteIntentSchema = domainRouteClaimSchema.extend({
  deploymentId: id
}).strict();

export const domainRoutePreviewRequestSchema = z.object({
  domain: domainRouteHostnameSchema,
  deploymentId: id
}).strict();

export const domainRouteRollbackRequestSchema = z.object({
  domain: domainRouteHostnameSchema
}).strict();

export const domainRouteRevisionSchema = z.object({
  schemaVersion: z.literal(1),
  id,
  projectId: id,
  domain: domainRouteHostnameSchema,
  deploymentId: id,
  revisionNumber: z.number().int().positive(),
  operation: z.enum(["baseline", "apply", "rollback"]),
  rollbackRevisionId: id.nullable(),
  commandId: id.nullable(),
  correlationId: id.nullable(),
  createdAt: z.string().datetime(),
  evidence: z.object({
    state: z.enum(["baseline", "created", "updated", "unchanged"]),
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    observedAt: z.number().int().nonnegative().nullable(),
    redacted: z.literal(true)
  }).strict()
}).strict().superRefine((revision, issue) => {
  if ((revision.operation === "baseline") !== (revision.commandId === null)
    || (revision.operation === "rollback") !== (revision.rollbackRevisionId !== null)) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["operation"], message: "Revision operation must match its durable command links" });
  }
});

export type DomainRouteClaimV1 = z.infer<typeof domainRouteClaimSchema>;
export type DomainRouteIntentV1 = z.infer<typeof domainRouteIntentSchema>;
export type DomainRouteRollbackRequestV1 = z.infer<typeof domainRouteRollbackRequestSchema>;
export type DomainRouteRevisionV1 = z.infer<typeof domainRouteRevisionSchema>;
