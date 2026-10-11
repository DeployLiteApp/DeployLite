import { expect, it, vi } from "vitest";
import { MANAGED_DATABASE_RUNTIME_CAPABILITY, MANAGED_DATABASE_STOP_CAPABILITY, type ManagedDatabaseStopReceiptV1, type ManagedDatabaseStartReceiptV1 } from "@deploylite/contracts";
import { composeRuntimeResourceName, createControlCommand, managedDatabaseRuntimeExecutionBinding,
  managedDatabaseRuntimeReplayFingerprintDigest, managedDatabaseStopExecutionBinding, managedDatabaseStopReplayFingerprintDigest, resolveControlCommandInMemory,
  type ControlCommand, type ProjectUpdateControlRepository } from "@deploylite/domain";
import { startManagedDatabaseRuntime } from "./managed-database-start.js";

function fixture() {
  let now = 1000;
  const ledger = new Map<string, ControlCommand>(), cache = new Map<string, ManagedDatabaseStartReceiptV1>();
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
  const receiptFor = (command: ControlCommand): ManagedDatabaseStartReceiptV1 => ({ ...base, action: "database.runtime.start",
    agentId: "agent-a", commandId: command.id, originalCommandId: original.id, originalStopCommandId:originalStop.id, inputDigest: command.inputDigest,
    correlationId: command.correlationId, containerId: originalReceipt.containerId, imageId: originalReceipt.imageId,
    volumeName: originalReceipt.volumeName, networkName: originalReceipt.networkName, networkId: originalReceipt.networkId,
    volumeCreatedAt: originalReceipt.volumeCreatedAt, observedAt: now, status: "ready", health:"passed",idempotent:false, storage: "verified", redacted: true });
  const transport = { available: vi.fn(() => true),
    readReceipt: vi.fn(async (prepared: { command: ControlCommand }) => cache.get(prepared.command.id) ?? null),
    dispatch: vi.fn(async (prepared: { command: ControlCommand }) => { const receipt = receiptFor(prepared.command); cache.set(prepared.command.id, receipt); return receipt; }) };
  const originalStopTransport={available:vi.fn(()=>true),readReceipt:vi.fn(async()=>structuredClone(originalStopReceipt)),dispatch:vi.fn(async()=>{throw new Error("original stop forbidden");})};
  const authorize=vi.fn(async()=>true),current=vi.fn(()=>true),admit=vi.fn(async()=>{});
  const options={controls,transport,originalTransport,originalStopTransport,agentId:"agent-a",now:()=>now,commandTtlMs:1000,deadlineMs:1000};
  const input={preparation,actorId:"current-operator",idempotencyKey:"start-orders",context:{requestId:"start-request",correlationId:"start-correlation"},authorize,current,admit};
  return {original,originalStop,ledger,cache,controls,transport,originalTransport,originalStopTransport,receiptFor,options,input,authorize,current,admit,advance:()=>{now=4000;}};
}

