import { z } from "zod";
import { approvedManagedDatabaseProfileSchema } from "./managed-database-profile.js";
export const managedDatabaseRuntimeConfigurationSchema = z.object({
  profiles: z.record(approvedManagedDatabaseProfileSchema),
  limits: z.object({
    deadlineMs: z.number().int().min(1).max(60000),
    maxOutputBytes: z.number().int().min(1).max(1048576),
    maxContainers: z.number().int().min(1).max(128),
    pollIntervalMs: z.number().int().min(1).max(1000),
    cpus: z.number().min(0.1).max(2),
    memoryBytes: z.number().int().min(64 * 1024 * 1024).max(4 * 1024 * 1024 * 1024),
    pidsLimit: z.number().int().min(16).max(1024),
    stopGraceSeconds: z.number().int().min(1).max(30).optional()
  }).strict()
}).strict();
