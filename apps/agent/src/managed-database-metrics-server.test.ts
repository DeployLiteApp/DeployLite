import type {IncomingMessage,ServerResponse} from "node:http";
import {expect,it,vi} from "vitest";
import {MANAGED_DATABASE_METRICS_PATH} from "@deploylite/contracts";
import {startAgentServer} from "./server.js";
const harness=vi.hoisted(()=>({callback:undefined as ((request:IncomingMessage,response:ServerResponse)=>Promise<void>)|undefined}));
vi.mock("node:http",()=>({createServer:(callback:typeof harness.callback)=>{
  harness.callback=callback;return {once:()=>{},removeListener:()=>{},listen:(_port:number,_host:string,ready:()=>void)=>ready(),close:(ready:()=>void)=>ready()};
}}));
function fixture(){
 const observation={schemaVersion:1,action:"database.runtime.metrics",projectId:"p1",databaseId:"orders",engine:"postgres",profileId:"profile-a",agentId:"agent-a",originalCommandId:"create-a",planDigest:"b".repeat(64),environmentFingerprint:"c".repeat(32),context:{requestId:"health-a",correlationId:"correlation-a"},containerId:"d".repeat(64),imageId:"sha256:"+"e".repeat(64),volumeName:"dl-"+"f".repeat(32)+"-vol-db-orders",networkName:"dl-"+"f".repeat(32)+"-net-db-orders",networkId:"0".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",observedAt:2000,state:"running",health:"healthy",uid:999,storage:"verified",redacted:true,metrics:{cpuPercent:0.25,memoryUsage:"5.629MiB / 512MiB",memoryPercent:1.1,networkIO:"916B / 0B",blockIO:"147kB / 0B",pids:9},metricsObservedAt:2000};
 const receiver={receive:vi.fn(),observeManagedDatabaseMetrics:vi.fn(async()=>observation),signResponse:vi.fn(()=>"signed-response")};
 async function request(path:string,body:unknown){
  const state={status:0,body:"",headers:{} as Record<string,string>},payload=Buffer.from(JSON.stringify(body));
  const req={method:"POST",url:path,headers:{"x-deploylite-signature":"signed-request"},once:()=>{},async *[Symbol.asyncIterator](){yield payload;}};
  const res={destroyed:false,writeHead(status:number,headers:Record<string,string>={}){state.status=status;state.headers=headers;return this;},end(body:string=""){state.body=body;return this;}};
  if(!harness.callback)throw new Error("No handler");await harness.callback(req as unknown as IncomingMessage,res as unknown as ServerResponse);return state;
 }
 return {observation,receiver,request};
}
it("mounts readonly metrics and signs the exact path/request/public response without sockets",async()=>{const f=fixture(),server=await startAgentServer({host:"fixture.invalid",port:12345,receiver:f.receiver as never,replayStore:{durable:true} as never});try{const body={action:"database.runtime.metrics"},result=await f.request(MANAGED_DATABASE_METRICS_PATH,body);expect(result.status).toBe(200);expect(JSON.parse(result.body)).toEqual(f.observation);expect(result.headers["x-deploylite-response-signature"]).toBe("signed-response");expect(f.receiver.signResponse).toHaveBeenCalledWith(`POST ${MANAGED_DATABASE_METRICS_PATH}\n${JSON.stringify(body)}\n${result.body}`);expect(f.receiver.receive).not.toHaveBeenCalled();}finally{await server.close();}});
it("rejects metrics path/action substitution before any receiver port",async()=>{const f=fixture(),server=await startAgentServer({host:"fixture.invalid",port:12345,receiver:f.receiver as never,replayStore:{durable:true} as never});try{for(const action of ["database.runtime","database.runtime.start","database.runtime.health","deploy.execute"])expect((await f.request(MANAGED_DATABASE_METRICS_PATH,{action})).status).toBe(403);for(const path of ["/deployments/execute","/databases/runtime","/databases/runtime/start","/databases/runtime/health"])expect((await f.request(path,{action:"database.runtime.metrics"})).status).toBe(403);expect(f.receiver.receive).not.toHaveBeenCalled();expect(f.receiver.observeManagedDatabaseMetrics).not.toHaveBeenCalled();}finally{await server.close();}});
it("rejects private metrics fields before sending or signing a response",async()=>{const f=fixture(),server=await startAgentServer({host:"fixture.invalid",port:12345,receiver:f.receiver as never,replayStore:{durable:true} as never});try{f.receiver.observeManagedDatabaseMetrics.mockResolvedValue({...f.observation,password:"private"} as any);expect((await f.request(MANAGED_DATABASE_METRICS_PATH,{action:"database.runtime.metrics"})).status).toBe(400);expect(f.receiver.signResponse).not.toHaveBeenCalled();}finally{await server.close();}});
