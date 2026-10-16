import {expect,it,vi} from "vitest";
import {MANAGED_DATABASE_RUNTIME_CAPABILITY} from "@deploylite/contracts";
import {composeRuntimeResourceName,createControlCommand,createConfirmation,managedDatabaseRuntimeExecutionBinding,
 managedDatabaseRuntimeReplayFingerprintDigest,managedDatabaseBackupExecutionDigest,managedDatabaseBackupSourceDigest,
 managedDatabaseRestoreExecutionDigest,resolveControlCommandInMemory,type ControlCommand,type ControlConfirmation,type ProjectUpdateControlRepository} from "@deploylite/domain";
import {prepareManagedDatabaseRestore} from "./managed-database-restore-prepare.js";
const engines=["postgres","mysql","mariadb","mongodb","redis"] as const;
import {applyManagedDatabaseRestore} from "./managed-database-restore-apply.js";
import {managedDatabaseRestoreReceiptMatches,type ManagedDatabaseRestoreCompletionInput} from "@deploylite/domain";
import {managedDatabaseRestoreReceiptSchema,managedDatabaseRestorePreparationSchema,type ManagedDatabaseRestoreReceiptV1} from "@deploylite/contracts";
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
 const preparation=managedDatabaseRestorePreparationSchema.parse({...source,backupReceipt,maxBytes:capture.maxBytes}),ledger=new Map<string,ControlCommand>(),nonces=new Map<string,ControlConfirmation>();
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
async function setup(engine:typeof engines[number]="postgres"){
 const f=fixture(engine),now={value:1000};f.access.now=()=>now.value;const intent=await prepareManagedDatabaseRestore(f.access,f.input),nonce=f.nonces.get(intent.command.id)!;
 const save=(command:ControlCommand)=>{const key=[...f.ledger].find(([,value])=>value.id===command.id)![0];f.ledger.set(key,structuredClone(command));return structuredClone(command);};
 const claimConfirmedProjectUpdate=vi.fn(async(command:ControlCommand,confirmation:ControlConfirmation)=>{
  if(confirmation.id!==nonce.id||nonce.consumedAt!==null||nonce.expiresAt.getTime()<=now.value)return {command,accepted:false,claimed:false,reason:"confirmation_rejected"};
  nonce.consumedAt=new Date(now.value);const authority={schemaVersion:1 as const,projectId:command.scope.kind==="project"?command.scope.projectId:"foreign",commandId:command.id,action:"project.update" as const,inputDigest:command.inputDigest,projectLease:{leaseId:"restore-lease",projectId:"project-a",fence:2,expiresAt:command.expiresAt.getTime()}};
  return {command:save({...command,status:"dispatching",projectExecutionAuthority:authority}),accepted:true,claimed:true,authority,reason:null};
 });
 const audit=vi.fn(),completeManagedDatabaseRestore=vi.fn(async(input:ManagedDatabaseRestoreCompletionInput)=>{
  if(!managedDatabaseRestoreReceiptMatches(input.query,input.receipt))throw new Error("invalid receipt");const current=[...f.ledger.values()][0]!;
  if(current.status==="completed")return structuredClone(current);audit(input.audit);return save({...input.command,status:"completed",result:input.receipt});
 });
 const controls={...f.controls,claimConfirmedProjectUpdate,completeManagedDatabaseRestore,validateProjectUpdateAuthority:vi.fn(async()=>{}),validateConfirmedProjectUpdateAuthority:vi.fn(async(_authority:unknown,id:string)=>{if(id!==nonce.id||!nonce.consumedAt)throw new Error("unconsumed");})};
 const assertProtected=vi.fn(async(_preparation:unknown,command:ControlCommand,id:string)=>{if(command.id!==intent.command.id||id!==nonce.id)throw new Error("detached protection");}),protection={...f.protection,assertProtected};
 const receiptFor=(command:ControlCommand):ManagedDatabaseRestoreReceiptV1=>{
  const original=f.preparation.originalReceipt,backup=f.preparation.backupReceipt;
  return managedDatabaseRestoreReceiptSchema.parse({schemaVersion:1,action:"database.runtime.restore",projectId:f.preparation.projectId,databaseId:f.preparation.databaseId,engine,profileId:f.preparation.profileId,agentId:"agent-a",commandId:command.id,originalCommandId:original.commandId,backupCommandId:backup.commandId,confirmationId:nonce.id,inputDigest:command.inputDigest,planDigest:f.preparation.planDigest,environmentFingerprint:f.preparation.environmentFingerprint,correlationId:command.correlationId,containerId:original.containerId,imageId:original.imageId,volumeName:original.volumeName,networkName:original.networkName,networkId:original.networkId,volumeCreatedAt:original.volumeCreatedAt,archiveId:backup.archiveId,archiveBytes:backup.archiveBytes,archiveSha256:backup.archiveSha256,manifestSha256:backup.manifestSha256,format:backup.format as ManagedDatabaseRestoreReceiptV1["format"],observedAt:1000,status:"restored",storage:"original",health:"passed",redacted:true});
 };
 const cache=new Map<string,ManagedDatabaseRestoreReceiptV1>(),transport={available:vi.fn(()=>true),readReceipt:vi.fn(async(p:{command:ControlCommand})=>cache.get(p.command.id)??null),dispatch:vi.fn(async(p:{command:ControlCommand})=>{const receipt=receiptFor(p.command);cache.set(p.command.id,receipt);return receipt;})};
 const options={...f.access,controls,protection,transport},input={preparation:f.preparation,actorId:f.input.actorId,idempotencyKey:f.input.idempotencyKey,confirmationId:nonce.id,context:{requestId:"apply-request",correlationId:"request-correlation"},authorize:f.input.authorize,current:f.input.current,admit:f.input.admit};
 f.controls.resolve.mockClear();f.originalTransport.readReceipt.mockClear();f.inventory.list.mockClear();f.archive.verify.mockClear();
 return {...f,options,input,intent,nonce,controls,protection,transport,cache,now,receiptFor,save,audit};
}
it.each(engines)("consumes original protected %s restore intent once and completes its correlated receipt",async engine=>{
 const f=await setup(engine),result=await applyManagedDatabaseRestore(f.options,f.input);
 expect(result.restored).toBe(true);expect(result.command.status).toBe("completed");expect(result.receipt.confirmationId).toBe(f.nonce.id);expect(f.nonce.consumedAt).toEqual(new Date(1000));
 expect(f.controls.claimConfirmedProjectUpdate).toHaveBeenCalledOnce();expect(f.transport.dispatch).toHaveBeenCalledOnce();expect(f.audit).toHaveBeenCalledOnce();expect(f.protection.assertProtected).toHaveBeenCalled();expect(f.inventory.list).toHaveBeenCalledTimes(2);expect(f.archive.verify).toHaveBeenCalledTimes(2);expect(f.controls.resolve).not.toHaveBeenCalled();expect(f.forbidden).not.toHaveBeenCalled();
});
it("recovers expired completed receipt using only original signed cache without fresh archive or approval",async()=>{
 const f=await setup(),first=await applyManagedDatabaseRestore(f.options,f.input);f.now.value=3000;f.inventory.list.mockClear();f.archive.verify.mockClear();f.protection.assertProtected.mockClear();f.originalTransport.readReceipt.mockClear();f.input.admit.mockClear();
 const again=await applyManagedDatabaseRestore(f.options,f.input);expect(again.receipt).toEqual(first.receipt);expect(again.idempotent).toBe(true);expect(f.transport.dispatch).toHaveBeenCalledOnce();expect(f.controls.claimConfirmedProjectUpdate).toHaveBeenCalledOnce();expect(f.audit).toHaveBeenCalledOnce();expect(f.inventory.list).not.toHaveBeenCalled();expect(f.archive.verify).not.toHaveBeenCalled();expect(f.protection.assertProtected).not.toHaveBeenCalled();expect(f.originalTransport.readReceipt).not.toHaveBeenCalled();expect(f.input.admit).not.toHaveBeenCalled();
});
it("repairs rolled-back completion from original cache after expiry without another effect",async()=>{
 const f=await setup(),complete=f.controls.completeManagedDatabaseRestore.getMockImplementation()!;f.controls.completeManagedDatabaseRestore.mockRejectedValueOnce(new Error("rollback"));
 await expect(applyManagedDatabaseRestore(f.options,f.input)).rejects.toThrow();f.now.value=3000;f.controls.completeManagedDatabaseRestore.mockImplementation(complete);
 await expect(applyManagedDatabaseRestore(f.options,f.input)).resolves.toMatchObject({restored:true,idempotent:true});expect(f.transport.dispatch).toHaveBeenCalledOnce();expect(f.audit).toHaveBeenCalledOnce();
});
it("recovers a lost successful response only from immutable original cache",async()=>{
 const f=await setup();f.transport.dispatch.mockImplementation(async(p)=>{f.cache.set(p.command.id,f.receiptFor(p.command));throw new Error("lost");});
 await expect(applyManagedDatabaseRestore(f.options,f.input)).resolves.toMatchObject({restored:true});expect(f.transport.dispatch).toHaveBeenCalledOnce();expect(f.audit).toHaveBeenCalledOnce();
});
it("leaves an uncertain consumed command unresolved on same-key retry without another dispatch",async()=>{
 const f=await setup();f.transport.dispatch.mockRejectedValue(new Error("uncertain"));await expect(applyManagedDatabaseRestore(f.options,f.input)).rejects.toThrow();await expect(applyManagedDatabaseRestore(f.options,f.input)).rejects.toThrow();expect(f.transport.dispatch).toHaveBeenCalledOnce();expect(f.audit).not.toHaveBeenCalled();expect([...f.ledger.values()][0]!.status).toBe("dispatching");
});
it.each(["nonce","protection","archive","inventory","source","grant","expired"])("rejects detached %s before original nonce consumption or effect",async mode=>{
 const f=await setup();let input=f.input;
 if(mode==="nonce")input={...input,confirmationId:"foreign"};if(mode==="protection")f.protection.assertProtected.mockRejectedValue(new Error("missing"));if(mode==="archive")f.archive.verify.mockResolvedValue({...f.view,archiveSha256:"0".repeat(64)});
 if(mode==="inventory")f.inventory.list.mockResolvedValue([]);if(mode==="source")f.originalTransport.readReceipt.mockResolvedValue(null as never);if(mode==="grant")f.input.authorize.mockResolvedValue(false);if(mode==="expired")f.now.value=2000;
 await expect(applyManagedDatabaseRestore(f.options,input)).rejects.toThrow();expect(f.nonce.consumedAt).toBeNull();expect(f.controls.claimConfirmedProjectUpdate).not.toHaveBeenCalled();expect(f.transport.dispatch).not.toHaveBeenCalled();expect(f.audit).not.toHaveBeenCalled();
});
it("refuses detached post-effect receipt without completing or renewing the original claim",async()=>{const f=await setup();f.transport.dispatch.mockImplementation(async(p)=>({...f.receiptFor(p.command),confirmationId:"foreign"}));await expect(applyManagedDatabaseRestore(f.options,f.input)).rejects.toThrow();expect(f.transport.dispatch).toHaveBeenCalledOnce();expect(f.audit).not.toHaveBeenCalled();expect(f.controls.resolve).not.toHaveBeenCalled();});
