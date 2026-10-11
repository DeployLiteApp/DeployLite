import {expect,it,vi} from "vitest";
import {MANAGED_DATABASE_RUNTIME_CAPABILITY} from "@deploylite/contracts";
import {composeRuntimeResourceName,createControlCommand,createConfirmation,managedDatabaseRuntimeExecutionBinding,
 managedDatabaseRuntimeReplayFingerprintDigest,managedDatabaseBackupExecutionDigest,managedDatabaseBackupSourceDigest,
 managedDatabaseRestoreExecutionDigest,resolveControlCommandInMemory,type ControlCommand,type ControlConfirmation,type ProjectUpdateControlRepository} from "@deploylite/domain";
import {prepareManagedDatabaseRestore} from "./managed-database-restore-prepare.js";
const engines=["postgres","mysql","mariadb","mongodb","redis"] as const;
function fixture(engine:typeof engines[number]="postgres"){
 const base={schemaVersion:1 as const,projectId:"project-a",databaseId:"orders",engine,profileId:"profile-a",planDigest:"a".repeat(64),environmentFingerprint:"b".repeat(32)};
 const seed=createControlCommand({actorId:"original-operator",action:"project.update",scope:{kind:"project",projectId:base.projectId},input:managedDatabaseRuntimeExecutionBinding(base),idempotencyKey:"original-create",correlationId:"original-correlation",expiresAt:new Date(10000)});
 const original:ControlCommand={...seed,status:"completed",projectExecutionAuthority:{schemaVersion:1,projectId:base.projectId,commandId:seed.id,action:"project.update",inputDigest:seed.inputDigest,projectLease:{leaseId:"lease-original",projectId:base.projectId,fence:1,expiresAt:10000}}};
 const {profileId:_profile,...receiptBase}=base;
 const originalReceipt={...receiptBase,action:"database.runtime" as const,agentId:"agent-a",commandId:seed.id,inputDigest:seed.inputDigest,correlationId:seed.correlationId,containerId:"c".repeat(64),imageId:"sha256:"+"d".repeat(64),volumeName:composeRuntimeResourceName(base.projectId,"volume","db-orders"),networkName:composeRuntimeResourceName(base.projectId,"network","db-orders"),networkId:"e".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",observedAt:1000,status:"ready" as const,health:"passed" as const,storage:"verified" as const,idempotent:false,redacted:true as const};
 const query={...base,action:"database.runtime",operation:"database.runtime.apply",agentId:"agent-a",commandId:seed.id,inputDigest:seed.inputDigest,idempotencyKey:seed.idempotencyKey,requiredCapabilities:[MANAGED_DATABASE_RUNTIME_CAPABILITY],authority:original.projectExecutionAuthority,lease:original.projectExecutionAuthority!.projectLease,context:{requestId:"original-request",correlationId:seed.correlationId},timeoutMs:1000};
 const source={...base,originalReceipt,originalReplayFingerprint:managedDatabaseRuntimeReplayFingerprintDigest(query)},capture={...source,destinationId:"private-native",maxBytes:2097152};
 const {health:_health,status:_status,...physical}=originalReceipt;
 const backupReceipt={...physical,profileId:base.profileId,action:"database.runtime.backup",commandId:"backup-a",originalCommandId:seed.id,inputDigest:managedDatabaseBackupExecutionDigest(capture),correlationId:"backup-correlation",volumeKey:"db-orders",sourceDigest:managedDatabaseBackupSourceDigest(capture),destinationId:capture.destinationId,archiveId:"backup_"+"f".repeat(32),archiveBytes:4,archiveSha256:"a".repeat(64),manifestSha256:"b".repeat(64),format:{postgres:"postgres-custom-gzip",mysql:"mysql-sql-gzip",mariadb:"mariadb-sql-gzip",mongodb:"mongodb-archive-gzip",redis:"volume-tar"}[engine],consistency:{postgres:"native-snapshot",mysql:"global-read-lock",mariadb:"global-read-lock",mongodb:"quiesced-writes",redis:"all-consumers-stopped"}[engine],status:"created"};
 const selection={...source,archiveId:backupReceipt.archiveId,destinationId:backupReceipt.destinationId,expectedArchiveSha256:backupReceipt.archiveSha256,expectedManifestSha256:backupReceipt.manifestSha256,maxBytes:capture.maxBytes};
 const preparation={...source,backupReceipt,maxBytes:capture.maxBytes},ledger=new Map<string,ControlCommand>(),nonces=new Map<string,ControlConfirmation>();
 const forbidden=vi.fn(async()=>{throw new Error("Execution forbidden.");});
 const controls={resolve:vi.fn(async(command:ControlCommand)=>resolveControlCommandInMemory(ledger,command)),complete:forbidden,claimProjectUpdate:forbidden,validateProjectUpdateAuthority:forbidden,completeProjectUpdate:forbidden,
  findProjectUpdateById:vi.fn(async()=>structuredClone(original)),findProjectUpdateByIdempotency:vi.fn(async()=>structuredClone([...ledger.values()][0]??null)),
  resolveProjectUpdateConfirmation:vi.fn(async(command:ControlCommand)=>{let nonce=nonces.get(command.id);if(!nonce){nonce=createConfirmation({command,classification:"destructive"});nonces.set(command.id,nonce);}return structuredClone(nonce);})} satisfies ProjectUpdateControlRepository;
 const originalTransport={available:()=>true,readReceipt:vi.fn(async()=>structuredClone(originalReceipt)),dispatch:forbidden};
 const inventory={available:()=>true,list:vi.fn(async()=>[{schemaVersion:1,receipt:backupReceipt,createdAtMs:1000}] as any)};
 const view={archiveId:backupReceipt.archiveId,archiveBytes:4,archiveSha256:backupReceipt.archiveSha256,manifestSha256:backupReceipt.manifestSha256,format:backupReceipt.format,integrity:"verified",redacted:true};
 const archive={verify:vi.fn(async(_preparation:unknown,_signal:AbortSignal)=>({...view}))};
 const protection={protect:vi.fn(async()=>{})};
 const access={protection,controls,originalTransport,agentId:"agent-a",deadlineMs:1000,inventory,archive,now:()=>1000,commandTtlMs:1000};
 const input={selection,actorId:"operator-a",idempotencyKey:"restore-orders",context:{requestId:"prepare-request",correlationId:"prepare-correlation"},authorize:vi.fn(async()=>true),current:vi.fn(()=>true),admit:vi.fn(async()=>{})};
 return {protection,access,input,preparation,controls,nonces,ledger,originalTransport,inventory,archive,view,forbidden};
}
it.each(engines)("persists and recovers the same original %s pending restore nonce",async engine=>{
 const f=fixture(engine),pending=prepareManagedDatabaseRestore(f.access,f.input);
 await expect(pending).resolves.toMatchObject({command:{status:"pending_confirmation"},confirmation:{classification:"destructive",consumedAt:null}});
 const first=await pending,again=await prepareManagedDatabaseRestore(f.access,{...f.input,context:{requestId:"retry",correlationId:"retry-correlation"}});
 expect(first.preparation).toEqual(f.preparation);expect(first.command).toMatchObject({actorId:f.input.actorId,status:"pending_confirmation",inputDigest:managedDatabaseRestoreExecutionDigest(f.preparation),correlationId:"prepare-correlation",expiresAt:new Date(2000)});
 expect(first.confirmation).toMatchObject({classification:"destructive",consumedAt:null,commandId:first.command.id});expect(again.command).toEqual(first.command);expect(again.confirmation).toEqual(first.confirmation);expect(again.idempotent).toBe(true);expect(first.idempotent).toBe(false);
 expect(f.nonces.size).toBe(1);expect(f.ledger.size).toBe(1);expect(f.protection.protect).toHaveBeenCalledTimes(2);expect(f.protection.protect).toHaveBeenCalledWith(first.preparation,first.command,first.confirmation);expect(f.originalTransport.readReceipt).toHaveBeenCalled();expect(f.forbidden).not.toHaveBeenCalled();expect(first.command).not.toHaveProperty("projectExecutionAuthority");
});
it("denies revoked access before private source inventory archive or pending writes",async()=>{
 const f=fixture();f.input.authorize.mockResolvedValue(false);await expect(prepareManagedDatabaseRestore(f.access,f.input)).rejects.toThrow("Database restore preparation is unavailable.");
 expect(f.controls.findProjectUpdateById).not.toHaveBeenCalled();expect(f.inventory.list).not.toHaveBeenCalled();expect(f.archive.verify).not.toHaveBeenCalled();expect(f.controls.resolve).not.toHaveBeenCalled();
});
it("denies absent original cached evidence before preparing any pending command",async()=>{
 const f=fixture();f.originalTransport.readReceipt.mockResolvedValue(null as never);await expect(prepareManagedDatabaseRestore(f.access,f.input)).rejects.toThrow("Database restore preparation is unavailable.");expect(f.archive.verify).not.toHaveBeenCalled();expect(f.controls.resolve).not.toHaveBeenCalled();expect(f.nonces.size).toBe(0);
});
it.each(["expired","consumed","foreign"])("does not renew or replace a %s original nonce",async kind=>{
 const f=fixture(),first=await prepareManagedDatabaseRestore(f.access,f.input);
 if(kind==="expired")f.access.now=()=>2000;else{const nonce=f.nonces.get(first.command.id)!;if(kind==="consumed")nonce.consumedAt=new Date(1000);else nonce.actorId="foreign";}
 await expect(prepareManagedDatabaseRestore(f.access,f.input)).rejects.toThrow("Database restore preparation is unavailable.");expect(f.nonces.size).toBe(1);expect(f.ledger.size).toBe(1);expect(f.forbidden).not.toHaveBeenCalled();
});
it("rejects caller-injected receipt or path before private original reads",async()=>{
 for(const patch of [{backupReceipt:{}},{privatePath:"private-fixture"}]){const f=fixture();await expect(prepareManagedDatabaseRestore(f.access,{...f.input,selection:{...f.input.selection,...patch}})).rejects.toThrow("Database restore preparation is unavailable.");expect(f.originalTransport.readReceipt).not.toHaveBeenCalled();expect(f.controls.resolve).not.toHaveBeenCalled();}
});
it("rechecks current authorization after archive verification and before pending writes",async()=>{
 const f=fixture();f.archive.verify.mockImplementation(async()=>{f.input.authorize.mockResolvedValue(false);return {...f.view};});
 await expect(prepareManagedDatabaseRestore(f.access,f.input)).rejects.toThrow("Database restore preparation is unavailable.");expect(f.controls.resolve).not.toHaveBeenCalled();expect(f.nonces.size).toBe(0);
});
it("bounds an original cache read that never settles without effects",async()=>{
 const f=fixture();f.access.deadlineMs=5;f.originalTransport.readReceipt.mockImplementation(()=>new Promise(()=>{}));await expect(prepareManagedDatabaseRestore(f.access,f.input)).rejects.toThrow("Database restore preparation is unavailable.");expect(f.originalTransport.readReceipt).toHaveBeenCalledTimes(1);expect(f.controls.resolve).not.toHaveBeenCalled();expect(f.forbidden).not.toHaveBeenCalled();
},2000);
it("rejects archive refusal without reflecting its private diagnostic or writing intent",async()=>{
 const f=fixture();f.archive.verify.mockImplementation(async()=>{throw new Error("password=private-fixture");});await expect(prepareManagedDatabaseRestore(f.access,f.input)).rejects.toThrow("Database restore preparation is unavailable.");expect(f.controls.resolve).not.toHaveBeenCalled();expect(f.nonces.size).toBe(0);
});
it("rejects missing durable confirmation capability before source reads",async()=>{
 const f=fixture();await expect(prepareManagedDatabaseRestore({...f.access,controls:{...f.controls,resolveProjectUpdateConfirmation:undefined}},f.input)).rejects.toThrow("Database restore preparation is unavailable.");expect(f.originalTransport.readReceipt).not.toHaveBeenCalled();expect(f.controls.resolve).not.toHaveBeenCalled();
});
it("requires durable archive protection before returning or reading original pending intent",async()=>{const f=fixture();await expect(prepareManagedDatabaseRestore({...f.access,protection:undefined} as never,f.input)).rejects.toThrow("Database restore preparation is unavailable.");expect(f.originalTransport.readReceipt).not.toHaveBeenCalled();expect(f.controls.resolve).not.toHaveBeenCalled();});
it("does not expose a pending approval when durable protection fails or reflect private diagnostics",async()=>{const f=fixture();f.protection.protect.mockImplementation(async()=>{throw new Error("password=private-fixture");});await expect(prepareManagedDatabaseRestore(f.access,f.input)).rejects.toThrow("Database restore preparation is unavailable.");expect(f.ledger.size).toBe(1);expect(f.nonces.size).toBe(1);expect([...f.nonces.values()][0]!.consumedAt).toBeNull();expect(f.forbidden).not.toHaveBeenCalled();});
it("rechecks grant after protecting the archive and before returning the original nonce",async()=>{const f=fixture();f.protection.protect.mockImplementation(async()=>{f.input.authorize.mockResolvedValue(false);});await expect(prepareManagedDatabaseRestore(f.access,f.input)).rejects.toThrow("Database restore preparation is unavailable.");expect(f.protection.protect).toHaveBeenCalledTimes(1);expect([...f.nonces.values()][0]!.consumedAt).toBeNull();expect(f.forbidden).not.toHaveBeenCalled();});
