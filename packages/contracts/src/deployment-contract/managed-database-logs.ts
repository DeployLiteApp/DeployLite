import {z} from "zod";
import {managedDatabaseHealthPreparationSchema, managedDatabaseHealthAgentQuerySchema, managedDatabaseHealthObservationSchema} from "./managed-database-health.js";
export const MANAGED_DATABASE_LOGS_CAPABILITY = "database.runtime.logs.v1" as const;
export const MANAGED_DATABASE_LOGS_PATH = "/databases/runtime/logs" as const;
/** Explicit bounded selection avoids Docker's invalid-tail fallback to unbounded logs. */
export const managedDatabaseLogsSelectionSchema = z.object({
  tail: z.number().int().min(1).max(5000),
  since: z.string().datetime().refine(value => {
    const time = Date.parse(value);
    return Number.isSafeInteger(time) && time >= 0 && new Date(time).toISOString() === value;
  }).optional()
}).strict();
/** Original ready source, existing readonly context, no new effects or secret envelope. */
export const managedDatabaseLogsAgentQuerySchema = managedDatabaseHealthAgentQuerySchema.innerType().extend({
  action: z.literal("database.runtime.logs"), requiredCapabilities: z.tuple([z.literal(MANAGED_DATABASE_LOGS_CAPABILITY)]),
  selection: managedDatabaseLogsSelectionSchema
}).strict().superRefine((value, ctx) => {
  const {selection: _selection, ...source} = value;
  if (!managedDatabaseHealthAgentQuerySchema.safeParse({...source, action: "database.runtime.health", requiredCapabilities: ["database.runtime.health.v1"]}).success) {
    ctx.addIssue({code: z.ZodIssueCode.custom, path: ["originalReceipt"], message: "Logs requires original ready scope"});
  }
});
export const managedDatabasePublicLogsSchema = z.object({
  stdout: z.string().max(1048576), stderr: z.string().max(1048576), redacted: z.literal(true)
}).strict().superRefine((value, ctx) => {
  if (new TextEncoder().encode(value.stdout).byteLength + new TextEncoder().encode(value.stderr).byteLength > 1048576) {
    ctx.addIssue({code: z.ZodIssueCode.custom, path: ["stdout"], message: "Log batch exceeds public byte limit"});
  }
});
/** Stopped containers retain logs; every batch has its own bounded observation time. */
export const managedDatabaseLogsObservationSchema = managedDatabaseHealthObservationSchema.innerType().extend({
  action: z.literal("database.runtime.logs"), logs: managedDatabasePublicLogsSchema,
  logsObservedAt: z.number().int().safe().nonnegative()
}).strict().superRefine((value, ctx) => {
  const {logs: _logs, logsObservedAt, ...health} = value;
  if (!managedDatabaseHealthObservationSchema.safeParse({...health, action: "database.runtime.health"}).success) {
    ctx.addIssue({code: z.ZodIssueCode.custom, path: ["health"], message: "Logs requires corroborated current state"});
  }
  if (logsObservedAt > value.observedAt) ctx.addIssue({code: z.ZodIssueCode.custom, path: ["logsObservedAt"], message: "Log batch must precede final corroboration"});
});
export const managedDatabaseLogsPreparationSchema = managedDatabaseHealthPreparationSchema.innerType().extend({selection: managedDatabaseLogsSelectionSchema}).strict().superRefine((value, ctx) => {
  const {selection: _selection, ...source} = value;
  if (!managedDatabaseHealthPreparationSchema.safeParse(source).success) ctx.addIssue({code: z.ZodIssueCode.custom, path: ["originalReceipt"], message: "Logs requires original ready scope"});
});
export type ManagedDatabaseLogsAgentQueryV1 = z.infer<typeof managedDatabaseLogsAgentQuerySchema>;
export type ManagedDatabaseLogsObservationV1 = z.infer<typeof managedDatabaseLogsObservationSchema>;
export type ManagedDatabaseLogsPreparationV1 = z.infer<typeof managedDatabaseLogsPreparationSchema>;
