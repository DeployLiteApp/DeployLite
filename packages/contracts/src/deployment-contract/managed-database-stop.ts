import { z } from "zod";
import { managedDatabaseRuntimePreparationSchema, managedDatabaseRuntimeReceiptSchema } from "./managed-database-runtime.js";
import { projectControlAuthoritySchema, projectControlLeaseSchema } from "./project-control-authority.js";
import { managedDatabaseProfileRequestSchema } from "../managed-database-profile.js";
const identity = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), id = z.string().min(1).max(256), digest = z.string().regex(/^[a-f0-9]{64}$/);
export const MANAGED_DATABASE_STOP_CAPABILITY = "database.runtime.stop.v1" as const;
export const MANAGED_DATABASE_STOP_PATH = "/databases/runtime/stop" as const;
export const MANAGED_DATABASE_STOP_RECEIPT_PATH = "/databases/runtime/stop/receipt" as const;
const preparation = managedDatabaseRuntimePreparationSchema.extend({
    originalReceipt: managedDatabaseRuntimeReceiptSchema.refine(receipt => receipt.status === "ready", "Original ready execution required"),
    originalReplayFingerprint: digest
}).strict();
function bindOriginal(value: z.infer<typeof preparation>, ctx: z.RefinementCtx) {
    const original = value.originalReceipt;
    if (value.projectId !== original.projectId || value.databaseId !== original.databaseId || value.engine !== original.engine
        || value.planDigest !== original.planDigest || value.environmentFingerprint !== original.environmentFingerprint)
        ctx.addIssue({code:z.ZodIssueCode.custom,path:["originalReceipt"],message:"Stop must bind original native execution scope"});
}
export const managedDatabaseStopPreparationSchema = preparation.superRefine(bindOriginal);
const query = preparation.extend({
    action: z.literal("database.runtime.stop"), operation: z.literal("database.runtime.stop"), agentId: identity, commandId: id,
    inputDigest: digest, idempotencyKey: identity, requiredCapabilities: z.tuple([z.literal(MANAGED_DATABASE_STOP_CAPABILITY)]),
    authority: projectControlAuthoritySchema, lease: projectControlLeaseSchema,
    context: z.object({requestId:id,correlationId:id}).strict(), timeoutMs:z.number().int().min(1).max(60000)
}).strict();
function bindCommand(value: z.infer<typeof query>, ctx: z.RefinementCtx) {
    bindOriginal(value,ctx);
    if (value.agentId !== value.originalReceipt.agentId || value.commandId === value.originalReceipt.commandId
        || value.projectId !== value.authority.projectId || value.commandId !== value.authority.commandId || value.inputDigest !== value.authority.inputDigest
        || JSON.stringify(value.lease) !== JSON.stringify(value.authority.projectLease))
        ctx.addIssue({code:z.ZodIssueCode.custom,path:["authority"],message:"New stop authority must bind its lease and original agent"});
}
/** No secret envelope, caller argv or resource removal fields are part of native stop. */
export const managedDatabaseStopAgentCommandSchema = query.extend({cancellationRequested:z.literal(false)}).strict().superRefine(bindCommand);
export const managedDatabaseStopReceiptQuerySchema = query.superRefine(bindCommand);
export const managedDatabaseStopReceiptSchema = z.object({
    ...managedDatabaseProfileRequestSchema.shape,
    action:z.literal("database.runtime.stop"),agentId:identity,commandId:id,originalCommandId:id,profileId:identity,
    inputDigest:digest,planDigest:digest,environmentFingerprint:z.string().regex(/^[a-f0-9]{32}$/),correlationId:id,
    containerId:digest,imageId:z.string().regex(/^sha256:[a-f0-9]{64}$/),
    volumeName:z.string().max(160).regex(/^dl-[a-f0-9]{32}-vol-db-[a-z][a-z0-9_-]{0,59}$/),
    networkName:z.string().max(160).regex(/^dl-[a-f0-9]{32}-net-db-[a-z][a-z0-9_-]{0,59}$/),
    networkId:digest,volumeCreatedAt:z.string().datetime({offset:true}),observedAt:z.number().int().nonnegative(),
    status:z.literal("stopped"),storage:z.literal("verified"),redacted:z.literal(true)
}).strict().superRefine((receipt,ctx)=>{
    if(receipt.commandId===receipt.originalCommandId)
        ctx.addIssue({code:z.ZodIssueCode.custom,path:["commandId"],message:"Stop command must differ from creation command"});
});
export const managedDatabaseStopCachedReceiptSchema = z.object({
    schemaVersion:z.literal(1),action:z.literal("database.runtime.stop"),agentId:identity,commandId:id,correlationId:id,receipt:managedDatabaseStopReceiptSchema.nullable()
}).strict().superRefine((cached,ctx)=>{
    if(cached.receipt && (cached.agentId!==cached.receipt.agentId || cached.commandId!==cached.receipt.commandId || cached.correlationId!==cached.receipt.correlationId))
        ctx.addIssue({code:z.ZodIssueCode.custom,path:["receipt"],message:"Stop cache must bind its own original command"});
});
export type ManagedDatabaseStopPreparationV1 = z.infer<typeof managedDatabaseStopPreparationSchema>;
export type ManagedDatabaseStopAgentCommandV1 = z.infer<typeof managedDatabaseStopAgentCommandSchema>;
export type ManagedDatabaseStopReceiptQueryV1 = z.infer<typeof managedDatabaseStopReceiptQuerySchema>;
export type ManagedDatabaseStopReceiptV1 = z.infer<typeof managedDatabaseStopReceiptSchema>;
