import { z } from "zod";

const id = z.string().min(1).max(256);
const port = z.number().int().min(1).max(65_535);

export const transportPortProtocolSchema = z.enum(["tcp", "udp"]);

/** A project-owned direct transport publication, separate from an HTTP hostname route. */
export const transportPortClaimSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: id,
  deploymentId: id.nullable(),
  protocol: transportPortProtocolSchema,
  publishedPort: port,
  targetPort: port
}).strict();

export const transportPortIntentSchema = transportPortClaimSchema.extend({
  deploymentId: id
}).strict();

export const transportPortPreviewRequestSchema = z.object({
  protocol: transportPortProtocolSchema,
  publishedPort: port,
  targetPort: port,
  deploymentId: id
}).strict();

export const transportPortRollbackRequestSchema = z.object({
  protocol: transportPortProtocolSchema,
  publishedPort: port
}).strict();

export type TransportPortClaimV1 = z.infer<typeof transportPortClaimSchema>;
export type TransportPortIntentV1 = z.infer<typeof transportPortIntentSchema>;
