import {createHash} from "node:crypto";
import {mkdtemp, realpath, readdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, expect, it, vi} from "vitest";
import {InMemoryCapabilityRegistry, managedDatabaseRuntimeReceiptSchema} from "@deploylite/contracts";
import {planManagedDatabaseProfile, managedDatabaseRuntimeExecutionDigest, managedDatabaseBackupExecutionDigest, managedDatabaseBackupReceiptMatches} from "@deploylite/domain";
import {createPrivateNativeBackupArchive} from "./docker-managed-database-backup-archive.js";
import {createLocalDirectoryComposeVolumeBackupSource} from "./docker-compose-volume-backup.js";
import {createManagedDatabaseBackupExecutor} from "./docker-managed-database-backup-executor.js";
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(engine:"postgres"|"mysql"|"mariadb"|"mongodb"|"redis"="postgres") {
  const root=await mkdtemp(join(await realpath(tmpdir()),"deploylite-backup-executor-"));roots.push(root);
  const imagePolicy={policyVersion:"images-1",trustedHosts:["registry.example.com"],allowTags:false,allowDigests:true};
  const request={schemaVersion:1 as const,projectId:"project-a",databaseId:"orders",engine};
  const profile={schemaVersion:1,profileId:"profile-"+engine,engine,image:`registry.example.com/${engine}@sha256:${"a".repeat(64)}`,dataPath:{postgres:"/var/lib/postgresql",mysql:"/var/lib/mysql",mariadb:"/var/lib/mysql",mongodb:"/data/db",redis:"/data"}[engine],containerPort:{postgres:5432,mysql:3306,mariadb:3306,mongodb:27017,redis:6379}[engine],credentialKeys:["DATABASE_PASSWORD"],backupStrategy:engine==="redis"?"volume-quiesced":"engine-native"};
  const plan=planManagedDatabaseProfile(request,profile,imagePolicy),input={...request,profileId:profile.profileId,planDigest:plan.planDigest,environmentFingerprint:"b".repeat(32)};
  const original=managedDatabaseRuntimeReceiptSchema.parse({...request,action:"database.runtime",agentId:"agent-a",commandId:"origin-a",inputDigest:managedDatabaseRuntimeExecutionDigest(input),planDigest:plan.planDigest,environmentFingerprint:input.environmentFingerprint,correlationId:"origin-correlation",containerId:"c".repeat(64),imageId:"sha256:"+"d".repeat(64),volumeName:plan.volume.runtimeName,networkName:plan.network.runtimeName,networkId:"e".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",observedAt:1000,status:"ready",health:"passed",storage:"verified",idempotent:false,redacted:true});
  const preparation={...input,originalReceipt:original,originalReplayFingerprint:"f".repeat(64),destinationId:"destination-a",maxBytes:10000};
  const inputDigest=managedDatabaseBackupExecutionDigest(preparation),lease={projectId:request.projectId,leaseId:"backup-lease",fence:2,expiresAt:10000};
  const command={...preparation,action:"database.runtime.backup",operation:"database.runtime.backup",agentId:"agent-a",commandId:"backup-a",inputDigest,idempotencyKey:"backup-once",requiredCapabilities:["database.runtime.backup.v1"],authority:{schemaVersion:1,projectId:request.projectId,commandId:"backup-a",action:"project.update",inputDigest,projectLease:lease},lease,context:{requestId:"request-a",correlationId:"backup-correlation"},timeoutMs:1000,cancellationRequested:false};
  const authority={projectId:request.projectId,commandId:command.commandId,inputDigest,expiresAt:lease.expiresAt,assertValid:vi.fn(async()=>{})};
  const clock={now:()=>2000},data=Buffer.from([0,255,128,10]),sha256=createHash("sha256").update(data).digest("hex");
  const replayStore={durable:true,lookupByFingerprintDigest:vi.fn(async()=>structuredClone(original))};
  const verifier={verify:vi.fn(async()=>({containerId:original.containerId!,uid:999}))};
  const runner={runBinaryToSink:vi.fn(async(_argv:readonly string[],_signal:AbortSignal,write:(bytes:Uint8Array)=>Promise<void>)=>{await write(data);return {bytes:data.length,sha256};})};
  const archive=createPrivateNativeBackupArchive({destinations:new Map([["destination-a",root]]),clock,maxBytes:10000,maxDurationMs:1000});
  const options={agentId:"agent-a",profiles:{[engine]:profile},imagePolicy,capabilities:new InMemoryCapabilityRegistry(["database.runtime.backup.v1"]),clock,replayStore,verifier,runner,archive,limits:{deadlineMs:1000,maxBytes:10000}};
  return {root,command,preparation,original,authority,data,sha256,replayStore,verifier,runner,options,executor:createManagedDatabaseBackupExecutor(options)};
}
it("captures the corroborated original PostgreSQL snapshot into a private archive and exact receipt",async()=>{
  const f=await fixture(),receipt=await f.executor.execute(f.command,f.authority,new AbortController().signal);
  const {cancellationRequested:_cancel,...query}=f.command;
  expect(managedDatabaseBackupReceiptMatches(query,receipt)).toBe(true);
  expect(receipt).toMatchObject({format:"postgres-custom-gzip",consistency:"native-snapshot",archiveBytes:4,archiveSha256:f.sha256,redacted:true});
  expect(f.replayStore.lookupByFingerprintDigest).toHaveBeenCalledWith(f.original.commandId,f.command.originalReplayFingerprint);
  expect(f.verifier.verify).toHaveBeenCalledTimes(2);
  expect(f.runner.runBinaryToSink.mock.calls[0]![0].slice(0,4)).toEqual(["docker","exec",f.original.containerId,"bash"]);
  expect(await readFile(join(f.root,(receipt as any).archiveId,"archive.bin"))).toEqual(f.data);
});
it("recovers private completed bytes without repeating the dump",async()=>{
  const f=await fixture(),first=await f.executor.execute(f.command,f.authority,new AbortController().signal);
  const second=await createManagedDatabaseBackupExecutor(f.options).execute(f.command,f.authority,new AbortController().signal);
  expect(second).toMatchObject({...first,status:"already-created",idempotent:true});expect(f.runner.runBinaryToSink).toHaveBeenCalledOnce();
});
it("refuses absent, foreign or nondurable original cache before live reads or private effects",async()=>{
  for(const mode of ["missing","foreign","volatile"]){const f=await fixture();
    if(mode==="missing")f.replayStore.lookupByFingerprintDigest.mockResolvedValue(null as any);
    if(mode==="foreign")f.replayStore.lookupByFingerprintDigest.mockResolvedValue({...f.original,containerId:"0".repeat(64)});
    const executor=mode==="volatile"?createManagedDatabaseBackupExecutor({...f.options,replayStore:{...f.replayStore,durable:false}}):f.executor;
    await expect(executor.execute(f.command,f.authority,new AbortController().signal)).rejects.toThrow();
    expect(f.verifier.verify).not.toHaveBeenCalled();expect(f.runner.runBinaryToSink).not.toHaveBeenCalled();expect(await readdir(f.root)).toEqual([]);
  }
});
it("withholds capture on failed ownership and publication on authority withdrawal after dump",async()=>{
  for(const stage of ["ownership","withdrawal"]){const f=await fixture();
    if(stage==="ownership")f.verifier.verify.mockRejectedValue(new Error("foreign"));
    else f.runner.runBinaryToSink.mockImplementation(async(_argv,_signal,write)=>{await write(f.data);f.authority.assertValid.mockRejectedValue(new Error("withdrawn/private"));return {bytes:4,sha256:f.sha256};});
    await expect(f.executor.execute(f.command,f.authority,new AbortController().signal)).rejects.toThrow("Database backup execution is unavailable.");
    expect(f.runner.runBinaryToSink).toHaveBeenCalledTimes(stage==="ownership"?0:1);expect(await readdir(f.root)).toEqual([]);
  }
});
it.each(["mysql","mariadb","mongodb","redis"] as const)("refuses unsupported or uncorroborated %s capture before private effects",async engine=>{
  const f=await fixture(engine);if(engine==="mysql"||engine==="mariadb"||engine==="mongodb")f.replayStore.durable=false;await expect(f.executor.execute(f.command,f.authority,new AbortController().signal)).rejects.toThrow();
  expect(f.runner.runBinaryToSink).not.toHaveBeenCalled();expect(await readdir(f.root)).toEqual([]);
});

it("enforces the command byte budget before private archive publication",async()=>{
  const f=await fixture(),preparation={...f.preparation,maxBytes:2};
  const inputDigest=managedDatabaseBackupExecutionDigest(preparation);
  const command={...f.command,maxBytes:2,inputDigest,authority:{...f.command.authority,inputDigest}};
  await expect(f.executor.execute(command,{...f.authority,inputDigest},new AbortController().signal)).rejects.toThrow();
  expect(await readdir(f.root)).toEqual([]);
});

it.each(["mysql","mariadb"] as const)("captures corroborated %s using one bounded global read lock dump",async engine=>{
 const f=await fixture(engine),receipt=await f.executor.execute(f.command,f.authority,new AbortController().signal);
 const {cancellationRequested:_cancel,...query}=f.command;expect(managedDatabaseBackupReceiptMatches(query,receipt)).toBe(true);
 expect(receipt).toMatchObject({consistency:"global-read-lock",format:engine+"-sql-gzip",archiveBytes:4});
 expect(f.runner.runBinaryToSink).toHaveBeenCalledOnce();expect(f.verifier.verify).toHaveBeenCalledTimes(2);
 expect(f.runner.runBinaryToSink.mock.calls[0]![0].at(-1)).toContain("timeout --signal=TERM --kill-after=1s");
 expect(await readFile(join(f.root,receipt.archiveId,"archive.bin"))).toEqual(f.data);
});

it("captures only a stopped original Redis volume into the existing private archive",async()=>{
 const f=await fixture("redis"),sourceRoot=await mkdtemp(join(await realpath(tmpdir()),"deploylite-redis-source-"));roots.push(sourceRoot);await writeFile(join(sourceRoot,"dump.rdb"),"owned-redis-data");
 const stopped=vi.fn(async()=>({containerId:f.original.containerId!}));
 const executor=createManagedDatabaseBackupExecutor({...f.options,verifier:{...f.verifier,verifyStopped:stopped},volumeSource:createLocalDirectoryComposeVolumeBackupSource(new Map([[f.original.volumeName,sourceRoot]]))});
 const receipt=await executor.execute(f.command,f.authority,new AbortController().signal);
 expect(receipt).toMatchObject({engine:"redis",format:"volume-tar",consistency:"all-consumers-stopped"});expect(stopped).toHaveBeenCalledTimes(2);expect(f.verifier.verify).not.toHaveBeenCalled();expect(f.runner.runBinaryToSink).not.toHaveBeenCalled();
});
it("refuses Redis backup when the original stopped-state proof fails",async()=>{
 const f=await fixture("redis"),source=createLocalDirectoryComposeVolumeBackupSource(new Map());
 const executor=createManagedDatabaseBackupExecutor({...f.options,verifier:{...f.verifier,verifyStopped:vi.fn(async()=>{throw new Error("running or foreign");})},volumeSource:source});
 await expect(executor.execute(f.command,f.authority,new AbortController().signal)).rejects.toThrow();expect(await readdir(f.root)).toEqual([]);expect(f.runner.runBinaryToSink).not.toHaveBeenCalled();
});

it("captures corroborated MongoDB only through the balanced fresh-lock command",async()=>{
 const f=await fixture("mongodb"),receipt=await f.executor.execute(f.command,f.authority,new AbortController().signal);
 expect(receipt).toMatchObject({format:"mongodb-archive-gzip",consistency:"quiesced-writes"});
 expect(f.runner.runBinaryToSink).toHaveBeenCalledOnce();expect(f.verifier.verify).toHaveBeenCalledTimes(2);
 const script=f.runner.runBinaryToSink.mock.calls[0]![0].at(-1)!;
 expect(script).toContain("fsyncUnlock");expect(script).toContain("topologyVersion");
 expect(script).toContain('token=""; DEPLOYLITE_MONGO_BACKUP_PROCESS_ID="$ownedToken"');
});