it("corroborates another operator's original cache then starts once and atomically audits public evidence", async () => {
  const f = fixture(),work=startManagedDatabaseRuntime(f.options,f.input);
  await expect(work).resolves.toMatchObject({ready:true});const result=await work;
  expect(result).toMatchObject({ command: { status: "completed" }, ready: true, idempotent: false });
  expect(result.command.id).not.toBe(f.original.id);
  expect(f.controls.findProjectUpdateById).toHaveBeenCalledWith("project-a", f.original.id);
  expect(f.originalTransport.dispatch).not.toHaveBeenCalled();expect(f.originalStopTransport.dispatch).not.toHaveBeenCalled();
  expect(f.controls.findProjectUpdateById).toHaveBeenCalledWith("project-a",f.originalStop.id);
  expect(f.transport.dispatch).toHaveBeenCalledTimes(1); expect(f.controls.claimProjectUpdate).toHaveBeenCalledTimes(1);
  expect(f.controls.completeProjectUpdate).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
    actorUserId: "current-operator", action: "database.runtime.started", metadata: expect.objectContaining({ receipt: result.receipt, redacted: true }) }));
});
it("reconciles a lost start reply exclusively from its cache", async () => {
  const f = fixture(); f.transport.dispatch.mockImplementation(async prepared => { f.cache.set(prepared.command.id, f.receiptFor(prepared.command)); throw new Error("lost"); });
  await expect(startManagedDatabaseRuntime(f.options,f.input)).resolves.toMatchObject({ready:true});
  expect(f.transport.dispatch).toHaveBeenCalledTimes(1); expect(f.originalTransport.readReceipt).toHaveBeenCalledTimes(1);
});
it("replays an expired completed start without original lookup, admission or execution", async () => {
  const f = fixture(); await startManagedDatabaseRuntime(f.options, f.input); f.advance();
  f.controls.findProjectUpdateById.mockClear(); f.originalTransport.readReceipt.mockClear();f.originalStopTransport.readReceipt.mockClear();
  f.originalTransport.available.mockReturnValue(false);f.originalStopTransport.available.mockReturnValue(false); f.admit.mockClear(); f.transport.dispatch.mockClear();
  await expect(startManagedDatabaseRuntime(f.options,f.input)).resolves.toMatchObject({idempotent:true});
  expect(f.controls.findProjectUpdateById).not.toHaveBeenCalled(); expect(f.originalTransport.readReceipt).not.toHaveBeenCalled();
  expect(f.admit).not.toHaveBeenCalled(); expect(f.transport.dispatch).not.toHaveBeenCalled();expect(f.originalStopTransport.readReceipt).not.toHaveBeenCalled();
});
it("rejects missing or detached original commands before creating or claiming a start", async () => {
  for (const mode of ["missing", "project", "command", "action", "digest", "correlation", "status"]) {
    const f = fixture(), original = structuredClone(f.original);
    if (mode === "project") original.scope = { kind: "project", projectId: "other" };
    if (mode === "command") original.id = "other";
    if (mode === "action") original.action = "deployment.stop";
    if (mode === "digest") original.inputDigest = "0".repeat(64);
    if (mode === "correlation") original.correlationId = "other";
    if (mode === "status") original.status = "dispatching";
    f.controls.findProjectUpdateById.mockResolvedValue(mode === "missing" ? null : original);
    await expect(startManagedDatabaseRuntime(f.options, f.input)).rejects.toThrow("Database native start");
    expect(f.controls.resolve).not.toHaveBeenCalled(); expect(f.transport.dispatch).not.toHaveBeenCalled();
  }
});
it("rejects forged opaque fingerprints before requesting original cache", async () => {
  const f = fixture(); f.input.preparation.originalReplayFingerprint = "0".repeat(64);
  await expect(startManagedDatabaseRuntime(f.options, f.input)).rejects.toThrow();
  expect(f.originalTransport.readReceipt).not.toHaveBeenCalled(); expect(f.controls.claimProjectUpdate).not.toHaveBeenCalled();
});
it("rejects changed original physical proof before new command admission", async () => {
  const f = fixture(); f.originalTransport.readReceipt.mockResolvedValue({ ...f.input.preparation.originalReceipt, containerId: "f".repeat(64) });
  await expect(startManagedDatabaseRuntime(f.options, f.input)).rejects.toThrow();
  expect(f.controls.resolve).not.toHaveBeenCalled(); expect(f.transport.dispatch).not.toHaveBeenCalled();
});
it("denies revoked project access before any command or cache lookup", async () => {
  const f = fixture(); f.authorize.mockResolvedValue(false);
  await expect(startManagedDatabaseRuntime(f.options, f.input)).rejects.toThrow();
  expect(f.controls.findProjectUpdateByIdempotency).not.toHaveBeenCalled(); expect(f.transport.dispatch).not.toHaveBeenCalled();
});
it("rejects stale trusted configuration before original evidence reads", async () => {
  const f = fixture(); f.admit.mockRejectedValue(new Error("stale profile"));
  await expect(startManagedDatabaseRuntime(f.options, f.input)).rejects.toThrow();
  expect(f.controls.findProjectUpdateById).not.toHaveBeenCalled(); expect(f.transport.dispatch).not.toHaveBeenCalled();
});
it("never redispatches an unresolved attempted start with no cached receipt", async () => {
  const f = fixture(); f.transport.dispatch.mockRejectedValue(new Error("unknown"));
  await expect(startManagedDatabaseRuntime(f.options, f.input)).rejects.toThrow();
  await expect(startManagedDatabaseRuntime(f.options, f.input)).rejects.toThrow();
  expect(f.transport.dispatch).toHaveBeenCalledTimes(1); expect(f.controls.claimProjectUpdate).toHaveBeenCalledTimes(1);
});
it("repairs failed atomic completion from start cache without rechecking original or starting again", async () => {
  const f = fixture(); f.controls.completeProjectUpdate.mockRejectedValueOnce(new Error("audit failure"));
  await expect(startManagedDatabaseRuntime(f.options, f.input)).rejects.toThrow();
  f.controls.findProjectUpdateById.mockClear();
  await expect(startManagedDatabaseRuntime(f.options,f.input)).resolves.toMatchObject({ready:true});
  expect(f.controls.findProjectUpdateById).not.toHaveBeenCalled(); expect(f.transport.dispatch).toHaveBeenCalledTimes(1);
});
it("rejects a forged started container before completing the command", async () => {
  const f = fixture(); f.transport.dispatch.mockImplementation(async prepared => ({ ...f.receiptFor(prepared.command), containerId: "f".repeat(64) }));
  await expect(startManagedDatabaseRuntime(f.options, f.input)).rejects.toThrow();
  expect(f.controls.completeProjectUpdate).not.toHaveBeenCalled();
});
it("bounds stalled original reads before command admission", async () => {
  const f = fixture(); f.options.deadlineMs = 10; f.originalTransport.readReceipt.mockImplementation(() => new Promise(() => {}));
  await expect(startManagedDatabaseRuntime(f.options, f.input)).rejects.toThrow();
  expect(f.controls.resolve).not.toHaveBeenCalled(); expect(f.transport.dispatch).not.toHaveBeenCalled();
});
it("honors cancellation before any read or effect", async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  await expect(startManagedDatabaseRuntime(f.options, { ...f.input, signal: controller.signal })).rejects.toThrow();
  expect(f.controls.findProjectUpdateByIdempotency).not.toHaveBeenCalled(); expect(f.transport.dispatch).not.toHaveBeenCalled();
});
it("fences access revoked while the original receipt is read", async () => {
  const f = fixture(); f.originalTransport.readReceipt.mockImplementation(async () => { f.authorize.mockResolvedValue(false); return f.input.preparation.originalReceipt; });
  await expect(startManagedDatabaseRuntime(f.options, f.input)).rejects.toThrow();
  expect(f.controls.resolve).not.toHaveBeenCalled(); expect(f.transport.dispatch).not.toHaveBeenCalled();
});

