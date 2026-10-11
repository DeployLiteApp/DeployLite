import type {createManagedDatabaseDaemonStopper} from "./docker-managed-database-daemon-stop.js";
import {expect,it,vi} from "vitest";
import {InMemoryCapabilityRegistry,managedDatabaseRuntimeReceiptSchema,managedDatabaseStopAgentCommandSchema} from "@deploylite/contracts";
import {planManagedDatabaseProfile,managedDatabaseRuntimeExecutionDigest,managedDatabaseStopExecutionDigest} from "@deploylite/domain";
import {createManagedDatabaseStopExecutor} from "./docker-managed-database-stop-executor.js";
const engines=["postgres","mysql","mariadb","mongodb","redis"] as const;
function fixture(engine:typeof engines[number]="postgres"){
    let now=1000;
    const policy={policyVersion:"images-1",trustedHosts:["registry.example.com"],allowTags:false,allowDigests:true};
    const request={schemaVersion:1 as const,projectId:"project-a",databaseId:"orders",engine};
    const profile={schemaVersion:1,profileId:"profile-"+engine,engine,image:`registry.example.com/${engine}@sha256:${"a".repeat(64)}`,
        dataPath:{postgres:"/var/lib/postgresql",mysql:"/var/lib/mysql",mariadb:"/var/lib/mysql",mongodb:"/data/db",redis:"/data"}[engine],containerPort:{postgres:5432,mysql:3306,mariadb:3306,mongodb:27017,redis:6379}[engine],credentialKeys:["DATABASE_PASSWORD"],backupStrategy:engine==="redis"?"volume-quiesced":"engine-native"};
    const plan=planManagedDatabaseProfile(request,profile,policy),input={...request,profileId:profile.profileId,planDigest:plan.planDigest,environmentFingerprint:"b".repeat(32)};
    const original=managedDatabaseRuntimeReceiptSchema.parse({...request,action:"database.runtime",agentId:"agent-a",commandId:"origin-a",inputDigest:managedDatabaseRuntimeExecutionDigest(input),planDigest:plan.planDigest,environmentFingerprint:input.environmentFingerprint,correlationId:"origin-correlation",
        containerId:"c".repeat(64),imageId:"sha256:"+"d".repeat(64),volumeName:plan.volume.runtimeName,networkName:plan.network.runtimeName,networkId:"e".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",observedAt:1000,status:"ready",health:"passed",storage:"verified",idempotent:false,redacted:true});
    const preparation={...input,originalReceipt:original,originalReplayFingerprint:"f".repeat(64)},inputDigest=managedDatabaseStopExecutionDigest(preparation),lease={projectId:request.projectId,leaseId:"stop-lease",fence:2,expiresAt:10000};
    const command=managedDatabaseStopAgentCommandSchema.parse({...preparation,action:"database.runtime.stop",operation:"database.runtime.stop",agentId:"agent-a",commandId:"stop-a",idempotencyKey:"stop-key",inputDigest,requiredCapabilities:["database.runtime.stop.v1"],
        authority:{schemaVersion:1,projectId:request.projectId,commandId:"stop-a",action:"project.update",inputDigest,projectLease:lease},lease,context:{requestId:"stop-request",correlationId:"stop-correlation"},timeoutMs:1000,cancellationRequested:false});
    const stopper={stop:vi.fn<ReturnType<typeof createManagedDatabaseDaemonStopper>["stop"]>(async()=>({containerId:original.containerId!}))},authority={assertValid:vi.fn(async()=>{})};
    const options={agentId:"agent-a",profiles:{[engine]:profile},imagePolicy:policy,capabilities:new InMemoryCapabilityRegistry(["database.runtime.stop.v1"]),clock:{now:()=>now},stopper,limits:{deadlineMs:1000}};
    return {request,profile,plan,input,original,command,stopper,authority,options,executor:createManagedDatabaseStopExecutor(options),setNow:(value:number)=>{now=value;}};
}
it.each(engines)("stops the original configured %s identity under the new authority without credential access",async engine=>{
    const f=fixture(engine),result=await f.executor.stop(f.command,f.authority,new AbortController().signal);
    expect(result).toMatchObject({...f.request,profileId:f.profile.profileId,action:"database.runtime.stop",commandId:f.command.commandId,originalCommandId:f.original.commandId,inputDigest:f.command.inputDigest,
        containerId:f.original.containerId,imageId:f.original.imageId,networkId:f.original.networkId,volumeCreatedAt:f.original.volumeCreatedAt,status:"stopped",storage:"verified",redacted:true});
    expect(result).not.toHaveProperty("health");expect(result).not.toHaveProperty("sealedEnvironment");expect(Object.isFrozen(result)).toBe(true);
    expect(f.stopper.stop).toHaveBeenCalledOnce();expect(f.stopper.stop.mock.calls[0]![0]).toEqual({request:f.request,profile:f.profile,commandId:f.original.commandId,imageId:f.original.imageId,containerId:f.original.containerId,environmentFingerprint:f.input.environmentFingerprint});
    expect(f.stopper.stop.mock.calls[0]![1]).toEqual({projectId:f.request.projectId,databaseId:f.request.databaseId,commandId:f.original.commandId,planDigest:f.plan.planDigest,volume:{name:f.original.volumeName,createdAt:f.original.volumeCreatedAt},network:{name:f.original.networkName,id:f.original.networkId}});
});
it("rejects changed approved plan/profile, stop digest, agent and capability before any stop",async()=>{
    for(const mode of ["plan","profile","digest","agent","capability"]){const f=fixture();let command=f.command;
        if(mode==="plan")command={...command,planDigest:"0".repeat(64),originalReceipt:{...command.originalReceipt,planDigest:"0".repeat(64)}};
        if(mode==="profile")command={...command,profileId:"foreign"};if(mode==="digest")command={...command,inputDigest:"0".repeat(64),authority:{...command.authority,inputDigest:"0".repeat(64)}};
        if(mode==="agent")command={...command,agentId:"foreign",originalReceipt:{...command.originalReceipt,agentId:"foreign"}};
        const executor=mode==="capability"?createManagedDatabaseStopExecutor({...f.options,capabilities:new InMemoryCapabilityRegistry([])}):f.executor;
        await expect(executor.stop(command,f.authority,new AbortController().signal)).rejects.toThrow();expect(f.stopper.stop).not.toHaveBeenCalled();}
});
it("refuses authority revocation, detached stop results and late revocation without retry",async()=>{
    for(const stage of ["before","identity","after"]){const f=fixture();if(stage==="before")f.authority.assertValid.mockRejectedValue(new Error("revoked"));if(stage==="identity")f.stopper.stop.mockResolvedValue({containerId:"a".repeat(64)});
        if(stage==="after")f.stopper.stop.mockImplementation(async()=>{f.authority.assertValid.mockRejectedValue(new Error("revoked"));return {containerId:f.original.containerId!};});
        await expect(f.executor.stop(f.command,f.authority,new AbortController().signal)).rejects.toThrow();expect(f.stopper.stop).toHaveBeenCalledTimes(stage==="before"?0:1);}
});
it("bounds stalled ports and rejects expired or canceled work without repeating stop",async()=>{
    const f=fixture();f.stopper.stop.mockImplementation(()=>new Promise(()=>{}));
    const executor=createManagedDatabaseStopExecutor({...f.options,limits:{deadlineMs:5}});await expect(executor.stop(f.command,f.authority,new AbortController().signal)).rejects.toThrow();expect(f.stopper.stop).toHaveBeenCalledOnce();
    const expired=fixture();expired.setNow(10000);await expect(expired.executor.stop(expired.command,expired.authority,new AbortController().signal)).rejects.toThrow();expect(expired.stopper.stop).not.toHaveBeenCalled();
    const canceled=fixture(),abort=new AbortController();abort.abort();await expect(canceled.executor.stop(canceled.command,canceled.authority,abort.signal)).rejects.toThrow();expect(canceled.stopper.stop).not.toHaveBeenCalled();
});
it("copies original inputs before authority waits and refuses invalid explicit limits",async()=>{
    const f=fixture();f.authority.assertValid.mockImplementation(async()=>{f.command.originalReceipt.containerId="a".repeat(64);f.command.originalReceipt.networkId="a".repeat(64);});
    await expect(f.executor.stop(f.command,f.authority,new AbortController().signal)).resolves.toHaveProperty("containerId",f.original.containerId);
    for(const limits of [{deadlineMs:0},{deadlineMs:60001}])expect(()=>createManagedDatabaseStopExecutor({...f.options,limits})).toThrow();
});
