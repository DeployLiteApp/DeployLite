import { z } from "zod";
import { projectControlAuthoritySchema, projectControlLeaseSchema } from "./project-control-authority.js";

const id = z.string().min(1).max(256);
const identity = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const key = z.string().max(63).regex(/^[a-z][a-z0-9_-]*$/).refine(value => !["constructor", "prototype", "__proto__"].includes(value));
const runtimeName = z.string().max(160).regex(/^dl-[a-f0-9]{32}-vol-[a-z][a-z0-9_-]*$/);
const context = z.object({ requestId: id, correlationId: id }).strict();

export const COMPOSE_VOLUME_ATTACHMENT_CAPABILITY = "compose.volume.attachment.v1" as const;
export const COMPOSE_VOLUME_ATTACHMENT_PATH = "/compose/volumes/attachment" as const;
export const COMPOSE_VOLUME_ATTACHMENT_RECEIPT_PATH = "/compose/volumes/receipt" as const;

export const composeVolumeAttachmentApplyInputSchema = z.object({
  priorRevisionId: identity, revisionId: identity, key, service: key, attachmentAction: z.enum(["attach", "detach"]),
  expectedStateDigest: digest, expectedContainerId: digest
}).strict().refine(value => value.priorRevisionId !== value.revisionId);
export type ComposeVolumeAttachmentApplyInputV1 = z.infer<typeof composeVolumeAttachmentApplyInputSchema>;

export const composeVolumeAttachmentExecutionRequestSchema = z.object({
  schemaVersion: z.literal(1), action: z.literal("project.update"), scope: z.object({ kind: z.literal("project"), projectId: identity }).strict(),
  operation: z.literal("compose.resource.attachment"), idempotencyKey: z.string().min(1).max(200), correlationId: id,
  projectId: identity, priorRevisionId: identity, revisionId: identity, priorConfigDigest: digest, configDigest: digest,
  stateDigest: digest, secretDigest: digest, priorCanonicalDocument: z.string().min(1).max(262_144), canonicalDocument: z.string().min(1).max(262_144),
  key, runtimeName, service: key, attachmentAction: z.enum(["attach", "detach"]), containerId: digest
}).strict().superRefine((request, issue) => {
  if (request.scope.projectId !== request.projectId || request.priorRevisionId === request.revisionId) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["projectId"], message: "Replacement request scope or revision identity is inconsistent" });
  }
});
export type ComposeVolumeAttachmentExecutionRequestV1 = z.infer<typeof composeVolumeAttachmentExecutionRequestSchema>;

const commandFields = {
  schemaVersion: z.literal(1), action: z.literal("compose.volume.attachment"), agentId: identity, commandId: id,
  projectId: identity, operation: z.literal("compose.resource.attachment"), idempotencyKey: z.string().min(1).max(200), inputDigest: digest,
  priorRevisionId: identity, revisionId: identity, priorConfigDigest: digest, configDigest: digest, stateDigest: digest, secretDigest: digest,
  priorCanonicalDocument: z.string().min(1).max(262_144), canonicalDocument: z.string().min(1).max(262_144), sealedEnvironment: z.string().min(1).max(131_072),
  key, runtimeName, service: key, attachmentAction: z.enum(["attach", "detach"]), containerId: digest,
  requiredCapabilities: z.tuple([z.literal(COMPOSE_VOLUME_ATTACHMENT_CAPABILITY)]), authority: projectControlAuthoritySchema,
  lease: projectControlLeaseSchema, context, timeoutMs: z.number().int().positive().max(60_000), cancellationRequested: z.literal(false)
};
const commandBaseSchema = z.object(commandFields).strict();
export const composeVolumeAttachmentAgentCommandSchema = commandBaseSchema.superRefine((command, issue) => {
  if (command.projectId !== command.authority.projectId || command.commandId !== command.authority.commandId
    || command.inputDigest !== command.authority.inputDigest || command.authority.action !== "project.update"
    || command.authority.projectLease.projectId !== command.projectId
    || JSON.stringify(command.lease) !== JSON.stringify(command.authority.projectLease)) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["authority"], message: "Project update authority must bind this replacement and lease" });
  }
  if (command.priorRevisionId === command.revisionId) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["revisionId"], message: "Replacement must bind a new saved revision" });
});
export type ComposeVolumeAttachmentAgentCommandV1 = z.infer<typeof composeVolumeAttachmentAgentCommandSchema>;