it("withholds fresh start when the original signed cache transport is unavailable", async () => {
  const f = fixture(); f.originalTransport.available.mockReturnValue(false);
  await expect(startManagedDatabaseRuntime(f.options, f.input)).rejects.toThrow();
  expect(f.originalTransport.readReceipt).not.toHaveBeenCalled(); expect(f.transport.dispatch).not.toHaveBeenCalled();
});
it("rejects original authority detached from its persisted command", async () => {
  const f = fixture(), original = structuredClone(f.original);
  original.projectExecutionAuthority!.commandId = "foreign-command";
  f.controls.findProjectUpdateById.mockResolvedValue(original);
  await expect(startManagedDatabaseRuntime(f.options, f.input)).rejects.toThrow();
  expect(f.originalTransport.readReceipt).not.toHaveBeenCalled(); expect(f.controls.resolve).not.toHaveBeenCalled();
});
it("rejects changed preparations on an existing start key without repeated effects", async () => {
  const f = fixture(); await startManagedDatabaseRuntime(f.options, f.input);
  f.input.preparation.originalReplayFingerprint = "0".repeat(64);
  await expect(startManagedDatabaseRuntime(f.options, f.input)).rejects.toThrow();
  expect(f.transport.dispatch).toHaveBeenCalledTimes(1); expect(f.controls.claimProjectUpdate).toHaveBeenCalledTimes(1);
});

it("withholds own start admission when the original stopped transport or command is unavailable",async()=>{
  for(const stage of ["transport","command"]){const f=fixture();
    if(stage==="transport")f.originalStopTransport.available.mockReturnValue(false);
    else f.controls.findProjectUpdateById.mockImplementation(async(_projectId,id)=>id===f.originalStop.id?null:structuredClone(f.original));
    await expect(startManagedDatabaseRuntime(f.options,f.input)).rejects.toThrow();expect(f.controls.resolve).not.toHaveBeenCalled();expect(f.transport.dispatch).not.toHaveBeenCalled();
  }
});

it("withholds dispatch when trusted transport changes during the final authorization await",async()=>{
  const f=fixture();f.authorize.mockImplementation(async()=>{
    if(f.controls.validateProjectUpdateAuthority.mock.calls.length>=2&&f.transport.readReceipt.mock.calls.length===1&&!f.transport.dispatch.mock.calls.length)f.options.transport={...f.transport};
    return true;
  });
  await expect(startManagedDatabaseRuntime(f.options,f.input)).rejects.toThrow();expect(f.transport.dispatch).not.toHaveBeenCalled();
});
