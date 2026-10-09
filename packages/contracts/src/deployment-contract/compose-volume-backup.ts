import { z } from "zod";
import { projectControlAuthoritySchema, projectControlLeaseSchema } from "./project-control-authority.js";
import { composeVolumeBackupPlanSchema } from "../compose/volume-backup-plan.js";

const identity = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const context = z.object({ requestId: z.string().min(1).max(256), correlationId: z.string().min(1).max(256) }).strict();

export const COMPOSE_VOLUME_BACKUP_CAPABILITY = "compose.volume.backup.v1" as const;
export const COMPOSE_VOLUME_BACKUP_PATH = "/compose/volumes/backup" as const;
export const COMPOSE_VOLUME_BACKUP_RECEIPT_PATH = "/compose/volumes/backup/receipt" as const;

const commandFields = {
  schemaVersion: z.literal(1), action: z.literal("compose.volume.backup"), agentId: identity, commandId: identity, projectId: identity,
  operation: z.literal("compose.volume.backup.execute"), idempotencyKey: identity, inputDigest: digest,
  canonicalDocument: z.string().min(1).max(65_536), plan: composeVolumeBackupPlanSchema,
  requiredCapabilities: z.tuple([z.literal(COMPOSE_VOLUME_BACKUP_CAPABILITY)]), authority: projectControlAuthoritySchema,
  lease: projectControlLeaseSchema, context, timeoutMs: z.number().int().positive().max(60_000), cancellationRequested: z.literal(false)
};
const commandBase = z.object(commandFields).strict();
type AuthorityBoundCommand = Pick<z.infer<typeof commandBase>, "projectId" | "commandId" | "inputDigest" | "plan" | "authority" | "lease">;
function authorityBound(value: AuthorityBoundCommand, issue: z.RefinementCtx): void {
  if (value.projectId !== value.plan.projectId || value.projectId !== value.authority.projectId || value.commandId !== value.authority.commandId
    || value.inputDigest !== value.authority.inputDigest || value.authority.action !== "project.update"
    || value.authority.projectLease.projectId !== value.projectId || JSON.stringify(value.lease) !== JSON.stringify(value.authority.projectLease)) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["authority"], message: "Project update authority must bind this backup command and lease" });
  }
}
export const composeVolumeBackupAgentCommandSchema = commandBase.superRefine(authorityBound);
export type ComposeVolumeBackupAgentCommandV1 = z.infer<typeof composeVolumeBackupAgentCommandSchema>;

const receiptFields = {
  schemaVersion: z.literal(1), action: z.literal("compose.volume.backup"), agentId: identity, commandId: identity, projectId: identity,
  inputDigest: digest, correlationId: identity, volumeKey: identity, destinationId: identity, archiveId: identity,
  status: z.enum(["created", "already-created"]), consistency: z.literal("stopped"), archiveBytes: z.number().int().positive(),
  entries: z.number().int().nonnegative(), archiveSha256: digest, manifestSha256: digest, idempotent: z.boolean(), redacted: z.literal(true)
};
export const composeVolumeBackupReceiptSchema = z.object(receiptFields).strict().superRefine((receipt, issue) => {
  if ((receipt.status === "already-created") !== receipt.idempotent)
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["idempotent"], message: "Receipt replay marker must match its terminal status" });
});
export type ComposeVolumeBackupReceiptV1 = z.infer<typeof composeVolumeBackupReceiptSchema>;

export const composeVolumeBackupReceiptQuerySchema = commandBase.omit({
  schemaVersion: true, action: true, requiredCapabilities: true, timeoutMs: true, cancellationRequested: true
}).extend({ schemaVersion: z.literal(1), action: z.literal("compose.volume.backup"),
  requiredCapabilities: z.tuple([z.literal(COMPOSE_VOLUME_BACKUP_CAPABILITY)]), timeoutMs: z.number().int().positive().max(60_000)
}).strict().superRefine(authorityBound);
export type ComposeVolumeBackupReceiptQueryV1 = z.infer<typeof composeVolumeBackupReceiptQuerySchema>;

export const composeVolumeBackupCachedReceiptSchema = z.object({
  schemaVersion: z.literal(1), action: z.literal("compose.volume.backup"), agentId: identity, commandId: identity, correlationId: identity,
  receipt: composeVolumeBackupReceiptSchema.nullable()
}).strict();
export type ComposeVolumeBackupCachedReceiptV1 = z.infer<typeof composeVolumeBackupCachedReceiptSchema>;

export const composeVolumeBackupExecuteApiRequestSchema = z.object({
  document: z.string().min(1).max(65_536), key: identity, expectedConfigDigest: digest, expectedStateDigest: digest,
  destinationId: identity, plan: composeVolumeBackupPlanSchema
}).strict();
export type ComposeVolumeBackupExecuteApiRequestV1 = z.infer<typeof composeVolumeBackupExecuteApiRequestSchema>;
