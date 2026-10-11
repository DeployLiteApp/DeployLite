import {startAgentServer} from "./server.js";
import { expect, it, vi } from "vitest";
import { signAgentTransport } from "@deploylite/config";
import { managedDatabaseRuntimeAgentCommandSchema, managedDatabaseRuntimeCachedReceiptSchema, MANAGED_DATABASE_RUNTIME_RECEIPT_PATH } from "@deploylite/contracts";
import { planManagedDatabaseProfile, managedDatabaseRuntimeExecutionDigest, managedDatabaseRuntimeReplayFingerprint } from "@deploylite/domain";
import { AuthenticatedAgentCommandReceiver, type AgentReplayStore } from "./agent-transport.js";
function fixture() {
    let now = 1000;
    const trustKey = "test-agent-key-" + "x".repeat(64), request = {schemaVersion:1 as const,projectId:"project-a",databaseId:"orders",engine:"postgres" as const};
    const profile = {schemaVersion:1,profileId:"profile-a",engine:"postgres",image:"registry.example.com/postgres@sha256:"+"a".repeat(64),dataPath:"/var/lib/postgresql/data",containerPort:5432,credentialKeys:["DATABASE_PASSWORD"],backupStrategy:"engine-native"};
    const plan = planManagedDatabaseProfile(request,profile,{policyVersion:"images-1",trustedHosts:["registry.example.com"],allowTags:false,allowDigests:true});
    const input = {...request,profileId:profile.profileId,planDigest:plan.planDigest,environmentFingerprint:"b".repeat(32)}, inputDigest = managedDatabaseRuntimeExecutionDigest(input);
    const lease = {projectId:request.projectId,leaseId:"lease-a",fence:1,expiresAt:10000};
    const command = managedDatabaseRuntimeAgentCommandSchema.parse({...input,action:"database.runtime",operation:"database.runtime.apply",agentId:"agent-a",commandId:"command-a",idempotencyKey:"key-a",inputDigest,
        requiredCapabilities:["database.runtime.v1"],authority:{schemaVersion:1,projectId:request.projectId,commandId:"command-a",action:"project.update",inputDigest,projectLease:lease},lease,
        context:{requestId:"request-a",correlationId:"correlation-a"},timeoutMs:5000,cancellationRequested:false,sealedEnvironment:"test-sealed-envelope"});
    const receipt = {...request,action:"database.runtime" as const,agentId:command.agentId,commandId:command.commandId,inputDigest,planDigest:plan.planDigest,environmentFingerprint:command.environmentFingerprint,correlationId:command.context.correlationId,
        containerId:"c".repeat(64),imageId:"sha256:"+"d".repeat(64),volumeName:plan.volume.runtimeName,networkName:plan.network.runtimeName,networkId:"f".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",observedAt:now,status:"ready" as const,health:"passed" as const,storage:"verified" as const,idempotent:false,redacted:true as const};
    const saved = new Map<string,{fingerprint:string;receipt:Record<string,unknown>}>();
    const replayStore = {durable:true,lookup:vi.fn(async (id:string,fingerprint:string) => {const value=saved.get(id);if(!value)return null;if(value.fingerprint!==fingerprint)throw new Error("fingerprint conflict");return structuredClone(value.receipt);}),
        claim:vi.fn<AgentReplayStore["claim"]>(async () => ({claimed:true,claimToken:"token-a"})),wait:vi.fn<AgentReplayStore["wait"]>(async () => {throw new Error("unexpected wait");}),
        complete:vi.fn(async (id:string,value:{fingerprint:string;receipt:Record<string,unknown>}) => {saved.set(id,structuredClone(value));}),release:vi.fn(async () => {})};
    const executor = {apply:vi.fn(async () => structuredClone(receipt))}, validator = vi.fn(async () => {});
    const options = {agentId:"agent-a",trustKey,capabilities:["database.runtime.v1"],dispatcher:{dispatch:async () => {throw new Error("unused");}},managedDatabaseRuntime:executor,replayStore,
        authorityValidator:{validateDeploymentAuthority:async () => {},validateProjectUpdateAuthority:validator},now:() => now};
    const receiver = new AuthenticatedAgentCommandReceiver(options);
    const signature = (value:unknown) => signAgentTransport(JSON.stringify(value),trustKey);
    const {sealedEnvironment:_,cancellationRequested:__,...query}=command;
    const read = (value=query) => receiver.readManagedDatabaseRuntimeReceipt(value,signAgentTransport(`POST ${MANAGED_DATABASE_RUNTIME_RECEIPT_PATH}\n${JSON.stringify(value)}`,trustKey));
    return {command,query,receipt,executor,validator,replayStore,options,receiver,signature,read,setNow:(value:number)=>{now=value;}};
}
it("authenticates fresh execution and replays the original durable receipt after lease expiry",async () => {
    const f=fixture();
    expect(await f.receiver.receive(f.command,f.signature(f.command))).toEqual(f.receipt);
    f.setNow(20000);
    expect(await f.receiver.receive(f.command,f.signature(f.command))).toEqual(f.receipt);
    expect((await f.read()).receipt).toEqual(f.receipt);
    expect(f.executor.apply).toHaveBeenCalledOnce();expect(f.replayStore.claim).toHaveBeenCalledOnce();expect(f.replayStore.complete).toHaveBeenCalledOnce();
});
it("returns explicit cache absence without claim or execution",async () => {
    const f=fixture();expect((await f.read()).receipt).toBeNull();expect(f.replayStore.claim).not.toHaveBeenCalled();expect(f.executor.apply).not.toHaveBeenCalled();
});
it("rejects unauthenticated, foreign digest and missing durable capability before effects",async () => {
    const f=fixture();
    await expect(f.receiver.receive(f.command,"invalid")).rejects.toThrow();
    const changed={...f.command,planDigest:"e".repeat(64)};
    await expect(f.receiver.receive(changed,f.signature(changed))).rejects.toThrow();
    const volatile=new AuthenticatedAgentCommandReceiver({...f.options,replayStore:{...f.replayStore,durable:false}});
    await expect(volatile.receive(f.command,f.signature(f.command))).rejects.toThrow();
    expect(f.executor.apply).not.toHaveBeenCalled();expect(f.replayStore.claim).not.toHaveBeenCalled();
});
it("preserves unresolved claims after ambiguous execution or completion",async () => {
    for(const stage of ["execution","completion"] as const){const f=fixture();if(stage==="execution")f.executor.apply.mockRejectedValue(new Error("private"));else f.replayStore.complete.mockRejectedValue(new Error("private"));
        await expect(f.receiver.receive(f.command,f.signature(f.command))).rejects.toThrow();expect(f.replayStore.release).not.toHaveBeenCalled();expect(f.executor.apply).toHaveBeenCalledOnce();}
});
it("fences authority before execution and rejects detached returned receipts",async () => {
    const f=fixture();f.validator.mockRejectedValue(new Error("revoked"));await expect(f.receiver.receive(f.command,f.signature(f.command))).rejects.toThrow();expect(f.executor.apply).not.toHaveBeenCalled();
    const detached=fixture();detached.executor.apply.mockResolvedValue({...detached.receipt,databaseId:"foreign"});await expect(detached.receiver.receive(detached.command,detached.signature(detached.command))).rejects.toThrow();expect(detached.replayStore.complete).not.toHaveBeenCalled();
});
it("binds cache queries to the original project, plan, environment and correlation",async () => {
    const f=fixture();await f.receiver.receive(f.command,f.signature(f.command));
    for(const patch of [{databaseId:"foreign"},{environmentFingerprint:"e".repeat(32)},{context:{...f.query.context,correlationId:"foreign"}}])await expect(f.read({...f.query,...patch})).rejects.toThrow();
    expect(f.executor.apply).toHaveBeenCalledOnce();
});
it("waits for an existing original claim without invoking the executor again",async () => {
    const f=fixture();f.replayStore.claim.mockResolvedValue({claimed:false});f.replayStore.wait.mockResolvedValue(f.receipt);
    expect(await f.receiver.receive(f.command,f.signature(f.command))).toEqual(f.receipt);expect(f.executor.apply).not.toHaveBeenCalled();expect(f.replayStore.complete).not.toHaveBeenCalled();
});
it("does not execute with a missing original claim token or expired uncached lease",async () => {
    const f=fixture();f.replayStore.claim.mockResolvedValue({claimed:true});await expect(f.receiver.receive(f.command,f.signature(f.command))).rejects.toThrow();expect(f.executor.apply).not.toHaveBeenCalled();
    const expired=fixture();expired.setNow(20000);await expect(expired.receiver.receive(expired.command,expired.signature(expired.command))).rejects.toThrow();expect(expired.replayStore.claim).not.toHaveBeenCalled();
});
it("bounds stalled receipt/execution ports and preserves attempted execution claims",async () => {
    for(const stage of ["lookup","execution"] as const){const f=fixture();const command={...f.command,timeoutMs:5};
        if(stage==="lookup")f.replayStore.lookup.mockImplementation(() => new Promise<never>(()=>{}));else f.executor.apply.mockImplementation(() => new Promise<never>(()=>{}));
        await expect(f.receiver.receive(command,f.signature(command))).rejects.toThrow();expect(f.replayStore.complete).not.toHaveBeenCalled();expect(f.replayStore.release).not.toHaveBeenCalled();}
});
it("rejects cache authentication and late authority revocation before completion",async () => {
    const f=fixture();await expect(f.receiver.readManagedDatabaseRuntimeReceipt(f.query,"invalid")).rejects.toThrow();expect(f.replayStore.lookup).not.toHaveBeenCalled();
    f.executor.apply.mockImplementation(async()=>{f.validator.mockRejectedValue(new Error("revoked"));return f.receipt;});
    await expect(f.receiver.receive(f.command,f.signature(f.command))).rejects.toThrow();expect(f.replayStore.complete).not.toHaveBeenCalled();expect(f.replayStore.release).not.toHaveBeenCalled();
});
it("serves authenticated native execution and cache-only HTTP without repeating effects",async () => {
    const f=fixture(), server=await startAgentServer({host:"127.0.0.1",port:0,receiver:f.receiver,replayStore:f.replayStore});
    try {
        const address=server.server.address();if(!address||typeof address==="string")throw new Error("missing test address");
        const base=`http://127.0.0.1:${address.port}`;
        const fresh=await fetch(base+"/databases/runtime",{method:"POST",headers:{"content-type":"application/json","x-deploylite-signature":f.signature(f.command)},body:JSON.stringify(f.command)});
        expect(fresh.status).toBe(200);expect(await fresh.json()).toEqual(f.receipt);
        const query=await fetch(base+MANAGED_DATABASE_RUNTIME_RECEIPT_PATH,{method:"POST",headers:{"content-type":"application/json","x-deploylite-signature":f.receiver.signResponse(`POST ${MANAGED_DATABASE_RUNTIME_RECEIPT_PATH}\n${JSON.stringify(f.query)}`)},body:JSON.stringify(f.query)});
        expect(query.status).toBe(200);expect(managedDatabaseRuntimeCachedReceiptSchema.parse(await query.json()).receipt).toEqual(f.receipt);expect(f.executor.apply).toHaveBeenCalledOnce();
    } finally {await server.close();}
});
it("rejects native action/path mismatch before execution or claim",async () => {
    const f=fixture(), server=await startAgentServer({host:"127.0.0.1",port:0,receiver:f.receiver,replayStore:f.replayStore});
    try {
        const address=server.server.address();if(!address||typeof address==="string")throw new Error("missing test address");
        for(const [path,body] of [["/deployments/execute",f.command],["/databases/runtime",{action:"deployment.stop"}]]){
            const response=await fetch(`http://127.0.0.1:${address.port}`+path,{method:"POST",headers:{"content-type":"application/json","x-deploylite-signature":f.signature(body)},body:JSON.stringify(body)});
            expect(response.status).toBe(403);
        }
        expect(f.executor.apply).not.toHaveBeenCalled();expect(f.replayStore.claim).not.toHaveBeenCalled();
    } finally {await server.close();}
});

it("derives the original replay fingerprint identical to the actual durable apply claim",async()=>{
    const f=fixture();await f.receiver.receive(f.command,f.signature(f.command));
    expect(managedDatabaseRuntimeReplayFingerprint(f.query)).toBe(f.replayStore.complete.mock.calls[0]![1].fingerprint);
    expect(managedDatabaseRuntimeReplayFingerprint({...f.query,timeoutMs:1,context:{...f.query.context,requestId:"new-read"}})).toBe(f.replayStore.complete.mock.calls[0]![1].fingerprint);
});
