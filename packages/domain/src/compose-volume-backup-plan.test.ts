import { describe,expect,it,vi } from "vitest";
import { prepareComposeVolumeBackupPlan as prepare,InMemoryComposeVolumeBackupPlanStore as Store,type ComposeVolumeBackupPlanningDependencies as Dependencies,type PreparedComposeVolumeBackupPlan as Prepared } from "./compose-volume-backup-plan.js";
import { createComposePreview,digestComposeResourceObservation,InMemoryExecutionState,type AuditEventInput,type ComposeAttachmentPreviewDependencies,type ControlGrantRepository } from "./index.js";
import { InMemoryCapabilityRegistry,type ComposeVolumeBackupPlanningProfile as Profile,type ComposeResourceObservationV1 } from "@deploylite/contracts";

type StoreOptions=ConstructorParameters<typeof Store>[0];
const image="registry.example.com/app@sha256:"+"a".repeat(64);
const document=JSON.stringify({services:{app:{image,volumes:[{type:"volume",source:"data",target:"/data"}]}},volumes:{data:{}}});
const policy={policyVersion:"backup-test",trustedHosts:["registry.example.com"],allowTags:false,allowDigests:true};
const preview=createComposePreview(document,"project-1",policy);
function fixture(){
  const observation:ComposeResourceObservationV1={schemaVersion:1,owner:"deploylite",agentId:"agent-1",projectId:"project-1",kind:"volume",key:"data",runtimeName:preview.volumes[0]!.runtimeName,physicalIdentity:"2026-10-08T00:00:00Z",configDigest:preview.configDigest,stateDigest:"0".repeat(64),observedAt:1000,containers:[{containerId:"b".repeat(64),service:"app",running:false,attached:true,mounts:[{target:"/data",readOnly:false}]}]};
  const seal=()=>{observation.stateDigest=digestComposeResourceObservation(observation);};seal();
  const inspect=vi.fn(async(_input:unknown,_signal:AbortSignal)=>structuredClone(observation));
  const profile:Profile={owner:"deploylite",agentId:"agent-1",projectId:"project-1",profileId:"offline-profile-1",destinationId:"destination-1",maxBytes:1_000_000,maxEntries:1000,maxDurationMs:30_000,planTtlMs:60_000};
  const profiles=new Map([[profile.destinationId,profile]]);
  const deps:Dependencies={inspection:{imagePolicy:policy,owner:"deploylite",agentId:"agent-1",inspector:{inspect},clock:{now:()=>1010},maxAgeMs:100},capabilities:new InMemoryCapabilityRegistry(["compose.resource.inspect.v1"]),profiles,actorId:"actor-1",role:"operator",correlationId:"correlation-1",requestId:"request-1",idempotencyKey:"key-1",grants:{listForActor:vi.fn<ControlGrantRepository["listForActor"]>(async actorId=>[{id:"grant-1",actorId,action:"project.deploy",scope:{kind:"project",projectId:"project-1"}}])},deadlineMs:1000};
  const input={document,projectId:"project-1",key:"data",expectedConfigDigest:preview.configDigest,expectedStateDigest:observation.stateDigest,destinationId:"destination-1"};
  return{observation,seal,inspect,profile,profiles,deps,input};
}
async function checked(f:ReturnType<typeof fixture>):Promise<Prepared>{
  const pending=prepare(f.input,f.deps);await expect(pending).resolves.toHaveProperty("plan.status","preview");return pending;
}
describe("finite effect-free owned-volume backup planning",()=>{
  it("prepares a bounded offline plan with no artifact or execution authority",async()=>{
    const f=fixture(),p=prepare(f.input,f.deps);await expect(p).resolves.toMatchObject({plan:{schemaVersion:1,status:"preview",executionAllowed:false,archiveCreated:false,projectId:"project-1",volumeKey:"data",configDigest:preview.configDigest,stateDigest:f.observation.stateDigest,profileId:f.profile.profileId,destinationId:f.profile.destinationId,consistency:"offline-required",verification:"integrity-and-completeness-required",limits:{maxBytes:1_000_000,maxEntries:1000,maxDurationMs:30_000,planTtlMs:60_000}},command:{action:"project.deploy",scope:{kind:"project",projectId:"project-1"},status:"eligible"}});
    const result=await p;expect(result.command.executionAuthority).toBeUndefined();expect(result.command.result).toBeUndefined();expect(result.plan.planDigest).toMatch(/^[a-f0-9]{64}$/);expect(result.command.inputDigest).toBe(result.plan.planDigest);
  });
  it("uses only current C1 intent and the existing scoped inspection port",async()=>{
    const f=fixture(),signal=new AbortController().signal;await expect(prepare(f.input,f.deps,signal)).resolves.toHaveProperty("plan.archiveCreated",false);expect(f.inspect).toHaveBeenCalledOnce();expect(f.inspect.mock.calls[0]![0]).toMatchObject({kind:"volume",key:"data",preview:{projectId:"project-1",configDigest:preview.configDigest}});expect(f.inspect.mock.calls[0]![1].aborted).toBe(false);
  });
  for(const role of ["read-only","auditor"] as const)it(`rejects ${role} before inspecting`,async()=>{const f=fixture();f.deps.role=role;await expect(prepare(f.input,f.deps)).rejects.toMatchObject({code:"COMPOSE_BACKUP_FORBIDDEN"});expect(f.inspect).not.toHaveBeenCalled();});
  for(const variant of ["scope","action","actor"] as const)it(`rejects a mismatched ${variant} grant`,async()=>{
    const f=fixture();f.deps.grants={listForActor:async()=>[{id:"g",actorId:variant==="actor"?"foreign":f.deps.actorId,action:variant==="action"?"project.update":"project.deploy",scope:{kind:"project",projectId:variant==="scope"?"foreign":"project-1"}}]};await expect(prepare(f.input,f.deps)).rejects.toMatchObject({code:"COMPOSE_BACKUP_FORBIDDEN"});expect(f.inspect).not.toHaveBeenCalled();
  });
  for(const variant of ["profile","capability"] as const)it(`requires explicit available ${variant}`,async()=>{
    const f=fixture();if(variant==="profile")f.profiles.clear();else f.deps.capabilities=new InMemoryCapabilityRegistry([]);await expect(prepare(f.input,f.deps)).rejects.toMatchObject({code:"COMPOSE_BACKUP_UNAVAILABLE"});expect(f.inspect).not.toHaveBeenCalled();
  });
  for(const field of ["owner","agentId","projectId"] as const)it(`rejects foreign profile ${field}`,async()=>{
    const f=fixture();f.profile[field]="foreign";await expect(prepare(f.input,f.deps)).rejects.toMatchObject({code:"COMPOSE_BACKUP_FOREIGN"});expect(f.inspect).not.toHaveBeenCalled();
  });
  it.each([{kind:"network"},{destinationId:"/tmp/user-data"},{execute:true},{maxBytes:123},{document:"é".repeat(32769)}])("rejects caller destinations/limits/authority outside the closed request %#",async extra=>{
    const f=fixture();await expect(prepare({...f.input,...extra},f.deps)).rejects.toMatchObject({code:"COMPOSE_BACKUP_INVALID"});expect(f.inspect).not.toHaveBeenCalled();
  });
  for(const field of ["maxBytes","maxEntries","maxDurationMs","planTtlMs"] as const)it(`requires a finite positive ${field}`,async()=>{
    const f=fixture();f.profile[field]=Infinity;await expect(prepare(f.input,f.deps)).rejects.toMatchObject({code:"COMPOSE_BACKUP_INVALID"});expect(f.inspect).not.toHaveBeenCalled();
  });
  it("refuses an attached running consumer without stopping it",async()=>{
    const f=fixture();f.observation.containers[0]!.running=true;f.seal();f.input.expectedStateDigest=f.observation.stateDigest;await expect(prepare(f.input,f.deps)).rejects.toMatchObject({code:"COMPOSE_BACKUP_IN_USE"});
  });
  it("allows zero consumers and ignores a running detached container",async()=>{
    const f=fixture();f.observation.containers=[];f.seal();f.input.expectedStateDigest=f.observation.stateDigest;await expect(prepare(f.input,f.deps)).resolves.toHaveProperty("plan.executionAllowed",false);
    f.observation.containers=[{containerId:"b".repeat(64),service:"app",running:true,attached:false,mounts:[]}];f.seal();f.input.expectedStateDigest=f.observation.stateDigest;await expect(prepare(f.input,f.deps)).resolves.toHaveProperty("plan.executionAllowed",false);
  });
  for(const field of ["expectedConfigDigest","expectedStateDigest"] as const)it(`refuses stale ${field}`,async()=>{const f=fixture();f.input[field]="f".repeat(64);await expect(prepare(f.input,f.deps)).rejects.toMatchObject({code:"COMPOSE_BACKUP_STALE"});});
  it("rejects stale observations and foreign or corrupt physical bindings",async()=>{
    const f=fixture();f.observation.observedAt=100;await expect(prepare(f.input,f.deps)).rejects.toMatchObject({code:"COMPOSE_BACKUP_STALE"});f.observation.observedAt=1000;f.observation.owner="foreign";f.seal();await expect(prepare(f.input,f.deps)).rejects.toMatchObject({code:"COMPOSE_BACKUP_FOREIGN"});
  });
  it("rejects a revoked capability or replaced profile before emitting a plan",async()=>{
    const f=fixture();let active=true;f.deps.capabilities={has:()=>active};f.deps.inspection.inspector.inspect=async()=>{active=false;return structuredClone(f.observation);};await expect(prepare(f.input,f.deps)).rejects.toMatchObject({code:"COMPOSE_BACKUP_UNAVAILABLE"});
    active=true;f.deps.inspection.inspector.inspect=async()=>{f.profiles.set("destination-1",{...f.profile});return structuredClone(f.observation);};await expect(prepare(f.input,f.deps)).rejects.toMatchObject({code:"COMPOSE_BACKUP_STALE"});
  });
  it("bounds a noncooperating metadata port and propagates deadline cancellation",async()=>{
    const f=fixture();f.deps.deadlineMs=10;let seen:AbortSignal|undefined;f.deps.inspection.inspector.inspect=async(_input,signal)=>{seen=signal;return new Promise(()=>undefined);};await expect(prepare(f.input,f.deps)).rejects.toMatchObject({code:"COMPOSE_BACKUP_FAILED"});expect(seen?.aborted).toBe(true);
  });
  it("refuses cancellation and masks raw port diagnostics",async()=>{
    const f=fixture(),abort=new AbortController();abort.abort();await expect(prepare(f.input,f.deps,abort.signal)).rejects.toMatchObject({code:"COMPOSE_BACKUP_FAILED"});expect(f.inspect).not.toHaveBeenCalled();
    f.deps.inspection.inspector.inspect=async()=>{throw new Error("password=must-not-reflect");};await expect(prepare(f.input,f.deps)).rejects.toMatchObject({code:"COMPOSE_BACKUP_FAILED",message:"Volume backup planning is unavailable or outside policy."});
  });
});
describe("shared-ledger backup plan receipt and audit",()=>{
  function sink(){const ledger=new InMemoryExecutionState(),audit:AuditEventInput[]=[];const options:StoreOptions={ledger,appendAudit:entry=>{audit.push(structuredClone(entry));},clock:()=>1010};return{ledger,audit,options,store:new Store(options)};}
  it("commits one metadata receipt and audit to the existing shared command ledger",async()=>{
    const f=fixture(),prepared=await checked(f),s=sink();await expect(s.store.save(prepared)).resolves.toMatchObject({commandId:prepared.command.id,plan:prepared.plan,idempotent:false});expect(s.ledger.commands.size).toBe(1);expect([...s.ledger.commands.values()][0]!.status).toBe("completed");expect(s.audit).toEqual([expect.objectContaining({actorUserId:"actor-1",action:"compose.volume.backup.planned",targetType:"project",targetId:"project-1",requestId:"request-1",correlationId:"correlation-1",metadata:expect.objectContaining({inputDigest:prepared.command.inputDigest,volumeKey:"data"})})]);expect(JSON.stringify(s.audit)).not.toContain("/data");expect(JSON.stringify(s.audit)).not.toContain(image);
  });
  it("returns the original receipt on identical and concurrent retry without duplicate audit",async()=>{
    const f=fixture(),a=await checked(f),b=await checked(f),s=sink();const [first,second]=await Promise.all([s.store.save(a),s.store.save(b)]);expect(second).toEqual({...first,idempotent:true});expect(s.audit).toHaveLength(1);expect(s.ledger.commands.size).toBe(1);
  });
  it("conflicts when the same key asks for different backup limits",async()=>{
    const f=fixture(),first=await checked(f),s=sink();await s.store.save(first);f.profile.maxBytes++;const changed=await checked(f);await expect(s.store.save(changed)).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});expect(s.audit).toHaveLength(1);
  });
  it("does not collide with other actors in the shared ledger",async()=>{
    const f=fixture(),first=await checked(f),s=sink();await s.store.save(first);f.deps.actorId="actor-2";const second=await checked(f);await s.store.save(second);expect(s.ledger.commands.size).toBe(2);expect(s.audit).toHaveLength(2);
  });
  it("does not publish a command if the required synchronous audit fails",async()=>{
    const f=fixture(),prepared=await checked(f),s=sink();s.options.appendAudit=()=>{throw new Error("audit-private");};await expect(s.store.save(prepared)).rejects.toMatchObject({code:"COMPOSE_BACKUP_FAILED"});expect(s.ledger.commands.size).toBe(0);
  });
  it("rejects an async sink rather than claiming atomic durable evidence",async()=>{
    const f=fixture(),prepared=await checked(f),s=sink();s.options.appendAudit=async()=>undefined;await expect(s.store.save(prepared)).rejects.toMatchObject({code:"COMPOSE_BACKUP_FAILED"});expect(s.ledger.commands.size).toBe(0);
  });
  it("rejects expired plans and a changed prepared receipt",async()=>{
    const f=fixture(),prepared=await checked(f),s=sink();s.options.clock=()=>100_000;await expect(s.store.save(prepared)).rejects.toMatchObject({code:"COMPOSE_BACKUP_EXPIRED"});expect(s.ledger.commands.size).toBe(0);
    s.options.clock=()=>1010;prepared.plan.destinationId="foreign";await expect(s.store.save(prepared)).rejects.toMatchObject({code:"COMPOSE_BACKUP_INVALID"});expect(s.ledger.commands.size).toBe(0);
  });
  it("does not turn a planning receipt into an execution-authorized command",async()=>{
    const f=fixture(),prepared=await checked(f),s=sink();prepared.command.status="dispatching";await expect(s.store.save(prepared)).rejects.toMatchObject({code:"COMPOSE_BACKUP_INVALID"});expect(s.ledger.commands.size).toBe(0);
  });
  it("keeps the stored command isolated from returned objects",async()=>{
    const f=fixture(),prepared=await checked(f),s=sink(),first=await s.store.save(prepared);first.plan.destinationId="foreign";const again=await s.store.save(prepared);expect(again.plan.destinationId).toBe("destination-1");expect(s.audit).toHaveLength(1);
  });
  it("captures the prepared plan before invoking the injected clock",async()=>{
    const f=fixture(),prepared=await checked(f),s=sink();s.options.clock=()=>{prepared.plan.destinationId="foreign";return 1010;};
    await expect(s.store.save(prepared)).resolves.toHaveProperty("plan.destinationId","destination-1");
  });
});
