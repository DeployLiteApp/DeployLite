import { z } from "zod";
import { composeVolumeBackupReceiptSchema } from "./deployment-contract/compose-volume-backup.js";
const identity = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
/** Server inventory and explicit count policy. This contract grants no deletion authority. */
export const backupRetentionRequestSchema = z.object({
  schemaVersion: z.literal(1), projectId: identity, volumeKey: identity, destinationId: identity,
  keepNewest: z.number().int().positive().max(10_000),
  protectedArchiveIds: z.array(identity).max(10_000),
  backups: z.array(z.object({receipt: composeVolumeBackupReceiptSchema,
    createdAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).strict()).max(10_000)
}).strict();
export type BackupRetentionRequestV1 = z.infer<typeof backupRetentionRequestSchema>;
