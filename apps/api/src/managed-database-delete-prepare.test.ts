import { expect, it, vi } from "vitest";
import { MANAGED_DATABASE_RUNTIME_CAPABILITY, MANAGED_DATABASE_STOP_CAPABILITY, type ManagedDatabaseStopReceiptV1 } from "@deploylite/contracts";
import { composeRuntimeResourceName, createControlCommand, managedDatabaseRuntimeExecutionBinding,
  managedDatabaseRuntimeReplayFingerprintDigest, managedDatabaseStopExecutionBinding, managedDatabaseStopReplayFingerprintDigest, resolveControlCommandInMemory,
  type ControlCommand, type ProjectUpdateControlRepository } from "@deploylite/domain";
import { prepareManagedDatabaseDelete } from "./managed-database-delete-prepare.js";
import { createConfirmation, type ControlConfirmation } from "@deploylite/domain";

function fixture() {
  let now = 1000;
  const ledger = new Map<string, ControlCommand>(), cache = new Map<string, ManagedDatabaseStopReceiptV1>();
  const base = { schemaVersion: 1 as const, projectId: "project-a", databaseId: "orders", engine: "postgres" as const,
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
  return {original,originalStop,originalReceipt,originalStopReceipt,preparation,controls,originalTransport,originalStopTransport,options,context,fence};
}

function setup() {
 const f=fixture(),nonces=new Map<string,ControlConfirmation>();
 const resolveProjectUpdateConfirmation=vi.fn(async(command:ControlCommand)=>{let nonce=nonces.get(command.id);if(!nonce){nonce=createConfirmation({command,classification:"destructive"});nonces.set(command.id,nonce);}return structuredClone(nonce);});
 const options={...f.options,controls:{...f.controls,resolveProjectUpdateConfirmation},now:()=>1000,commandTtlMs:1000};
 const authorize=vi.fn(async()=>true),current=vi.fn(()=>true),admit=vi.fn(async()=>{});
 const input={preparation:f.preparation,actorId:"operator",idempotencyKey:"delete-orders",context:{requestId:"prepare",correlationId:"prepare-correlation"},authorize,current,admit};
 return {...f,options,input,nonces,authorize,current,admit,resolveProjectUpdateConfirmation};
}
it("persists only pending intent and recovers the same unconsumed original nonce on retry",async()=>{
 const f=setup(),first=await prepareManagedDatabaseDelete(f.options,f.input),again=await prepareManagedDatabaseDelete(f.options,{...f.input,context:{requestId:"retry",correlationId:"retry-correlation"}});
 expect(first.command.status).toBe("pending_confirmation");expect(first.confirmation.classification).toBe("destructive");expect(first.confirmation.consumedAt).toBeNull();expect(first.command).not.toHaveProperty("projectExecutionAuthority");
 expect(again.command.id).toBe(first.command.id);expect(again.confirmation).toEqual(first.confirmation);
 expect(first.command.actorId).toBe("operator");expect(first.command.correlationId).toBe("prepare-correlation");expect(first.command.expiresAt).toEqual(new Date(2000));
 expect(f.originalTransport.dispatch).not.toHaveBeenCalled();expect(f.originalStopTransport.dispatch).not.toHaveBeenCalled();expect(f.controls.claimProjectUpdate).not.toHaveBeenCalled();
});
it("denies revoked access before any private history or intent write",async()=>{
 const f=setup();f.authorize.mockResolvedValue(false);await expect(prepareManagedDatabaseDelete(f.options,f.input)).rejects.toThrow();expect(f.controls.findProjectUpdateById).not.toHaveBeenCalled();expect(f.controls.resolve).not.toHaveBeenCalled();expect(f.resolveProjectUpdateConfirmation).not.toHaveBeenCalled();
});
it("denies missing original evidence before intent or nonce persistence",async()=>{
 const f=setup();f.originalTransport.readReceipt.mockResolvedValue(null as never);await expect(prepareManagedDatabaseDelete(f.options,f.input)).rejects.toThrow();expect(f.controls.resolve).not.toHaveBeenCalled();expect(f.resolveProjectUpdateConfirmation).not.toHaveBeenCalled();
});
it("never renews expired intent or reuses consumed or foreign confirmation",async()=>{
 for(const mode of ["expired","consumed","foreign"]){const f=setup(),first=await prepareManagedDatabaseDelete(f.options,f.input);
  if(mode==="expired")f.options.now=()=>2000;else{const nonce=f.nonces.get(first.command.id)!;if(mode==="consumed")nonce.consumedAt=new Date(1000);else nonce.actorId="foreign";}
  await expect(prepareManagedDatabaseDelete(f.options,f.input)).rejects.toThrow();expect(f.nonces.size).toBe(1);expect(f.controls.claimProjectUpdate).not.toHaveBeenCalled();
 }
});
it("rechecks current configuration and grant after asynchronous original evidence",async()=>{
 const f=setup();f.originalStopTransport.readReceipt.mockImplementation(async()=>{f.current.mockReturnValue(false);return f.originalStopReceipt;});await expect(prepareManagedDatabaseDelete(f.options,f.input)).rejects.toThrow();expect(f.controls.resolve).not.toHaveBeenCalled();
});
it("bounds pending confirmation storage without acquiring execution authority",async()=>{
 const f=setup();f.options.deadlineMs=5;f.resolveProjectUpdateConfirmation.mockImplementation(()=>new Promise(()=>{}));await expect(prepareManagedDatabaseDelete(f.options,f.input)).rejects.toThrow();expect(f.controls.claimProjectUpdate).not.toHaveBeenCalled();expect(f.originalTransport.dispatch).not.toHaveBeenCalled();
});
