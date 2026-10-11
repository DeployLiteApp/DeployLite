import type {IncomingMessage,ServerResponse} from "node:http";
import {expect,it,vi} from "vitest";
import {MANAGED_DATABASE_START_PATH,MANAGED_DATABASE_START_RECEIPT_PATH} from "@deploylite/contracts";
import {startAgentServer} from "./server.js";
const harness=vi.hoisted(()=>({callback:undefined as ((request:IncomingMessage,response:ServerResponse)=>Promise<void>)|undefined}));
vi.mock("node:http",()=>({createServer:(callback:typeof harness.callback)=>{
  harness.callback=callback;return {once:()=>{},removeListener:()=>{},listen:(_port:number,_host:string,ready:()=>void)=>ready(),close:(ready:()=>void)=>ready()};
}}));
function fixture(){
  const receipt={schemaVersion:1,action:"database.runtime.start",projectId:"p1",databaseId:"orders",engine:"postgres",profileId:"profile-a",agentId:"agent-a",
    commandId:"start-a",originalCommandId:"create-a",originalStopCommandId:"stop-a",inputDigest:"a".repeat(64),planDigest:"b".repeat(64),environmentFingerprint:"c".repeat(32),
    correlationId:"correlation-a",containerId:"d".repeat(64),imageId:"sha256:"+"e".repeat(64),volumeName:"dl-"+"f".repeat(32)+"-vol-db-orders",
    networkName:"dl-"+"f".repeat(32)+"-net-db-orders",networkId:"0".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",observedAt:1000,status:"ready",health:"passed",storage:"verified",idempotent:false,redacted:true};
  const cached={schemaVersion:1,action:receipt.action,agentId:receipt.agentId,commandId:receipt.commandId,correlationId:receipt.correlationId,receipt};
  const receiver={receive:vi.fn(async()=>receipt),readManagedDatabaseStartReceipt:vi.fn(async()=>cached)};
  async function request(path:string,body:unknown){
    const state={status:0,body:""},payload=Buffer.from(JSON.stringify(body));
    const req={method:"POST",url:path,headers:{"x-deploylite-signature":"signed-request"},once:()=>{},async *[Symbol.asyncIterator](){yield payload;}};
    const res={destroyed:false,writeHead(status:number){state.status=status;return this;},end(body:string=""){state.body=body;return this;}};
    if(!harness.callback)throw new Error("No handler");await harness.callback(req as unknown as IncomingMessage,res as unknown as ServerResponse);return state;
  }
  return {receipt,cached,receiver,request};
}
it("mounts strict native start and own cache schemas on dedicated signed routes with injected HTTP",async()=>{
  const f=fixture(),server=await startAgentServer({host:"fixture.invalid",port:12345,receiver:f.receiver as never,replayStore:{durable:true} as never});
  try {
    const body={action:"database.runtime.start"};const execution=await f.request(MANAGED_DATABASE_START_PATH,body);
    expect(execution.status).toBe(200);expect(JSON.parse(execution.body)).toEqual(f.receipt);
    expect(f.receiver.receive).toHaveBeenCalledWith(body,"signed-request",expect.any(AbortSignal));
    const cached=await f.request(MANAGED_DATABASE_START_RECEIPT_PATH,body);expect(cached.status).toBe(200);expect(JSON.parse(cached.body)).toEqual(f.cached);
    expect(f.receiver.readManagedDatabaseStartReceipt).toHaveBeenCalledWith(body,"signed-request",expect.any(AbortSignal));
  } finally {await server.close();}
});
it("refuses native start path/action substitution before any receiver or cache call",async()=>{
  const f=fixture(),server=await startAgentServer({host:"fixture.invalid",port:12345,receiver:f.receiver as never,replayStore:{durable:true} as never});
  try {
    for(const path of [MANAGED_DATABASE_START_PATH,MANAGED_DATABASE_START_RECEIPT_PATH]){
      for(const action of ["database.runtime","database.runtime.stop","deploy.execute"]){expect((await f.request(path,{action})).status).toBe(403);}
    }
    for(const path of ["/deployments/execute","/databases/runtime","/databases/runtime/stop"]){expect((await f.request(path,{action:"database.runtime.start"})).status).toBe(403);}
    expect(f.receiver.receive).not.toHaveBeenCalled();expect(f.receiver.readManagedDatabaseStartReceipt).not.toHaveBeenCalled();
  } finally {await server.close();}
});
it("rejects private or detached receipt projections instead of exposing a successful route response",async()=>{
  const f=fixture(),server=await startAgentServer({host:"fixture.invalid",port:12345,receiver:f.receiver as never,replayStore:{durable:true} as never});
  try {
    f.receiver.receive.mockResolvedValue({...f.receipt,commandId:f.receipt.originalCommandId});
    expect((await f.request(MANAGED_DATABASE_START_PATH,{action:f.receipt.action})).status).toBe(400);
    f.receiver.readManagedDatabaseStartReceipt.mockResolvedValue({...f.cached,commandId:"foreign"});
    expect((await f.request(MANAGED_DATABASE_START_RECEIPT_PATH,{action:f.receipt.action})).status).toBe(400);
  } finally {await server.close();}
});
