import {prepareVerifiedManagedDatabaseRestoreConfirmation} from "./managed-database-verified-restore.js";
import {expect,it,vi} from "vitest";
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

function verifiedFixture(engine:typeof engines[number]="postgres") {
 const f=fixture(engine),{backupReceipt,...source}=f.preparation;
 const selection={...source,archiveId:backupReceipt.archiveId,destinationId:backupReceipt.destinationId,expectedArchiveSha256:backupReceipt.archiveSha256,expectedManifestSha256:backupReceipt.manifestSha256};
 const record={schemaVersion:1 as const,receipt:backupReceipt,createdAtMs:2000};
 const view={archiveId:backupReceipt.archiveId,archiveBytes:backupReceipt.archiveBytes,archiveSha256:backupReceipt.archiveSha256,manifestSha256:backupReceipt.manifestSha256,format:backupReceipt.format,integrity:"verified",redacted:true};
 const ports={expectedAgentId:"agent-a",inventory:{available:()=>true,list:vi.fn(async()=>[record] as any)},archive:{verify:vi.fn(async(_preparation:unknown,_signal:AbortSignal)=>({...view}))},clock:{now:()=>3000},maxDurationMs:1000};
 const request={selection,actorId:f.input.actorId,idempotencyKey:f.input.idempotencyKey,correlationId:f.input.correlationId,commandTtlMs:f.input.commandTtlMs};
 return {...f,selection,record,view,ports,request};
}
it.each(engines)("prepares verified %s intent after fresh archive and inventory observations",async engine=>{
 const f=verifiedFixture(engine),result=await prepareVerifiedManagedDatabaseRestoreConfirmation(f.request,f.ports);
 expect(result.preparation).toEqual(f.preparation);expect(result.command).toMatchObject({status:"pending_confirmation",inputDigest:digestControlInput(managedDatabaseRestoreExecutionBinding(f.preparation)),expiresAt:new Date(13000)});
 expect(result.confirmation).toMatchObject({commandId:result.command.id,classification:"destructive",consumedAt:null});
 expect(f.ports.inventory.list).toHaveBeenCalledTimes(4);expect(f.ports.archive.verify).toHaveBeenCalledTimes(2);
 for(const call of f.ports.archive.verify.mock.calls){expect(call[0]).toEqual(f.preparation);expect(call[1]).toBeInstanceOf(AbortSignal);}
 expect(result).not.toHaveProperty("projectExecutionAuthority");expect(result.command).not.toHaveProperty("projectExecutionAuthority");
});
it.each([{archiveSha256:"0".repeat(64)},{manifestSha256:"0".repeat(64)},{archiveId:"backup_"+"0".repeat(32)},{archiveBytes:1},{format:"volume-tar"},{integrity:"pending"},{redacted:false},{privatePath:"private-fixture"}])("rejects detached archive observation before confirmation $integrity",async patch=>{
 const f=verifiedFixture();f.ports.archive.verify.mockImplementation(async()=>({...f.view,...patch}) as any);
 await expect(prepareVerifiedManagedDatabaseRestoreConfirmation(f.request,f.ports)).rejects.toThrow("Verified database restore confirmation is unavailable.");
 expect(f.ports.inventory.list).toHaveBeenCalledTimes(2);
});
it("rejects a selected archive that changes during private verification",async()=>{
 const f=verifiedFixture();f.ports.archive.verify.mockImplementation(async()=>{f.record.receipt.archiveSha256="0".repeat(64);return {...f.view};});
 await expect(prepareVerifiedManagedDatabaseRestoreConfirmation(f.request,f.ports)).rejects.toThrow("Verified database restore confirmation is unavailable.");expect(f.ports.archive.verify).toHaveBeenCalledTimes(1);
});
it("rejects a second integrity refusal after fresh inventory without reflecting private diagnostics",async()=>{
 const f=verifiedFixture();f.ports.archive.verify.mockResolvedValueOnce({...f.view});f.ports.archive.verify.mockImplementation(async()=>{throw new Error("private-password-fixture");});
 await expect(prepareVerifiedManagedDatabaseRestoreConfirmation(f.request,f.ports)).rejects.toThrow("Verified database restore confirmation is unavailable.");expect(f.ports.inventory.list).toHaveBeenCalledTimes(4);
});
it("rejects getters and extra symbols without evaluating private observation accessors",async()=>{
 const f=verifiedFixture(),getter=vi.fn(()=>"private-fixture"),view={...f.view};Object.defineProperty(view,"archiveSha256",{get:getter});f.ports.archive.verify.mockResolvedValue(view);
 await expect(prepareVerifiedManagedDatabaseRestoreConfirmation(f.request,f.ports)).rejects.toThrow("Verified database restore confirmation is unavailable.");expect(getter).not.toHaveBeenCalled();
 const g=verifiedFixture();g.ports.archive.verify.mockResolvedValue({...g.view,[Symbol("private")]:"private-fixture"});await expect(prepareVerifiedManagedDatabaseRestoreConfirmation(g.request,g.ports)).rejects.toThrow("Verified database restore confirmation is unavailable.");
});
it("bounds a never-settling inventory read and propagates cancellation to the archive reader",async()=>{
 const f=verifiedFixture();f.ports.inventory.list.mockImplementation(()=>new Promise(()=>{}));
 await expect(prepareVerifiedManagedDatabaseRestoreConfirmation(f.request,{...f.ports,maxDurationMs:10})).rejects.toThrow("Verified database restore confirmation is unavailable.");expect(f.ports.archive.verify).not.toHaveBeenCalled();
 const g=verifiedFixture(),controller=new AbortController();g.ports.archive.verify.mockImplementation(async(_preparation,signal)=>{expect(signal.aborted).toBe(false);controller.abort();return {...g.view};});
 await expect(prepareVerifiedManagedDatabaseRestoreConfirmation(g.request,g.ports,controller.signal)).rejects.toThrow("Verified database restore confirmation is unavailable.");expect(g.ports.archive.verify.mock.calls[0]![1].aborted).toBe(true);
},2000);
it.each([0,60001,1.2])("refuses unusable workflow deadline %s before any reads",async maxDurationMs=>{
 const f=verifiedFixture();await expect(prepareVerifiedManagedDatabaseRestoreConfirmation(f.request,{...f.ports,maxDurationMs})).rejects.toThrow("Verified database restore confirmation is unavailable.");expect(f.ports.inventory.list).not.toHaveBeenCalled();
});
it("rejects a replaced archive port during preparation",async()=>{
 const f=verifiedFixture();f.ports.archive.verify.mockImplementation(async()=>{f.ports.archive.verify=vi.fn(async(_preparation:unknown,_signal:AbortSignal)=>({...f.view}));return {...f.view};});
 await expect(prepareVerifiedManagedDatabaseRestoreConfirmation(f.request,f.ports)).rejects.toThrow("Verified database restore confirmation is unavailable.");
});
it("rejects a cancelled input before reading inventory",async()=>{
 const f=verifiedFixture(),signal=new AbortController();signal.abort();await expect(prepareVerifiedManagedDatabaseRestoreConfirmation(f.request,f.ports,signal.signal)).rejects.toThrow("Verified database restore confirmation is unavailable.");expect(f.ports.inventory.list).not.toHaveBeenCalled();
});

it("refuses an intent whose own short expiry elapses before it can be returned",async()=>{
 const f=verifiedFixture();let now=3000;f.ports.clock.now=()=>now++;
 await expect(prepareVerifiedManagedDatabaseRestoreConfirmation({...f.request,commandTtlMs:1},f.ports)).rejects.toThrow("Verified database restore confirmation is unavailable.");
});
