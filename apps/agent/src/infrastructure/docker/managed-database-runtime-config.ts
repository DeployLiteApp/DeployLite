import { z } from "zod";
import { approvedManagedDatabaseProfileSchema } from "@deploylite/contracts";
import { createManagedDatabaseRuntime } from "./docker-managed-database-runtime.js";

export const MANAGED_DATABASE_RUNTIME_CONFIG_ENV = "DEPLOYLITE_MANAGED_DATABASE_RUNTIME" as const;
const schema = z.object({
  profiles: z.record(approvedManagedDatabaseProfileSchema),
  limits: z.object({
    deadlineMs: z.number().int().min(1).max(60000),
    maxOutputBytes: z.number().int().min(1).max(1048576),
    maxContainers: z.number().int().min(1).max(128),
    pollIntervalMs: z.number().int().min(1).max(1000),
    cpus: z.number().min(0.1).max(2),
    memoryBytes: z.number().int().min(64 * 1024 * 1024).max(4 * 1024 * 1024 * 1024),
    pidsLimit: z.number().int().min(16).max(1024)
  }).strict()
}).strict();

/** Trusted configuration only: no default images/limits, discovery or runtime effects. */
export function createConfiguredManagedDatabaseRuntime(
  raw: string | undefined,
  options: Omit<Parameters<typeof createManagedDatabaseRuntime>[0], "profiles" | "limits">
): ReturnType<typeof createManagedDatabaseRuntime> | undefined {
  if (raw === undefined) return undefined;
  try {
    if (raw.length > 65536) throw new Error();
    const configuration = schema.parse(JSON.parse(raw));
    return createManagedDatabaseRuntime({ ...options, ...configuration });
  } catch {
    throw new Error("Database runtime configuration is invalid.");
  }
}
