import {projectControlAuthoritySchema,projectControlLeaseSchema} from "./project-control-authority.js";
import {managedDatabaseRuntimeReceiptSchema} from "./managed-database-runtime.js";
import {z} from "zod";
import {managedDatabaseStopPreparationSchema} from "./managed-database-stop.js";
import {managedDatabaseBackupReceiptSchema} from "./managed-database-backup.js";
const original=managedDatabaseStopPreparationSchema.innerType();
/** Internal server-owned inventory selection; parsing alone authenticates no archive. */
export const managedDatabaseRestorePreparationSchema=original.extend({
 backupReceipt:managedDatabaseBackupReceiptSchema,
 maxBytes:z.number().int().safe().positive()
}).strict();
export const managedDatabaseRestoreConfirmationPreparationSchema=z.object({
 preparation:managedDatabaseRestorePreparationSchema,
 actorId:z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
 idempotencyKey:z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
 correlationId:z.string().min(1).max(256).regex(/^[^\x00-\x1f\x7f]+$/),
 now:z.number().int().safe().nonnegative(),
 commandTtlMs:z.number().int().min(1).max(60000)
}).strict();

/** Public selection carries identifiers and expected hashes, never a caller receipt/path/secret. */
export const managedDatabaseRestoreSelectionSchema=original.extend({
 archiveId:z.string().regex(/^backup_[a-f0-9]{32}$/),
 destinationId:z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
 expectedArchiveSha256:z.string().regex(/^[a-f0-9]{64}$/),
 expectedManifestSha256:z.string().regex(/^[a-f0-9]{64}$/),
 maxBytes:z.number().int().safe().positive()
}).strict();

/** Signed private archive metadata over the existing agent channel. No bytes, paths or effect authority. */
export const MANAGED_DATABASE_RESTORE_ARCHIVE_CAPABILITY="database.runtime.restore.archive.v1" as const;
export const MANAGED_DATABASE_RESTORE_ARCHIVE_PATH="/databases/runtime/restore/archive" as const;
const restoreArchiveIdentity=z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const restoreArchiveId=z.string().min(1).max(256);
const restoreArchiveDigest=z.string().regex(/^[a-f0-9]{64}$/);
const restoreArchiveContext=z.object({requestId:restoreArchiveId,correlationId:restoreArchiveId}).strict();
export const managedDatabaseRestoreArchiveAgentQuerySchema=managedDatabaseRestorePreparationSchema.extend({
 action:z.literal("database.runtime.restore.archive"),agentId:restoreArchiveIdentity,
 requiredCapabilities:z.tuple([z.literal(MANAGED_DATABASE_RESTORE_ARCHIVE_CAPABILITY)]),context:restoreArchiveContext,
 timeoutMs:z.number().int().min(1).max(60000)
}).strict();
export const managedDatabaseRestoreArchiveObservationSchema=z.object({
 schemaVersion:z.literal(1),action:z.literal("database.runtime.restore.archive"),agentId:restoreArchiveIdentity,
 projectId:restoreArchiveIdentity,databaseId:managedDatabaseRestorePreparationSchema.shape.databaseId,
 engine:managedDatabaseRestorePreparationSchema.shape.engine,inputDigest:restoreArchiveDigest,context:restoreArchiveContext,
 observedAt:z.number().int().safe().nonnegative(),archiveId:z.string().regex(/^backup_[a-f0-9]{32}$/),
 archiveBytes:z.number().int().safe().positive(),archiveSha256:restoreArchiveDigest,manifestSha256:restoreArchiveDigest,
 format:managedDatabaseBackupReceiptSchema.innerType().shape.format,integrity:z.literal("verified"),redacted:z.literal(true)
}).strict();
export type ManagedDatabaseRestoreArchiveAgentQueryV1=z.infer<typeof managedDatabaseRestoreArchiveAgentQuerySchema>;
export type ManagedDatabaseRestoreArchiveObservationV1=z.infer<typeof managedDatabaseRestoreArchiveObservationSchema>;

