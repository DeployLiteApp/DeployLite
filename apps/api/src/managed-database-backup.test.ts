import {expect,it,vi} from "vitest";
import {MANAGED_DATABASE_RUNTIME_CAPABILITY,managedDatabaseBackupReceiptSchema,type ManagedDatabaseBackupReceiptV1} from "@deploylite/contracts";
import {createControlCommand,managedDatabaseRuntimeExecutionBinding,managedDatabaseRuntimeReplayFingerprintDigest,managedDatabaseBackupSourceDigest,composeRuntimeResourceName,resolveControlCommandInMemory,prepareBackupInventoryRecord,type ControlCommand,type ProjectUpdateControlRepository} from "@deploylite/domain";
import {backupManagedDatabaseRuntime} from "./managed-database-backup.js";
function fixture() {
  let now=1000;
  const ledger=new Map<string,ControlCommand>(),cache=new Map<string,ManagedDatabaseBackupReceiptV1>();
  const base={schemaVersion:1 as const,projectId:"project-a",databaseId:"orders",engine:"postgres" as const,profileId:"profile-a",planDigest:"a".repeat(64),environmentFingerprint:"b".repeat(32)};
  const authorityFor=(command:ControlCommand)=>({schemaVersion:1 as const,projectId:base.projectId,commandId:command.id,action:"project.update" as const,inputDigest:command.inputDigest,projectLease:{leaseId:"lease-"+command.id,projectId:base.projectId,fence:1,expiresAt:command.expiresAt.getTime()}});
  const seed=createControlCommand({actorId:"original-operator",action:"project.update",scope:{kind:"project",projectId:base.projectId},input:managedDatabaseRuntimeExecutionBinding(base),idempotencyKey:"original-create",correlationId:"original-correlation",expiresAt:new Date(2000)});
  const original={...seed,status:"completed" as const,projectExecutionAuthority:authorityFor(seed)};
  const {profileId:_profile,...receiptBase}=base;
  const originalReceipt={...receiptBase,action:"database.runtime" as const,agentId:"agent-a",commandId:original.id,inputDigest:original.inputDigest,correlationId:original.correlationId,containerId:"c".repeat(64),imageId:"sha256:"+"d".repeat(64),volumeName:composeRuntimeResourceName(base.projectId,"volume","db-orders"),networkName:composeRuntimeResourceName(base.projectId,"network","db-orders"),networkId:"e".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",observedAt:1000,status:"ready" as const,health:"passed" as const,storage:"verified" as const,idempotent:false,redacted:true as const};
  const originalQuery={...base,action:"database.runtime",operation:"database.runtime.apply",agentId:"agent-a",commandId:original.id,inputDigest:original.inputDigest,idempotencyKey:original.idempotencyKey,requiredCapabilities:[MANAGED_DATABASE_RUNTIME_CAPABILITY],authority:original.projectExecutionAuthority,lease:original.projectExecutionAuthority.projectLease,context:{requestId:"original-request",correlationId:original.correlationId},timeoutMs:1000};
  const preparation={...base,originalReceipt,originalReplayFingerprint:managedDatabaseRuntimeReplayFingerprintDigest(originalQuery),destinationId:"destination-a",maxBytes:10000};
  const save=(command:ControlCommand)=>{const key=[...ledger].find(([,row])=>row.id===command.id)![0];ledger.set(key,structuredClone(command));return structuredClone(command);};
  let completedAudit:any;
  const controls={resolve:vi.fn(async(command:ControlCommand)=>resolveControlCommandInMemory(ledger,command)),complete:vi.fn(async(command:ControlCommand)=>save(command)),findProjectUpdateById:vi.fn(async()=>structuredClone(original) as ControlCommand|null),findProjectUpdateByIdempotency:vi.fn(async()=>structuredClone([...ledger.values()][0]??null)),claimProjectUpdate:vi.fn(async(command:ControlCommand)=>{const authority=authorityFor(command);return {command:save({...command,status:"dispatching",projectExecutionAuthority:authority}),claimed:true,authority};}),validateProjectUpdateAuthority:vi.fn(async()=>{}),completeProjectUpdate:vi.fn(async(command:ControlCommand,_authority:unknown,audit:unknown)=>{completedAudit=structuredClone(audit);return save({...command,status:"completed"});})} satisfies ProjectUpdateControlRepository;
  const receiptFor=(command:ControlCommand)=>managedDatabaseBackupReceiptSchema.parse({...base,action:"database.runtime.backup",agentId:"agent-a",commandId:command.id,originalCommandId:original.id,inputDigest:command.inputDigest,correlationId:command.correlationId,containerId:originalReceipt.containerId,imageId:originalReceipt.imageId,volumeName:originalReceipt.volumeName,networkName:originalReceipt.networkName,networkId:originalReceipt.networkId,volumeCreatedAt:originalReceipt.volumeCreatedAt,observedAt:now,volumeKey:"db-orders",destinationId:preparation.destinationId,sourceDigest:managedDatabaseBackupSourceDigest(preparation),archiveId:"backup_"+"a".repeat(32),archiveBytes:4,archiveSha256:"a".repeat(64),manifestSha256:"b".repeat(64),format:"postgres-custom-gzip",consistency:"native-snapshot",status:"created",idempotent:false,storage:"verified",redacted:true});
  const transport={available:vi.fn(()=>true),readReceipt:vi.fn(async(prepared:{command:ControlCommand})=>cache.get(prepared.command.id)??null),dispatch:vi.fn(async(prepared:{command:ControlCommand})=>{const receipt=receiptFor(prepared.command);cache.set(prepared.command.id,receipt);return receipt;})};
  const originalTransport={available:vi.fn(()=>true),readReceipt:vi.fn(async()=>structuredClone(originalReceipt)),dispatch:vi.fn(async()=>{throw new Error("original execution forbidden");})};
  const inventory={available:vi.fn(()=>true),recordAuthenticatedReceipt:vi.fn(async(receipt:unknown)=>{
    const command=[...ledger.values()][0];if(!completedAudit||command?.status!=="completed")throw new Error("completion first");
    return prepareBackupInventoryRecord({receipt,expectedAgentId:"agent-a",observedAtMs:now,command,audit:{...completedAudit,createdAt:new Date(1000)}});
  })};
  const authorize=vi.fn(async()=>true),current=vi.fn(()=>true),admit=vi.fn(async()=>{});
  const options={controls,transport,originalTransport,inventory,agentId:"agent-a",now:()=>now,commandTtlMs:1000,deadlineMs:1000};
  const input={preparation,actorId:"current-operator",idempotencyKey:"backup-orders",context:{requestId:"backup-request",correlationId:"backup-correlation"},authorize,current,admit};
  return {options,input,controls,transport,originalTransport,inventory,authorize,current,admit,ledger,cache,receiptFor,advance:()=>{now=4000;}};
}
it("backs up the authenticated original once and completes/audits before durable ingestion",async()=>{
  const f=fixture(),result=await backupManagedDatabaseRuntime(f.options,f.input);
  expect(result).toMatchObject({command:{status:"completed"},backupCreated:true,idempotent:false,inventory:{receipt:result.receipt}});
  expect(f.transport.dispatch).toHaveBeenCalledOnce();expect(f.originalTransport.dispatch).not.toHaveBeenCalled();
  expect(f.controls.completeProjectUpdate).toHaveBeenCalledWith(expect.anything(),expect.anything(),expect.objectContaining({action:"database.runtime.backup.executed",metadata:expect.objectContaining({sourceDigest:result.receipt.sourceDigest,archiveId:result.receipt.archiveId,redacted:true})}));
  expect(f.inventory.recordAuthenticatedReceipt).toHaveBeenCalledOnce();
});
it("repairs failed ingestion on expired completed replay without another original read or backup",async()=>{
  const f=fixture();f.inventory.recordAuthenticatedReceipt.mockRejectedValueOnce(new Error("private inventory"));
  await expect(backupManagedDatabaseRuntime(f.options,f.input)).rejects.toThrow();expect([...f.ledger.values()][0]?.status).toBe("completed");
  f.advance();f.originalTransport.readReceipt.mockClear();f.admit.mockClear();
  expect(await backupManagedDatabaseRuntime(f.options,f.input)).toMatchObject({backupCreated:true,idempotent:true});
  expect(f.transport.dispatch).toHaveBeenCalledOnce();expect(f.controls.completeProjectUpdate).toHaveBeenCalledOnce();expect(f.originalTransport.readReceipt).not.toHaveBeenCalled();expect(f.admit).not.toHaveBeenCalled();
});
it("reconciles a lost capture reply from its original cache without another dump",async()=>{
  const f=fixture();f.transport.dispatch.mockImplementation(async prepared=>{f.cache.set(prepared.command.id,f.receiptFor(prepared.command));throw new Error("lost");});
  expect(await backupManagedDatabaseRuntime(f.options,f.input)).toMatchObject({backupCreated:true});expect(f.transport.dispatch).toHaveBeenCalledOnce();
});
it("rejects missing inventory and forged original proof before creating or dispatching backup",async()=>{
  for(const mode of ["inventory","proof","origin"]){const f=fixture();if(mode==="inventory")f.inventory.available.mockReturnValue(false);if(mode==="proof")f.input.preparation.originalReplayFingerprint="0".repeat(64);if(mode==="origin")f.controls.findProjectUpdateById.mockResolvedValue(null);
    await expect(backupManagedDatabaseRuntime(f.options,f.input)).rejects.toThrow();expect(f.controls.resolve).not.toHaveBeenCalled();expect(f.transport.dispatch).not.toHaveBeenCalled();
  }
});
it("rejects detached returned evidence or revoked completion without accepting inventory",async()=>{
  for(const stage of ["receipt","authority"]){const f=fixture();
    if(stage==="receipt")f.transport.dispatch.mockImplementation(async prepared=>({...f.receiptFor(prepared.command),sourceDigest:"0".repeat(64)}));
    else f.transport.dispatch.mockImplementation(async prepared=>{f.controls.validateProjectUpdateAuthority.mockRejectedValue(new Error("revoked"));return f.receiptFor(prepared.command);});
    await expect(backupManagedDatabaseRuntime(f.options,f.input)).rejects.toThrow();expect(f.controls.completeProjectUpdate).not.toHaveBeenCalled();expect(f.inventory.recordAuthenticatedReceipt).not.toHaveBeenCalled();
  }
});
it("bounds hung inventory ingestion without retrying or fabricating success",async()=>{
  const f=fixture();f.inventory.recordAuthenticatedReceipt.mockImplementation(()=>new Promise(()=>{}));
  await expect(backupManagedDatabaseRuntime({...f.options,deadlineMs:5},f.input)).rejects.toThrow();expect(f.transport.dispatch).toHaveBeenCalledOnce();expect(f.inventory.recordAuthenticatedReceipt).toHaveBeenCalledOnce();
});
