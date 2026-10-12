import {z} from "zod";
import {managedDatabaseHealthAgentQuerySchema,managedDatabaseHealthObservationSchema} from "./managed-database-health.js";
export const MANAGED_DATABASE_METRICS_CAPABILITY="database.runtime.metrics.v1" as const;
export const MANAGED_DATABASE_METRICS_PATH="/databases/runtime/metrics" as const;
/** Reuse original ready-scope admission without new commands, authority or secrets. */
export const managedDatabaseMetricsAgentQuerySchema=managedDatabaseHealthAgentQuerySchema.innerType().extend({action:z.literal("database.runtime.metrics"),requiredCapabilities:z.tuple([z.literal(MANAGED_DATABASE_METRICS_CAPABILITY)])}).strict().superRefine((value,ctx)=>{
 if(!managedDatabaseHealthAgentQuerySchema.safeParse({...value,action:"database.runtime.health",requiredCapabilities:["database.runtime.health.v1"]}).success)ctx.addIssue({code:z.ZodIssueCode.custom,path:["originalReceipt"],message:"Metrics requires original ready scope"});
});
const quantity="[0-9]{1,16}(?:\\.[0-9]{1,6})?(?:B|kB|MB|GB|TB|PB|EB|KiB|MiB|GiB|TiB|PiB|EiB)";
const pair=z.string().regex(new RegExp("^"+quantity+" / "+quantity+"$"));
/** Preserve rounded CLI display quantities instead of claiming precise bytes. */
export const managedDatabasePublicMetricsSchema=z.object({cpuPercent:z.number().finite().nonnegative(),memoryUsage:pair,memoryPercent:z.number().finite().nonnegative(),networkIO:pair,blockIO:pair,pids:z.number().int().safe().positive()}).strict();
export const managedDatabaseMetricsObservationSchema=managedDatabaseHealthObservationSchema.innerType().extend({action:z.literal("database.runtime.metrics"),metrics:managedDatabasePublicMetricsSchema.nullable(),metricsObservedAt:z.number().int().safe().nonnegative().nullable()}).strict().superRefine((value,ctx)=>{
 const {metrics,metricsObservedAt,...health}=value;
 if(!managedDatabaseHealthObservationSchema.safeParse({...health,action:"database.runtime.health"}).success)ctx.addIssue({code:z.ZodIssueCode.custom,path:["health"],message:"Metrics requires corroborated current state"});
 if(value.state==="stopped"?(metrics!==null||metricsObservedAt!==null):(metrics===null||metricsObservedAt===null||metricsObservedAt>value.observedAt))ctx.addIssue({code:z.ZodIssueCode.custom,path:["metrics"],message:"Metrics must match current process state and time"});
});
export type ManagedDatabaseMetricsAgentQueryV1=z.infer<typeof managedDatabaseMetricsAgentQuerySchema>;
export type ManagedDatabaseMetricsObservationV1=z.infer<typeof managedDatabaseMetricsObservationSchema>;
