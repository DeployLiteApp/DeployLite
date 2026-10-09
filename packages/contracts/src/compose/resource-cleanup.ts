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

export const composeResourceCleanupExecutionReceiptSchema = z.object({
  schemaVersion: z.literal(1), action: z.literal("compose.resource.cleanup"), agentId: identity, commandId: identity,
  cleanupCommandId: identity, confirmationId: identity, projectId: identity, inputDigest: digest, cleanupInputDigest: digest,
  correlationId: identity, kind: composeResourceInspectionInputSchema.shape.kind, key: composeResourceInspectionInputSchema.shape.key,
  runtimeName: z.string().min(1).max(160), configDigest: digest, stateDigest: digest, status: z.literal("completed"),
  physicalIdentity: z.string().min(1).max(64), terminalStatus: z.literal("removed"),
  idempotent: z.boolean(), redacted: z.literal(true)
}).strict().superRefine((receipt, context) => {
  const valid = receipt.kind === "network" ? /^[a-f0-9]{64}$/.test(receipt.physicalIdentity)
    : /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(receipt.physicalIdentity)
      && Number.isFinite(Date.parse(receipt.physicalIdentity));
  if (!valid) context.addIssue({ code: z.ZodIssueCode.custom, path: ["physicalIdentity"], message: "Invalid physical identity" });
});
export type ComposeResourceCleanupExecutionReceiptV1 = z.infer<typeof composeResourceCleanupExecutionReceiptSchema>;

export const composeResourceCleanupReceiptSchema = z.object({
  commandId: identity, confirmationId: identity, expiresAt: z.string().datetime(),
  status: z.enum(["pending_confirmation", "eligible", "dispatching", "completed"]), idempotent: z.boolean(), preview: composeResourceCleanupPreviewSchema,
  execution: composeResourceCleanupExecutionReceiptSchema.optional()
}).strict().superRefine((receipt, context) => {
  if ((receipt.status === "completed") !== Boolean(receipt.execution)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["execution"], message: "Completed cleanup receipt must include its terminal execution" });
});
export type ComposeResourceCleanupReceiptV1 = z.infer<typeof composeResourceCleanupReceiptSchema>;
