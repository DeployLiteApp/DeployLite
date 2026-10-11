import { z } from "zod";
import { managedDatabaseStopPreparationSchema, managedDatabaseStopReceiptSchema } from "./managed-database-stop.js";
import { projectControlAuthoritySchema, projectControlLeaseSchema } from "./project-control-authority.js";

const identity = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const id = z.string().min(1).max(256);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const originalPreparation = managedDatabaseStopPreparationSchema.innerType();
export const MANAGED_DATABASE_BACKUP_CAPABILITY = "database.runtime.backup.v1" as const;
export const MANAGED_DATABASE_BACKUP_PATH = "/databases/runtime/backup" as const;
export const MANAGED_DATABASE_BACKUP_RECEIPT_PATH = "/databases/runtime/backup/receipt" as const;
const preparation = originalPreparation.extend({
  destinationId: identity,
  maxBytes: z.number().int().safe().positive()
}).strict();
function bindSource(value:z.infer<typeof preparation>, ctx:z.RefinementCtx):void {
  const source = Object.fromEntries(Object.keys(originalPreparation.shape).map(key => [key, value[key as keyof typeof value]]));
  if (!managedDatabaseStopPreparationSchema.safeParse(source).success)
    ctx.addIssue({code:z.ZodIssueCode.custom, path:["originalReceipt"], message:"Backup requires the original ready source"});
}
export const managedDatabaseBackupPreparationSchema = preparation.superRefine(bindSource);
const query = preparation.extend({
  action: z.literal("database.runtime.backup"),
  operation: z.literal("database.runtime.backup"),
  agentId: identity,
  commandId: id,
  inputDigest: digest,
  idempotencyKey: identity,
  requiredCapabilities: z.tuple([z.literal(MANAGED_DATABASE_BACKUP_CAPABILITY)]),
  authority: projectControlAuthoritySchema,
  lease: projectControlLeaseSchema,
  context: z.object({requestId:id, correlationId:id}).strict(),
  timeoutMs: z.number().int().min(1).max(60000)
}).strict();
function bindCommand(value:z.infer<typeof query>, ctx:z.RefinementCtx):void {
  bindSource(value, ctx);
  if (value.agentId !== value.originalReceipt.agentId || value.commandId === value.originalReceipt.commandId
    || value.projectId !== value.authority.projectId || value.commandId !== value.authority.commandId
    || value.inputDigest !== value.authority.inputDigest
    || JSON.stringify(value.lease) !== JSON.stringify(value.authority.projectLease))
    ctx.addIssue({code:z.ZodIssueCode.custom, path:["authority"], message:"Backup authority must bind the new command, original agent and lease"});
}
/** Extend the existing project-update lane; no caller path, argv, secret or consistency claim. */
export const managedDatabaseBackupAgentCommandSchema = query.extend({cancellationRequested:z.literal(false)}).strict().superRefine(bindCommand);
export const managedDatabaseBackupReceiptQuerySchema = query.superRefine(bindCommand);
const formats = {postgres:"postgres-custom-gzip", mysql:"mysql-sql-gzip", mariadb:"mariadb-sql-gzip", mongodb:"mongodb-archive-gzip", redis:"volume-tar"} as const;
const consistency = {postgres:"native-snapshot", mysql:"transactional-tables", mariadb:"transactional-tables", mongodb:"quiesced-writes", redis:"all-consumers-stopped"} as const;
export const managedDatabaseBackupReceiptSchema = managedDatabaseStopReceiptSchema.innerType().omit({action:true,status:true}).extend({
  action: z.literal("database.runtime.backup"),
  destinationId: identity,
  volumeKey: identity,
  sourceDigest: digest,
  archiveId: z.string().regex(/^backup_[a-f0-9]{32}$/),
  archiveBytes: z.number().int().safe().positive(),
  archiveSha256: digest,
  manifestSha256: digest,
  format: z.enum(["postgres-custom-gzip", "mysql-sql-gzip", "mariadb-sql-gzip", "mongodb-archive-gzip", "volume-tar"]),
  consistency: z.enum(["native-snapshot", "transactional-tables", "quiesced-writes", "all-consumers-stopped"]),
  status: z.enum(["created", "already-created"]),
  idempotent: z.boolean()
}).strict().superRefine((value, ctx) => {
  if (value.volumeKey !== "db-"+value.databaseId || value.commandId === value.originalCommandId || value.format !== formats[value.engine]
    || value.consistency !== consistency[value.engine] || (value.status === "already-created") !== value.idempotent)
    ctx.addIssue({code:z.ZodIssueCode.custom, path:["status"], message:"Backup evidence must bind its engine, original source and replay marker"});
});
export const managedDatabaseBackupCachedReceiptSchema = z.object({
  schemaVersion:z.literal(1), action:z.literal("database.runtime.backup"), agentId:identity,
  commandId:id, correlationId:id, receipt:managedDatabaseBackupReceiptSchema.nullable()
}).strict().superRefine((value, ctx) => {
  if (value.receipt && (value.agentId !== value.receipt.agentId || value.commandId !== value.receipt.commandId
    || value.correlationId !== value.receipt.correlationId))
    ctx.addIssue({code:z.ZodIssueCode.custom, path:["receipt"], message:"Backup cache must bind the original command"});
});
export type ManagedDatabaseBackupPreparationV1 = z.infer<typeof managedDatabaseBackupPreparationSchema>;
export type ManagedDatabaseBackupAgentCommandV1 = z.infer<typeof managedDatabaseBackupAgentCommandSchema>;
export type ManagedDatabaseBackupReceiptQueryV1 = z.infer<typeof managedDatabaseBackupReceiptQuerySchema>;
export type ManagedDatabaseBackupReceiptV1 = z.infer<typeof managedDatabaseBackupReceiptSchema>;
