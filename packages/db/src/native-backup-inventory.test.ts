import {expect,it} from "vitest";
import {PgDialect} from "drizzle-orm/pg-core";
import {DbBackupInventoryStore} from "./repositories/backup-inventory.js";
import {controlCommands,auditEvents} from "./schema.js";
import type {DeployLiteDb} from "./client.js";
function fixture() {
  const receipt={schemaVersion:1,projectId:"project-a",databaseId:"orders",engine:"postgres",action:"database.runtime.backup",agentId:"agent-a",commandId:"backup-a",originalCommandId:"origin-a",profileId:"profile-a",inputDigest:"a".repeat(64),planDigest:"a".repeat(64),environmentFingerprint:"b".repeat(32),correlationId:"correlation-a",containerId:"c".repeat(64),imageId:"sha256:"+"d".repeat(64),volumeName:"dl-"+"b".repeat(32)+"-vol-db-orders",networkName:"dl-"+"b".repeat(32)+"-net-db-orders",networkId:"e".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",observedAt:1000,volumeKey:"db-orders",destinationId:"destination-a",sourceDigest:"f".repeat(64),archiveId:"backup_"+"a".repeat(32),archiveBytes:4,archiveSha256:"a".repeat(64),manifestSha256:"b".repeat(64),format:"postgres-custom-gzip",consistency:"native-snapshot",status:"created",idempotent:false,storage:"verified",redacted:true};
  const command={id:receipt.commandId,actorUserId:"actor-a",action:"project.update",scopeKind:"project",scopeKey:receipt.projectId,status:"completed",inputDigest:receipt.inputDigest,correlationId:receipt.correlationId};
  const audit={id:"audit-a",actorUserId:command.actorUserId,action:"database.runtime.backup.executed",targetType:"project",targetId:receipt.projectId,correlationId:receipt.correlationId,createdAt:new Date(1500),metadata:{...receipt}};
  let saved:Record<string,unknown>|undefined,inserts=0;
  const filters:unknown[][]=[];
  const queries={select(){return {from(table:unknown){
    const rows=table===controlCommands?[command]:table===auditEvents?[audit]:saved?[saved]:[];
    const query={where(condition:Parameters<PgDialect["sqlToQuery"]>[0]){filters.push(new PgDialect().sqlToQuery(condition).params);return query;},limit(){return query;},for(){return query;},orderBy(){return query;},then(resolve:(rows:unknown[])=>unknown){return Promise.resolve(rows).then(resolve);}};
    return query;
  }};},insert(){return {values(value:Record<string,unknown>){inserts++;return {onConflictDoNothing(){return {returning:async()=>{if(saved)return [];saved=structuredClone(value);return [saved];}};}};}};}};
  const db={...queries,transaction:async(run:(tx:typeof queries)=>Promise<unknown>)=>run(queries)} as unknown as DeployLiteDb;
  return {receipt,command,audit,filters,store:()=>new DbBackupInventoryStore(db,"agent-a",()=>2000),saved:()=>saved,inserts:()=>inserts};
}
it("persists native evidence in the existing inventory and reopens the same project/volume/destination scope",async()=>{
  const f=fixture(),record=await f.store().recordAuthenticatedReceipt(f.receipt);
  expect(await f.store().list("project-a","db-orders","destination-a")).toEqual([record]);
  expect(f.filters.at(-1)).toEqual(["project-a","db-orders","destination-a"]);
  expect(f.saved()).toMatchObject({receipt:f.receipt,createdAt:new Date(1500)});
  expect(f.filters.some(values=>values.includes("database.runtime.backup.executed"))).toBe(true);
});
it("normalizes authenticated native replay to the original audit time/evidence without overwriting",async()=>{
  const f=fixture(),record=await f.store().recordAuthenticatedReceipt(f.receipt);
  expect(await f.store().recordAuthenticatedReceipt({...f.receipt,status:"already-created",idempotent:true})).toEqual(record);
  expect(f.saved()).toMatchObject({receipt:f.receipt,createdAt:new Date(1500)});
});
it("refuses detached native source metadata and foreign agent before an inventory insert",async()=>{
  for(const field of ["sourceDigest","databaseId","format"]){const f=fixture();Object.assign(f.audit.metadata,{[field]:"foreign"});await expect(f.store().recordAuthenticatedReceipt(f.receipt)).rejects.toThrow();expect(f.inserts()).toBe(0);}
  const f=fixture();await expect(f.store().recordAuthenticatedReceipt({...f.receipt,agentId:"foreign"})).rejects.toThrow();expect(f.inserts()).toBe(0);
});
