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

export type DomainRouteClaimV1 = z.infer<typeof domainRouteClaimSchema>;
export type DomainRouteIntentV1 = z.infer<typeof domainRouteIntentSchema>;
