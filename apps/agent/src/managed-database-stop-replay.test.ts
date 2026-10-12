import {createHash} from "node:crypto";
import {startAgentServer} from "./server.js";
import {expect,it,vi} from "vitest";
import {signAgentTransport} from "@deploylite/config";
import {managedDatabaseRuntimeReceiptSchema,managedDatabaseStopAgentCommandSchema,MANAGED_DATABASE_STOP_PATH,MANAGED_DATABASE_STOP_RECEIPT_PATH,managedDatabaseStopCachedReceiptSchema,protocolPayloadFingerprint} from "@deploylite/contracts";
import {managedDatabaseRuntimeExecutionDigest,managedDatabaseStopExecutionDigest,composeRuntimeResourceName} from "@deploylite/domain";
import {AuthenticatedAgentCommandReceiver,type AgentReplayStore} from "./agent-transport.js";
function fixture() {
    let now=1000;
    const trustKey="test-agent-key-"+"x".repeat(64),input={schemaVersion:1 as const,projectId:"project-a",databaseId:"orders",engine:"postgres" as const,profileId:"profile-a",planDigest:"a".repeat(64),environmentFingerprint:"b".repeat(32)};
    const {profileId:__,...originInput}=input;
    const originalReceipt=managedDatabaseRuntimeReceiptSchema.parse({...originInput,action:"database.runtime",agentId:"agent-a",commandId:"origin-a",inputDigest:managedDatabaseRuntimeExecutionDigest(input),correlationId:"origin-correlation",
        containerId:"c".repeat(64),imageId:"sha256:"+"d".repeat(64),volumeName:composeRuntimeResourceName(input.projectId,"volume","db-orders"),networkName:composeRuntimeResourceName(input.projectId,"network","db-orders"),networkId:"e".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",observedAt:1000,status:"ready",health:"passed",storage:"verified",idempotent:false,redacted:true});
    const preparation={...input,originalReceipt,originalReplayFingerprint:createHash("sha256").update("original-canonical-fingerprint").digest("hex")},inputDigest=managedDatabaseStopExecutionDigest(preparation),lease={projectId:input.projectId,leaseId:"stop-lease",fence:2,expiresAt:10000};
    const command=managedDatabaseStopAgentCommandSchema.parse({...preparation,action:"database.runtime.stop",operation:"database.runtime.stop",agentId:"agent-a",commandId:"stop-a",idempotencyKey:"stop-once",inputDigest,
        requiredCapabilities:["database.runtime.stop.v1"],authority:{schemaVersion:1,projectId:input.projectId,commandId:"stop-a",action:"project.update",inputDigest,projectLease:lease},lease,context:{requestId:"request-a",correlationId:"stop-correlation"},timeoutMs:5000,cancellationRequested:false});
    const receipt={...input,action:"database.runtime.stop" as const,agentId:"agent-a",commandId:"stop-a",originalCommandId:originalReceipt.commandId,inputDigest,correlationId:command.context.correlationId,
        containerId:originalReceipt.containerId!,imageId:originalReceipt.imageId!,volumeName:originalReceipt.volumeName,networkName:originalReceipt.networkName,networkId:originalReceipt.networkId!,volumeCreatedAt:originalReceipt.volumeCreatedAt!,observedAt:1000,status:"stopped" as const,storage:"verified" as const,redacted:true as const};
    const saved=new Map<string,{fingerprint:string;receipt:Record<string,unknown>}>([[originalReceipt.commandId,{fingerprint:"original-canonical-fingerprint",receipt:originalReceipt}]]);
    const replayStore={durable:true,lookupByFingerprintDigest:vi.fn(async(id:string,digest:string)=>{const row=saved.get(id);if(!row)return null;if(createHash("sha256").update(row.fingerprint).digest("hex")!==digest)throw new Error("conflict");return structuredClone(row.receipt);}),lookup:vi.fn<NonNullable<AgentReplayStore["lookup"]>>(async(id,fp)=>{const row=saved.get(id);if(!row)return null;if(row.fingerprint!==fp)throw new Error("conflict");return structuredClone(row.receipt);}),claim:vi.fn<AgentReplayStore["claim"]>(async()=>({claimed:true,claimToken:"token-a"})),wait:vi.fn<AgentReplayStore["wait"]>(async()=>{throw new Error("unexpected");}),complete:vi.fn<AgentReplayStore["complete"]>(async(id,row)=>{saved.set(id,structuredClone(row));}),release:vi.fn(async()=>{})};
    const stop=vi.fn(async()=>structuredClone(receipt)),validator=vi.fn(async()=>{});
    const options={agentId:"agent-a",trustKey,capabilities:["database.runtime.stop.v1"],dispatcher:{dispatch:async()=>{throw new Error("unused");}},managedDatabaseStop:{stop},replayStore,authorityValidator:{validateDeploymentAuthority:async()=>{},validateProjectUpdateAuthority:validator},now:()=>now};
    const receiver=new AuthenticatedAgentCommandReceiver(options),signature=(value:unknown)=>signAgentTransport(JSON.stringify(value),trustKey);
    const {cancellationRequested:_,...query}=command;
    const read=(value=query)=>receiver.readManagedDatabaseStopReceipt(value,signAgentTransport(`POST ${MANAGED_DATABASE_STOP_RECEIPT_PATH}\n${JSON.stringify(value)}`,trustKey));
    return {options,command,query,receipt,originalReceipt,replayStore,saved,stop,validator,receiver,signature,read,setNow:(value:number)=>{now=value;}};
}
it("stops once after corroborating the original durable ready receipt and replays after lease expiry",async()=>{
    const f=fixture();expect(await f.receiver.receive(f.command,f.signature(f.command))).toEqual(f.receipt);
    expect(f.replayStore.lookupByFingerprintDigest).toHaveBeenCalledWith(f.originalReceipt.commandId,f.command.originalReplayFingerprint);
    expect(f.stop).toHaveBeenCalledOnce();f.setNow(20000);
    expect(await f.receiver.receive(f.command,f.signature(f.command))).toEqual(f.receipt);expect((await f.read()).receipt).toEqual(f.receipt);
    expect(f.stop).toHaveBeenCalledOnce();expect(f.replayStore.claim).toHaveBeenCalledOnce();expect(f.replayStore.complete).toHaveBeenCalledOnce();
});
it("rejects absent, detached and conflicting original cache without claiming or stopping",async()=>{
    for(const mode of ["missing","identity","fingerprint"]){const f=fixture();if(mode==="missing")f.saved.delete(f.originalReceipt.commandId);else{const row=f.saved.get(f.originalReceipt.commandId)!;if(mode==="identity")row.receipt={...row.receipt,containerId:"a".repeat(64)};else row.fingerprint="a".repeat(64);}
        await expect(f.receiver.receive(f.command,f.signature(f.command))).rejects.toThrow();expect(f.stop).not.toHaveBeenCalled();expect(f.replayStore.claim).not.toHaveBeenCalled();}
});
it("returns explicit stop cache absence without original reads, claim or effects",async()=>{
    const f=fixture();expect((await f.read()).receipt).toBeNull();expect(f.replayStore.lookup).toHaveBeenCalledOnce();expect(f.stop).not.toHaveBeenCalled();expect(f.replayStore.claim).not.toHaveBeenCalled();
});
it("denies authentication, capabilities, foreign digest and uncached expiry before effect",async()=>{
    const f=fixture();await expect(f.receiver.receive(f.command,"invalid")).rejects.toThrow();await expect(f.receiver.readManagedDatabaseStopReceipt(f.query,"invalid")).rejects.toThrow();expect(f.replayStore.lookup).not.toHaveBeenCalled();
    for(const mode of ["volatile","no-executor","digest","expired"]){const f=fixture();let command=f.command,receiver=f.receiver;
        if(mode==="volatile")receiver=new AuthenticatedAgentCommandReceiver({...f.options,replayStore:{...f.replayStore,durable:false}});
        if(mode==="no-executor")receiver=new AuthenticatedAgentCommandReceiver({...f.options,managedDatabaseStop:undefined});
        if(mode==="digest")command={...command,inputDigest:"0".repeat(64),authority:{...command.authority,inputDigest:"0".repeat(64)}};
        if(mode==="expired")f.setNow(20000);
        await expect(receiver.receive(command,f.signature(command))).rejects.toThrow();expect(f.stop).not.toHaveBeenCalled();expect(f.replayStore.claim).not.toHaveBeenCalled();}
});
it("retains attempted durable claims after execution or completion uncertainty and rejects returned identity changes",async()=>{
    for(const stage of ["execution","completion","receipt","late-authority"]){const f=fixture();
        if(stage==="execution")f.stop.mockRejectedValue(new Error("private"));if(stage==="completion")f.replayStore.complete.mockRejectedValue(new Error("private"));if(stage==="receipt")f.stop.mockResolvedValue({...f.receipt,containerId:"a".repeat(64)});
        if(stage==="late-authority")f.stop.mockImplementation(async()=>{f.validator.mockRejectedValue(new Error("revoked"));return f.receipt;});
        await expect(f.receiver.receive(f.command,f.signature(f.command))).rejects.toThrow();expect(f.stop).toHaveBeenCalledOnce();expect(f.replayStore.release).not.toHaveBeenCalled();if(stage!=="completion")expect(f.replayStore.complete).not.toHaveBeenCalled();}
});
it("waits for an existing stop claim without another stop and checks the complete receipt binding",async()=>{
    const f=fixture();f.replayStore.claim.mockResolvedValue({claimed:false});f.replayStore.wait.mockResolvedValue(f.receipt);
    expect(await f.receiver.receive(f.command,f.signature(f.command))).toEqual(f.receipt);expect(f.stop).not.toHaveBeenCalled();expect(f.replayStore.complete).not.toHaveBeenCalled();
    f.replayStore.wait.mockResolvedValue({...f.receipt,networkId:"a".repeat(64)});await expect(f.receiver.receive(f.command,f.signature(f.command))).rejects.toThrow();
});
it("bounds stalled origin, execution and cache ports without retry or release",async()=>{
    for(const stage of ["origin","execution","cache"]){const f=fixture(),command={...f.command,timeoutMs:5};
        if(stage==="origin")f.replayStore.lookupByFingerprintDigest.mockImplementation(()=>new Promise(()=>{}));
        if(stage==="execution")f.stop.mockImplementation(()=>new Promise(()=>{}));if(stage==="cache")f.replayStore.lookup.mockImplementation(()=>new Promise(()=>{}));
        await expect(f.receiver.receive(command,f.signature(command))).rejects.toThrow();expect(f.replayStore.complete).not.toHaveBeenCalled();expect(f.replayStore.release).not.toHaveBeenCalled();}
});
it("refuses changed cached proof or revoked fresh authority, retaining the original apply receipt",async()=>{
    const f=fixture();f.validator.mockRejectedValue(new Error("revoked"));await expect(f.receiver.receive(f.command,f.signature(f.command))).rejects.toThrow();expect(f.stop).not.toHaveBeenCalled();expect(f.replayStore.claim).not.toHaveBeenCalled();
    const g=fixture();await g.receiver.receive(g.command,g.signature(g.command));const row=g.saved.get(g.command.commandId)!;row.receipt={...row.receipt,volumeCreatedAt:"2026-10-09T00:00:00Z"};
    await expect(g.read()).rejects.toThrow();expect(protocolPayloadFingerprint(g.saved.get(g.originalReceipt.commandId)!.receipt)).toBe(protocolPayloadFingerprint(g.originalReceipt));
});

it("serves signed stop and cache HTTP on dedicated paths and refuses action/path mismatch",async()=>{
    const f=fixture(),server=await startAgentServer({host:"127.0.0.1",port:0,receiver:f.receiver,replayStore:f.replayStore});
    try {
        const address=server.server.address();if(!address||typeof address==="string")throw new Error("missing address");
        const base=`http://127.0.0.1:${address.port}`;
        for(const path of ["/deployments/execute","/databases/runtime"]){
            const response=await fetch(base+path,{method:"POST",headers:{"content-type":"application/json","x-deploylite-signature":f.signature(f.command)},body:JSON.stringify(f.command)});
            expect(response.status).toBe(403);
        }
        expect(f.stop).not.toHaveBeenCalled();expect(f.replayStore.claim).not.toHaveBeenCalled();
        const response=await fetch(base+MANAGED_DATABASE_STOP_PATH,{method:"POST",headers:{"content-type":"application/json","x-deploylite-signature":f.signature(f.command)},body:JSON.stringify(f.command)});
        expect(response.status).toBe(200);expect(await response.json()).toEqual(f.receipt);
        const cached=await fetch(base+MANAGED_DATABASE_STOP_RECEIPT_PATH,{method:"POST",headers:{"content-type":"application/json","x-deploylite-signature":signAgentTransport(`POST ${MANAGED_DATABASE_STOP_RECEIPT_PATH}\n${JSON.stringify(f.query)}`,f.options.trustKey)},body:JSON.stringify(f.query)});
        expect(cached.status).toBe(200);expect(managedDatabaseStopCachedReceiptSchema.parse(await cached.json()).receipt).toEqual(f.receipt);expect(f.stop).toHaveBeenCalledOnce();
    } finally {await server.close();}
});
it("rejects missing stop tokens and pre-cancellation without repeating or releasing a stop",async()=>{
    const f=fixture();f.replayStore.claim.mockResolvedValue({claimed:true});
    await expect(f.receiver.receive(f.command,f.signature(f.command))).rejects.toThrow();expect(f.stop).not.toHaveBeenCalled();expect(f.replayStore.release).not.toHaveBeenCalled();
    const g=fixture(),abort=new AbortController();abort.abort();
    await expect(g.receiver.receive(g.command,g.signature(g.command),abort.signal)).rejects.toThrow();expect(g.replayStore.lookup).not.toHaveBeenCalled();expect(g.stop).not.toHaveBeenCalled();
    const unavailable=new AuthenticatedAgentCommandReceiver({...g.options,replayStore:{...g.replayStore,lookup:undefined}});
    expect(unavailable.capabilities).not.toContain("database.runtime.stop.v1");
});
it("rejects a lower project fence before original cache reads or another stop",async()=>{
    const f=fixture();await f.receiver.receive(f.command,f.signature(f.command));f.replayStore.lookup.mockClear();f.replayStore.lookupByFingerprintDigest.mockClear();
    const lease={...f.command.lease,leaseId:"old-lease",fence:1},command={...f.command,commandId:"other-stop",idempotencyKey:"other-key",lease,authority:{...f.command.authority,commandId:"other-stop",projectLease:lease}};
    await expect(f.receiver.receive(command,f.signature(command))).rejects.toThrow();expect(f.stop).toHaveBeenCalledOnce();expect(f.replayStore.claim).toHaveBeenCalledOnce();
    expect(f.replayStore.lookupByFingerprintDigest).not.toHaveBeenCalledWith(f.originalReceipt.commandId,f.command.originalReplayFingerprint);
});
it("withholds stop without the explicit opaque original fingerprint reader",()=>{
    const f=fixture(),receiver=new AuthenticatedAgentCommandReceiver({...f.options,replayStore:{...f.replayStore,lookupByFingerprintDigest:undefined}});
    expect(receiver.capabilities).not.toContain("database.runtime.stop.v1");
});
