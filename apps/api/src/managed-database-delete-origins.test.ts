import { expect, it, vi } from "vitest";
import { MANAGED_DATABASE_RUNTIME_CAPABILITY, MANAGED_DATABASE_STOP_CAPABILITY, type ManagedDatabaseStopReceiptV1 } from "@deploylite/contracts";
import { composeRuntimeResourceName, createControlCommand, managedDatabaseRuntimeExecutionBinding,
  managedDatabaseRuntimeReplayFingerprintDigest, managedDatabaseStopExecutionBinding, managedDatabaseStopReplayFingerprintDigest, resolveControlCommandInMemory,
  type ControlCommand, type ProjectUpdateControlRepository } from "@deploylite/domain";
import { corroborateManagedDatabaseDeleteOrigins } from "./managed-database-delete-origins.js";

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

it("corroborates both completed commands and exact immutable signed receipts without original effects",async()=>{
  const f=fixture(),before=structuredClone([f.original,f.originalStop,f.preparation]);
  await expect(corroborateManagedDatabaseDeleteOrigins(f.options,f.preparation,f.context,f.fence)).resolves.toBeUndefined();
  expect(f.controls.findProjectUpdateById).toHaveBeenNthCalledWith(1,"project-a",f.original.id);
  expect(f.controls.findProjectUpdateById).toHaveBeenNthCalledWith(2,"project-a",f.originalStop.id);
  expect(f.originalTransport.readReceipt).toHaveBeenCalledOnce();expect(f.originalStopTransport.readReceipt).toHaveBeenCalledOnce();
  expect(f.originalTransport.dispatch).not.toHaveBeenCalled();expect(f.originalStopTransport.dispatch).not.toHaveBeenCalled();
  expect(f.controls.claimProjectUpdate).not.toHaveBeenCalled();expect(f.controls.resolve).not.toHaveBeenCalled();
  expect([f.original,f.originalStop,f.preparation]).toEqual(before);
});
it("rejects missing or detached authority/command from either original before requesting either cache",async()=>{
  for(const source of ["create","stop"]){for(const mode of ["missing","project","id","action","digest","correlation","status","authority"]){
    const f=fixture(),chosen=source==="create"?f.original:f.originalStop,changed=structuredClone(chosen);
    if(mode==="project")changed.scope={kind:"project",projectId:"foreign"};if(mode==="id")changed.id="foreign";
    if(mode==="action")changed.action="deployment.stop";if(mode==="digest")changed.inputDigest="0".repeat(64);
    if(mode==="correlation")changed.correlationId="foreign";if(mode==="status")changed.status="dispatching";
    if(mode==="authority")changed.projectExecutionAuthority!.commandId="foreign";
    f.controls.findProjectUpdateById.mockImplementation(async(_scope,id)=>id===chosen.id?(mode==="missing"?null:changed):structuredClone(id===f.original.id?f.original:f.originalStop));
    await expect(corroborateManagedDatabaseDeleteOrigins(f.options,f.preparation,f.context,f.fence)).rejects.toThrow();
    expect(f.originalTransport.readReceipt).not.toHaveBeenCalled();expect(f.originalStopTransport.readReceipt).not.toHaveBeenCalled();
  }}
});
it("rejects either opaque selector before cache reads and changed original public receipt after reads",async()=>{
  for(const source of ["create","stop"]){const f=fixture();if(source==="create")f.preparation.originalReplayFingerprint="0".repeat(64);else f.preparation.originalStopReplayFingerprint="0".repeat(64);
    await expect(corroborateManagedDatabaseDeleteOrigins(f.options,f.preparation,f.context,f.fence)).rejects.toThrow();
    expect(f.originalTransport.readReceipt).not.toHaveBeenCalled();expect(f.originalStopTransport.readReceipt).not.toHaveBeenCalled();
  }
  const f=fixture();f.originalStopTransport.readReceipt.mockResolvedValue({...f.originalStopReceipt,networkId:"0".repeat(64)});
  await expect(corroborateManagedDatabaseDeleteOrigins(f.options,f.preparation,f.context,f.fence)).rejects.toThrow();expect(f.controls.resolve).not.toHaveBeenCalled();
});
it("bounds both control/cache ports, cancellation, configuration and current project access",async()=>{
  for(const stage of ["command","cache"]){const f=fixture();f.options.deadlineMs=5;
    if(stage==="command")f.controls.findProjectUpdateById.mockImplementation(()=>new Promise(()=>{}));else f.originalStopTransport.readReceipt.mockImplementation(()=>new Promise(()=>{}));
    await expect(corroborateManagedDatabaseDeleteOrigins(f.options,f.preparation,f.context,f.fence)).rejects.toThrow();expect(f.originalStopTransport.dispatch).not.toHaveBeenCalled();
  }
  const f=fixture();f.fence.mockRejectedValue(new Error("revoked"));await expect(corroborateManagedDatabaseDeleteOrigins(f.options,f.preparation,f.context,f.fence)).rejects.toThrow();expect(f.controls.findProjectUpdateById).not.toHaveBeenCalled();
  const canceled=fixture(),abort=new AbortController();abort.abort();await expect(corroborateManagedDatabaseDeleteOrigins(canceled.options,canceled.preparation,{...canceled.context,signal:abort.signal},canceled.fence)).rejects.toThrow();expect(canceled.controls.findProjectUpdateById).not.toHaveBeenCalled();
});

it("rechecks changed configured scope after awaiting current authorization before either cache read",async()=>{
  const f=fixture();let checks=0;f.fence.mockImplementation(async()=>{if(++checks===6)f.options.agentId="foreign";});
  await expect(corroborateManagedDatabaseDeleteOrigins(f.options,f.preparation,f.context,f.fence)).rejects.toThrow();
  expect(f.originalTransport.readReceipt).not.toHaveBeenCalled();expect(f.originalStopTransport.readReceipt).not.toHaveBeenCalled();
});

it("corroborates original ready execution without requiring any manual STOP source",async()=>{
 const f=fixture(),{originalStopReceipt:_stop,originalStopReplayFingerprint:_fp,...ready}=f.preparation;
 await expect(corroborateManagedDatabaseDeleteOrigins({...f.options,originalStopTransport:undefined},ready,f.context,f.fence)).resolves.toBeUndefined();
 expect(f.originalTransport.readReceipt).toHaveBeenCalledOnce();expect(f.originalStopTransport.readReceipt).not.toHaveBeenCalled();expect(f.controls.claimProjectUpdate).not.toHaveBeenCalled();expect(f.controls.resolve).not.toHaveBeenCalled();
});
