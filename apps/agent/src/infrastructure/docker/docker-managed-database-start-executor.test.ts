import type {createManagedDatabaseDaemonStarter} from "./docker-managed-database-daemon-start.js";
import {expect,it,vi} from "vitest";
import {InMemoryCapabilityRegistry,managedDatabaseRuntimeReceiptSchema,managedDatabaseStartAgentCommandSchema} from "@deploylite/contracts";
import {planManagedDatabaseProfile,managedDatabaseRuntimeExecutionDigest,managedDatabaseStopExecutionDigest,managedDatabaseStartExecutionDigest} from "@deploylite/domain";
import {createManagedDatabaseStartExecutor} from "./docker-managed-database-start-executor.js";
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
    const stopPreparation={...input,originalReceipt:original,originalReplayFingerprint:"f".repeat(64)};
    const {health:_health,idempotent:_idempotent,...physical}=original;
    const stopped={...physical,action:"database.runtime.stop",commandId:"stop-a",originalCommandId:original.commandId,profileId:profile.profileId,
      inputDigest:managedDatabaseStopExecutionDigest(stopPreparation),correlationId:"stop-correlation",status:"stopped"};
    const preparation={...stopPreparation,originalStopReceipt:stopped,originalStopReplayFingerprint:"0".repeat(64)},inputDigest=managedDatabaseStartExecutionDigest(preparation),lease={projectId:request.projectId,leaseId:"start-lease",fence:2,expiresAt:10000};
    const command=managedDatabaseStartAgentCommandSchema.parse({...preparation,action:"database.runtime.start",operation:"database.runtime.start",agentId:"agent-a",commandId:"start-a",idempotencyKey:"start-key",inputDigest,requiredCapabilities:["database.runtime.start.v1"],
        authority:{schemaVersion:1,projectId:request.projectId,commandId:"start-a",action:"project.update",inputDigest,projectLease:lease},lease,context:{requestId:"start-request",correlationId:"start-correlation"},timeoutMs:1000,cancellationRequested:false});
    const starter={start:vi.fn<ReturnType<typeof createManagedDatabaseDaemonStarter>["start"]>(async()=>({containerId:original.containerId!,uid:1000}))},authority={assertValid:vi.fn(async()=>{})};
    const options={agentId:"agent-a",profiles:{[engine]:profile},imagePolicy:policy,capabilities:new InMemoryCapabilityRegistry(["database.runtime.start.v1"]),clock:{now:()=>now},starter,limits:{deadlineMs:1000}};
    return {request,profile,plan,input,original,command,starter,authority,options,executor:createManagedDatabaseStartExecutor(options),setNow:(value:number)=>{now=value;}};
}
it.each(engines)("starts the original stopped %s daemon under fresh authority without credential access",async engine=>{
    const f=fixture(engine),result=await f.executor.start(f.command,f.authority,new AbortController().signal);
    expect(result).toMatchObject({...f.request,profileId:f.profile.profileId,action:"database.runtime.start",commandId:f.command.commandId,originalCommandId:f.original.commandId,originalStopCommandId:"stop-a",inputDigest:f.command.inputDigest,
        containerId:f.original.containerId,imageId:f.original.imageId,networkId:f.original.networkId,volumeCreatedAt:f.original.volumeCreatedAt,status:"ready",health:"passed",storage:"verified",idempotent:false,redacted:true});
    expect(result.health).toBe("passed");expect(result).not.toHaveProperty("sealedEnvironment");expect(Object.isFrozen(result)).toBe(true);
    expect(f.starter.start).toHaveBeenCalledOnce();expect(f.starter.start.mock.calls[0]![0]).toEqual({request:f.request,profile:f.profile,commandId:f.original.commandId,imageId:f.original.imageId,containerId:f.original.containerId,environmentFingerprint:f.input.environmentFingerprint});
    expect(f.starter.start.mock.calls[0]![1]).toEqual({projectId:f.request.projectId,databaseId:f.request.databaseId,commandId:f.original.commandId,planDigest:f.plan.planDigest,volume:{name:f.original.volumeName,createdAt:f.original.volumeCreatedAt},network:{name:f.original.networkName,id:f.original.networkId}});
});
it("rejects changed approved plan/profile, start digest, agent and capability before any start",async()=>{
    for(const mode of ["plan","profile","digest","agent","capability"]){const f=fixture();let command=f.command;
        if(mode==="plan")command={...command,planDigest:"0".repeat(64),originalReceipt:{...command.originalReceipt,planDigest:"0".repeat(64)}};
        if(mode==="profile")command={...command,profileId:"foreign"};if(mode==="digest")command={...command,inputDigest:"0".repeat(64),authority:{...command.authority,inputDigest:"0".repeat(64)}};
        if(mode==="agent")command={...command,agentId:"foreign",originalReceipt:{...command.originalReceipt,agentId:"foreign"}};
        const executor=mode==="capability"?createManagedDatabaseStartExecutor({...f.options,capabilities:new InMemoryCapabilityRegistry([])}):f.executor;
        await expect(executor.start(command,f.authority,new AbortController().signal)).rejects.toThrow();expect(f.starter.start).not.toHaveBeenCalled();}
});
it("refuses authority revocation, detached start results and late revocation without retry",async()=>{
    for(const stage of ["before","identity","after"]){const f=fixture();if(stage==="before")f.authority.assertValid.mockRejectedValue(new Error("revoked"));if(stage==="identity")f.starter.start.mockResolvedValue({containerId:"a".repeat(64),uid:1000});
        if(stage==="after")f.starter.start.mockImplementation(async()=>{f.authority.assertValid.mockRejectedValue(new Error("revoked"));return {containerId:f.original.containerId!,uid:1000};});
        await expect(f.executor.start(f.command,f.authority,new AbortController().signal)).rejects.toThrow();expect(f.starter.start).toHaveBeenCalledTimes(stage==="before"?0:1);}
});
it("bounds stalled ports and rejects expired or canceled work without repeating start",async()=>{
    const f=fixture();f.starter.start.mockImplementation(()=>new Promise(()=>{}));
    const executor=createManagedDatabaseStartExecutor({...f.options,limits:{deadlineMs:5}});await expect(executor.start(f.command,f.authority,new AbortController().signal)).rejects.toThrow();expect(f.starter.start).toHaveBeenCalledOnce();
    const expired=fixture();expired.setNow(10000);await expect(expired.executor.start(expired.command,expired.authority,new AbortController().signal)).rejects.toThrow();expect(expired.starter.start).not.toHaveBeenCalled();
    const canceled=fixture(),abort=new AbortController();abort.abort();await expect(canceled.executor.start(canceled.command,canceled.authority,abort.signal)).rejects.toThrow();expect(canceled.starter.start).not.toHaveBeenCalled();
});
it("copies original inputs before authority waits and refuses invalid explicit limits",async()=>{
    const f=fixture();f.authority.assertValid.mockImplementation(async()=>{f.command.originalReceipt.containerId="a".repeat(64);f.command.originalReceipt.networkId="a".repeat(64);});
    await expect(f.executor.start(f.command,f.authority,new AbortController().signal)).resolves.toHaveProperty("containerId",f.original.containerId);
    for(const limits of [{deadlineMs:0},{deadlineMs:60001}])expect(()=>createManagedDatabaseStartExecutor({...f.options,limits})).toThrow();
});

it("rejects root, invalid process identity and future stopped receipts without publishing readiness",async()=>{
    for(const uid of [0,-1,1.5,4294967295,Number.NaN]){const f=fixture();f.starter.start.mockResolvedValue({containerId:f.original.containerId!,uid});
        await expect(f.executor.start(f.command,f.authority,new AbortController().signal)).rejects.toThrow();expect(f.starter.start).toHaveBeenCalledOnce();}
    const f=fixture();f.command.originalStopReceipt.observedAt=2000;
    const inputDigest=managedDatabaseStartExecutionDigest({...f.input,originalReceipt:f.command.originalReceipt,originalReplayFingerprint:f.command.originalReplayFingerprint,
        originalStopReceipt:f.command.originalStopReceipt,originalStopReplayFingerprint:f.command.originalStopReplayFingerprint});
    f.command.inputDigest=inputDigest;f.command.authority.inputDigest=inputDigest;
    await expect(f.executor.start(f.command,f.authority,new AbortController().signal)).rejects.toThrow();expect(f.starter.start).not.toHaveBeenCalled();
});
