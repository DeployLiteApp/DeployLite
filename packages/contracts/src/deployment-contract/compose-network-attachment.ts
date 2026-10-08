import { z } from "zod";
import { projectControlAuthoritySchema, projectControlLeaseSchema } from "./project-control-authority.js";

const id = z.string().min(1).max(256);
const identity = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const key = z.string().max(63).regex(/^[a-z][a-z0-9_-]*$/).refine(value => !["constructor", "prototype", "__proto__"].includes(value));
const runtimeName = z.string().max(160).regex(/^dl-[a-f0-9]{32}-net-[a-z][a-z0-9_-]*$/);
const context = z.object({ requestId: id, correlationId: id }).strict();
const authority = projectControlAuthoritySchema;
const lease = projectControlLeaseSchema;

export const COMPOSE_NETWORK_ATTACHMENT_CAPABILITY = "compose.network.attachment.v1" as const;
export const COMPOSE_NETWORK_ATTACHMENT_PATH = "/compose/networks/attachment" as const;
export const COMPOSE_NETWORK_ATTACHMENT_RECEIPT_PATH = "/compose/networks/receipt" as const;

const commandFields = {
  schemaVersion: z.literal(1), action: z.literal("compose.network.attachment"), agentId: identity, commandId: id,
  projectId: identity, operation: z.literal("compose.resource.attachment"), idempotencyKey: z.string().min(1).max(200),
  inputDigest: digest, canonicalDocument: z.string().min(1).max(65_536), configDigest: digest, stateDigest: digest,
  key, runtimeName, service: key, attachmentAction: z.enum(["attach", "detach"]), containerId: digest,
  alreadySatisfied: z.boolean(), requiredCapabilities: z.tuple([z.literal(COMPOSE_NETWORK_ATTACHMENT_CAPABILITY)]),
  authority, lease, context, timeoutMs: z.number().int().positive().max(60_000), cancellationRequested: z.literal(false)
};
const composeNetworkAttachmentCommandBaseSchema = z.object(commandFields).strict();
export const composeNetworkAttachmentAgentCommandSchema = composeNetworkAttachmentCommandBaseSchema.superRefine((command, issue) => {
  if (command.projectId !== command.authority.projectId || command.commandId !== command.authority.commandId
    || command.inputDigest !== command.authority.inputDigest || command.authority.action !== "project.update"
    || command.authority.projectLease.projectId !== command.projectId
    || JSON.stringify(command.lease) !== JSON.stringify(command.authority.projectLease)) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["authority"], message: "Project update authority must bind this command and lease" });
  }
});
export type ComposeNetworkAttachmentAgentCommandV1 = z.infer<typeof composeNetworkAttachmentAgentCommandSchema>;

const receiptFields = {
  schemaVersion: z.literal(1), action: z.literal("compose.network.attachment"), agentId: identity, commandId: id,
  projectId: identity, inputDigest: digest, correlationId: id, key, runtimeName, service: key, attachmentAction: z.enum(["attach", "detach"]),
  containerId: digest, resourceId: digest, beforeStateDigest: digest, afterStateDigest: digest, observedAt: z.number().int().nonnegative(),
  status: z.enum(["attached", "detached", "already-attached", "already-detached", "failed"]), reconciled: z.boolean(),
  redacted: z.literal(true), reason: z.enum(["mutation-failed", "postcondition-failed"]).nullable()
};
export const composeNetworkAttachmentReceiptSchema = z.object(receiptFields).strict().superRefine((receipt, issue) => {
  const success = receipt.status !== "failed";
  if ((receipt.attachmentAction === "attach") !== (["attached", "already-attached"].includes(receipt.status)) && success)
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["status"], message: "Terminal status must match the requested attachment action" });
  if (success && receipt.reason !== null) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "Successful receipt cannot contain a failure reason" });
  if (!success && receipt.reason === null) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "Failed receipt requires a bounded failure reason" });
});
export type ComposeNetworkAttachmentReceiptV1 = z.infer<typeof composeNetworkAttachmentReceiptSchema>;

export const composeNetworkAttachmentReceiptQuerySchema = composeNetworkAttachmentCommandBaseSchema.omit({
  schemaVersion: true, action: true, requiredCapabilities: true, timeoutMs: true, cancellationRequested: true
}).extend({ schemaVersion: z.literal(1), action: z.literal("compose.network.attachment"),
  requiredCapabilities: z.tuple([z.literal(COMPOSE_NETWORK_ATTACHMENT_CAPABILITY)]), timeoutMs: z.number().int().positive().max(60_000)
}).strict().superRefine((query, issue) => {
  if (query.projectId !== query.authority.projectId || query.commandId !== query.authority.commandId
    || query.inputDigest !== query.authority.inputDigest || JSON.stringify(query.lease) !== JSON.stringify(query.authority.projectLease)) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["authority"], message: "Receipt query must preserve original project authority" });
  }
});
export type ComposeNetworkAttachmentReceiptQueryV1 = z.infer<typeof composeNetworkAttachmentReceiptQuerySchema>;

export const composeNetworkAttachmentCachedReceiptSchema = z.object({
  schemaVersion: z.literal(1), action: z.literal("compose.network.attachment"), agentId: identity, commandId: id,
  correlationId: id, receipt: composeNetworkAttachmentReceiptSchema.nullable()
}).strict();
export type ComposeNetworkAttachmentCachedReceiptV1 = z.infer<typeof composeNetworkAttachmentCachedReceiptSchema>;
