import { randomBytes } from "node:crypto";
import { ENCRYPTION_KEY_VERSION, type EnvSecretCipher } from "@deploylite/config";
import { managedDatabaseCredentialBundleSchema, type ImageReferencePolicyV1 } from "@deploylite/contracts";
import type { EncryptedEnvSecretValueRecord, EnvSecretValueInput } from "./index.js";
import { digestControlInput } from "./control-plane.js";
import { planManagedDatabaseProfile } from "./managed-database-profile.js";
export type ManagedDatabaseCredentialCreationRepository = Readonly<{
  find(projectId: string, key: string): Promise<EncryptedEnvSecretValueRecord | undefined>;
  /** Atomic insert-if-absent; returns original stored encrypted row on conflict, never overwrites. */
  createIfAbsent(record: EnvSecretValueInput): Promise<EncryptedEnvSecretValueRecord>;
}>;
export type ManagedDatabaseCredentialPorts = Readonly<{
  imagePolicy: ImageReferencePolicyV1; cipher: EnvSecretCipher; secrets: ManagedDatabaseCredentialCreationRepository;
  authorize(projectId: string): Promise<boolean>; entropy?: (bytes: number) => Buffer;
}>;
export class ManagedDatabaseCredentialsError extends Error {
  constructor() { super("Managed database credentials are unavailable.");this.name="ManagedDatabaseCredentialsError"; }
}
/** Canonical existing encrypted-bundle slot; no secret access or authority is granted. */
export function managedDatabaseCredentialKey(projectId: string, databaseId: string): string {
  return "DEPLOYLITE_DATABASE_" + digestControlInput({projectId,databaseId}).toUpperCase();
}
/** Private decrypted payload for authorized server-side runtime preparation, never an API response. */
export function readManagedDatabaseCredentialBundle(plan:ReturnType<typeof planManagedDatabaseProfile>,row:EncryptedEnvSecretValueRecord,cipher:EnvSecretCipher) {
  const key=managedDatabaseCredentialKey(plan.projectId,plan.databaseId);
  if (!row.id || row.projectId!==plan.projectId || row.key!==key || row.scope!=="project" || !row.valuePresent
    || row.keyVersion!==ENCRYPTION_KEY_VERSION || !Buffer.isBuffer(row.encryptedValue) || !row.encryptedValue.length) throw new ManagedDatabaseCredentialsError();
  const plaintext=cipher.decrypt(row.encryptedValue.toString("base64"));
  const bundle=managedDatabaseCredentialBundleSchema.parse(JSON.parse(plaintext));
  if (bundle.projectId!==plan.projectId || bundle.databaseId!==plan.databaseId || bundle.engine!==plan.engine
    || bundle.profileId!==plan.profileId || bundle.planDigest!==plan.planDigest
    || JSON.stringify(Object.keys(bundle.credentials).sort())!==JSON.stringify(plan.credentialKeys)
    || cipher.fingerprint(plaintext)!==row.valueFingerprint) throw new ManagedDatabaseCredentialsError();
  return bundle;
}
/** Trusted application caller supplies project authority; only encrypted bytes cross the repository boundary. */
export async function ensureManagedDatabaseCredentials(raw: unknown, profile: unknown, ports: ManagedDatabaseCredentialPorts) {
  try {
    const plan=planManagedDatabaseProfile(raw,profile,ports.imagePolicy);
    if (!await ports.authorize(plan.projectId)) throw new ManagedDatabaseCredentialsError();
    const key=managedDatabaseCredentialKey(plan.projectId,plan.databaseId);
    const inspect=(row:EncryptedEnvSecretValueRecord) => {
      readManagedDatabaseCredentialBundle(plan,row,ports.cipher);
      return {schemaVersion:1 as const,projectId:plan.projectId,databaseId:plan.databaseId,engine:plan.engine,
        secretRefId:row.id,credentialKey:key,credentialsConfigured:true as const,redacted:true as const};
    };
    const existing=await ports.secrets.find(plan.projectId,key);
    if (existing) {
      if (!await ports.authorize(plan.projectId)) throw new ManagedDatabaseCredentialsError();
      return inspect(existing);
    }
    const credentials:Record<string,string>={};
    for (const name of plan.credentialKeys) {
      const bytes=(ports.entropy??randomBytes)(32);
      if (!Buffer.isBuffer(bytes) || bytes.length!==32) throw new ManagedDatabaseCredentialsError();
      credentials[name]=bytes.toString("hex");
    }
    const plaintext=JSON.stringify({schemaVersion:1,projectId:plan.projectId,databaseId:plan.databaseId,engine:plan.engine,
      profileId:plan.profileId,planDigest:plan.planDigest,credentials});
    const encryptedValue=Buffer.from(ports.cipher.encrypt(plaintext),"base64");
    if (!encryptedValue.length) throw new ManagedDatabaseCredentialsError();
    if (!await ports.authorize(plan.projectId)) throw new ManagedDatabaseCredentialsError();
    const row=await ports.secrets.createIfAbsent({projectId:plan.projectId,key,scope:"project",encryptedValue,
      valueFingerprint:ports.cipher.fingerprint(plaintext),keyVersion:ENCRYPTION_KEY_VERSION});
    return inspect(row);
  } catch { throw new ManagedDatabaseCredentialsError(); }
}
