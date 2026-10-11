import { ENCRYPTION_KEY_VERSION, type EnvSecretCipher } from "@deploylite/config";
import { managedDatabaseCredentialBundleSchema, managedDatabaseProfileRequestSchema, managedDatabaseRuntimePreparationSchema,
  type ApprovedManagedDatabaseProfileV1, type ImageReferencePolicyV1, type ManagedDatabaseEngineV1 } from "@deploylite/contracts";
import type { EncryptedEnvSecretValueRecord } from "./index.js";
import { managedDatabaseCredentialKey } from "./managed-database-credentials.js";
import { materializeManagedDatabaseRuntime, managedDatabaseInternalConnection } from "./managed-database-runtime-spec.js";
export type ManagedDatabaseInventoryPorts = Readonly<{cipher: EnvSecretCipher; imagePolicy: ImageReferencePolicyV1; profiles: ReadonlyMap<ManagedDatabaseEngineV1, ApprovedManagedDatabaseProfileV1>}>;
export type ManagedDatabaseInventoryPreparation = Readonly<{
  preparation: ReturnType<typeof managedDatabaseRuntimePreparationSchema.parse>;
  connection: ReturnType<typeof managedDatabaseInternalConnection>;
}>;
/** Public preparations from existing encrypted rows; never a claim of current runtime readiness. */
export function prepareManagedDatabaseInventory(projectId: string, rows: readonly EncryptedEnvSecretValueRecord[], ports: ManagedDatabaseInventoryPorts): ManagedDatabaseInventoryPreparation[] {
  try {
    managedDatabaseProfileRequestSchema.shape.projectId.parse(projectId);
    const items: ManagedDatabaseInventoryPreparation[] = [], identities = new Set<string>();
    for (const row of rows) {
      if (row.projectId !== projectId) throw new Error("scope");
      if (!row.key.startsWith("DEPLOYLITE_DATABASE_")) continue;
      if (!/^DEPLOYLITE_DATABASE_[A-F0-9]{64}$/.test(row.key) || row.scope !== "project" || !row.valuePresent || row.keyVersion !== ENCRYPTION_KEY_VERSION
        || !Buffer.isBuffer(row.encryptedValue) || !row.encryptedValue.length) throw new Error("record");
      const bundle = managedDatabaseCredentialBundleSchema.parse(JSON.parse(ports.cipher.decrypt(row.encryptedValue.toString("base64"))));
      if (bundle.projectId !== projectId || row.key !== managedDatabaseCredentialKey(projectId, bundle.databaseId) || identities.has(bundle.databaseId)) throw new Error("identity");
      const profile = ports.profiles.get(bundle.engine);
      if (!profile) throw new Error("profile");
      const input = {schemaVersion: 1 as const, projectId, databaseId: bundle.databaseId, engine: bundle.engine};
      const runtime = materializeManagedDatabaseRuntime(input, profile, {cipher: ports.cipher, imagePolicy: ports.imagePolicy, credentials: row});
      identities.add(bundle.databaseId);
      items.push({preparation: managedDatabaseRuntimePreparationSchema.parse({...input, profileId: runtime.plan.profileId,
        planDigest: runtime.plan.planDigest, environmentFingerprint: runtime.environmentFingerprint}), connection: managedDatabaseInternalConnection(runtime)});
    }
    return items.sort((left, right) => left.preparation.databaseId < right.preparation.databaseId ? -1 : left.preparation.databaseId > right.preparation.databaseId ? 1 : 0);
  } catch { throw new Error("Database inventory is unavailable."); }
}
