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

import {managedDatabaseRestoreArchiveSourceBinding,managedDatabaseRestoreArchiveObservationMatches} from "./managed-database-restore-archive-binding.js";
import {managedDatabaseRestoreExecutionDigest} from "./managed-database-restore-binding.js";
function archiveChannelFixture(engine:typeof engines[number]="postgres") {
 const {preparation}=fixture(engine);
 const query={...preparation,action:"database.runtime.restore.archive",agentId:"agent-a",requiredCapabilities:["database.runtime.restore.archive.v1"],context:{requestId:"request-a",correlationId:"correlation-a"},timeoutMs:1000};
 const backup=query.backupReceipt;
 const observation={schemaVersion:1,action:query.action,agentId:query.agentId,projectId:query.projectId,databaseId:query.databaseId,engine,
  inputDigest:managedDatabaseRestoreExecutionDigest(preparation),context:query.context,observedAt:3001,
  archiveId:backup.archiveId,archiveBytes:backup.archiveBytes,archiveSha256:backup.archiveSha256,manifestSha256:backup.manifestSha256,format:backup.format,integrity:"verified",redacted:true};
 return {query,observation};
}
it.each(engines)("binds the %s archive channel to original source and current request without authority",engine=>{
 const f=archiveChannelFixture(engine);expect(()=>managedDatabaseRestoreArchiveSourceBinding(f.query)).not.toThrow();
 expect(managedDatabaseRestoreArchiveSourceBinding(f.query)).toEqual(f.query);
 expect(managedDatabaseRestoreArchiveObservationMatches(f.query,f.observation,3000,3002)).toBe(true);
 expect(f.observation).not.toHaveProperty("path");expect(f.observation).not.toHaveProperty("projectExecutionAuthority");
});
it.each([
 {agentId:"foreign"},{projectId:"foreign"},{databaseId:"foreign"},{engine:"redis"},{inputDigest:"0".repeat(64)},
 {context:{requestId:"other",correlationId:"correlation-a"}},{context:{requestId:"request-a",correlationId:"other"}},
 {archiveId:"backup_"+"0".repeat(32)},{archiveBytes:5},{archiveSha256:"0".repeat(64)},{manifestSha256:"0".repeat(64)},
 {format:"mysql-sql-gzip"},{integrity:"unknown"},{redacted:false},{observedAt:2999},{observedAt:3003},
 {path:"private-fixture"},{bytes:"private-fixture"},{projectExecutionAuthority:{}},{context:{requestId:"request-a",correlationId:"correlation-a",secret:"private"}}
])("refuses detached or private archive observation %j",patch=>{
 const f=archiveChannelFixture();expect(managedDatabaseRestoreArchiveObservationMatches(f.query,{...f.observation,...patch},3000,3002)).toBe(false);
});
it.each([[1999,2001],[3000,2999],[3000,4000],[3000,3001.5],[NaN,3002]])("refuses invalid archive observation time fence %s/%s",(before,after)=>{
 const f=archiveChannelFixture();expect(managedDatabaseRestoreArchiveObservationMatches(f.query,f.observation,before,after)).toBe(false);
});
it.each([{agentId:"foreign"},{requiredCapabilities:[]},{requiredCapabilities:["database.runtime.restore.archive.v1","extra"]},
 {timeoutMs:0},{timeoutMs:60001},{action:"database.runtime.restore"},{password:"private"},{projectExecutionAuthority:{}}])("refuses archive query authority or invalid source %j",patch=>{
 const f=archiveChannelFixture();expect(()=>managedDatabaseRestoreArchiveSourceBinding({...f.query,...patch})).toThrow("Restore archive source is unavailable.");
});
it("refuses changed original resource and archive binding",()=>{
 const f=archiveChannelFixture();
 expect(()=>managedDatabaseRestoreArchiveSourceBinding({...f.query,backupReceipt:{...f.query.backupReceipt,containerId:"0".repeat(64)}})).toThrow("Restore archive source is unavailable.");
 expect(()=>managedDatabaseRestoreArchiveSourceBinding({...f.query,backupReceipt:{...f.query.backupReceipt,archiveBytes:f.query.maxBytes+1}})).toThrow("Restore archive source is unavailable.");
});

