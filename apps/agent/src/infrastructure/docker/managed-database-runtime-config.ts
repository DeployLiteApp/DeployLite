import { parseManagedDatabaseRuntimeConfiguration } from "@deploylite/domain";
export { MANAGED_DATABASE_RUNTIME_CONFIG_ENV } from "@deploylite/domain";
import { createManagedDatabaseRuntime } from "./docker-managed-database-runtime.js";

/** Trusted configuration only: no default images/limits, discovery or runtime effects. */
export function createConfiguredManagedDatabaseRuntime(
  raw: string | undefined,
  options: Omit<Parameters<typeof createManagedDatabaseRuntime>[0], "profiles" | "limits">
): ReturnType<typeof createManagedDatabaseRuntime> | undefined {
  if (raw === undefined) return undefined;
  try {
    const configuration = parseManagedDatabaseRuntimeConfiguration(raw, options.imagePolicy)!;
    return createManagedDatabaseRuntime({ ...options, ...configuration });
  } catch {
    throw new Error("Database runtime configuration is invalid.");
  }
}
