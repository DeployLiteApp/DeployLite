import type {IncomingMessage,ServerResponse} from "node:http";
import {expect,it,vi} from "vitest";
import {MANAGED_DATABASE_RESTORE_PATH,MANAGED_DATABASE_RESTORE_RECEIPT_PATH} from "@deploylite/contracts";
import {startAgentServer} from "./server.js";
const harness=vi.hoisted(()=>({callback:undefined as ((request:IncomingMessage,response:ServerResponse)=>Promise<void>)|undefined}));
vi.mock("node:http",()=>({createServer:(callback:typeof harness.callback)=>{harness.callback=callback;return {once:()=>{},removeListener:()=>{},listen:(_port:number,_host:string,ready:()=>void)=>ready(),close:(ready:()=>void)=>ready()};}}));
function fixture(){
 const receipt={schemaVersion:1,action:"database.runtime.restore",projectId:"p1",databaseId:"orders",engine:"postgres",profileId:"approved",agentId:"agent-a",commandId:"restore-a",originalCommandId:"origin-a",backupCommandId:"backup-a",confirmationId:"approval-a",inputDigest:"a".repeat(64),planDigest:"b".repeat(64),environmentFingerprint:"c".repeat(32),correlationId:"restore-correlation",containerId:"d".repeat(64),imageId:"sha256:"+"e".repeat(64),volumeName:"dl-"+"f".repeat(32)+"-vol-db-orders",networkName:"dl-"+"f".repeat(32)+"-net-db-orders",networkId:"0".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",archiveId:"backup_"+"a".repeat(32),archiveBytes:4,archiveSha256:"a".repeat(64),manifestSha256:"b".repeat(64),format:"postgres-custom-gzip",observedAt:3000,status:"restored",storage:"original",health:"passed",redacted:true};
 const cache={schemaVersion:1,action:receipt.action,agentId:receipt.agentId,commandId:receipt.commandId,confirmationId:receipt.confirmationId,correlationId:receipt.correlationId,receipt};
 const receiver={receive:vi.fn(),restoreManagedDatabase:vi.fn(async()=>receipt),readManagedDatabaseRestoreReceipt:vi.fn(async()=>cache),signResponse:vi.fn(()=>"signed-response")};
 async function request(path:string,body:unknown){
  const state={status:0,body:"",headers:{} as Record<string,string>},payload=Buffer.from(JSON.stringify(body));
  const req={method:"POST",url:path,headers:{"x-deploylite-signature":"signed-request"},once:()=>{},async *[Symbol.asyncIterator](){yield payload;}};
  const res={destroyed:false,writeHead(status:number,headers:Record<string,string>={}){state.status=status;state.headers=headers;return this;},end(body:string=""){state.body=body;return this;}};
  if(!harness.callback)throw new Error("No handler");await harness.callback(req as unknown as IncomingMessage,res as unknown as ServerResponse);return state;
 }
 return {receipt,cache,receiver,request};
}
it.each([MANAGED_DATABASE_RESTORE_PATH,MANAGED_DATABASE_RESTORE_RECEIPT_PATH])("mounts exact %s and signs path/request/strict redacted response without sockets",async path=>{
 const f=fixture(),server=await startAgentServer({host:"fixture.invalid",port:12345,receiver:f.receiver as never,replayStore:{durable:true} as never});
 try{const body={action:"database.runtime.restore"},result=await f.request(path,body);expect(result.status).toBe(200);expect(JSON.parse(result.body)).toEqual(path===MANAGED_DATABASE_RESTORE_PATH?f.receipt:f.cache);expect(result.headers["x-deploylite-response-signature"]).toBe("signed-response");expect(f.receiver.signResponse).toHaveBeenCalledWith(`POST ${path}\n${JSON.stringify(body)}\n${result.body}`);expect(f.receiver.receive).not.toHaveBeenCalled();}finally{await server.close();}
});
it("returns authenticated null restore cache through only the readonly port",async()=>{
 const f=fixture(),server=await startAgentServer({host:"fixture.invalid",port:12345,receiver:f.receiver as never,replayStore:{durable:true} as never});
 try{f.receiver.readManagedDatabaseRestoreReceipt.mockResolvedValue({...f.cache,receipt:null} as any);const result=await f.request(MANAGED_DATABASE_RESTORE_RECEIPT_PATH,{action:"database.runtime.restore"});expect(result.status).toBe(200);expect(JSON.parse(result.body).receipt).toBeNull();expect(f.receiver.restoreManagedDatabase).not.toHaveBeenCalled();}finally{await server.close();}
});
it("rejects restore action/path substitution before any receiver operation",async()=>{
 const f=fixture(),server=await startAgentServer({host:"fixture.invalid",port:12345,receiver:f.receiver as never,replayStore:{durable:true} as never});
 try{for(const path of [MANAGED_DATABASE_RESTORE_PATH,MANAGED_DATABASE_RESTORE_RECEIPT_PATH])for(const action of ["database.runtime","database.runtime.restore.archive","deploy.execute"])expect((await f.request(path,{action})).status).toBe(403);for(const path of ["/deployments/execute","/databases/runtime/restore/archive"])expect((await f.request(path,{action:"database.runtime.restore"})).status).toBe(403);expect(f.receiver.receive).not.toHaveBeenCalled();expect(f.receiver.restoreManagedDatabase).not.toHaveBeenCalled();expect(f.receiver.readManagedDatabaseRestoreReceipt).not.toHaveBeenCalled();}finally{await server.close();}
});
it("refuses private restore response fields before sending or signing bytes",async()=>{
 const f=fixture(),server=await startAgentServer({host:"fixture.invalid",port:12345,receiver:f.receiver as never,replayStore:{durable:true} as never});
 try{f.receiver.restoreManagedDatabase.mockResolvedValue({...f.receipt,bytes:"private"} as any);const result=await f.request(MANAGED_DATABASE_RESTORE_PATH,{action:"database.runtime.restore"});expect(result.status).toBe(400);expect(result.body).not.toContain("private");expect(f.receiver.signResponse).not.toHaveBeenCalled();}finally{await server.close();}
});