export const composeVolumeAttachmentReceiptSchema = z.object({
  schemaVersion: z.literal(1), action: z.literal("compose.volume.attachment"), agentId: identity, commandId: id,
  projectId: identity, inputDigest: digest, correlationId: id, key, runtimeName, service: key,
  attachmentAction: z.enum(["attach", "detach"]), priorContainerId: digest, replacementContainerId: digest,
  resourceCreatedAt: z.string().datetime({ offset: true }), beforeStateDigest: digest, afterStateDigest: digest,
  observedAt: z.number().int().nonnegative(), status: z.enum(["replaced", "already-satisfied", "failed"]),
  health: z.enum(["passed", "failed", "not-run"]), rollback: z.enum(["not-required", "restored", "failed"]),
  reconciled: z.boolean(), redacted: z.literal(true),
  reason: z.enum(["candidate-failed", "cutover-failed", "rollback-failed", "postcondition-failed"]).nullable()
}).strict().superRefine((receipt, issue) => {
  if (receipt.status === "replaced" && (receipt.health !== "passed" || receipt.rollback !== "not-required" || receipt.reason !== null
    || receipt.priorContainerId === receipt.replacementContainerId)) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["status"], message: "Successful replacement requires a healthy distinct candidate and no rollback" });
  }
  if (receipt.status === "already-satisfied" && ((receipt.health !== "not-run" && receipt.health !== "passed") || receipt.rollback !== "not-required" || receipt.reason !== null)) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["status"], message: "Already-satisfied receipt cannot claim execution or recovery" });
  }
  if (receipt.status === "failed" && (receipt.reason === null || receipt.health === "passed" || receipt.rollback === "not-required" && receipt.reason === "rollback-failed"
    || (receipt.rollback === "failed") !== (receipt.reason === "rollback-failed"))) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["status"], message: "Failed replacement requires truthful health and rollback evidence" });
  }
});
export type ComposeVolumeAttachmentReceiptV1 = z.infer<typeof composeVolumeAttachmentReceiptSchema>;

export const composeVolumeAttachmentReceiptQuerySchema = commandBaseSchema.omit({ sealedEnvironment: true, cancellationRequested: true }).extend({
  schemaVersion: z.literal(1), action: z.literal("compose.volume.attachment"),
  requiredCapabilities: z.tuple([z.literal(COMPOSE_VOLUME_ATTACHMENT_CAPABILITY)]), timeoutMs: z.number().int().positive().max(60_000)
}).strict().superRefine((query, issue) => {
  if (query.projectId !== query.authority.projectId || query.commandId !== query.authority.commandId
    || query.inputDigest !== query.authority.inputDigest || JSON.stringify(query.lease) !== JSON.stringify(query.authority.projectLease)) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["authority"], message: "Receipt query must preserve original project authority" });
  }
});
export type ComposeVolumeAttachmentReceiptQueryV1 = z.infer<typeof composeVolumeAttachmentReceiptQuerySchema>;

export const composeVolumeAttachmentCachedReceiptSchema = z.object({
  schemaVersion: z.literal(1), action: z.literal("compose.volume.attachment"), agentId: identity, commandId: id,
  correlationId: id, receipt: composeVolumeAttachmentReceiptSchema.nullable()
}).strict();
export type ComposeVolumeAttachmentCachedReceiptV1 = z.infer<typeof composeVolumeAttachmentCachedReceiptSchema>;
