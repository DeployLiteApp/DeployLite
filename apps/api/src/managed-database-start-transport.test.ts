import {expect,it,vi} from "vitest";
import {signAgentTransport} from "@deploylite/config";
import {managedDatabaseRuntimeReceiptSchema,managedDatabaseStopReceiptSchema} from "@deploylite/contracts";
import {claimProjectUpdateAuthority,createControlCommand,managedDatabaseRuntimeExecutionDigest,managedDatabaseStartExecutionBinding,managedDatabaseStopExecutionDigest,composeRuntimeResourceName} from "@deploylite/domain";
import {isAgentPreDispatchRejection} from "./agent-transport.js";
import {AuthenticatedManagedDatabaseStartTransport} from "./managed-database-start-transport.js";
function fixture(){
    const input={schemaVersion:1 as const,projectId:"project-a",databaseId:"orders",engine:"postgres" as const,profileId:"profile-a",planDigest:"a".repeat(64),environmentFingerprint:"b".repeat(32)};
    const {profileId:_,...originInput}=input;
    const original=managedDatabaseRuntimeReceiptSchema.parse({...originInput,action:"database.runtime",agentId:"agent-a",commandId:"origin-a",inputDigest:managedDatabaseRuntimeExecutionDigest(input),correlationId:"origin-correlation",
        containerId:"c".repeat(64),imageId:"sha256:"+"d".repeat(64),volumeName:composeRuntimeResourceName(input.projectId,"volume","db-orders"),networkName:composeRuntimeResourceName(input.projectId,"network","db-orders"),networkId:"e".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",observedAt:1000,status:"ready",health:"passed",storage:"verified",idempotent:false,redacted:true});
    const stopPreparation={...input,originalReceipt:original,originalReplayFingerprint:"f".repeat(64)};
    const {health:_health,idempotent:_idempotent,...physical}=original;
    const originalStop=managedDatabaseStopReceiptSchema.parse({...physical,action:"database.runtime.stop",commandId:"stop-a",originalCommandId:original.commandId,profileId:input.profileId,
        inputDigest:managedDatabaseStopExecutionDigest(stopPreparation),correlationId:"original-stop-correlation",observedAt:1500,status:"stopped"});
    const preparation={...stopPreparation,originalStopReceipt:originalStop,originalStopReplayFingerprint:"0".repeat(64)};
    const command={...createControlCommand({actorId:"operator-a",action:"project.update",scope:{kind:"project" as const,projectId:input.projectId},input:managedDatabaseStartExecutionBinding(preparation),idempotencyKey:"stop-key",correlationId:"stop-correlation",expiresAt:new Date(Date.now()+30000)}),status:"eligible" as const};
    const authority=claimProjectUpdateAuthority([command],command)!,prepared={command,input:preparation,agentId:"agent-a"},context={requestId:"request-a",correlationId:command.correlationId};
    const receipt={...input,action:"database.runtime.start",agentId:"agent-a",commandId:command.id,originalCommandId:original.commandId,originalStopCommandId:originalStop.commandId,inputDigest:command.inputDigest,correlationId:command.correlationId,
        containerId:original.containerId,imageId:original.imageId,volumeName:original.volumeName,networkName:original.networkName,networkId:original.networkId,volumeCreatedAt:original.volumeCreatedAt,observedAt:2000,status:"ready",health:"passed",idempotent:false,storage:"verified",redacted:true};
    const trustKey="stop-transport-key-"+"x".repeat(64);
    const fetchResponse:typeof fetch=async(url,init)=>{
        if(String(url).endsWith("/capabilities"))return new Response(JSON.stringify({schemaVersion:1,agentId:"agent-a",capabilities:["database.runtime.start.v1"],protocolVersions:[1]}),{headers:{"x-deploylite-request-signature":String((init?.headers as Record<string,string>)["x-deploylite-signature"])}});
        if(String(url).endsWith("/receipt"))return new Response(JSON.stringify({schemaVersion:1,action:"database.runtime.start",agentId:"agent-a",commandId:command.id,correlationId:command.correlationId,receipt}));
        return new Response(JSON.stringify(receipt));
    };
    const fetcher=vi.fn(fetchResponse),options={endpoint:"https://agent.test",agentId:"agent-a",trustKey,timeoutMs:1000,fetch:fetcher};
    return {input,original,preparation,command,authority,prepared,context,receipt,trustKey,fetcher,fetchResponse,options,transport:new AuthenticatedManagedDatabaseStartTransport(options)};
}
it("signs start with the separate authority and original proof without secrets or execution options",async()=>{
    const f=fixture();await expect(f.transport.dispatch(f.prepared,f.authority,f.context)).resolves.toEqual(f.receipt);
    const [url,init]=f.fetcher.mock.calls[1]!;expect(url).toBe("https://agent.test/databases/runtime/start");expect(init?.redirect).toBe("error");
    const body=JSON.parse(String(init?.body));expect(body).toMatchObject({action:"database.runtime.start",operation:"database.runtime.start",authority:f.authority,lease:f.authority.projectLease,originalReceipt:f.original,originalStopReceipt:f.preparation.originalStopReceipt,originalStopReplayFingerprint:f.preparation.originalStopReplayFingerprint,cancellationRequested:false});
    expect(body).not.toHaveProperty("sealedEnvironment");expect(body).not.toHaveProperty("argv");expect(body).not.toHaveProperty("command");
    expect((init?.headers as Record<string,string>)["x-deploylite-signature"]).toBe(signAgentTransport(String(init?.body),f.trustKey));
});
it("recovers only the start cache after capability removal without execution fields or effects",async()=>{
    const f=fixture();f.fetcher.mockImplementationOnce(async(_url,init)=>new Response(JSON.stringify({schemaVersion:1,agentId:"agent-a",capabilities:[],protocolVersions:[1]}),{headers:{"x-deploylite-request-signature":String((init?.headers as Record<string,string>)["x-deploylite-signature"])}}));
    await expect(f.transport.readReceipt(f.prepared,f.authority,f.context)).resolves.toEqual(f.receipt);
    const [url,init]=f.fetcher.mock.calls[1]!;expect(url).toBe("https://agent.test/databases/runtime/start/receipt");const body=JSON.parse(String(init?.body));expect(body).not.toHaveProperty("cancellationRequested");expect(body).not.toHaveProperty("sealedEnvironment");
    expect((init?.headers as Record<string,string>)["x-deploylite-signature"]).toBe(signAgentTransport(`POST /databases/runtime/start/receipt\n${init?.body}`,f.trustKey));
});
it("returns explicit start cache absence without dispatch",async()=>{
    const f=fixture();f.fetcher.mockImplementation(async(url,init)=>String(url).endsWith("/receipt")?new Response(JSON.stringify({schemaVersion:1,action:"database.runtime.start",agentId:"agent-a",commandId:f.command.id,correlationId:f.command.correlationId,receipt:null})):f.fetchResponse(url,init));
    await expect(f.transport.readReceipt(f.prepared,f.authority,f.context)).resolves.toBeNull();expect(f.fetcher.mock.calls.map(([url])=>String(url))).not.toContain("https://agent.test/databases/runtime/start");
});
it("rejects detached preparation, authority, agent and correlation before fetching",async()=>{
    for(const mode of ["digest","authority","agent","correlation"]){const f=fixture();const prepared=mode==="digest"?{...f.prepared,command:{...f.command,inputDigest:"0".repeat(64)}}:mode==="agent"?{...f.prepared,agentId:"foreign"}:f.prepared;
        const authority=mode==="authority"?{...f.authority,commandId:"foreign"}:f.authority,context=mode==="correlation"?{...f.context,correlationId:"foreign"}:f.context;
        const error=await f.transport.dispatch(prepared,authority,context).catch(error=>error);expect(isAgentPreDispatchRejection(error)).toBe(true);expect(f.fetcher).not.toHaveBeenCalled();}
});
it("requires start capability for new effects and validates signed handshake identity",async()=>{
    for(const patch of [{capabilities:[]},{agentId:"foreign"},{protocolVersions:[2]}]){const f=fixture();f.fetcher.mockImplementationOnce(async(_url,init)=>new Response(JSON.stringify({schemaVersion:1,agentId:"agent-a",capabilities:["database.runtime.start.v1"],protocolVersions:[1],...patch}),{headers:{"x-deploylite-request-signature":String((init?.headers as Record<string,string>)["x-deploylite-signature"])}}));
        const error=await f.transport.dispatch(f.prepared,f.authority,f.context).catch(error=>error);expect(isAgentPreDispatchRejection(error)).toBe(true);expect(f.fetcher).toHaveBeenCalledOnce();}
});
it("refuses changed original identities and receipt scope after POST without claiming no effect",async()=>{
    for(const patch of [{containerId:"a".repeat(64)},{networkId:"a".repeat(64)},{profileId:"foreign"},{originalCommandId:"foreign"},{originalStopCommandId:"foreign"},{password:"private"},{observedAt:1499},{inputDigest:"0".repeat(64)},{observedAt:999}]){const f=fixture();f.fetcher.mockImplementation(async(url,init)=>String(url).endsWith("/start")?new Response(JSON.stringify({...f.receipt,...patch})):f.fetchResponse(url,init));
        const error=await f.transport.dispatch(f.prepared,f.authority,f.context).catch(error=>error);expect(error).toBeInstanceOf(Error);expect(isAgentPreDispatchRejection(error)).toBe(false);expect(f.fetcher).toHaveBeenCalledTimes(2);}
});
it("bounds stalled fetch and JSON ports and pre-cancellation without dispatch",async()=>{
    for(const stage of ["fetch","json"]){const f=fixture();f.fetcher.mockImplementation(stage==="fetch"?async()=>new Promise(()=>{}):async(_url,init)=>({ok:true,headers:new Headers({"x-deploylite-request-signature":String((init?.headers as Record<string,string>)["x-deploylite-signature"])}),json:()=>new Promise(()=>{})}) as Response);
        const transport=new AuthenticatedManagedDatabaseStartTransport({...f.options,timeoutMs:5});await expect(transport.dispatch(f.prepared,f.authority,f.context)).rejects.toThrow();}
    const f=fixture(),abort=new AbortController();abort.abort();await expect(f.transport.dispatch(f.prepared,f.authority,{...f.context,signal:abort.signal})).rejects.toThrow();expect(f.fetcher).not.toHaveBeenCalled();
});
it("uses the existing explicit endpoint and limit admission without inventing access",()=>{
    const f=fixture();expect(f.transport.available()).toBe(true);
    for(const endpoint of ["http://public.test","https://user:password@agent.test","https://agent.test/?token=private"]){expect(new AuthenticatedManagedDatabaseStartTransport({...f.options,endpoint}).available()).toBe(false);}
    expect(new AuthenticatedManagedDatabaseStartTransport({...f.options,endpoint:"http://agent",allowInsecureInternal:true}).available()).toBe(true);
    expect(new AuthenticatedManagedDatabaseStartTransport({...f.options,timeoutMs:0}).available()).toBe(false);expect(f.fetcher).not.toHaveBeenCalled();
});