export const MANAGED_DATABASE_RESTORE_CAPABILITY="database.runtime.restore.v1" as const;
export const MANAGED_DATABASE_RESTORE_PATH="/databases/runtime/restore" as const;
export const MANAGED_DATABASE_RESTORE_RECEIPT_PATH="/databases/runtime/restore/receipt" as const;
const restoreQuery=managedDatabaseRestorePreparationSchema.extend({
 action:z.literal("database.runtime.restore"),operation:z.literal("database.runtime.restore"),confirmationId:restoreArchiveIdentity,
 agentId:restoreArchiveIdentity,commandId:restoreArchiveId,inputDigest:restoreArchiveDigest,idempotencyKey:restoreArchiveIdentity,
 requiredCapabilities:z.tuple([z.literal(MANAGED_DATABASE_RESTORE_CAPABILITY)]),authority:projectControlAuthoritySchema,lease:projectControlLeaseSchema,
 context:restoreArchiveContext,timeoutMs:z.number().int().min(1).max(60000)
}).strict();
function bindRestoreCommand(value:z.infer<typeof restoreQuery>,ctx:z.RefinementCtx){
 if(value.agentId!==value.originalReceipt.agentId||value.agentId!==value.backupReceipt.agentId||value.commandId===value.originalReceipt.commandId||value.commandId===value.backupReceipt.commandId
  ||value.projectId!==value.authority.projectId||value.commandId!==value.authority.commandId||value.inputDigest!==value.authority.inputDigest||JSON.stringify(value.lease)!==JSON.stringify(value.authority.projectLease))
  ctx.addIssue({code:z.ZodIssueCode.custom,path:["authority"],message:"Original restore source and confirmed project authority required"});
}
/** Grammar alone neither consumes a confirmation nor grants archive access or destructive effects. */
export const managedDatabaseRestoreAgentCommandSchema=restoreQuery.extend({cancellationRequested:z.literal(false)}).strict().superRefine(bindRestoreCommand);
export const managedDatabaseRestoreReceiptQuerySchema=restoreQuery.superRefine(bindRestoreCommand);
const runtimeReceipt=managedDatabaseRuntimeReceiptSchema.innerType().shape;
export const managedDatabaseRestoreReceiptSchema=z.object({
 schemaVersion:z.literal(1),action:z.literal("database.runtime.restore"),projectId:restoreArchiveIdentity,databaseId:managedDatabaseRestorePreparationSchema.shape.databaseId,
 engine:managedDatabaseRestorePreparationSchema.shape.engine,profileId:restoreArchiveIdentity,agentId:restoreArchiveIdentity,commandId:restoreArchiveId,originalCommandId:restoreArchiveId,backupCommandId:restoreArchiveId,confirmationId:restoreArchiveIdentity,
 inputDigest:restoreArchiveDigest,planDigest:restoreArchiveDigest,environmentFingerprint:z.string().regex(/^[a-f0-9]{32}$/),correlationId:restoreArchiveId,
 containerId:restoreArchiveDigest,imageId:z.string().regex(/^sha256:[a-f0-9]{64}$/),volumeName:runtimeReceipt.volumeName,networkName:runtimeReceipt.networkName,
 networkId:restoreArchiveDigest,volumeCreatedAt:z.string().datetime({offset:true}),archiveId:z.string().regex(/^backup_[a-f0-9]{32}$/),archiveBytes:z.number().int().safe().positive(),
 archiveSha256:restoreArchiveDigest,manifestSha256:restoreArchiveDigest,format:managedDatabaseRestoreArchiveObservationSchema.shape.format,
 observedAt:z.number().int().safe().nonnegative(),status:z.literal("restored"),storage:z.literal("original"),health:z.literal("passed"),redacted:z.literal(true)
}).strict().superRefine((value,ctx)=>{
 const formats={postgres:"postgres-custom-gzip",mysql:"mysql-sql-gzip",mariadb:"mariadb-sql-gzip",mongodb:"mongodb-archive-gzip",redis:"volume-tar"};
 if(value.commandId===value.originalCommandId||value.commandId===value.backupCommandId||value.format!==formats[value.engine])ctx.addIssue({code:z.ZodIssueCode.custom,path:["commandId"],message:"Restore must bind a new command and native archive format"});
});
export const managedDatabaseRestoreCachedReceiptSchema=z.object({schemaVersion:z.literal(1),action:z.literal("database.runtime.restore"),agentId:restoreArchiveIdentity,commandId:restoreArchiveId,confirmationId:restoreArchiveIdentity,correlationId:restoreArchiveId,receipt:managedDatabaseRestoreReceiptSchema.nullable()}).strict().superRefine((value,ctx)=>{
 if(value.receipt && (value.agentId!==value.receipt.agentId||value.commandId!==value.receipt.commandId||value.confirmationId!==value.receipt.confirmationId||value.correlationId!==value.receipt.correlationId))ctx.addIssue({code:z.ZodIssueCode.custom,path:["receipt"],message:"Original restore cache identity required"});
});
export type ManagedDatabaseRestoreAgentCommandV1=z.infer<typeof managedDatabaseRestoreAgentCommandSchema>;
export type ManagedDatabaseRestoreReceiptQueryV1=z.infer<typeof managedDatabaseRestoreReceiptQuerySchema>;
export type ManagedDatabaseRestoreReceiptV1=z.infer<typeof managedDatabaseRestoreReceiptSchema>;
export type ManagedDatabaseRestoreCachedReceiptV1=z.infer<typeof managedDatabaseRestoreCachedReceiptSchema>;
