import { expect, it, vi } from "vitest";
import { MANAGED_DATABASE_RUNTIME_CAPABILITY, MANAGED_DATABASE_STOP_CAPABILITY, type ManagedDatabaseEngineV1, type ManagedDatabaseDeleteReceiptV1, type ManagedDatabaseStopReceiptV1 } from "@deploylite/contracts";
import { composeRuntimeResourceName, createControlCommand, managedDatabaseRuntimeExecutionBinding,
  managedDatabaseRuntimeReplayFingerprintDigest, managedDatabaseStopExecutionBinding, managedDatabaseStopReplayFingerprintDigest, resolveControlCommandInMemory,
  type ControlCommand, type ProjectUpdateControlRepository } from "@deploylite/domain";
import { applyManagedDatabaseDelete } from "./managed-database-delete-apply.js";
import { prepareManagedDatabaseDeleteConfirmation, managedDatabaseDeleteReceiptMatches, type ManagedDatabaseDeleteCompletionInput, type ControlConfirmation } from "@deploylite/domain";

function fixture(engine:ManagedDatabaseEngineV1="postgres") {
  let now = 1000;
  const ledger = new Map<string, ControlCommand>(), cache = new Map<string, ManagedDatabaseStopReceiptV1>();
  const base = { schemaVersion: 1 as const, projectId: "project-a", databaseId: "orders", engine,
    profileId: "profile-a", planDigest: "a".repeat(64), environmentFingerprint: "b".repeat(32) };
  const authorityFor = (command: ControlCommand) => ({ schemaVersion: 1 as const, projectId: base.projectId,
    commandId: command.id, action: "project.update" as const, inputDigest: command.inputDigest,
    projectLease: { leaseId: "lease-" + command.id, projectId: base.projectId, fence: 1, expiresAt: command.expiresAt.getTime() } });
  const seed = createControlCommand({ actorId: "original-operator", action: "project.update",
    scope: { kind: "project", projectId: base.projectId }, input: managedDatabaseRuntimeExecutionBinding(base),
    idempotencyKey: "original-create", correlationId: "original-correlation", expiresAt: new Date(2000) });
  const original: ControlCommand = { ...seed, status: "completed", projectExecutionAuthority: authorityFor(seed) };
  const { profileId: _profile, ...receiptBase } = base;
  const originalReceipt = { ...receiptBase, action: "database.runtime" as const, agentId: "agent-a", commandId: original.id,
    inputDigest: original.inputDigest, correlationId: original.correlationId, containerId: "c".repeat(64),
    imageId: "sha256:" + "d".repeat(64), volumeName: composeRuntimeResourceName(base.projectId, "volume", "db-orders"),
    networkName: composeRuntimeResourceName(base.projectId, "network", "db-orders"), networkId: "e".repeat(64),
    volumeCreatedAt: "2026-10-10T00:00:00Z", observedAt: 1000, status: "ready" as const, health: "passed" as const,
    storage: "verified" as const, idempotent: false, redacted: true as const };
  const originalQuery = { ...base, action: "database.runtime", operation: "database.runtime.apply", agentId: "agent-a",
    commandId: original.id, inputDigest: original.inputDigest, idempotencyKey: original.idempotencyKey,
    requiredCapabilities: [MANAGED_DATABASE_RUNTIME_CAPABILITY], authority: original.projectExecutionAuthority,
    lease: original.projectExecutionAuthority!.projectLease, context: { requestId: "original-request", correlationId: original.correlationId }, timeoutMs: 1000 };
  const stopPreparation = { ...base, originalReceipt, originalReplayFingerprint: managedDatabaseRuntimeReplayFingerprintDigest(originalQuery) };
  const stopSeed=createControlCommand({actorId:"original-stop-operator",action:"project.update",scope:{kind:"project",projectId:base.projectId},
    input:managedDatabaseStopExecutionBinding(stopPreparation),idempotencyKey:"original-stop",correlationId:"original-stop-correlation",expiresAt:new Date(2000)});
  const originalStop:ControlCommand={...stopSeed,status:"completed",projectExecutionAuthority:authorityFor(stopSeed)};
  const {health:_health,idempotent:_idempotent,...physical}=originalReceipt;
  const originalStopReceipt:ManagedDatabaseStopReceiptV1={...physical,action:"database.runtime.stop",commandId:originalStop.id,originalCommandId:original.id,profileId:base.profileId,
    inputDigest:originalStop.inputDigest,correlationId:originalStop.correlationId,status:"stopped"};
  const stopQuery={...stopPreparation,action:"database.runtime.stop",operation:"database.runtime.stop",agentId:"agent-a",commandId:originalStop.id,
    idempotencyKey:originalStop.idempotencyKey,inputDigest:originalStop.inputDigest,requiredCapabilities:[MANAGED_DATABASE_STOP_CAPABILITY],authority:originalStop.projectExecutionAuthority,
    lease:originalStop.projectExecutionAuthority!.projectLease,context:{requestId:"original-stop-request",correlationId:originalStop.correlationId},timeoutMs:1000};
  const preparation={...stopPreparation,originalStopReceipt,originalStopReplayFingerprint:managedDatabaseStopReplayFingerprintDigest(stopQuery)};
  const save = (command: ControlCommand) => {
    const key = [...ledger].find(([, value]) => value.id === command.id)![0];
    ledger.set(key, structuredClone(command)); return structuredClone(command);
  };
  const controls = {
    resolve: vi.fn(async (command: ControlCommand) => resolveControlCommandInMemory(ledger, command)),
    complete: vi.fn(async (command: ControlCommand) => save(command)),
    findProjectUpdateById: vi.fn(async (_projectId:string,id:string) => structuredClone(id===original.id?original:id===originalStop.id?originalStop:null)),
    findProjectUpdateByIdempotency: vi.fn(async () => structuredClone([...ledger.values()][0] ?? null)),
    claimProjectUpdate: vi.fn(async (command: ControlCommand) => {
      const authority = authorityFor(command), claimed = save({ ...command, status: "dispatching", projectExecutionAuthority: authority });
      return { command: claimed, claimed: true, authority };
    }),
    validateProjectUpdateAuthority: vi.fn(async () => {}),
    completeProjectUpdate: vi.fn(async (command: ControlCommand) => save({ ...command, status: "completed" }))
  } satisfies ProjectUpdateControlRepository;
  const originalTransport = { available: vi.fn(() => true), readReceipt: vi.fn(async () => structuredClone(originalReceipt)),
    dispatch: vi.fn(async () => { throw new Error("original execution forbidden"); }) };
  const originalStopTransport={available:vi.fn(()=>true),readReceipt:vi.fn(async()=>structuredClone(originalStopReceipt)),dispatch:vi.fn(async()=>{throw new Error("original stop forbidden");})};
  const fence=vi.fn(async()=>{}),context={requestId:"start-request",signal:new AbortController().signal};
  const options={controls,originalTransport,originalStopTransport,agentId:"agent-a",deadlineMs:1000};
  return {ledger,original,originalStop,originalReceipt,originalStopReceipt,preparation,controls,originalTransport,originalStopTransport,options,context,fence};
}

