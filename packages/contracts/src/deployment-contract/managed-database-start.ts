import {z} from "zod";
import {managedDatabaseStopPreparationSchema,managedDatabaseStopReceiptSchema} from "./managed-database-stop.js";
import {managedDatabaseRuntimeReceiptSchema} from "./managed-database-runtime.js";
import {projectControlAuthoritySchema,projectControlLeaseSchema} from "./project-control-authority.js";
const identity=z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),id=z.string().min(1).max(256),digest=z.string().regex(/^[a-f0-9]{64}$/);
export const MANAGED_DATABASE_START_CAPABILITY="database.runtime.start.v1" as const;
export const MANAGED_DATABASE_START_PATH="/databases/runtime/start" as const;
export const MANAGED_DATABASE_START_RECEIPT_PATH="/databases/runtime/start/receipt" as const;
const preparation=managedDatabaseStopPreparationSchema.innerType().extend({
  originalStopReceipt:managedDatabaseStopReceiptSchema,originalStopReplayFingerprint:digest
}).strict();
const originalFields=["schemaVersion","projectId","databaseId","engine","agentId","planDigest","environmentFingerprint","containerId","imageId","volumeName","networkName","networkId","volumeCreatedAt"] as const;
function bindOriginal(value:z.infer<typeof preparation>,ctx:z.RefinementCtx){
  const original=value.originalReceipt,stopped=value.originalStopReceipt;
  if(value.projectId!==original.projectId||value.databaseId!==original.databaseId||value.engine!==original.engine||value.planDigest!==original.planDigest
    ||value.environmentFingerprint!==original.environmentFingerprint||value.profileId!==stopped.profileId||stopped.originalCommandId!==original.commandId
    ||stopped.commandId===original.commandId||stopped.observedAt<original.observedAt||originalFields.some(key=>stopped[key]!==original[key]))
    ctx.addIssue({code:z.ZodIssueCode.custom,path:["originalStopReceipt"],message:"Start must bind both original native receipts and storage"});
}
/** Public immutable intent only; original cache corroboration and fresh authority precede any effect. */
export const managedDatabaseStartPreparationSchema=preparation.superRefine(bindOriginal);
const query=preparation.extend({action:z.literal("database.runtime.start"),operation:z.literal("database.runtime.start"),agentId:identity,commandId:id,
  inputDigest:digest,idempotencyKey:identity,requiredCapabilities:z.tuple([z.literal(MANAGED_DATABASE_START_CAPABILITY)]),
  authority:projectControlAuthoritySchema,lease:projectControlLeaseSchema,context:z.object({requestId:id,correlationId:id}).strict(),timeoutMs:z.number().int().min(1).max(60000)
}).strict();
function bindCommand(value:z.infer<typeof query>,ctx:z.RefinementCtx){
  bindOriginal(value,ctx);
  if(value.agentId!==value.originalReceipt.agentId||value.commandId===value.originalReceipt.commandId||value.commandId===value.originalStopReceipt.commandId
    ||value.projectId!==value.authority.projectId||value.commandId!==value.authority.commandId||value.inputDigest!==value.authority.inputDigest
    ||JSON.stringify(value.lease)!==JSON.stringify(value.authority.projectLease))
    ctx.addIssue({code:z.ZodIssueCode.custom,path:["authority"],message:"New start must bind its own project command and lease"});
}
// No environment envelope, image selection, argv, port, initialization or resource adoption fields.
export const managedDatabaseStartAgentCommandSchema=query.extend({cancellationRequested:z.literal(false)}).strict().superRefine(bindCommand);
export const managedDatabaseStartReceiptQuerySchema=query.superRefine(bindCommand);
export const managedDatabaseStartReceiptSchema=managedDatabaseRuntimeReceiptSchema.innerType().extend({action:z.literal("database.runtime.start"),
  originalCommandId:id,originalStopCommandId:id,profileId:identity,containerId:digest,imageId:z.string().regex(/^sha256:[a-f0-9]{64}$/),
  networkId:digest,volumeCreatedAt:z.string().datetime({offset:true}),status:z.literal("ready"),health:z.literal("passed"),storage:z.literal("verified")
}).strict().superRefine((receipt,ctx)=>{
  if(receipt.commandId===receipt.originalCommandId||receipt.commandId===receipt.originalStopCommandId||receipt.originalCommandId===receipt.originalStopCommandId)
    ctx.addIssue({code:z.ZodIssueCode.custom,path:["commandId"],message:"Start must have a distinct command linked to original creation and stop"});
});
export const managedDatabaseStartCachedReceiptSchema=z.object({schemaVersion:z.literal(1),action:z.literal("database.runtime.start"),agentId:identity,commandId:id,
  correlationId:id,receipt:managedDatabaseStartReceiptSchema.nullable()
}).strict().superRefine((cached,ctx)=>{
  if(cached.receipt&&(cached.agentId!==cached.receipt.agentId||cached.commandId!==cached.receipt.commandId||cached.correlationId!==cached.receipt.correlationId))
    ctx.addIssue({code:z.ZodIssueCode.custom,path:["receipt"],message:"Start cache must bind its own original command"});
});
export type ManagedDatabaseStartPreparationV1=z.infer<typeof managedDatabaseStartPreparationSchema>;
export type ManagedDatabaseStartAgentCommandV1=z.infer<typeof managedDatabaseStartAgentCommandSchema>;
export type ManagedDatabaseStartReceiptQueryV1=z.infer<typeof managedDatabaseStartReceiptQuerySchema>;
export type ManagedDatabaseStartReceiptV1=z.infer<typeof managedDatabaseStartReceiptSchema>;
