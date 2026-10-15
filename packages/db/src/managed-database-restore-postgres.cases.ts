import {randomUUID} from "node:crypto";
import {expect,it} from "vitest";
import type pg from "pg";
import {managedDatabaseRuntimeReceiptSchema,managedDatabaseBackupReceiptSchema,managedDatabaseRestoreReceiptQuerySchema,managedDatabaseRestoreReceiptSchema} from "@deploylite/contracts";
import {composeRuntimeResourceName,managedDatabaseRuntimeExecutionDigest,managedDatabaseBackupExecutionDigest,managedDatabaseBackupSourceDigest,prepareManagedDatabaseRestoreConfirmation} from "@deploylite/domain";
import {createDbClient,createDbPool,closeDbPool} from "./client.js";
import {DbControlCommandRepository} from "./repositories/control-plane.js";
/** Actual SQL confirmation/completion persistence, synthetic resource metadata only; never a Docker restore claim. */
export function defineManagedDatabaseRestoreCompletionCases(getPool:()=>pg.Pool,getUrl:()=>string){
 const controls=(pool=getPool(),fault?: (stage:string)=>void)=>new DbControlCommandRepository(createDbClient(pool),fault);
 async function prepare(engine:"postgres"|"mysql"|"mariadb"|"mongodb"|"redis"="postgres"){
  const projectId=randomUUID(),actorId=randomUUID(),now=Date.now();
  await getPool().query("INSERT INTO users(id,email,email_normalized,password_hash,role_id) SELECT $1,$2,$2,'fixture',id FROM roles WHERE name='admin'",[actorId,`${actorId}@example.test`]);
  await getPool().query("INSERT INTO projects(id,name,repo_url,default_branch) VALUES($1,'Restore metadata fixture','https://example.test/repo','main')",[projectId]);
  const base={schemaVersion:1 as const,projectId,databaseId:"orders",engine,profileId:"profile1",planDigest:"a".repeat(64),environmentFingerprint:"b".repeat(32)};
 const {profileId:_profile,...originalBase}=base;
 const original=managedDatabaseRuntimeReceiptSchema.parse({...originalBase,action:"database.runtime",agentId:"agent1",commandId:"create1",inputDigest:managedDatabaseRuntimeExecutionDigest(base),correlationId:"create-correlation",containerId:"c".repeat(64),imageId:"sha256:"+"d".repeat(64),volumeName:composeRuntimeResourceName(base.projectId,"volume","db-orders"),networkName:composeRuntimeResourceName(base.projectId,"network","db-orders"),networkId:"e".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",observedAt:500,status:"ready",storage:"verified",health:"passed",idempotent:false,redacted:true});
 const source={...base,originalReceipt:original,originalReplayFingerprint:"f".repeat(64)},capture={...source,destinationId:"destination1",maxBytes:1048576};
 const {status:_status,health:_health,inputDigest:_digest,correlationId:_correlation,...physical}=original;
 const backup=managedDatabaseBackupReceiptSchema.parse({...physical,profileId:base.profileId,action:"database.runtime.backup",commandId:"backup1",originalCommandId:original.commandId,inputDigest:managedDatabaseBackupExecutionDigest(capture),correlationId:"backup-correlation",observedAt:2000,destinationId:capture.destinationId,sourceDigest:managedDatabaseBackupSourceDigest(capture),volumeKey:"db-orders",archiveId:"backup_"+"a".repeat(32),archiveBytes:4,archiveSha256:"a".repeat(64),manifestSha256:"b".repeat(64),format:{postgres:"postgres-custom-gzip",mysql:"mysql-sql-gzip",mariadb:"mariadb-sql-gzip",mongodb:"mongodb-archive-gzip",redis:"volume-tar"}[engine],consistency:{postgres:"native-snapshot",mysql:"global-read-lock",mariadb:"global-read-lock",mongodb:"quiesced-writes",redis:"all-consumers-stopped"}[engine],status:"created",idempotent:false});

  const preparation={...source,backupReceipt:backup,maxBytes:capture.maxBytes},intent=prepareManagedDatabaseRestoreConfirmation({preparation,actorId,idempotencyKey:randomUUID(),correlationId:randomUUID(),now,commandTtlMs:60000});
  const repository=controls(),resolved=await repository.resolve(intent.command),nonce=await repository.resolveProjectUpdateConfirmation(resolved.command,new Date(now));expect(nonce).not.toBeNull();
  const claimed=await repository.claimConfirmedProjectUpdate(resolved.command,nonce!,new Date(now)),authority=claimed.authority!;expect(claimed.claimed).toBe(true);
  const query=managedDatabaseRestoreReceiptQuerySchema.parse({...preparation,action:"database.runtime.restore",operation:"database.runtime.restore",confirmationId:nonce!.id,agentId:"agent1",commandId:claimed.command.id,inputDigest:claimed.command.inputDigest,idempotencyKey:claimed.command.idempotencyKey,requiredCapabilities:["database.runtime.restore.v1"],authority,lease:authority.projectLease,context:{requestId:randomUUID(),correlationId:claimed.command.correlationId},timeoutMs:1000});
  const receipt=managedDatabaseRestoreReceiptSchema.parse({...base,action:query.action,agentId:query.agentId,commandId:query.commandId,inputDigest:query.inputDigest,originalCommandId:original.commandId,backupCommandId:backup.commandId,confirmationId:nonce!.id,correlationId:query.context.correlationId,containerId:original.containerId,imageId:original.imageId,volumeName:original.volumeName,networkName:original.networkName,networkId:original.networkId,volumeCreatedAt:original.volumeCreatedAt,archiveId:backup.archiveId,archiveBytes:backup.archiveBytes,archiveSha256:backup.archiveSha256,manifestSha256:backup.manifestSha256,format:backup.format,observedAt:now+1,status:"restored",storage:"original",health:"passed",redacted:true});
  return {command:claimed.command,query,receipt,now:now+2,audit:{actorUserId:actorId,action:"database.runtime.restored",targetType:"project",targetId:projectId,requestId:query.context.requestId,correlationId:query.context.correlationId,metadata:{receipt,redacted:true}}};
 }
 it("converges five-engine confirmed restore metadata completion and original receipt across a fresh pool",async()=>{
  for(const engine of ["postgres","mysql","mariadb","mongodb","redis"] as const){
   const input=await prepare(engine),before=(await getPool().query("SELECT * FROM control_command_confirmations WHERE command_id=$1",[input.command.id])).rows;
   expect(before).toHaveLength(1);expect(before[0].consumed_at).toBeInstanceOf(Date);
   const results=await Promise.all([controls().completeManagedDatabaseRestore({...input,now:input.query.lease.expiresAt+1}),controls().completeManagedDatabaseRestore({...input,now:input.query.lease.expiresAt+1})]);expect(results[1]).toEqual(results[0]);expect(results[0].result).toEqual(input.receipt);
   const fresh=createDbPool(getUrl(),{max:1});try{expect(await controls(fresh).completeManagedDatabaseRestore({...input,now:input.query.lease.expiresAt+1})).toEqual(results[0]);}finally{await closeDbPool(fresh);}
   expect((await getPool().query("SELECT * FROM control_command_confirmations WHERE command_id=$1",[input.command.id])).rows).toEqual(before);
   const events=(await getPool().query("SELECT * FROM audit_events WHERE target_id=$1 AND action='database.runtime.restored'",[input.query.projectId])).rows;expect(events).toHaveLength(1);expect(events[0].correlation_id).toBe(input.query.context.correlationId);expect(events[0].metadata.receipt.containerId).toBe("[REDACTED]");
  }
 });
 it("rolls back restore completion audit and refuses unconsumed original nonce without ledger changes",async()=>{
  const input=await prepare(),before=(await getPool().query("SELECT * FROM control_commands WHERE id=$1",[input.command.id])).rows;
  await expect(controls(getPool(),stage=>{if(stage==="command-completed")throw new Error("restore transaction fault");}).completeManagedDatabaseRestore(input)).rejects.toThrow("restore transaction fault");
  expect((await getPool().query("SELECT * FROM control_commands WHERE id=$1",[input.command.id])).rows).toEqual(before);
  expect((await getPool().query("SELECT count(*)::int AS count FROM audit_events WHERE target_id=$1 AND action='database.runtime.restored'",[input.query.projectId])).rows[0].count).toBe(0);
  await getPool().query("UPDATE control_command_confirmations SET consumed_at=NULL WHERE command_id=$1",[input.command.id]);
  await expect(controls().completeManagedDatabaseRestore(input)).rejects.toThrow();
  expect((await getPool().query("SELECT * FROM control_commands WHERE id=$1",[input.command.id])).rows).toEqual(before);
 });
}
