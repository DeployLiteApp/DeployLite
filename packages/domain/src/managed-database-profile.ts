import { approvedManagedDatabaseProfileSchema, managedDatabaseProfileRequestSchema, normalizeImageReferencePolicy, validateImageReference,
  type ImageReferencePolicyV1, type ManagedDatabaseEngineV1 } from "@deploylite/contracts";
import { composeRuntimeResourceName } from "./compose-preview.js";
import { digestControlInput } from "./control-plane.js";
const ports: Record<ManagedDatabaseEngineV1, number> = {postgres: 5432, mysql: 3306, mariadb: 3306, mongodb: 27017, redis: 6379};
export class ManagedDatabaseProfileError extends Error {
  constructor() { super("Managed database profile cannot be prepared safely."); this.name = "ManagedDatabaseProfileError"; }
}
/** Pure scoped metadata; credential materialization and runtime authority remain separate. */
export function planManagedDatabaseProfile(raw: unknown, approved: unknown, imagePolicy: ImageReferencePolicyV1) {
  try {
    const input = managedDatabaseProfileRequestSchema.parse(raw);
    const profile = approvedManagedDatabaseProfileSchema.parse(approved);
    if (input.engine !== profile.engine || profile.containerPort !== ports[input.engine]
      || profile.backupStrategy !== (input.engine === "redis" ? "volume-quiesced" : "engine-native")) throw new ManagedDatabaseProfileError();
    const policy = normalizeImageReferencePolicy({...imagePolicy, allowTags: false});
    const image = validateImageReference(profile.image, policy).reference;
    const key = `db-${input.databaseId}`;
    const plan = {schemaVersion: 1 as const, operation: "database.profile.preview" as const, executionAllowed: false as const,
      projectId: input.projectId, databaseId: input.databaseId, engine: input.engine, profileId: profile.profileId,
      image, containerPort: profile.containerPort, credentialKeys: [...profile.credentialKeys].sort(), backupStrategy: profile.backupStrategy,
      volume: {key, runtimeName: composeRuntimeResourceName(input.projectId, "volume", key), target: profile.dataPath},
      network: {key, runtimeName: composeRuntimeResourceName(input.projectId, "network", key), internal: true as const},
      policyVersion: policy.policyVersion};
    return {...plan, planDigest: digestControlInput({plan, imagePolicy: policy})};
  } catch { throw new ManagedDatabaseProfileError(); }
}
