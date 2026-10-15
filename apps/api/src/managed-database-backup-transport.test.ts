import {expect,it,vi} from "vitest";
import {signAgentTransport} from "@deploylite/config";
import {managedDatabaseRuntimeReceiptSchema,managedDatabaseBackupReceiptSchema} from "@deploylite/contracts";
import {createControlCommand,managedDatabaseRuntimeExecutionDigest,managedDatabaseBackupExecutionBinding,managedDatabaseBackupExecutionDigest,managedDatabaseBackupSourceDigest,composeRuntimeResourceName} from "@deploylite/domain";
import {AuthenticatedManagedDatabaseBackupTransport} from "./managed-database-backup-transport.js";
function fixture() {
  const base={schemaVersion:1 as const,projectId:"project-a",databaseId:"orders",engine:"postgres" as const,profileId:"profile-a",planDigest:"a".repeat(64),environmentFingerprint:"b".repeat(32)};
  const {profileId:_profile,...request}=base;
  const original=managedDatabaseRuntimeReceiptSchema.parse({...request,action:"database.runtime",agentId:"agent-a",commandId:"origin-a",inputDigest:managedDatabaseRuntimeExecutionDigest(base),correlationId:"origin-correlation",containerId:"c".repeat(64),imageId:"sha256:"+"d".repeat(64),volumeName:composeRuntimeResourceName(base.projectId,"volume","db-orders"),networkName:composeRuntimeResourceName(base.projectId,"network","db-orders"),networkId:"e".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",observedAt:1000,status:"ready",health:"passed",storage:"verified",idempotent:false,redacted:true});
  const input={...base,originalReceipt:original,originalReplayFingerprint:"f".repeat(64),destinationId:"destination-a",maxBytes:10000};
  const binding=managedDatabaseBackupExecutionBinding(input);
  const command=createControlCommand({actorId:"actor-a",action:"project.update",scope:binding.scope,input:binding,idempotencyKey:"backup-once",correlationId:"backup-correlation",expiresAt:new Date(10000)});
  const prepared={command,input,agentId:"agent-a"};
  const lease={projectId:base.projectId,leaseId:"backup-lease",fence:2,expiresAt:10000};
  const authority={schemaVersion:1 as const,projectId:base.projectId,commandId:command.id,action:"project.update" as const,inputDigest:command.inputDigest,projectLease:lease};
  const receipt=managedDatabaseBackupReceiptSchema.parse({...base,action:"database.runtime.backup",agentId:"agent-a",commandId:command.id,originalCommandId:original.commandId,inputDigest:managedDatabaseBackupExecutionDigest(input),correlationId:command.correlationId,containerId:original.containerId,imageId:original.imageId,volumeName:original.volumeName,networkName:original.networkName,networkId:original.networkId,volumeCreatedAt:original.volumeCreatedAt,observedAt:2000,destinationId:input.destinationId,sourceDigest:managedDatabaseBackupSourceDigest(input),volumeKey:"db-orders",archiveId:"backup_"+"a".repeat(32),archiveBytes:4,archiveSha256:"a".repeat(64),manifestSha256:"b".repeat(64),format:"postgres-custom-gzip",consistency:"native-snapshot",status:"created",idempotent:false,storage:"verified",redacted:true});
  const trustKey="test-backup-transport-"+"x".repeat(64),context={requestId:"request-a",correlationId:command.correlationId};
  let capability=true,readReceipt:any=receipt;
  const fetcher=vi.fn(async(url:string|URL|Request,options?:RequestInit)=>{
    if(String(url).endsWith("/capabilities"))return new Response(JSON.stringify({schemaVersion:1,agentId:"agent-a",capabilities:capability?["database.runtime.backup.v1"]:[],protocolVersions:[1]}),{headers:{"content-type":"application/json","x-deploylite-request-signature":signAgentTransport("GET /capabilities",trustKey)}});
    const body=JSON.parse(String(options?.body));
    if(String(url).endsWith("/receipt"))return new Response(JSON.stringify({schemaVersion:1,action:"database.runtime.backup",agentId:"agent-a",commandId:command.id,correlationId:command.correlationId,receipt:readReceipt}));
    return new Response(JSON.stringify(receipt));
  });
  const options={agentId:"agent-a",endpoint:"http://127.0.0.1:45000",trustKey,timeoutMs:1000,allowInsecureInternal:true,fetch:fetcher as typeof fetch};
  return {prepared,authority,receipt,context,options,fetcher,transport:new AuthenticatedManagedDatabaseBackupTransport(options),setCapability:(value:boolean)=>{capability=value;},setReceipt:(value:unknown)=>{readReceipt=value;}};
}
it("dispatches signed bound backup metadata without paths, credentials or bytes",async()=>{
  const f=fixture();expect(await f.transport.dispatch(f.prepared,f.authority,f.context)).toEqual(f.receipt);
  expect(f.fetcher).toHaveBeenCalledTimes(2);const [url,options]=f.fetcher.mock.calls[1]!;
  expect(String(url)).toBe(f.options.endpoint+"/databases/runtime/backup");
  const body=JSON.parse(String(options?.body));expect(body).toMatchObject({destinationId:"destination-a",maxBytes:10000,inputDigest:f.prepared.command.inputDigest,cancellationRequested:false});
  expect(options?.headers).toMatchObject({"x-deploylite-signature":signAgentTransport(String(options?.body),f.options.trustKey)});
  for(const field of ["password","path","argv","bytes","environment"])expect(body).not.toHaveProperty(field);
});
it("recovers completed cache after execution capability withdrawal and signs the receipt path",async()=>{
  const f=fixture();f.setCapability(false);expect(await f.transport.readReceipt(f.prepared,f.authority,f.context)).toEqual(f.receipt);
  const [url,options]=f.fetcher.mock.calls[1]!;expect(String(url)).toBe(f.options.endpoint+"/databases/runtime/backup/receipt");
  expect(options?.headers).toMatchObject({"x-deploylite-signature":signAgentTransport(`POST /databases/runtime/backup/receipt\n${String(options?.body)}`,f.options.trustKey)});
});
it("rejects absent execution capability and detached authority before POST",async()=>{
  for(const mode of ["capability","authority"]){const f=fixture();if(mode==="capability")f.setCapability(false);
    await expect(f.transport.dispatch(f.prepared,mode==="authority"?{...f.authority,commandId:"foreign"}:f.authority,f.context)).rejects.toThrow();
    expect(f.fetcher.mock.calls.some(([,options])=>options?.method==="POST")).toBe(false);
  }
});
it("refuses detached/private cached receipt and preserves explicit absence",async()=>{
  for(const patch of [{sourceDigest:"0".repeat(64)},{destinationId:"foreign"},{path:"/private"}]){const f=fixture();f.setReceipt({...f.receipt,...patch});await expect(f.transport.readReceipt(f.prepared,f.authority,f.context)).rejects.toThrow();}
  const f=fixture();f.setReceipt(null);expect(await f.transport.readReceipt(f.prepared,f.authority,f.context)).toBeNull();
});
it("bounds uncooperative transport and cancellation without retry",async()=>{
  const f=fixture();f.fetcher.mockImplementation(()=>new Promise(()=>{}));
  const transport=new AuthenticatedManagedDatabaseBackupTransport({...f.options,timeoutMs:5});
  await expect(transport.dispatch(f.prepared,f.authority,f.context)).rejects.toThrow();expect(f.fetcher).toHaveBeenCalledOnce();
  const g=fixture(),controller=new AbortController();controller.abort();await expect(g.transport.dispatch(g.prepared,g.authority,{...g.context,signal:controller.signal})).rejects.toThrow();expect(g.fetcher).not.toHaveBeenCalled();
});
