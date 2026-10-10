import { randomUUID } from "node:crypto";
import { createEnvSecretCipher } from "@deploylite/config";
import { ensureManagedDatabaseCredentials } from "@deploylite/domain";
import pg from "pg";
import { expect, it } from "vitest";
import { createDbClient, createDbPool, closeDbPool } from "./client.js";
import { DbManagedDatabaseCredentialCreationRepository } from "./repositories/managed-database-credentials.js";
/** Shares the existing P5 owned fixture lifecycle; adds no server or restart helper. */
export function defineManagedDatabaseCredentialCases(getPool:()=>pg.Pool,getUrl:()=>string) {
  const cipher=createEnvSecretCipher(Buffer.alloc(32,17));
  const imagePolicy={policyVersion:"images-1",trustedHosts:["registry.example.com"],allowTags:false,allowDigests:true};
  const profile={schemaVersion:1,profileId:"approved-1",engine:"postgres",image:`registry.example.com/db@sha256:${"a".repeat(64)}`,
    dataPath:"/database/data",containerPort:5432,credentialKeys:["DATABASE_PASSWORD"],backupStrategy:"engine-native"};
  async function project() {
    const projectId=randomUUID();await getPool().query("INSERT INTO projects(id,name,repo_url,default_branch) VALUES($1,'P5 credentials','https://example.test/repo','main')",[projectId]);
    return {schemaVersion:1,projectId,databaseId:"orders",engine:"postgres"};
  }
  const ports=(pool=getPool())=>({cipher,imagePolicy,authorize:async()=>true,secrets:new DbManagedDatabaseCredentialCreationRepository(createDbClient(pool))});
  it("persists one encrypted database credential bundle through concurrent creation and a new pool",async()=>{
    const input=await project();
    const results=await Promise.all(Array.from({length:3},()=>ensureManagedDatabaseCredentials(input,profile,ports())));
    expect(results[1]).toEqual(results[0]);expect(results[2]).toEqual(results[0]);
    const rows=(await getPool().query("SELECT encrypted_value,value_fingerprint FROM env_secret_values WHERE project_id=$1",[input.projectId])).rows;
    expect(rows).toHaveLength(1);expect(Buffer.isBuffer(rows[0].encrypted_value)).toBe(true);
    const plaintext=cipher.decrypt(rows[0].encrypted_value.toString("base64"));const bundle=JSON.parse(plaintext);
    expect(bundle.credentials.DATABASE_PASSWORD).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(results)).not.toContain(bundle.credentials.DATABASE_PASSWORD);
    expect(rows[0].value_fingerprint).toBe(cipher.fingerprint(plaintext));
    const fresh=createDbPool(getUrl(),{max:1});
    try {expect(await ensureManagedDatabaseCredentials(input,profile,ports(fresh))).toEqual(results[0]);}
    finally {await closeDbPool(fresh);}
  });
  it("keeps generated database credentials unchanged on stale profiles and refuses unauthorized creation",async()=>{
    const input=await project();await ensureManagedDatabaseCredentials(input,profile,ports());
    const before=(await getPool().query("SELECT encrypted_value FROM env_secret_values WHERE project_id=$1",[input.projectId])).rows[0].encrypted_value;
    await expect(ensureManagedDatabaseCredentials(input,{...profile,profileId:"approved-2"},ports())).rejects.toThrow("credentials are unavailable");
    const after=(await getPool().query("SELECT encrypted_value FROM env_secret_values WHERE project_id=$1",[input.projectId])).rows[0].encrypted_value;
    expect(after).toEqual(before);
    const foreign=await project();await expect(ensureManagedDatabaseCredentials(foreign,profile,{...ports(),authorize:async()=>false})).rejects.toThrow("credentials are unavailable");
    expect((await getPool().query("SELECT count(*)::int AS count FROM env_secret_values WHERE project_id=$1",[foreign.projectId])).rows[0].count).toBe(0);
  });
}