import {managedDatabaseRestoreAgentCommandSchema,managedDatabaseRestoreReceiptQuerySchema,managedDatabaseRestoreReceiptSchema,managedDatabaseRestoreCachedReceiptSchema} from "@deploylite/contracts";
import {managedDatabaseRestoreReceiptMatches,managedDatabaseRestoreReplayFingerprint} from "./managed-database-restore-receipt-binding.js";
function restoreReceiptFixture(engine:typeof engines[number]="postgres"){
 const {preparation,input}=fixture(engine),intent=prepareManagedDatabaseRestoreConfirmation(input),command=intent.command,original=preparation.originalReceipt,backup=preparation.backupReceipt;
 const authority={schemaVersion:1,projectId:preparation.projectId,commandId:command.id,action:"project.update",inputDigest:command.inputDigest,projectLease:{leaseId:"restore-lease",projectId:preparation.projectId,fence:1,expiresAt:command.expiresAt.getTime()}};
 const query={...preparation,action:"database.runtime.restore",operation:"database.runtime.restore",confirmationId:intent.confirmation.id,agentId:"agent-a",commandId:command.id,inputDigest:command.inputDigest,idempotencyKey:command.idempotencyKey,requiredCapabilities:["database.runtime.restore.v1"],authority,lease:authority.projectLease,context:{requestId:"restore-request",correlationId:command.correlationId},timeoutMs:10000};
 const receipt={schemaVersion:1,projectId:preparation.projectId,databaseId:preparation.databaseId,engine,profileId:preparation.profileId,action:query.action,agentId:query.agentId,commandId:query.commandId,originalCommandId:original.commandId,backupCommandId:backup.commandId,confirmationId:query.confirmationId,inputDigest:query.inputDigest,planDigest:preparation.planDigest,environmentFingerprint:preparation.environmentFingerprint,correlationId:query.context.correlationId,
  containerId:original.containerId,imageId:original.imageId,volumeName:original.volumeName,networkName:original.networkName,networkId:original.networkId,volumeCreatedAt:original.volumeCreatedAt,
  archiveId:backup.archiveId,archiveBytes:backup.archiveBytes,archiveSha256:backup.archiveSha256,manifestSha256:backup.manifestSha256,format:backup.format,observedAt:3000,status:"restored",storage:"original",health:"passed",redacted:true};
 const cache={schemaVersion:1,action:query.action,agentId:query.agentId,commandId:query.commandId,confirmationId:query.confirmationId,correlationId:query.context.correlationId,receipt};
 return {query,receipt,cache,intent};
}
it.each(engines)("accepts strict %s restore command and immutable correlated receipt grammar without issuing authority",engine=>{
 const f=restoreReceiptFixture(engine);expect(managedDatabaseRestoreAgentCommandSchema.safeParse({...f.query,cancellationRequested:false}).success).toBe(true);
 expect(managedDatabaseRestoreReceiptQuerySchema.safeParse(f.query).success).toBe(true);expect(managedDatabaseRestoreReceiptSchema.safeParse(f.receipt).success).toBe(true);expect(managedDatabaseRestoreCachedReceiptSchema.safeParse(f.cache).success).toBe(true);
 expect(f.intent.confirmation.consumedAt).toBeNull();expect(f.intent.command).not.toHaveProperty("projectExecutionAuthority");
});
it.each(engines)("matches %s original source archive approval and receipt before completion",engine=>{const f=restoreReceiptFixture(engine);expect(managedDatabaseRestoreReceiptMatches(f.query,f.receipt)).toBe(true);});
it.each([{agentId:"foreign"},{commandId:"foreign"},{confirmationId:"foreign"},{originalCommandId:"foreign"},{backupCommandId:"foreign"},{projectId:"foreign"},{databaseId:"foreign"},{engine:"redis"},{profileId:"foreign"},{inputDigest:"0".repeat(64)},{correlationId:"foreign"},{containerId:"0".repeat(64)},{imageId:"sha256:"+"0".repeat(64)},{volumeName:"foreign"},{networkName:"foreign"},{networkId:"0".repeat(64)},{volumeCreatedAt:"2026-10-09T00:00:00Z"},{archiveId:"backup_"+"0".repeat(32)},{archiveBytes:5},{archiveSha256:"0".repeat(64)},{manifestSha256:"0".repeat(64)},{format:"mysql-sql-gzip"},{observedAt:1999},{status:"unknown"},{storage:"replaced"},{health:"unknown"},{path:"private"},{bytes:"private"}])("refuses detached restore completion %j",patch=>{const f=restoreReceiptFixture();expect(managedDatabaseRestoreReceiptMatches(f.query,{...f.receipt,...patch})).toBe(false);});
it("keeps replay identity stable only across readonly request and timeout changes",()=>{
 const f=restoreReceiptFixture(),base=managedDatabaseRestoreReplayFingerprint(f.query);
 expect(managedDatabaseRestoreReplayFingerprint({...f.query,context:{...f.query.context,requestId:"retry"},timeoutMs:5})).toBe(base);
 for(const patch of [{confirmationId:"other"},{inputDigest:"0".repeat(64),authority:{...f.query.authority,inputDigest:"0".repeat(64)}},{context:{...f.query.context,correlationId:"other"}},{backupReceipt:{...f.query.backupReceipt,archiveSha256:"0".repeat(64)}}])expect(managedDatabaseRestoreReplayFingerprint({...f.query,...patch})).not.toBe(base);
});
it.each([{authority:{projectId:"foreign"}},{lease:{leaseId:"foreign"}},{confirmationId:""},{requiredCapabilities:[]},{operation:"database.runtime.delete"},{cancellationRequested:true},{password:"private"},{argv:["private"]},{archivePath:"private"}])("rejects malformed or private confirmed command %j",patch=>{const f=restoreReceiptFixture();expect(managedDatabaseRestoreAgentCommandSchema.safeParse({...f.query,cancellationRequested:false,...patch}).success).toBe(false);});
it("refuses mismatched cached approval and archive source digest",()=>{
 const f=restoreReceiptFixture();expect(managedDatabaseRestoreCachedReceiptSchema.safeParse({...f.cache,confirmationId:"foreign"}).success).toBe(false);
 expect(managedDatabaseRestoreReceiptMatches({...f.query,backupReceipt:{...f.query.backupReceipt,sourceDigest:"0".repeat(64)}},f.receipt)).toBe(false);
});
