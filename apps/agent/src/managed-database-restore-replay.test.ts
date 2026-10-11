import {createHash} from "node:crypto";
import {expect,it,vi} from "vitest";
import {signAgentTransport} from "@deploylite/config";
import {managedDatabaseRuntimeReceiptSchema,managedDatabaseRestoreAgentCommandSchema,MANAGED_DATABASE_RESTORE_PATH,MANAGED_DATABASE_RESTORE_RECEIPT_PATH} from "@deploylite/contracts";
import {managedDatabaseRuntimeExecutionDigest,managedDatabaseBackupExecutionDigest,managedDatabaseBackupSourceDigest,managedDatabaseRestoreExecutionDigest,composeRuntimeResourceName} from "@deploylite/domain";
import {AuthenticatedAgentCommandReceiver,type AgentReplayStore} from "./agent-transport.js";
const engines=["postgres","mysql","mariadb","mongodb","redis"] as const;
function fixture(engine:typeof engines[number]="postgres"){
 let now=1000;const trustKey="unit-agent-restore-key-"+"x".repeat(64),input={schemaVersion:1 as const,projectId:"project-a",databaseId:"orders",engine,profileId:"profile-a",planDigest:"a".repeat(64),environmentFingerprint:"b".repeat(32)};
    const {profileId:__,...originInput}=input;
    const originalReceipt=managedDatabaseRuntimeReceiptSchema.parse({...originInput,action:"database.runtime",agentId:"agent-a",commandId:"origin-a",inputDigest:managedDatabaseRuntimeExecutionDigest(input),correlationId:"origin-correlation",
        containerId:"c".repeat(64),imageId:"sha256:"+"d".repeat(64),volumeName:composeRuntimeResourceName(input.projectId,"volume","db-orders"),networkName:composeRuntimeResourceName(input.projectId,"network","db-orders"),networkId:"e".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",observedAt:1000,status:"ready",health:"passed",storage:"verified",idempotent:false,redacted:true});

 const source={...input,originalReceipt,originalReplayFingerprint:createHash("sha256").update("original-canonical-fingerprint").digest("hex")},capture={...source,destinationId:"private-native",maxBytes:1048576};
 const {status:_status,health:_health,inputDigest:_digest,correlationId:_correlation,...physical}=originalReceipt;
 const backupReceipt={...physical,profileId:input.profileId,action:"database.runtime.backup",commandId:"backup-a",originalCommandId:originalReceipt.commandId,inputDigest:managedDatabaseBackupExecutionDigest(capture),correlationId:"backup-correlation",volumeKey:"db-orders",sourceDigest:managedDatabaseBackupSourceDigest(capture),destinationId:capture.destinationId,archiveId:"backup_"+"f".repeat(32),archiveBytes:4,archiveSha256:"a".repeat(64),manifestSha256:"b".repeat(64),format:{postgres:"postgres-custom-gzip",mysql:"mysql-sql-gzip",mariadb:"mariadb-sql-gzip",mongodb:"mongodb-archive-gzip",redis:"volume-tar"}[engine],consistency:{postgres:"native-snapshot",mysql:"global-read-lock",mariadb:"global-read-lock",mongodb:"quiesced-writes",redis:"all-consumers-stopped"}[engine],status:"created"};
 const preparation={...source,backupReceipt,maxBytes:capture.maxBytes},inputDigest=managedDatabaseRestoreExecutionDigest(preparation),lease={projectId:input.projectId,leaseId:"restore-lease",fence:2,expiresAt:10000};
 const command=managedDatabaseRestoreAgentCommandSchema.parse({...preparation,action:"database.runtime.restore",operation:"database.runtime.restore",confirmationId:"approval-a",agentId:"agent-a",commandId:"restore-a",idempotencyKey:"restore-once",inputDigest,requiredCapabilities:["database.runtime.restore.v1"],authority:{schemaVersion:1,projectId:input.projectId,commandId:"restore-a",action:"project.update",inputDigest,projectLease:lease},lease,context:{requestId:"request-a",correlationId:"restore-correlation"},timeoutMs:5000,cancellationRequested:false});
 const receipt={...input,action:"database.runtime.restore" as const,agentId:"agent-a",commandId:"restore-a",originalCommandId:originalReceipt.commandId,backupCommandId:backupReceipt.commandId,confirmationId:command.confirmationId,inputDigest,correlationId:command.context.correlationId,containerId:originalReceipt.containerId!,imageId:originalReceipt.imageId!,volumeName:originalReceipt.volumeName,networkName:originalReceipt.networkName,networkId:originalReceipt.networkId!,volumeCreatedAt:originalReceipt.volumeCreatedAt!,archiveId:backupReceipt.archiveId,archiveBytes:backupReceipt.archiveBytes,archiveSha256:backupReceipt.archiveSha256,manifestSha256:backupReceipt.manifestSha256,format:command.backupReceipt.format,observedAt:1000,status:"restored" as const,storage:"original" as const,health:"passed" as const,redacted:true as const};
    const saved=new Map<string,{fingerprint:string;receipt:Record<string,unknown>}>([[originalReceipt.commandId,{fingerprint:"original-canonical-fingerprint",receipt:originalReceipt}]]);
    const replayStore={durable:true,lookupByFingerprintDigest:vi.fn(async(id:string,digest:string)=>{const row=saved.get(id);if(!row)return null;if(createHash("sha256").update(row.fingerprint).digest("hex")!==digest)throw new Error("conflict");return structuredClone(row.receipt);}),lookup:vi.fn<NonNullable<AgentReplayStore["lookup"]>>(async(id,fp)=>{const row=saved.get(id);if(!row)return null;if(row.fingerprint!==fp)throw new Error("conflict");return structuredClone(row.receipt);}),claim:vi.fn<AgentReplayStore["claim"]>(async()=>({claimed:true,claimToken:"token-a"})),wait:vi.fn<AgentReplayStore["wait"]>(async()=>{throw new Error("unexpected");}),complete:vi.fn<AgentReplayStore["complete"]>(async(id,row)=>{saved.set(id,structuredClone(row));}),release:vi.fn(async()=>{})};

 const restore=vi.fn(async()=>structuredClone(receipt)),validator=vi.fn(async()=>{}),confirmed=vi.fn(async()=>{});
 const options={agentId:"agent-a",trustKey,capabilities:["database.runtime.restore.v1"],dispatcher:{dispatch:async()=>{throw new Error("unused");}},managedDatabaseRestore:{restore},replayStore,authorityValidator:{validateDeploymentAuthority:async()=>{},validateProjectUpdateAuthority:validator,validateConfirmedProjectUpdateAuthority:confirmed},now:()=>now};
 const receiver=new AuthenticatedAgentCommandReceiver(options),signature=(value:unknown,path=MANAGED_DATABASE_RESTORE_PATH as string)=>signAgentTransport(`POST ${path}\n${JSON.stringify(value)}`,trustKey);
 const {cancellationRequested:_,...query}=command;
 const apply=()=>receiver.restoreManagedDatabase(command,signature(command)),read=()=>receiver.readManagedDatabaseRestoreReceipt(query,signature(query,MANAGED_DATABASE_RESTORE_RECEIPT_PATH));
 return {options,command,query,receipt,originalReceipt,replayStore,saved,restore,validator,confirmed,receiver,signature,apply,read,setNow:(value:number)=>{now=value;}};
}
it.each(engines)("executes confirmed %s once and reads original immutable cache after expiry without authority renewal",async engine=>{
 const f=fixture(engine);expect(await f.apply()).toEqual(f.receipt);expect(f.confirmed).toHaveBeenCalled();expect(f.restore).toHaveBeenCalledOnce();expect(f.replayStore.complete).toHaveBeenCalledOnce();
 f.setNow(20000);f.confirmed.mockClear();f.validator.mockClear();expect((await f.read()).receipt).toEqual(f.receipt);expect(f.restore).toHaveBeenCalledOnce();expect(f.confirmed).not.toHaveBeenCalled();expect(f.validator).not.toHaveBeenCalled();expect(f.replayStore.release).not.toHaveBeenCalled();
});
it("returns signed cache absence without claim or effect",async()=>{const f=fixture();expect((await f.read()).receipt).toBeNull();expect(f.restore).not.toHaveBeenCalled();expect(f.replayStore.claim).not.toHaveBeenCalled();});
it.each(["unconsumed","expired","original","capability"])("rejects %s approval or source before replay claim or effect",async mode=>{
 const f=fixture();let receiver=f.receiver;
 if(mode==="unconsumed")f.confirmed.mockRejectedValue(new Error("not consumed"));if(mode==="expired")f.setNow(20000);if(mode==="original")f.saved.delete(f.originalReceipt.commandId);if(mode==="capability")receiver=new AuthenticatedAgentCommandReceiver({...f.options,managedDatabaseRestore:undefined});
 await expect(receiver.restoreManagedDatabase(f.command,f.signature(f.command))).rejects.toThrow();expect(f.restore).not.toHaveBeenCalled();expect(f.replayStore.claim).not.toHaveBeenCalled();
});
it.each(["execution","completion","receipt"])("retains original claim after %s uncertainty without release",async stage=>{
 const f=fixture();if(stage==="execution")f.restore.mockRejectedValue(new Error("private"));if(stage==="completion")f.replayStore.complete.mockRejectedValue(new Error("private"));if(stage==="receipt")f.restore.mockResolvedValue({...f.receipt,confirmationId:"foreign"});
 await expect(f.apply()).rejects.toThrow();expect(f.restore).toHaveBeenCalledOnce();expect(f.replayStore.claim).toHaveBeenCalledOnce();expect(f.replayStore.release).not.toHaveBeenCalled();
});
it("rejects body-only and cross-path signatures before cache or effects",async()=>{
 const f=fixture();await expect(f.receiver.restoreManagedDatabase(f.command,signAgentTransport(JSON.stringify(f.command),f.options.trustKey))).rejects.toThrow();
 await expect(f.receiver.restoreManagedDatabase(f.command,f.signature(f.command,MANAGED_DATABASE_RESTORE_RECEIPT_PATH))).rejects.toThrow();expect(f.replayStore.lookup).not.toHaveBeenCalled();expect(f.restore).not.toHaveBeenCalled();
});

it("rejects replaced executor during original cache read before taking an effect claim",async()=>{
 const f=fixture(),read=f.replayStore.lookupByFingerprintDigest.getMockImplementation()!;
 f.replayStore.lookupByFingerprintDigest.mockImplementation(async(...args)=>{const receipt=await read(...args);f.options.managedDatabaseRestore.restore=vi.fn(async()=>f.receipt);return receipt;});
 await expect(f.apply()).rejects.toThrow();expect(f.replayStore.claim).not.toHaveBeenCalled();expect(f.restore).not.toHaveBeenCalled();
});

it("keeps uncertain same-command retries unresolved rather than calling the effect twice",async()=>{
 const f=fixture();f.restore.mockRejectedValue(new Error("uncertain"));await expect(f.apply()).rejects.toThrow();
 f.replayStore.claim.mockResolvedValue({claimed:false});await expect(f.apply()).rejects.toThrow();
 expect(f.restore).toHaveBeenCalledOnce();expect(f.replayStore.release).not.toHaveBeenCalled();expect(f.replayStore.complete).not.toHaveBeenCalled();
});

it("refuses cache reader replacement during readonly recovery",async()=>{
 const f=fixture();await f.apply();const read=f.replayStore.lookup.getMockImplementation()!;
 f.replayStore.lookup.mockImplementation(async(...args)=>{const receipt=await read(...args);f.options.replayStore.lookup=vi.fn(async()=>receipt);return receipt;});
 await expect(f.read()).rejects.toThrow();expect(f.restore).toHaveBeenCalledOnce();
});

it.each(["missing-port","unconfirmed","volatile"])("withholds restore capability for %s runtime wiring",mode=>{
 const f=fixture(),options=mode==="missing-port"?{...f.options,managedDatabaseRestore:{} as any}:mode==="unconfirmed"?{...f.options,authorityValidator:{...f.options.authorityValidator,validateConfirmedProjectUpdateAuthority:undefined}}:{...f.options,replayStore:{...f.options.replayStore,durable:false}};
 expect(new AuthenticatedAgentCommandReceiver(options).capabilities).not.toContain("database.runtime.restore.v1");expect(f.restore).not.toHaveBeenCalled();
});
