import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { DeployLiteDb } from "../client.js";
import { envSecretValues } from "../schema.js";
import { DbManagedDatabaseCredentialCreationRepository } from "./managed-database-credentials.js";
const input={projectId:"project-a",key:"DEPLOYLITE_DATABASE_"+"A".repeat(64),scope:"project" as const,
  encryptedValue:Buffer.from("fixture-ciphertext"),valueFingerprint:"a".repeat(32),keyVersion:1};
const row={id:"secret-a",...input,createdAt:new Date(0),updatedAt:new Date(0)};
function fixture(inserted= [row],found=[row]) {
  const selectChain={from:vi.fn().mockReturnThis(),where:vi.fn().mockReturnThis(),limit:vi.fn(async()=>found)};
  const insertChain={values:vi.fn().mockReturnThis(),onConflictDoNothing:vi.fn().mockReturnThis(),returning:vi.fn(async()=>inserted)};
  const db={select:vi.fn(()=>selectChain),insert:vi.fn(()=>insertChain)};
  return {store:new DbManagedDatabaseCredentialCreationRepository(db as unknown as DeployLiteDb),db,selectChain,insertChain};
}
describe("database credential create-once adapter",()=>{
  it("uses an atomic existing secret-row insert without updates",async()=>{
    const {store,db,insertChain}=fixture();const result=await store.createIfAbsent(input);
    expect(result).toMatchObject({id:row.id,key:input.key,scope:"project"});expect(result.encryptedValue).toEqual(row.encryptedValue);
    expect(insertChain.onConflictDoNothing).toHaveBeenCalledWith({target:[envSecretValues.projectId,envSecretValues.key,envSecretValues.scope]});
    expect(db.select).not.toHaveBeenCalled();
  });
  it("returns the original encrypted row after concurrent insertion",async()=>{
    const {store,insertChain}=fixture([], [row]);const result=await store.createIfAbsent({...input,encryptedValue:Buffer.from("different-fixture")});
    expect(result.encryptedValue).toEqual(row.encryptedValue);expect(insertChain.returning).toHaveBeenCalledTimes(1);
  });
  it("reads only the exact project, key and project secret scope",async()=>{
    const {store,selectChain}=fixture();await store.find(input.projectId,input.key);
    const sql=new PgDialect().sqlToQuery(selectChain.where.mock.calls[0]![0]);
    expect(sql.params).toEqual([input.projectId,input.key,"project"]);expect(selectChain.limit).toHaveBeenCalledWith(2);
  });
  it("rejects ambiguous rows instead of choosing a credential",async()=>{
    const {store}=fixture([], [row,row]);await expect(store.find(input.projectId,input.key)).rejects.toThrow();
  });
  it("rejects raw values and wrong scope before any write",async()=>{
    const {store,db}=fixture();await expect(store.createIfAbsent({...input,value:"private-fixture"} as typeof input)).rejects.toThrow();
    await expect(store.createIfAbsent({...input,scope:"deployment"})).rejects.toThrow();expect(db.insert).not.toHaveBeenCalled();
  });
});
