import { z } from "zod";
import { composeResourceInspectionInputSchema } from "./resource-inspection.js";

const identity = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const composeResourceCleanupInputSchema = composeResourceInspectionInputSchema.extend({ expectedStateDigest: digest }).strict();
export type ComposeResourceCleanupInput = z.infer<typeof composeResourceCleanupInputSchema>;
export const composeResourceCleanupPreviewSchema = z.object({
  schemaVersion: z.literal(1), operation: z.literal("compose.resource.cleanup"),
  status: z.literal("preview"), executionAllowed: z.literal(false), requiresConfirmation: z.literal(true),
  projectId: identity, kind: composeResourceInspectionInputSchema.shape.kind, key: composeResourceInspectionInputSchema.shape.key,
  configDigest: digest, stateDigest: digest, confirmationTtlMs: z.number().int().positive().max(900_000)
}).strict();
export type ComposeResourceCleanupPreviewV1 = z.infer<typeof composeResourceCleanupPreviewSchema>;
export const composeResourceCleanupConfirmationViewSchema = composeResourceCleanupPreviewSchema.extend({
  commandId: identity, confirmationId: identity, confirmationValidated: z.literal(true)
}).strict();
export type ComposeResourceCleanupConfirmationViewV1 = z.infer<typeof composeResourceCleanupConfirmationViewSchema>;