function setup(engine:ManagedDatabaseEngineV1="postgres"){
 const f=fixture(engine),cache=new Map<string,ManagedDatabaseDeleteReceiptV1>(),now={value:1000};
 const intent=prepareManagedDatabaseDeleteConfirmation({preparation:f.preparation,actorId:"operator",idempotencyKey:"delete-orders",correlationId:"delete-correlation",now:now.value,commandTtlMs:1000});
 resolveControlCommandInMemory(f.ledger,intent.command);const nonce:ControlConfirmation=structuredClone(intent.confirmation);
 const save=(command:ControlCommand)=>{const key=[...f.ledger].find(([,v])=>v.id===command.id)![0];f.ledger.set(key,structuredClone(command));return structuredClone(command);};
 const claimConfirmedProjectUpdate=vi.fn(async(command:ControlCommand,confirmation:ControlConfirmation)=>{
  if(confirmation.id!==nonce.id||nonce.consumedAt!==null)return {command,accepted:false,claimed:false,reason:"confirmation_rejected"};
  nonce.consumedAt=new Date(now.value);const authority={schemaVersion:1 as const,projectId:"project-a",commandId:command.id,action:"project.update" as const,inputDigest:command.inputDigest,projectLease:{leaseId:"delete-lease",projectId:"project-a",fence:3,expiresAt:command.expiresAt.getTime()}};
  return {command:save({...command,status:"dispatching",projectExecutionAuthority:authority}),accepted:true,claimed:true,authority,reason:null};
 });
 const audit=vi.fn(),completeManagedDatabaseDelete=vi.fn(async(input:ManagedDatabaseDeleteCompletionInput)=>{
  if(!managedDatabaseDeleteReceiptMatches(input.query,input.receipt))throw new Error("invalid completion");const current=[...f.ledger.values()][0]!;
  if(current.status==="completed")return structuredClone(current);audit(input.audit);return save({...input.command,status:"completed",result:input.receipt});
 });
 const validateConfirmedProjectUpdateAuthority=vi.fn(async(_authority:unknown,id:string)=>{if(id!==nonce.id||!nonce.consumedAt)throw new Error("not confirmed");});
 const controls={...f.controls,claimConfirmedProjectUpdate,completeManagedDatabaseDelete,validateConfirmedProjectUpdateAuthority};
 const receiptFor=(command:ControlCommand):ManagedDatabaseDeleteReceiptV1=>{
  const {health:_health,idempotent:_idempotent,...physical}=f.originalReceipt;
  return {...physical,action:"database.runtime.delete",profileId:f.preparation.profileId,commandId:command.id,originalCommandId:f.original.id,originalStopCommandId:f.originalStop.id,confirmationId:nonce.id,
    inputDigest:command.inputDigest,correlationId:command.correlationId,observedAt:now.value,status:"removed",storage:"retained"};
 };
 const transport={available:vi.fn(()=>true),readReceipt:vi.fn(async(p:{command:ControlCommand})=>cache.get(p.command.id)??null),dispatch:vi.fn(async(p:{command:ControlCommand})=>{const receipt=receiptFor(p.command);cache.set(p.command.id,receipt);return receipt;})};
 const options={...f.options,controls,transport,now:()=>now.value};
 const authorize=vi.fn(async()=>true),current=vi.fn(()=>true),admit=vi.fn(async()=>{});
 const input={preparation:f.preparation,actorId:"operator",idempotencyKey:"delete-orders",confirmationId:nonce.id,context:{requestId:"apply",correlationId:"request-correlation"},authorize,current,admit};
 return {...f,options,input,nonce,intent,save,cache,now,controls,transport,receiptFor,audit,authorize,current,admit};
}
it.each(["postgres","mysql","mariadb","mongodb","redis"] as const)("confirms %s original intent once and completes immutable deletion evidence",async(engine)=>{
 const f=setup(engine),result=await applyManagedDatabaseDelete(f.options,f.input);expect(result.removed).toBe(true);expect(result.command.status).toBe("completed");expect(result.receipt.confirmationId).toBe(f.nonce.id);
 expect(f.controls.claimConfirmedProjectUpdate).toHaveBeenCalledOnce();expect(f.transport.dispatch).toHaveBeenCalledOnce();expect(f.audit).toHaveBeenCalledOnce();expect(f.controls.resolve).not.toHaveBeenCalled();expect(f.controls.claimProjectUpdate).not.toHaveBeenCalled();expect(f.originalTransport.dispatch).not.toHaveBeenCalled();
});
it("replays expired completed original cache without nonce renewal or another effect",async()=>{
 const f=setup(),first=await applyManagedDatabaseDelete(f.options,f.input);f.now.value=3000;f.admit.mockClear();f.controls.findProjectUpdateById.mockClear();
 const next=await applyManagedDatabaseDelete(f.options,f.input);expect(next.receipt).toEqual(first.receipt);expect(next.idempotent).toBe(true);expect(f.controls.claimConfirmedProjectUpdate).toHaveBeenCalledOnce();expect(f.transport.dispatch).toHaveBeenCalledOnce();expect(f.audit).toHaveBeenCalledOnce();expect(f.admit).not.toHaveBeenCalled();expect(f.controls.findProjectUpdateById).not.toHaveBeenCalled();
});
it("recovers a lost reply solely from original cache",async()=>{
 const f=setup();f.transport.dispatch.mockImplementation(async(p)=>{f.cache.set(p.command.id,f.receiptFor(p.command));throw new Error("lost");});await expect(applyManagedDatabaseDelete(f.options,f.input)).resolves.toMatchObject({removed:true});expect(f.transport.dispatch).toHaveBeenCalledOnce();expect(f.audit).toHaveBeenCalledOnce();
});
it("leaves an uncertain attempt dispatching and never redispatches on same-key retry",async()=>{
 const f=setup();f.transport.dispatch.mockRejectedValue(new Error("lost"));await expect(applyManagedDatabaseDelete(f.options,f.input)).rejects.toThrow();await expect(applyManagedDatabaseDelete(f.options,f.input)).rejects.toThrow();expect(f.transport.dispatch).toHaveBeenCalledOnce();expect(f.audit).not.toHaveBeenCalled();expect([...f.ledger.values()][0]!.status).toBe("dispatching");
});
it("rejects a foreign nonce before dispatch or completion",async()=>{
 const f=setup();await expect(applyManagedDatabaseDelete(f.options,{...f.input,confirmationId:"foreign"})).rejects.toThrow();expect(f.transport.dispatch).not.toHaveBeenCalled();expect(f.audit).not.toHaveBeenCalled();expect(f.nonce.consumedAt).toBeNull();
});
it("rejects missing or expired intent without creating intent or approval",async()=>{
 for(const mode of ["missing","expired"]){const f=setup();if(mode==="missing")f.ledger.clear();else f.now.value=2000;await expect(applyManagedDatabaseDelete(f.options,f.input)).rejects.toThrow();expect(f.controls.resolve).not.toHaveBeenCalled();expect(f.controls.claimConfirmedProjectUpdate).not.toHaveBeenCalled();expect(f.transport.dispatch).not.toHaveBeenCalled();}
});
it("denies changed current grant or original signed source before consuming approval",async()=>{
 for(const mode of ["grant","source"]){const f=setup();if(mode==="grant")f.authorize.mockResolvedValue(false);else f.originalTransport.readReceipt.mockResolvedValue(null as never);await expect(applyManagedDatabaseDelete(f.options,f.input)).rejects.toThrow();expect(f.controls.claimConfirmedProjectUpdate).not.toHaveBeenCalled();expect(f.nonce.consumedAt).toBeNull();}
});
it("rejects detached execution receipt after one effect without completion or retry",async()=>{
 const f=setup();f.transport.dispatch.mockImplementation(async(p)=>({...f.receiptFor(p.command),confirmationId:"foreign"}));await expect(applyManagedDatabaseDelete(f.options,f.input)).rejects.toThrow();expect(f.transport.dispatch).toHaveBeenCalledOnce();expect(f.audit).not.toHaveBeenCalled();
});
it("reconciles completion rollback from cache on retry without another execution",async()=>{
 const f=setup(),complete=f.controls.completeManagedDatabaseDelete.getMockImplementation()!;f.controls.completeManagedDatabaseDelete.mockRejectedValueOnce(new Error("rollback"));await expect(applyManagedDatabaseDelete(f.options,f.input)).rejects.toThrow();f.controls.completeManagedDatabaseDelete.mockImplementation(complete);await expect(applyManagedDatabaseDelete(f.options,f.input)).resolves.toMatchObject({removed:true});expect(f.transport.dispatch).toHaveBeenCalledOnce();expect(f.audit).toHaveBeenCalledOnce();
});
