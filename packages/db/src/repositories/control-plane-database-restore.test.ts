import {expect,it} from "vitest";
import {managedDatabaseRuntimeReceiptSchema,managedDatabaseBackupReceiptSchema,managedDatabaseRestoreReceiptQuerySchema,managedDatabaseRestoreReceiptSchema} from "@deploylite/contracts";
import {composeRuntimeResourceName,managedDatabaseRuntimeExecutionDigest,managedDatabaseBackupExecutionDigest,managedDatabaseBackupSourceDigest,managedDatabaseRestoreExecutionDigest} from "@deploylite/domain";
import {fixture} from "./control-plane-project-confirmation.fixture.js";
const engines=["postgres","mysql","mariadb","mongodb","redis"] as const;
async function restoration(engine:typeof engines[number]="postgres"){
 const f=fixture(),base={schemaVersion:1 as const,projectId:"project1",databaseId:"orders",engine,profileId:"profile1",planDigest:"a".repeat(64),environmentFingerprint:"b".repeat(32)};
 const {profileId:_profile,...originalBase}=base;
 const original=managedDatabaseRuntimeReceiptSchema.parse({...originalBase,action:"database.runtime",agentId:"agent1",commandId:"create1",inputDigest:managedDatabaseRuntimeExecutionDigest(base),correlationId:"create-correlation",containerId:"c".repeat(64),imageId:"sha256:"+"d".repeat(64),volumeName:composeRuntimeResourceName(base.projectId,"volume","db-orders"),networkName:composeRuntimeResourceName(base.projectId,"network","db-orders"),networkId:"e".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",observedAt:500,status:"ready",storage:"verified",health:"passed",idempotent:false,redacted:true});
 const source={...base,originalReceipt:original,originalReplayFingerprint:"f".repeat(64)},capture={...source,destinationId:"destination1",maxBytes:1048576};
 const {status:_status,health:_health,inputDigest:_digest,correlationId:_correlation,...physical}=original;
 const backup=managedDatabaseBackupReceiptSchema.parse({...physical,profileId:base.profileId,action:"database.runtime.backup",commandId:"backup1",originalCommandId:original.commandId,inputDigest:managedDatabaseBackupExecutionDigest(capture),correlationId:"backup-correlation",observedAt:2000,destinationId:capture.destinationId,sourceDigest:managedDatabaseBackupSourceDigest(capture),volumeKey:"db-orders",archiveId:"backup_"+"a".repeat(32),archiveBytes:4,archiveSha256:"a".repeat(64),manifestSha256:"b".repeat(64),format:{postgres:"postgres-custom-gzip",mysql:"mysql-sql-gzip",mariadb:"mariadb-sql-gzip",mongodb:"mongodb-archive-gzip",redis:"volume-tar"}[engine],consistency:{postgres:"native-snapshot",mysql:"global-read-lock",mariadb:"global-read-lock",mongodb:"quiesced-writes",redis:"all-consumers-stopped"}[engine],status:"created",idempotent:false});
 const preparation={...source,backupReceipt:backup,maxBytes:capture.maxBytes},inputDigest=managedDatabaseRestoreExecutionDigest(preparation);f.command.inputDigest=inputDigest;f.row.inputDigest=inputDigest;
 const nonce=f.seed(),claimed=await f.repository().claimConfirmedProjectUpdate(f.command,nonce,new Date(3000)),authority=claimed.authority!;
 const query=managedDatabaseRestoreReceiptQuerySchema.parse({...preparation,action:"database.runtime.restore",operation:"database.runtime.restore",confirmationId:nonce.id,agentId:"agent1",commandId:f.command.id,inputDigest,idempotencyKey:f.command.idempotencyKey,requiredCapabilities:["database.runtime.restore.v1"],authority,lease:authority.projectLease,context:{requestId:"restore-request",correlationId:f.command.correlationId},timeoutMs:1000});
 const receipt=managedDatabaseRestoreReceiptSchema.parse({...base,action:query.action,agentId:query.agentId,commandId:query.commandId,inputDigest,originalCommandId:original.commandId,backupCommandId:backup.commandId,confirmationId:nonce.id,correlationId:query.context.correlationId,containerId:original.containerId,imageId:original.imageId,volumeName:original.volumeName,networkName:original.networkName,networkId:original.networkId,volumeCreatedAt:original.volumeCreatedAt,archiveId:backup.archiveId,archiveBytes:backup.archiveBytes,archiveSha256:backup.archiveSha256,manifestSha256:backup.manifestSha256,format:backup.format,observedAt:3100,status:"restored",storage:"original",health:"passed",redacted:true});
 const input={command:claimed.command,query,receipt,now:3200,audit:{actorUserId:f.command.actorId,action:"database.runtime.restored",targetType:"project",targetId:base.projectId,requestId:"restore-request",correlationId:f.command.correlationId,metadata:{receipt,redacted:true}}};
 return {...f,nonce,input};
}
it.each(engines)("atomically completes %s original confirmed restore and one redacted audit, recovering immutable receipt after expiry",async engine=>{
 const f=await restoration(engine),approvals=structuredClone(f.confirmations),accepted=structuredClone(f.audits);
 const result=await f.repository().completeManagedDatabaseRestore(f.input);
 expect(result).toMatchObject({id:f.command.id,status:"completed",result:f.input.receipt});expect(f.confirmations).toEqual(approvals);expect(f.audits).toEqual(accepted);expect(f.events).toHaveLength(1);expect(f.events[0]!.metadata.receipt.containerId).toBe("[REDACTED]");
 const before=structuredClone(f.row),again=await f.repository().completeManagedDatabaseRestore({...f.input,now:9000});expect(again).toEqual(result);expect(f.row).toEqual(before);expect(f.events).toHaveLength(1);
});
it("rolls back both command completion and audit on transaction fault, preserving consumed approval",async()=>{
 const f=await restoration(),before=structuredClone(f.row),approvals=structuredClone(f.confirmations);
 await expect(f.repository(stage=>{if(stage==="command-completed")throw new Error("restore completion rollback");}).completeManagedDatabaseRestore(f.input)).rejects.toThrow("restore completion rollback");
 expect(f.row).toEqual(before);expect(f.confirmations).toEqual(approvals);expect(f.events).toHaveLength(0);
});
it.each(["source","archive","approval","audit","future","expiry","nonce","superseded","digest","correlation","idempotency","stored-authority"])("refuses detached %s completion without receipt or audit write",async mode=>{
 const f=await restoration(),input=structuredClone(f.input);
 if(mode==="source")input.receipt.containerId="0".repeat(64);if(mode==="archive")input.receipt.archiveSha256="0".repeat(64);if(mode==="approval")input.query.confirmationId="foreign";if(mode==="audit")input.audit.actorUserId="foreign";
 if(mode==="future")input.now=3099;if(mode==="expiry"){input.now=8000;input.receipt.observedAt=8000;}if(mode==="nonce")f.confirmations[0]!.consumedAt=null;
 if(mode==="superseded")f.related.push({...f.row,id:"successor",executionAuthority:{...input.query.authority,commandId:"successor",projectLease:{...input.query.lease,fence:3}}});
 if(mode==="digest")f.row.inputDigest="0".repeat(64);if(mode==="correlation")f.row.correlationId="foreign";if(mode==="idempotency")f.row.idempotencyKey="foreign";if(mode==="stored-authority")f.row.executionAuthority={...input.query.authority,projectLease:{...input.query.lease,fence:3}};
 await expect(f.repository().completeManagedDatabaseRestore(input)).rejects.toThrow();expect(f.row.status).toBe("dispatching");expect(f.row.result).toBeNull();expect(f.events).toHaveLength(0);
});
it("rejects altered stored completion without replacing original result or adding an audit",async()=>{
 const f=await restoration();await f.repository().completeManagedDatabaseRestore(f.input);f.row.result={...f.input.receipt,confirmationId:"foreign"};
 await expect(f.repository().completeManagedDatabaseRestore(f.input)).rejects.toThrow();expect(f.row.result.confirmationId).toBe("foreign");expect(f.events).toHaveLength(1);
});

it.each(["before-consumption","request"])("rejects receipt detached from consumed time or current audit %s",async mode=>{
 const f=await restoration(),input=structuredClone(f.input);
 if(mode==="before-consumption")input.receipt.observedAt=2999;
 else input.audit.requestId="foreign-request";
 await expect(f.repository().completeManagedDatabaseRestore(input)).rejects.toThrow();
 expect(f.row.status).toBe("dispatching");expect(f.events).toHaveLength(0);
});

it("recovers a dispatching command from its in-lease original receipt after lease expiry without renewal",async()=>{
 const f=await restoration(),approvals=structuredClone(f.confirmations),authority=structuredClone(f.row.executionAuthority);
 const completed=await f.repository().completeManagedDatabaseRestore({...f.input,now:9000});
 expect(completed.status).toBe("completed");expect(completed.result).toEqual(f.input.receipt);
 expect(f.confirmations).toEqual(approvals);expect(f.row.executionAuthority).toEqual(authority);expect(f.events).toHaveLength(1);
});
