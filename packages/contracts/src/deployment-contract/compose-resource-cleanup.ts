import { z } from "zod";
import { composeResourceKindSchema } from "../compose/resource-inspection.js";
import { composeResourceCleanupExecutionReceiptSchema } from "../compose/resource-cleanup.js";

const identity = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const id = z.string().min(1).max(256);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const key = z.string().max(63).regex(/^[a-z][a-z0-9_-]*$/).refine(value => !["constructor", "prototype", "__proto__"].includes(value));
const context = z.object({ requestId: id, correlationId: id }).strict();

export const COMPOSE_RESOURCE_CLEANUP_CAPABILITY = "compose.resource.cleanup.v1" as const;
export const COMPOSE_RESOURCE_CLEANUP_PATH = "/compose/resources/cleanup" as const;
export const COMPOSE_RESOURCE_CLEANUP_RECEIPT_PATH = "/compose/resources/cleanup/receipt" as const;

const fields = {
  schemaVersion: z.literal(1), action: z.literal("compose.resource.cleanup"), agentId: identity, commandId: id,
  cleanupCommandId: id, confirmationId: id, projectId: identity, inputDigest: digest, cleanupInputDigest: digest,
  canonicalDocument: z.string().min(1).max(65_536), kind: composeResourceKindSchema, key,
  runtimeName: z.string().min(1).max(160), configDigest: digest, stateDigest: digest, expiresAt: z.number().int().positive(),
  requiredCapabilities: z.tuple([z.literal(COMPOSE_RESOURCE_CLEANUP_CAPABILITY)]), context
};
const commandBase = z.object(fields).strict();

export const composeResourceCleanupAgentCommandSchema = commandBase.extend({
  timeoutMs: z.number().int().positive().max(60_000), cancellationRequested: z.literal(false)
}).strict().superRefine((command, issue) => {
  if (command.cleanupCommandId !== command.commandId) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["cleanupCommandId"], message: "Cleanup command identity mismatch" });
});
export type ComposeResourceCleanupAgentCommandV1 = z.infer<typeof composeResourceCleanupAgentCommandSchema>;

export const composeResourceCleanupReceiptQuerySchema = commandBase.extend({ timeoutMs: z.number().int().positive().max(60_000) }).strict()
  .superRefine((query, issue) => {
    if (query.cleanupCommandId !== query.commandId) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["cleanupCommandId"], message: "Cleanup query identity mismatch" });
  });
export type ComposeResourceCleanupReceiptQueryV1 = z.infer<typeof composeResourceCleanupReceiptQuerySchema>;

export const composeResourceCleanupCachedReceiptSchema = z.object({
  schemaVersion: z.literal(1), action: z.literal("compose.resource.cleanup"), agentId: identity,
  commandId: id, correlationId: id, receipt: composeResourceCleanupExecutionReceiptSchema.nullable()
}).strict();
export type ComposeResourceCleanupCachedReceiptV1 = z.infer<typeof composeResourceCleanupCachedReceiptSchema>;
