import {z} from "zod";
import {managedDatabaseRuntimePreparationSchema,managedDatabaseRuntimeReceiptSchema} from "./managed-database-runtime.js";
import {managedDatabaseStopPreparationSchema,managedDatabaseStopReceiptSchema} from "./managed-database-stop.js";
import {managedDatabaseStartPreparationSchema} from "./managed-database-start.js";
import {projectControlAuthoritySchema,projectControlLeaseSchema} from "./project-control-authority.js";
import {managedDatabaseProfileRequestSchema} from "../managed-database-profile.js";
const identity=z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),id=z.string().min(1).max(256),digest=z.string().regex(/^[a-f0-9]{64}$/);
export const MANAGED_DATABASE_DELETE_CAPABILITY="database.runtime.delete.v1" as const;
export const MANAGED_DATABASE_DELETE_PATH="/databases/runtime/delete" as const;
export const MANAGED_DATABASE_DELETE_RECEIPT_PATH="/databases/runtime/delete/receipt" as const;
const preparation=managedDatabaseRuntimePreparationSchema.extend({
 originalReceipt:managedDatabaseRuntimeReceiptSchema.refine(value=>value.status==="ready","Original ready execution required"),
 originalReplayFingerprint:digest,originalStopReceipt:managedDatabaseStopReceiptSchema.optional(),originalStopReplayFingerprint:digest.optional()
}).strict();
function bindOriginal(value:z.infer<typeof preparation>,ctx:z.RefinementCtx){
 const source={schemaVersion:value.schemaVersion,projectId:value.projectId,databaseId:value.databaseId,engine:value.engine,profileId:value.profileId,
  planDigest:value.planDigest,environmentFingerprint:value.environmentFingerprint,originalReceipt:value.originalReceipt,originalReplayFingerprint:value.originalReplayFingerprint};
 const hasStop=value.originalStopReceipt!==undefined||value.originalStopReplayFingerprint!==undefined;
 const parsed=hasStop?managedDatabaseStartPreparationSchema.safeParse({...source,originalStopReceipt:value.originalStopReceipt,originalStopReplayFingerprint:value.originalStopReplayFingerprint}):managedDatabaseStopPreparationSchema.safeParse(source);
 if(!parsed.success)ctx.addIssue({code:z.ZodIssueCode.custom,path:["originalReceipt"],message:"Removal must bind original execution and any paired STOP source"});
}
export const managedDatabaseDeletePreparationSchema=preparation.superRefine(bindOriginal);
const query=preparation.extend({
 action:z.literal("database.runtime.delete"),operation:z.literal("database.runtime.delete"),storagePolicy:z.literal("retain-original"),stopPolicy:z.literal("if-running"),
 confirmationId:identity,agentId:identity,commandId:id,inputDigest:digest,idempotencyKey:identity,requiredCapabilities:z.tuple([z.literal(MANAGED_DATABASE_DELETE_CAPABILITY)]),
 authority:projectControlAuthoritySchema,lease:projectControlLeaseSchema,context:z.object({requestId:id,correlationId:id}).strict(),timeoutMs:z.number().int().min(1).max(60000)
}).strict();
function bindCommand(value:z.infer<typeof query>,ctx:z.RefinementCtx){
 bindOriginal(value,ctx);
 if(value.agentId!==value.originalReceipt.agentId||value.commandId===value.originalReceipt.commandId||value.commandId===value.originalStopReceipt?.commandId
  ||value.projectId!==value.authority.projectId||value.commandId!==value.authority.commandId||value.inputDigest!==value.authority.inputDigest
  ||JSON.stringify(value.lease)!==JSON.stringify(value.authority.projectLease))ctx.addIssue({code:z.ZodIssueCode.custom,path:["authority"],message:"Confirmed removal must bind original agent and new project authority"});
}
/** No secrets, caller argv, force or persistent-resource deletion fields. */
export const managedDatabaseDeleteAgentCommandSchema=query.extend({cancellationRequested:z.literal(false)}).strict().superRefine(bindCommand);
export const managedDatabaseDeleteReceiptQuerySchema=query.superRefine(bindCommand);
export const managedDatabaseDeleteReceiptSchema=z.object({
 ...managedDatabaseProfileRequestSchema.shape,action:z.literal("database.runtime.delete"),agentId:identity,commandId:id,originalCommandId:id,
 originalStopCommandId:id.nullable(),confirmationId:identity,profileId:identity,inputDigest:digest,planDigest:digest,environmentFingerprint:z.string().regex(/^[a-f0-9]{32}$/),correlationId:id,
 containerId:digest,imageId:z.string().regex(/^sha256:[a-f0-9]{64}$/),volumeName:z.string().max(160).regex(/^dl-[a-f0-9]{32}-vol-db-[a-z][a-z0-9_-]{0,59}$/),
 networkName:z.string().max(160).regex(/^dl-[a-f0-9]{32}-net-db-[a-z][a-z0-9_-]{0,59}$/),networkId:digest,volumeCreatedAt:z.string().datetime({offset:true}),observedAt:z.number().int().nonnegative(),
 status:z.literal("removed"),storage:z.literal("retained"),redacted:z.literal(true)
}).strict().superRefine((value,ctx)=>{
 if(value.commandId===value.originalCommandId||value.commandId===value.originalStopCommandId)ctx.addIssue({code:z.ZodIssueCode.custom,path:["commandId"],message:"Removal must differ from original source commands"});
});
export const managedDatabaseDeleteCachedReceiptSchema=z.object({schemaVersion:z.literal(1),action:z.literal("database.runtime.delete"),
 agentId:identity,commandId:id,confirmationId:identity,correlationId:id,receipt:managedDatabaseDeleteReceiptSchema.nullable()
}).strict().superRefine((value,ctx)=>{
 if(value.receipt&&(value.agentId!==value.receipt.agentId||value.commandId!==value.receipt.commandId||value.confirmationId!==value.receipt.confirmationId||value.correlationId!==value.receipt.correlationId))
  ctx.addIssue({code:z.ZodIssueCode.custom,path:["receipt"],message:"Removal cache must bind its own command and confirmation"});
});
export type ManagedDatabaseDeletePreparationV1=z.infer<typeof managedDatabaseDeletePreparationSchema>;
export type ManagedDatabaseDeleteAgentCommandV1=z.infer<typeof managedDatabaseDeleteAgentCommandSchema>;
export type ManagedDatabaseDeleteReceiptQueryV1=z.infer<typeof managedDatabaseDeleteReceiptQuerySchema>;
export type ManagedDatabaseDeleteReceiptV1=z.infer<typeof managedDatabaseDeleteReceiptSchema>;
export type ManagedDatabaseDeleteCachedReceiptV1=z.infer<typeof managedDatabaseDeleteCachedReceiptSchema>;
