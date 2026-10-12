import {createHash} from "node:crypto";
import {expect,it,vi} from "vitest";
import {signAgentTransport} from "@deploylite/config";
import {managedDatabaseRuntimeReceiptSchema,managedDatabaseStartAgentCommandSchema,MANAGED_DATABASE_START_RECEIPT_PATH,protocolPayloadFingerprint} from "@deploylite/contracts";
import {managedDatabaseRuntimeExecutionDigest,managedDatabaseStopExecutionDigest,managedDatabaseStartExecutionDigest,composeRuntimeResourceName} from "@deploylite/domain";
import {AuthenticatedAgentCommandReceiver,type AgentReplayStore} from "./agent-transport.js";
function fixture() {
    let now=1000;
    const trustKey="test-agent-key-"+"x".repeat(64),input={schemaVersion:1 as const,projectId:"project-a",databaseId:"orders",engine:"postgres" as const,profileId:"profile-a",planDigest:"a".repeat(64),environmentFingerprint:"b".repeat(32)};
    const {profileId:__,...originInput}=input;
    const originalReceipt=managedDatabaseRuntimeReceiptSchema.parse({...originInput,action:"database.runtime",agentId:"agent-a",commandId:"origin-a",inputDigest:managedDatabaseRuntimeExecutionDigest(input),correlationId:"origin-correlation",
        containerId:"c".repeat(64),imageId:"sha256:"+"d".repeat(64),volumeName:composeRuntimeResourceName(input.projectId,"volume","db-orders"),networkName:composeRuntimeResourceName(input.projectId,"network","db-orders"),networkId:"e".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",observedAt:1000,status:"ready",health:"passed",storage:"verified",idempotent:false,redacted:true});
    const stopPreparation={...input,originalReceipt,originalReplayFingerprint:createHash("sha256").update("original-canonical-fingerprint").digest("hex")};
    const {health:_health,idempotent:_idempotent,...physical}=originalReceipt;
    const originalStopReceipt={...physical,action:"database.runtime.stop",commandId:"stop-a",originalCommandId:originalReceipt.commandId,profileId:input.profileId,
        inputDigest:managedDatabaseStopExecutionDigest(stopPreparation),correlationId:"original-stop-correlation",status:"stopped"};
    const preparation={...stopPreparation,originalStopReceipt,originalStopReplayFingerprint:createHash("sha256").update("original-stop-canonical-fingerprint").digest("hex")},inputDigest=managedDatabaseStartExecutionDigest(preparation),lease={projectId:input.projectId,leaseId:"stop-lease",fence:2,expiresAt:10000};
    const command=managedDatabaseStartAgentCommandSchema.parse({...preparation,action:"database.runtime.start",operation:"database.runtime.start",agentId:"agent-a",commandId:"start-a",idempotencyKey:"start-once",inputDigest,
        requiredCapabilities:["database.runtime.start.v1"],authority:{schemaVersion:1,projectId:input.projectId,commandId:"start-a",action:"project.update",inputDigest,projectLease:lease},lease,context:{requestId:"request-a",correlationId:"stop-correlation"},timeoutMs:5000,cancellationRequested:false});
    const receipt={...input,action:"database.runtime.start" as const,agentId:"agent-a",commandId:"start-a",originalCommandId:originalReceipt.commandId,originalStopCommandId:originalStopReceipt.commandId,inputDigest,correlationId:command.context.correlationId,
        containerId:originalReceipt.containerId!,imageId:originalReceipt.imageId!,volumeName:originalReceipt.volumeName,networkName:originalReceipt.networkName,networkId:originalReceipt.networkId!,volumeCreatedAt:originalReceipt.volumeCreatedAt!,observedAt:1000,status:"ready" as const,health:"passed" as const,idempotent:false,storage:"verified" as const,redacted:true as const};
    const saved=new Map<string,{fingerprint:string;receipt:Record<string,unknown>}>([[originalReceipt.commandId,{fingerprint:"original-canonical-fingerprint",receipt:originalReceipt}],[originalStopReceipt.commandId,{fingerprint:"original-stop-canonical-fingerprint",receipt:originalStopReceipt}]]);
    const replayStore={durable:true,lookupByFingerprintDigest:vi.fn(async(id:string,digest:string)=>{const row=saved.get(id);if(!row)return null;if(createHash("sha256").update(row.fingerprint).digest("hex")!==digest)throw new Error("conflict");return structuredClone(row.receipt);}),lookup:vi.fn<NonNullable<AgentReplayStore["lookup"]>>(async(id,fp)=>{const row=saved.get(id);if(!row)return null;if(row.fingerprint!==fp)throw new Error("conflict");return structuredClone(row.receipt);}),claim:vi.fn<AgentReplayStore["claim"]>(async()=>({claimed:true,claimToken:"token-a"})),wait:vi.fn<AgentReplayStore["wait"]>(async()=>{throw new Error("unexpected");}),complete:vi.fn<AgentReplayStore["complete"]>(async(id,row)=>{saved.set(id,structuredClone(row));}),release:vi.fn(async()=>{})};
    const start=vi.fn(async()=>structuredClone(receipt)),validator=vi.fn(async()=>{});
    const options={agentId:"agent-a",trustKey,capabilities:["database.runtime.start.v1"],dispatcher:{dispatch:async()=>{throw new Error("unused");}},managedDatabaseStart:{start},replayStore,authorityValidator:{validateDeploymentAuthority:async()=>{},validateProjectUpdateAuthority:validator},now:()=>now};
    const receiver=new AuthenticatedAgentCommandReceiver(options),signature=(value:unknown)=>signAgentTransport(JSON.stringify(value),trustKey);
    const {cancellationRequested:_,...query}=command;
    const read=(value=query)=>receiver.readManagedDatabaseStartReceipt(value,signAgentTransport(`POST ${MANAGED_DATABASE_START_RECEIPT_PATH}\n${JSON.stringify(value)}`,trustKey));
    return {options,command,query,receipt,originalReceipt,originalStopReceipt,replayStore,saved,start,validator,receiver,signature,read,setNow:(value:number)=>{now=value;}};
}
it("starts once after corroborating both original durable receipts and replays after lease expiry",async()=>{
    const f=fixture();await expect(f.receiver.receive(f.command,f.signature(f.command))).resolves.toEqual(f.receipt);
    expect(f.replayStore.lookupByFingerprintDigest).toHaveBeenCalledWith(f.originalReceipt.commandId,f.command.originalReplayFingerprint);
    expect(f.replayStore.lookupByFingerprintDigest).toHaveBeenCalledWith(f.originalStopReceipt.commandId,f.command.originalStopReplayFingerprint);
    expect(f.start).toHaveBeenCalledOnce();f.setNow(20000);
    await expect(f.receiver.receive(f.command,f.signature(f.command))).resolves.toEqual(f.receipt);expect((await f.read()).receipt).toEqual(f.receipt);
    expect(f.start).toHaveBeenCalledOnce();expect(f.replayStore.claim).toHaveBeenCalledOnce();expect(f.replayStore.complete).toHaveBeenCalledOnce();
});
it("rejects absent, detached and conflicting original cache without claiming or starting",async()=>{
    for(const mode of ["missing","identity","fingerprint"]){const f=fixture();if(mode==="missing")f.saved.delete(f.originalReceipt.commandId);else{const row=f.saved.get(f.originalReceipt.commandId)!;if(mode==="identity")row.receipt={...row.receipt,containerId:"a".repeat(64)};else row.fingerprint="a".repeat(64);}
        await expect(f.receiver.receive(f.command,f.signature(f.command))).rejects.toThrow();expect(f.start).not.toHaveBeenCalled();expect(f.replayStore.claim).not.toHaveBeenCalled();}
});
it("returns explicit start cache absence without original reads, claim or effects",async()=>{
    const f=fixture();expect((await f.read()).receipt).toBeNull();expect(f.replayStore.lookup).toHaveBeenCalledOnce();expect(f.start).not.toHaveBeenCalled();expect(f.replayStore.claim).not.toHaveBeenCalled();
});
it("denies authentication, capabilities, foreign digest and uncached expiry before effect",async()=>{
    const f=fixture();await expect(f.receiver.receive(f.command,"invalid")).rejects.toThrow();await expect(f.receiver.readManagedDatabaseStartReceipt(f.query,"invalid")).rejects.toThrow();expect(f.replayStore.lookup).not.toHaveBeenCalled();
    for(const mode of ["volatile","no-executor","digest","expired"]){const f=fixture();let command=f.command,receiver=f.receiver;
        if(mode==="volatile")receiver=new AuthenticatedAgentCommandReceiver({...f.options,replayStore:{...f.replayStore,durable:false}});
        if(mode==="no-executor")receiver=new AuthenticatedAgentCommandReceiver({...f.options,managedDatabaseStart:undefined});
        if(mode==="digest")command={...command,inputDigest:"0".repeat(64),authority:{...command.authority,inputDigest:"0".repeat(64)}};
        if(mode==="expired")f.setNow(20000);
        await expect(receiver.receive(command,f.signature(command))).rejects.toThrow();expect(f.start).not.toHaveBeenCalled();expect(f.replayStore.claim).not.toHaveBeenCalled();}
});
it("retains attempted durable claims after execution or completion uncertainty and rejects returned identity changes",async()=>{
    for(const stage of ["execution","completion","receipt","late-authority"]){const f=fixture();
        if(stage==="execution")f.start.mockRejectedValue(new Error("private"));if(stage==="completion")f.replayStore.complete.mockRejectedValue(new Error("private"));if(stage==="receipt")f.start.mockResolvedValue({...f.receipt,containerId:"a".repeat(64)});
        if(stage==="late-authority")f.start.mockImplementation(async()=>{f.validator.mockRejectedValue(new Error("revoked"));return f.receipt;});
        await expect(f.receiver.receive(f.command,f.signature(f.command))).rejects.toThrow();expect(f.start).toHaveBeenCalledOnce();expect(f.replayStore.release).not.toHaveBeenCalled();if(stage!=="completion")expect(f.replayStore.complete).not.toHaveBeenCalled();}
});
it("waits for an existing start claim without another start and checks the complete receipt binding",async()=>{
    const f=fixture();f.replayStore.claim.mockResolvedValue({claimed:false});f.replayStore.wait.mockResolvedValue(f.receipt);
    await expect(f.receiver.receive(f.command,f.signature(f.command))).resolves.toEqual(f.receipt);expect(f.start).not.toHaveBeenCalled();expect(f.replayStore.complete).not.toHaveBeenCalled();
    f.replayStore.wait.mockResolvedValue({...f.receipt,networkId:"a".repeat(64)});await expect(f.receiver.receive(f.command,f.signature(f.command))).rejects.toThrow();
});
it("bounds stalled origin, execution and cache ports without retry or release",async()=>{
    for(const stage of ["origin","execution","cache"]){const f=fixture(),command={...f.command,timeoutMs:5};
        if(stage==="origin")f.replayStore.lookupByFingerprintDigest.mockImplementation(()=>new Promise(()=>{}));
        if(stage==="execution")f.start.mockImplementation(()=>new Promise(()=>{}));if(stage==="cache")f.replayStore.lookup.mockImplementation(()=>new Promise(()=>{}));
        await expect(f.receiver.receive(command,f.signature(command))).rejects.toThrow();expect(f.replayStore.complete).not.toHaveBeenCalled();expect(f.replayStore.release).not.toHaveBeenCalled();}
});
it("refuses changed cached proof or revoked fresh authority, retaining the original apply receipt",async()=>{
    const f=fixture();f.validator.mockRejectedValue(new Error("revoked"));await expect(f.receiver.receive(f.command,f.signature(f.command))).rejects.toThrow();expect(f.start).not.toHaveBeenCalled();expect(f.replayStore.claim).not.toHaveBeenCalled();
    const g=fixture();await g.receiver.receive(g.command,g.signature(g.command));const row=g.saved.get(g.command.commandId)!;row.receipt={...row.receipt,volumeCreatedAt:"2026-10-09T00:00:00Z"};
    await expect(g.read()).rejects.toThrow();expect(protocolPayloadFingerprint(g.saved.get(g.originalReceipt.commandId)!.receipt)).toBe(protocolPayloadFingerprint(g.originalReceipt));
});

it("rejects missing start tokens and pre-cancellation without repeating or releasing a start",async()=>{
    const f=fixture();f.replayStore.claim.mockResolvedValue({claimed:true});
    await expect(f.receiver.receive(f.command,f.signature(f.command))).rejects.toThrow();expect(f.start).not.toHaveBeenCalled();expect(f.replayStore.release).not.toHaveBeenCalled();
    const g=fixture(),abort=new AbortController();abort.abort();
    await expect(g.receiver.receive(g.command,g.signature(g.command),abort.signal)).rejects.toThrow();expect(g.replayStore.lookup).not.toHaveBeenCalled();expect(g.start).not.toHaveBeenCalled();
    const unavailable=new AuthenticatedAgentCommandReceiver({...g.options,replayStore:{...g.replayStore,lookup:undefined}});
    expect(unavailable.capabilities).not.toContain("database.runtime.start.v1");
});
it("rejects a lower project fence before original cache reads or another start",async()=>{
    const f=fixture();await f.receiver.receive(f.command,f.signature(f.command));f.replayStore.lookup.mockClear();f.replayStore.lookupByFingerprintDigest.mockClear();
    const lease={...f.command.lease,leaseId:"old-lease",fence:1},command={...f.command,commandId:"other-stop",idempotencyKey:"other-key",lease,authority:{...f.command.authority,commandId:"other-stop",projectLease:lease}};
    await expect(f.receiver.receive(command,f.signature(command))).rejects.toThrow();expect(f.start).toHaveBeenCalledOnce();expect(f.replayStore.claim).toHaveBeenCalledOnce();
    expect(f.replayStore.lookupByFingerprintDigest).not.toHaveBeenCalledWith(f.originalReceipt.commandId,f.command.originalReplayFingerprint);
});
it("withholds start without the explicit opaque original fingerprint reader",()=>{
    const f=fixture(),receiver=new AuthenticatedAgentCommandReceiver({...f.options,replayStore:{...f.replayStore,lookupByFingerprintDigest:undefined}});
    expect(receiver.capabilities).not.toContain("database.runtime.start.v1");
});

it("corroborates both immutable originals before claiming, rejecting missing or changed stopped evidence",async()=>{
    for(const mode of ["missing","identity","fingerprint","correlation"]){const f=fixture(),row=f.saved.get(f.originalStopReceipt.commandId)!;
        if(mode==="missing")f.saved.delete(f.originalStopReceipt.commandId);
        if(mode==="identity")row.receipt={...row.receipt,networkId:"0".repeat(64)};
        if(mode==="fingerprint")row.fingerprint="changed-original-stop";
        if(mode==="correlation")row.receipt={...row.receipt,correlationId:"changed"};
        await expect(f.receiver.receive(f.command,f.signature(f.command))).rejects.toThrow();expect(f.start).not.toHaveBeenCalled();expect(f.replayStore.claim).not.toHaveBeenCalled();
    }
});
it("reads own completed start cache after executor/capability removal without either original read",async()=>{
    const f=fixture();await expect(f.receiver.receive(f.command,f.signature(f.command))).resolves.toEqual(f.receipt);f.setNow(20000);
    f.replayStore.lookupByFingerprintDigest.mockClear();f.saved.delete(f.originalReceipt.commandId);f.saved.delete(f.originalStopReceipt.commandId);
    const receiver=new AuthenticatedAgentCommandReceiver({...f.options,managedDatabaseStart:undefined,capabilities:[]});
    const signature=signAgentTransport(`POST ${MANAGED_DATABASE_START_RECEIPT_PATH}\n${JSON.stringify(f.query)}`,f.options.trustKey);
    await expect(receiver.readManagedDatabaseStartReceipt(f.query,signature)).resolves.toMatchObject({receipt:f.receipt});
    expect(f.replayStore.lookupByFingerprintDigest).not.toHaveBeenCalled();expect(f.start).toHaveBeenCalledOnce();expect(f.replayStore.claim).toHaveBeenCalledOnce();
});
