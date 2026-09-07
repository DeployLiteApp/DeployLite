import { z } from "zod";

const idSchema = z.string().min(1).max(256);
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const containerSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);

export const trustedPriorExecutionReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  candidateId: idSchema,
  deploymentId: idSchema,
  projectId: idSchema,
  snapshotOriginId: idSchema,
  snapshotHash: hashSchema,
  effectiveImageDigest: digestSchema,
  runtimeHost: idSchema,
  container: containerSchema,
  containerId: idSchema,
  hostPort: z.number().int().min(1024).max(65535),
  containerPort: z.number().int().min(1).max(65535),
  network: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,62}$/).nullable()
}).strict();

export type TrustedPriorExecutionReceiptV1 = z.infer<typeof trustedPriorExecutionReceiptSchema>;
