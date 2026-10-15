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
