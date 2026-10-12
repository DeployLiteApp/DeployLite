import {z} from "zod";
import {managedDatabaseStopPreparationSchema} from "./managed-database-stop.js";
import {managedDatabaseRuntimeReceiptSchema} from "./managed-database-runtime.js";
const identity=z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),id=z.string().min(1).max(256),digest=z.string().regex(/^[a-f0-9]{64}$/);
const context=z.object({requestId:id,correlationId:id}).strict();
export const MANAGED_DATABASE_HEALTH_CAPABILITY="database.runtime.health.v1" as const;
export const MANAGED_DATABASE_HEALTH_PATH="/databases/runtime/health" as const;
const preparation=managedDatabaseStopPreparationSchema.innerType();
function bindOriginal(value:z.infer<typeof preparation>,ctx:z.RefinementCtx){
 const source=Object.fromEntries(Object.keys(preparation.shape).map(key=>[key,value[key as keyof typeof value]]));
 if(!managedDatabaseStopPreparationSchema.safeParse(source).success)ctx.addIssue({code:z.ZodIssueCode.custom,path:["originalReceipt"],message:"Health requires original ready scope"});
}
export const managedDatabaseHealthPreparationSchema=preparation.superRefine(bindOriginal);
/** Signed read only: original opaque proof, current request context, bounded transport. */
export const managedDatabaseHealthAgentQuerySchema=preparation.extend({action:z.literal("database.runtime.health"),agentId:identity,
 requiredCapabilities:z.tuple([z.literal(MANAGED_DATABASE_HEALTH_CAPABILITY)]),context,timeoutMs:z.number().int().min(1).max(60000)
}).strict().superRefine((value,ctx)=>{
 bindOriginal(value,ctx);if(value.agentId!==value.originalReceipt.agentId)ctx.addIssue({code:z.ZodIssueCode.custom,path:["agentId"],message:"Original agent required"});
});
export const managedDatabaseHealthObservationSchema=managedDatabaseRuntimeReceiptSchema.innerType().omit({commandId:true,inputDigest:true,correlationId:true,status:true,health:true,idempotent:true}).extend({
 action:z.literal("database.runtime.health"),originalCommandId:id,profileId:identity,context,
 containerId:digest,imageId:z.string().regex(/^sha256:[a-f0-9]{64}$/),networkId:digest,volumeCreatedAt:z.string().datetime({offset:true}),
 observedAt:z.number().int().safe().nonnegative(),storage:z.literal("verified"),state:z.enum(["running","stopped"]),
 health:z.enum(["healthy","unhealthy","starting","unknown","not-running"]),uid:z.number().int().min(1).max(4294967294).nullable()
}).strict().superRefine((value,ctx)=>{
 if(value.state==="stopped"?(value.health!=="not-running"||value.uid!==null):(value.health==="not-running"||value.uid===null))
  ctx.addIssue({code:z.ZodIssueCode.custom,path:["health"],message:"Current health must match observed process state"});
});
export type ManagedDatabaseHealthPreparationV1=z.infer<typeof managedDatabaseHealthPreparationSchema>;
export type ManagedDatabaseHealthAgentQueryV1=z.infer<typeof managedDatabaseHealthAgentQuerySchema>;
export type ManagedDatabaseHealthObservationV1=z.infer<typeof managedDatabaseHealthObservationSchema>;
