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
