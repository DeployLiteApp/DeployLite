import {expect,it} from "vitest";
import {managedDatabaseRuntimeExecutionDigest} from "./managed-database-runtime-binding.js";
import {managedDatabaseBackupExecutionDigest,managedDatabaseBackupSourceDigest} from "./managed-database-backup-binding.js";
import {composeRuntimeResourceName} from "./compose-preview.js";
import {digestControlInput} from "./control-plane.js";
import {selectManagedDatabaseRestoreInventory,managedDatabaseRestoreExecutionBinding,prepareManagedDatabaseRestoreConfirmation} from "./managed-database-restore-binding.js";
const engines=["postgres","mysql","mariadb","mongodb","redis"] as const;
function fixture(engine:typeof engines[number]="postgres"){
 const source={schemaVersion:1,projectId:"project-a",databaseId:"orders",engine,profileId:"profile-a",planDigest:"a".repeat(64),environmentFingerprint:"b".repeat(32)};
 const originalReceipt={...source,profileId:undefined,action:"database.runtime",agentId:"agent-a",commandId:"origin-a",inputDigest:managedDatabaseRuntimeExecutionDigest(source),correlationId:"origin-correlation",containerId:"c".repeat(64),imageId:"sha256:"+"d".repeat(64),volumeName:composeRuntimeResourceName(source.projectId,"volume","db-orders"),networkName:composeRuntimeResourceName(source.projectId,"network","db-orders"),networkId:"e".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",observedAt:1000,status:"ready",health:"passed",storage:"verified",idempotent:false,redacted:true};
 delete originalReceipt.profileId;
 const target={...source,originalReceipt,originalReplayFingerprint:"f".repeat(64)};
 const capture={...target,destinationId:"destination-a",maxBytes:1048576};
 const {status:_status,health:_health,inputDigest:_digest,correlationId:_correlation,...physical}=originalReceipt;
 const backupReceipt={...physical,profileId:source.profileId,action:"database.runtime.backup",commandId:"backup-a",originalCommandId:originalReceipt.commandId,inputDigest:managedDatabaseBackupExecutionDigest(capture),correlationId:"backup-correlation",observedAt:2000,destinationId:capture.destinationId,sourceDigest:managedDatabaseBackupSourceDigest(capture),volumeKey:"db-orders",archiveId:"backup_"+"a".repeat(32),archiveBytes:4,archiveSha256:"a".repeat(64),manifestSha256:"b".repeat(64),format:{postgres:"postgres-custom-gzip",mysql:"mysql-sql-gzip",mariadb:"mariadb-sql-gzip",mongodb:"mongodb-archive-gzip",redis:"volume-tar"}[engine],consistency:{postgres:"native-snapshot",mysql:"global-read-lock",mariadb:"global-read-lock",mongodb:"quiesced-writes",redis:"all-consumers-stopped"}[engine],status:"created",idempotent:false};
 const preparation={...target,backupReceipt,maxBytes:1048576};
 return {preparation,input:{preparation,actorId:"actor-a",idempotencyKey:"restore-once",correlationId:"restore-correlation",now:3000,commandTtlMs:10000}};
}
it.each(engines)("binds destructive %s restore intent to original source and immutable backup",engine=>{
 const f=fixture(engine),binding=managedDatabaseRestoreExecutionBinding(f.preparation),result=prepareManagedDatabaseRestoreConfirmation(f.input);
 expect(binding).toMatchObject({operation:"database.runtime.restore",action:"project.update",scope:{kind:"project",projectId:"project-a"},backupReceipt:f.preparation.backupReceipt});
 expect(result.command).toMatchObject({actorId:"actor-a",status:"pending_confirmation",inputDigest:digestControlInput(binding),expiresAt:new Date(13000)});
 expect(result.confirmation).toMatchObject({commandId:result.command.id,inputDigest:result.command.inputDigest,classification:"destructive",consumedAt:null});
 expect(result.command).not.toHaveProperty("projectExecutionAuthority");
});
it("refuses detached resource, scope, source proof, archive hashes and byte budget",()=>{
 const f=fixture();for(const patch of [{projectId:"foreign"},{databaseId:"foreign"},{containerId:"0".repeat(64)},{imageId:"sha256:"+"0".repeat(64)},{networkId:"0".repeat(64)},{volumeCreatedAt:"2026-10-09T00:00:00Z"},{sourceDigest:"0".repeat(64)},{archiveSha256:"invalid"},{archiveBytes:1048577}])expect(()=>managedDatabaseRestoreExecutionBinding({...f.preparation,backupReceipt:{...f.preparation.backupReceipt,...patch}})).toThrow();
 expect(()=>managedDatabaseRestoreExecutionBinding({...f.preparation,password:"private"})).toThrow();
});
it("binds every immutable archive and destination dimension into confirmation digest",()=>{
 const f=fixture(),base=digestControlInput(managedDatabaseRestoreExecutionBinding(f.preparation));
 for(const patch of [{archiveId:"backup_"+"0".repeat(32)},{archiveSha256:"0".repeat(64)},{manifestSha256:"0".repeat(64)},{destinationId:"destination-b"}])expect(digestControlInput(managedDatabaseRestoreExecutionBinding({...f.preparation,backupReceipt:{...f.preparation.backupReceipt,...patch}}))).not.toBe(base);
});
it("refuses future backup time, invalid expiry and injected authority before preparing confirmation",()=>{
 const f=fixture();for(const patch of [{now:1999},{commandTtlMs:0},{commandTtlMs:60001},{actorId:""},{projectExecutionAuthority:{}}])expect(()=>prepareManagedDatabaseRestoreConfirmation({...f.input,...patch})).toThrow();
});

it("selects the immutable archive from server inventory twice before producing restore intent",async()=>{
 const f=fixture(),{backupReceipt,...source}=f.preparation;let reads=0;
 const selection={...source,archiveId:backupReceipt.archiveId,destinationId:backupReceipt.destinationId,expectedArchiveSha256:backupReceipt.archiveSha256,expectedManifestSha256:backupReceipt.manifestSha256};
 const record={schemaVersion:1 as const,receipt:backupReceipt,createdAtMs:2000};
 const selected=await selectManagedDatabaseRestoreInventory(selection,{expectedAgentId:"agent-a",clock:{now:()=>3000},inventory:{available:()=>true,list:async(project,volume,destination)=>{reads++;expect([project,volume,destination]).toEqual(["project-a","db-orders","destination-a"]);return [record] as any;}}});
 expect(selected).toEqual(managedDatabaseRestoreExecutionBinding(f.preparation));expect(reads).toBe(2);
});
it("refuses archive changes between inventory observations",async()=>{
 const f=fixture(),{backupReceipt,...source}=f.preparation;let reads=0;
 const selection={...source,archiveId:backupReceipt.archiveId,destinationId:backupReceipt.destinationId,expectedArchiveSha256:backupReceipt.archiveSha256,expectedManifestSha256:backupReceipt.manifestSha256};
 await expect(selectManagedDatabaseRestoreInventory(selection,{expectedAgentId:"agent-a",clock:{now:()=>3000},inventory:{available:()=>true,list:async()=>[{schemaVersion:1,receipt:{...backupReceipt,archiveSha256:reads++===0?backupReceipt.archiveSha256:"0".repeat(64)},createdAtMs:2000}] as any}})).rejects.toThrow();
});
