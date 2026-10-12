import { approvedManagedDatabaseProfileSchema, managedDatabaseEngineSchema, managedDatabaseRuntimeConfigurationSchema,
  type ImageReferencePolicyV1, type ManagedDatabaseEngineV1, type ApprovedManagedDatabaseProfileV1 } from "@deploylite/contracts";
import { planManagedDatabaseProfile } from "./managed-database-profile.js";
export const MANAGED_DATABASE_RUNTIME_CONFIG_ENV = "DEPLOYLITE_MANAGED_DATABASE_RUNTIME" as const;
/** Identical native API/agent plan policy; no workload images or limits are supplied. */
export function managedDatabaseNativeImagePolicy(): ImageReferencePolicyV1 {
  return { policyVersion: "agent-compose-v1", trustedHosts: ["docker.io", "ghcr.io", "registry.example.com"], allowTags: false, allowDigests: true };
}
export function validateManagedDatabaseRuntimeProfiles(raw: unknown, policy: ImageReferencePolicyV1) {
  const engines = managedDatabaseEngineSchema.options;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || JSON.stringify(Object.keys(raw).sort()) !== JSON.stringify([...engines].sort())) throw new Error("Database runtime configuration is invalid.");
  const paths = { postgres: ["/var/lib/postgresql", "/var/lib/postgresql/data"], mysql: ["/var/lib/mysql"], mariadb: ["/var/lib/mysql"], mongodb: ["/data/db"], redis: ["/data"] };
  const profiles = {} as Record<ManagedDatabaseEngineV1, ApprovedManagedDatabaseProfileV1>;
  for (const engine of engines) {
    const profile = approvedManagedDatabaseProfileSchema.parse((raw as Record<string, unknown>)[engine]);
    if (profile.engine !== engine || !paths[engine].includes(profile.dataPath) || !profile.credentialKeys.includes("DATABASE_PASSWORD")
      || profile.credentialKeys.some(key => key !== "DATABASE_PASSWORD" && !(key === "DATABASE_ROOT_PASSWORD" && ["mysql", "mariadb"].includes(engine))))
      throw new Error("Database runtime configuration is invalid.");
    planManagedDatabaseProfile({ schemaVersion: 1, projectId: "profile-validation", databaseId: "validate", engine }, profile, policy);
    profiles[engine] = profile;
  }
  return profiles;
}
/** Pure trusted JSON parsing shared by API/agent; absence disables native operations. */
export function parseManagedDatabaseRuntimeConfiguration(raw: string | undefined, policy = managedDatabaseNativeImagePolicy()) {
  if (raw === undefined) return undefined;
  try {
    if (raw.length > 65536) throw new Error();
    const configuration = managedDatabaseRuntimeConfigurationSchema.parse(JSON.parse(raw));
    return { ...configuration, profiles: validateManagedDatabaseRuntimeProfiles(configuration.profiles, policy) };
  } catch { throw new Error("Database runtime configuration is invalid."); }
}
