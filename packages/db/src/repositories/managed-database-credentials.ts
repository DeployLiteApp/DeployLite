import { and, eq } from "drizzle-orm";
import { ENCRYPTION_KEY_VERSION } from "@deploylite/config";
import { envSecretValueSchema } from "@deploylite/contracts";
import type { ManagedDatabaseCredentialCreationRepository, EnvSecretValueInput, EncryptedEnvSecretValueRecord } from "@deploylite/domain";
import type { DeployLiteDb } from "../client.js";
import { assertEnvSecretValuesInputHasNoRawValueColumns } from "../env-metadata.js";
import { envSecretValues, type EnvSecretValueRow } from "../schema.js";
function encryptedRecord(row:EnvSecretValueRow):EncryptedEnvSecretValueRecord {
  if (!Buffer.isBuffer(row.encryptedValue) || !row.encryptedValue.length) throw new Error("Credentials unavailable");
  return {...envSecretValueSchema.parse({id:row.id,projectId:row.projectId,key:row.key,scope:row.scope,valuePresent:true,
    valueFingerprint:row.valueFingerprint,keyVersion:row.keyVersion,createdAt:row.createdAt.toISOString(),updatedAt:row.updatedAt.toISOString()}),
    encryptedValue:Buffer.from(row.encryptedValue)};
}
/** Existing encrypted-secret table and unique project/key/scope constraint, with no overwrite path. */
export class DbManagedDatabaseCredentialCreationRepository implements ManagedDatabaseCredentialCreationRepository {
  constructor(private readonly db: DeployLiteDb) {}
  async find(projectId:string,key:string):Promise<EncryptedEnvSecretValueRecord|undefined> {
    const rows=await this.db.select().from(envSecretValues).where(and(eq(envSecretValues.projectId,projectId),eq(envSecretValues.key,key),eq(envSecretValues.scope,"project"))).limit(2);
    if (rows.length>1) throw new Error("Credentials unavailable");
    return rows[0] ? encryptedRecord(rows[0]) : undefined;
  }
  async createIfAbsent(record:EnvSecretValueInput):Promise<EncryptedEnvSecretValueRecord> {
    assertEnvSecretValuesInputHasNoRawValueColumns(Object.keys(record));
    if (record.scope!=="project" || !/^DEPLOYLITE_DATABASE_[A-F0-9]{64}$/.test(record.key)
      || !Buffer.isBuffer(record.encryptedValue) || !record.encryptedValue.length || !/^[a-f0-9]{32}$/.test(record.valueFingerprint)
      || record.keyVersion!==ENCRYPTION_KEY_VERSION) throw new Error("Credentials unavailable");
    const now=new Date();
    const rows=await this.db.insert(envSecretValues).values({...record,createdAt:now,updatedAt:now})
      .onConflictDoNothing({target:[envSecretValues.projectId,envSecretValues.key,envSecretValues.scope]}).returning();
    if (rows.length>1) throw new Error("Credentials unavailable");
    const row=rows[0] ? encryptedRecord(rows[0]) : await this.find(record.projectId,record.key);
    if (!row) throw new Error("Credentials unavailable");
    return row;
  }
}
