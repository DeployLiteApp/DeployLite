import {startAgentServer} from "./server.js";
import {createHash} from "node:crypto";
import {expect,it,vi} from "vitest";
import {signAgentTransport} from "@deploylite/config";
import {MANAGED_DATABASE_BACKUP_RECEIPT_PATH, managedDatabaseRuntimeReceiptSchema, managedDatabaseBackupReceiptSchema, managedDatabaseBackupCachedReceiptSchema} from "@deploylite/contracts";
import {composeRuntimeResourceName, managedDatabaseRuntimeExecutionDigest, managedDatabaseBackupExecutionDigest, managedDatabaseBackupSourceDigest} from "@deploylite/domain";
import {AuthenticatedAgentCommandReceiver,type AgentReplayStore} from "./agent-transport.js";
function fixture() {
  let now=2000;
  const trustKey="test-backup-key-"+"x".repeat(64);
  const input={schemaVersion:1 as const,projectId:"project-a",databaseId:"orders",engine:"postgres" as const,profileId:"profile-a",planDigest:"a".repeat(64),environmentFingerprint:"b".repeat(32)};
  const {profileId:_profile,...request}=input;
  const original=managedDatabaseRuntimeReceiptSchema.parse({...request,action:"database.runtime",agentId:"agent-a",commandId:"origin-a",inputDigest:managedDatabaseRuntimeExecutionDigest(input),correlationId:"origin-correlation",containerId:"c".repeat(64),imageId:"sha256:"+"d".repeat(64),volumeName:composeRuntimeResourceName(input.projectId,"volume","db-orders"),networkName:composeRuntimeResourceName(input.projectId,"network","db-orders"),networkId:"e".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",observedAt:1000,status:"ready",health:"passed",storage:"verified",idempotent:false,redacted:true});
  const preparation={...input,originalReceipt:original,originalReplayFingerprint:createHash("sha256").update("origin-fingerprint").digest("hex"),destinationId:"destination-a",maxBytes:10000};
  const inputDigest=managedDatabaseBackupExecutionDigest(preparation),lease={projectId:input.projectId,leaseId:"backup-lease",fence:2,expiresAt:10000};
  const command={...preparation,action:"database.runtime.backup",operation:"database.runtime.backup",agentId:"agent-a",commandId:"backup-a",inputDigest,idempotencyKey:"backup-once",requiredCapabilities:["database.runtime.backup.v1"],authority:{schemaVersion:1,projectId:input.projectId,commandId:"backup-a",action:"project.update",inputDigest,projectLease:lease},lease,context:{requestId:"request-a",correlationId:"backup-correlation"},timeoutMs:1000,cancellationRequested:false};
  const receipt=managedDatabaseBackupReceiptSchema.parse({...input,action:command.action,agentId:command.agentId,commandId:command.commandId,originalCommandId:original.commandId,inputDigest,correlationId:command.context.correlationId,containerId:original.containerId,imageId:original.imageId,volumeName:original.volumeName,networkName:original.networkName,networkId:original.networkId,volumeCreatedAt:original.volumeCreatedAt,observedAt:2000,destinationId:command.destinationId,sourceDigest:managedDatabaseBackupSourceDigest(preparation),volumeKey:"db-orders",archiveId:"backup_"+"a".repeat(32),archiveBytes:4,archiveSha256:"a".repeat(64),manifestSha256:"b".repeat(64),format:"postgres-custom-gzip",consistency:"native-snapshot",status:"created",idempotent:false,storage:"verified",redacted:true});
  const saved=new Map<string,{fingerprint:string;receipt:Record<string,unknown>}>([[original.commandId,{fingerprint:"origin-fingerprint",receipt:original}]]);
  const replayStore={durable:true,lookupByFingerprintDigest:vi.fn(async(id:string,digest:string)=>{const row=saved.get(id);if(!row)return null;if(createHash("sha256").update(row.fingerprint).digest("hex")!==digest)throw new Error("conflict");return structuredClone(row.receipt);}),lookup:vi.fn<NonNullable<AgentReplayStore["lookup"]>>(async(id,fp)=>{const row=saved.get(id);if(!row)return null;if(row.fingerprint!==fp)throw new Error("conflict");return structuredClone(row.receipt);}),claim:vi.fn<AgentReplayStore["claim"]>(async()=>({claimed:true,claimToken:"token-a"})),wait:vi.fn<AgentReplayStore["wait"]>(async()=>{throw new Error("unexpected");}),complete:vi.fn<AgentReplayStore["complete"]>(async(id,row)=>{saved.set(id,structuredClone(row));}),release:vi.fn(async()=>{})};
  const execute=vi.fn(async()=>structuredClone(receipt)),validator=vi.fn(async()=>{});
  const options={agentId:"agent-a",trustKey,capabilities:["database.runtime.backup.v1"],dispatcher:{dispatch:async()=>{throw new Error("unused");}},managedDatabaseBackup:{execute},replayStore,authorityValidator:{validateDeploymentAuthority:async()=>{},validateProjectUpdateAuthority:validator},now:()=>now};
  const receiver=new AuthenticatedAgentCommandReceiver(options);
  const signature=(value:unknown)=>signAgentTransport(JSON.stringify(value),trustKey);
  const {cancellationRequested:_cancel,...query}=command;
  const read=(reader:any=receiver,value=query)=>reader.readManagedDatabaseBackupReceipt(value,signAgentTransport(`POST ${MANAGED_DATABASE_BACKUP_RECEIPT_PATH}\n${JSON.stringify(value)}`,trustKey));
  return {options,receiver,command,query,receipt,original,replayStore,saved,execute,validator,signature,read,setNow:(value:number)=>{now=value;}};
}
it("claims and captures once then recovers original backup evidence after expiry",async()=>{
  const f=fixture();expect(await f.receiver.receive(f.command,f.signature(f.command))).toEqual(f.receipt);
  f.setNow(20000);expect(await f.receiver.receive(f.command,f.signature(f.command))).toEqual(f.receipt);
  expect((await f.read()).receipt).toEqual(f.receipt);expect(f.execute).toHaveBeenCalledOnce();expect(f.replayStore.claim).toHaveBeenCalledOnce();expect(f.replayStore.complete).toHaveBeenCalledOnce();
});
it("returns explicit cache absence with no source lookup, claim or capture",async()=>{
  const f=fixture();expect((await f.read()).receipt).toBeNull();expect(f.replayStore.lookupByFingerprintDigest).not.toHaveBeenCalled();expect(f.replayStore.claim).not.toHaveBeenCalled();expect(f.execute).not.toHaveBeenCalled();
});
it("rejects invalid authentication and missing/detached original proof before claim",async()=>{
  const f=fixture();await expect(f.receiver.receive(f.command,"invalid")).rejects.toThrow();expect(f.replayStore.lookup).not.toHaveBeenCalled();
  for(const mode of ["missing","foreign"]){const f=fixture();if(mode==="missing")f.saved.delete(f.original.commandId);else f.saved.get(f.original.commandId)!.receipt={...f.original,containerId:"0".repeat(64)};
    await expect(f.receiver.receive(f.command,f.signature(f.command))).rejects.toThrow();expect(f.replayStore.claim).not.toHaveBeenCalled();expect(f.execute).not.toHaveBeenCalled();}
});
it("withholds the execution capability without durable source lookup, executor or authority",()=>{
  const f=fixture();for(const patch of [{managedDatabaseBackup:undefined},{replayStore:{...f.replayStore,durable:false}},{replayStore:{...f.replayStore,lookupByFingerprintDigest:undefined}},{authorityValidator:undefined}])
    expect(new AuthenticatedAgentCommandReceiver({...f.options,...patch}).capabilities).not.toContain("database.runtime.backup.v1");
});
it("retains uncertain claims when capture, receipt, authority or completion fails",async()=>{
  for(const stage of ["capture","receipt","authority","completion"]){const f=fixture();
    if(stage==="capture")f.execute.mockRejectedValue(new Error("private"));
    if(stage==="receipt")f.execute.mockResolvedValue({...f.receipt,sourceDigest:"0".repeat(64)});
    if(stage==="authority")f.execute.mockImplementation(async()=>{f.validator.mockRejectedValue(new Error("revoked"));return f.receipt;});
    if(stage==="completion")f.replayStore.complete.mockRejectedValue(new Error("private"));
    await expect(f.receiver.receive(f.command,f.signature(f.command))).rejects.toThrow();expect(f.execute).toHaveBeenCalledOnce();expect(f.replayStore.release).not.toHaveBeenCalled();if(stage!=="completion")expect(f.replayStore.complete).not.toHaveBeenCalled();
  }
});
it("reads completed durable backup after executor/capability withdrawal without another effect",async()=>{
  const f=fixture();await f.receiver.receive(f.command,f.signature(f.command));
  const reader=new AuthenticatedAgentCommandReceiver({...f.options,capabilities:[],managedDatabaseBackup:undefined});
  expect((await f.read(reader)).receipt).toEqual(f.receipt);expect(f.execute).toHaveBeenCalledOnce();
});
it("waits for a pre-existing claim and refuses detached terminal evidence",async()=>{
  const f=fixture();f.replayStore.claim.mockResolvedValue({claimed:false});f.replayStore.wait.mockResolvedValue(f.receipt);
  expect(await f.receiver.receive(f.command,f.signature(f.command))).toEqual(f.receipt);expect(f.execute).not.toHaveBeenCalled();
  f.replayStore.wait.mockResolvedValue({...f.receipt,destinationId:"foreign"});await expect(f.receiver.receive(f.command,f.signature(f.command))).rejects.toThrow();
});

it("serves dedicated signed backup/cache HTTP and rejects action/path mismatch before capture",async()=>{
  const f=fixture(),server=await startAgentServer({host:"127.0.0.1",port:0,receiver:f.receiver,replayStore:f.replayStore});
  try {
    const address=server.server.address();if(!address||typeof address==="string")throw new Error("missing address");
    const base=`http://127.0.0.1:${address.port}`;
    const send=(path:string,value:unknown,signature:string)=>fetch(base+path,{method:"POST",headers:{"content-type":"application/json","x-deploylite-signature":signature},body:JSON.stringify(value)});
    for(const path of ["/deployments/execute","/databases/runtime"]){expect((await send(path,f.command,f.signature(f.command))).status).toBe(403);}
    expect(f.execute).not.toHaveBeenCalled();
    const applied=await send("/databases/runtime/backup",f.command,f.signature(f.command));expect(applied.status).toBe(200);expect(await applied.json()).toEqual(f.receipt);
    const read=await send(MANAGED_DATABASE_BACKUP_RECEIPT_PATH,f.query,signAgentTransport(`POST ${MANAGED_DATABASE_BACKUP_RECEIPT_PATH}\n${JSON.stringify(f.query)}`,f.options.trustKey));
    expect(read.status).toBe(200);expect(managedDatabaseBackupCachedReceiptSchema.parse(await read.json()).receipt).toEqual(f.receipt);expect(f.execute).toHaveBeenCalledOnce();
  } finally {await server.close();}
});
it("redacts private capture/storage errors at the backup HTTP boundary",async()=>{
  const f=fixture();f.execute.mockRejectedValue(new Error("/private/archive/bundle.sql private credential"));
  const server=await startAgentServer({host:"127.0.0.1",port:0,receiver:f.receiver,replayStore:f.replayStore});
  try {
    const address=server.server.address();if(!address||typeof address==="string")throw new Error("missing address");
    const response=await fetch(`http://127.0.0.1:${address.port}/databases/runtime/backup`,{method:"POST",headers:{"content-type":"application/json","x-deploylite-signature":f.signature(f.command)},body:JSON.stringify(f.command)});
    expect(response.status).toBe(400);expect(await response.json()).toEqual({error:"Database backup is unavailable."});
  } finally {await server.close();}
});
