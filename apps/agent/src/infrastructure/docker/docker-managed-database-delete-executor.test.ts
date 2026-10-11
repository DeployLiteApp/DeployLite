import {expect,it,vi} from "vitest";
import {InMemoryCapabilityRegistry,managedDatabaseRuntimeReceiptSchema,managedDatabaseDeleteAgentCommandSchema} from "@deploylite/contracts";
import {planManagedDatabaseProfile,managedDatabaseRuntimeExecutionDigest,managedDatabaseDeleteExecutionDigest} from "@deploylite/domain";
import {createManagedDatabaseDeleteExecutor} from "./docker-managed-database-delete-executor.js";
const engines=["postgres","mysql","mariadb","mongodb","redis"] as const;
function fixture(engine:typeof engines[number]="postgres",running=true){
 let now=2000;
 const policy={policyVersion:"images-1",trustedHosts:["registry.example.com"],allowTags:false,allowDigests:true},request={schemaVersion:1 as const,projectId:"project-a",databaseId:"orders",engine};
 const profile={schemaVersion:1,profileId:"profile-"+engine,engine,image:`registry.example.com/${engine}@sha256:${"a".repeat(64)}`,dataPath:{postgres:"/var/lib/postgresql",mysql:"/var/lib/mysql",mariadb:"/var/lib/mysql",mongodb:"/data/db",redis:"/data"}[engine],containerPort:{postgres:5432,mysql:3306,mariadb:3306,mongodb:27017,redis:6379}[engine],credentialKeys:["DATABASE_PASSWORD"],backupStrategy:engine==="redis"?"volume-quiesced":"engine-native"};
 const plan=planManagedDatabaseProfile(request,profile,policy),input={...request,profileId:profile.profileId,planDigest:plan.planDigest,environmentFingerprint:"b".repeat(32)};
 const original=managedDatabaseRuntimeReceiptSchema.parse({...request,action:"database.runtime",agentId:"agent-a",commandId:"origin-a",inputDigest:managedDatabaseRuntimeExecutionDigest(input),planDigest:plan.planDigest,environmentFingerprint:input.environmentFingerprint,correlationId:"origin-correlation",containerId:"c".repeat(64),imageId:"sha256:"+"d".repeat(64),volumeName:plan.volume.runtimeName,networkName:plan.network.runtimeName,networkId:"e".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",observedAt:1000,status:"ready",health:"passed",storage:"verified",idempotent:false,redacted:true});
 const preparation={...input,originalReceipt:original,originalReplayFingerprint:"f".repeat(64)},inputDigest=managedDatabaseDeleteExecutionDigest(preparation),lease={projectId:request.projectId,leaseId:"delete-lease",fence:3,expiresAt:10000};
 const command=managedDatabaseDeleteAgentCommandSchema.parse({...preparation,action:"database.runtime.delete",operation:"database.runtime.delete",storagePolicy:"retain-original",stopPolicy:"if-running",confirmationId:"confirmation-a",agentId:"agent-a",commandId:"delete-a",idempotencyKey:"delete-key",inputDigest,requiredCapabilities:["database.runtime.delete.v1"],authority:{schemaVersion:1,projectId:request.projectId,commandId:"delete-a",action:"project.update",inputDigest,projectLease:lease},lease,context:{requestId:"delete-request",correlationId:"delete-correlation"},timeoutMs:1000,cancellationRequested:false});
 const events:string[]=[],inspector={inspectContainer:vi.fn(async()=>{events.push("inspect");return {id:original.containerId!,running};})},stopper={stop:vi.fn(async()=>{events.push("stop");return {containerId:original.containerId!};})},remover={remove:vi.fn(async(..._args:unknown[])=>{events.push("remove");return {containerId:original.containerId!,storage:"retained" as const};})};
 const authority={assertValid:vi.fn(async()=>{events.push("authority");}),assertConfirmed:vi.fn(async()=>{events.push("confirmation");})};
 const options={agentId:"agent-a",profiles:{[engine]:profile},imagePolicy:policy,capabilities:new InMemoryCapabilityRegistry(["database.runtime.delete.v1"]),clock:{now:()=>now},inspector,stopper,remover,limits:{deadlineMs:1000}};
 return {request,profile,plan,input,original,preparation,command,events,inspector,stopper,remover,authority,options,executor:createManagedDatabaseDeleteExecutor(options),setNow:(value:number)=>{now=value;}};
}
it.each(engines)("conditionally stops then retires only original confirmed %s daemon retaining storage",async engine=>{
 for(const running of [false,true]){const f=fixture(engine,running);
  const result=await f.executor.delete(f.command,f.authority,new AbortController().signal);
  expect(result).toMatchObject({...f.request,action:"database.runtime.delete",commandId:f.command.commandId,originalCommandId:f.original.commandId,originalStopCommandId:null,confirmationId:f.command.confirmationId,inputDigest:f.command.inputDigest,containerId:f.original.containerId,imageId:f.original.imageId,volumeName:f.original.volumeName,networkId:f.original.networkId,status:"removed",storage:"retained",redacted:true});
  expect(Object.isFrozen(result)).toBe(true);expect(result).not.toHaveProperty("sealedEnvironment");expect(result).not.toHaveProperty("health");
  expect(f.stopper.stop).toHaveBeenCalledTimes(running?1:0);expect(f.remover.remove).toHaveBeenCalledOnce();
  expect(f.events.indexOf("confirmation")).toBeLessThan(f.events.indexOf("inspect"));if(running)expect(f.events.indexOf("stop")).toBeLessThan(f.events.indexOf("remove"));
  expect(f.authority.assertConfirmed).toHaveBeenCalledWith(f.command.authority,f.command.confirmationId);
  expect(f.remover.remove.mock.calls[0]![0]).toEqual({request:f.request,profile:f.profile,commandId:f.original.commandId,imageId:f.original.imageId,containerId:f.original.containerId,environmentFingerprint:f.input.environmentFingerprint});
 }
});
it("rejects missing or revoked confirmed authority before inspector or effects",async()=>{
 for(const mode of ["missing","ordinary","confirmed"]){const f=fixture(),authority=mode==="missing"?{assertValid:f.authority.assertValid}:f.authority;
  if(mode==="ordinary")f.authority.assertValid.mockRejectedValue(new Error("revoked"));if(mode==="confirmed")f.authority.assertConfirmed.mockRejectedValue(new Error("unconfirmed"));
  await expect(f.executor.delete(f.command,authority,new AbortController().signal)).rejects.toThrow();expect(f.inspector.inspectContainer).not.toHaveBeenCalled();expect(f.remover.remove).not.toHaveBeenCalled();expect(f.stopper.stop).not.toHaveBeenCalled();
 }
});
it("refuses detached inspection stop or retained result without retry or fabricated receipt",async()=>{
 for(const stage of ["inspect","stop","remove","revokedAfterStop"]){const f=fixture();
  if(stage==="inspect")f.inspector.inspectContainer.mockResolvedValue({id:"0".repeat(64),running:true});
  if(stage==="stop")f.stopper.stop.mockResolvedValue({containerId:"0".repeat(64)});
  if(stage==="remove")f.remover.remove.mockResolvedValue({containerId:"0".repeat(64),storage:"retained"});
  if(stage==="revokedAfterStop")f.stopper.stop.mockImplementation(async()=>{f.authority.assertConfirmed.mockRejectedValue(new Error("revoked"));return {containerId:f.original.containerId!};});
  await expect(f.executor.delete(f.command,f.authority,new AbortController().signal)).rejects.toThrow();expect(f.stopper.stop.mock.calls.length).toBeLessThanOrEqual(1);expect(f.remover.remove).toHaveBeenCalledTimes(stage==="remove"?1:0);
 }
});
it("rejects detached plan digest agent capability expiry and cancellation before any effect",async()=>{
 for(const mode of ["digest","profile","agent","capability","expired","canceled"]){const f=fixture();let command=f.command,executor=f.executor;const signal=new AbortController();
  if(mode==="digest")command={...command,inputDigest:"0".repeat(64),authority:{...command.authority,inputDigest:"0".repeat(64)}};
  if(mode==="profile")command={...command,profileId:"foreign"};if(mode==="agent")command={...command,agentId:"foreign",originalReceipt:{...command.originalReceipt,agentId:"foreign"}};
  if(mode==="capability")executor=createManagedDatabaseDeleteExecutor({...f.options,capabilities:new InMemoryCapabilityRegistry([])});if(mode==="expired")f.setNow(10000);if(mode==="canceled")signal.abort();
  await expect(executor.delete(command,f.authority,signal.signal)).rejects.toThrow();expect(f.stopper.stop).not.toHaveBeenCalled();expect(f.remover.remove).not.toHaveBeenCalled();
 }
});
it("bounds stalled inspection and never proceeds to removal after the deadline",async()=>{
 const f=fixture();f.inspector.inspectContainer.mockImplementation(()=>new Promise(()=>{}));const executor=createManagedDatabaseDeleteExecutor({...f.options,limits:{deadlineMs:5}});
 await expect(executor.delete(f.command,f.authority,new AbortController().signal)).rejects.toThrow();expect(f.inspector.inspectContainer).toHaveBeenCalledOnce();expect(f.remover.remove).not.toHaveBeenCalled();
});
