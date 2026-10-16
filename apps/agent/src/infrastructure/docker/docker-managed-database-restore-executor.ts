import {validateManagedDatabaseRestoreTar} from "./docker-managed-database-restore-tar.js";
import {createHash} from "node:crypto";
import {managedDatabaseRestoreAgentCommandSchema,managedDatabaseRestorePreparationSchema,managedDatabaseRestoreReceiptSchema,managedDatabaseRuntimeReceiptSchema,MANAGED_DATABASE_RESTORE_CAPABILITY,protocolPayloadFingerprint,type Clock,type CapabilityRegistry,type ImageReferencePolicyV1,type ManagedDatabaseEngineV1,type ProjectControlAuthorityV1} from "@deploylite/contracts";
import {awaitAbortable,managedDatabaseRestoreExecutionDigest,managedDatabaseRestoreReceiptMatches} from "@deploylite/domain";
import type {AgentReplayStore} from "../../agent-transport.js";
import type {DockerProcessRunner} from "./docker-process-runner.js";
import type {createManagedDatabaseReadinessVerifier} from "./docker-managed-database-readiness.js";
import type {createPrivateNativeRestoreArchive} from "./docker-managed-database-restore-archive.js";
import {buildManagedDatabaseBackupSource} from "./docker-managed-database-backup-source.js";
type Verifier=ReturnType<typeof createManagedDatabaseReadinessVerifier>;
type Input=Parameters<Verifier["verify"]>[0];
type Resources=Parameters<Verifier["verify"]>[1];
type ValidAuthority=Readonly<{assertValid():Promise<void>}>;
type ConfirmedAuthority=ValidAuthority & Readonly<{assertConfirmed(authority:ProjectControlAuthorityV1,id:string):Promise<void>}>;
export type ManagedDatabaseRestoreVolumeWriter=Readonly<{restore(input:Input,resources:Resources,bytes:Uint8Array,authority:ValidAuthority,signal:AbortSignal,deadline:number,commandId:string):Promise<Readonly<{bytes:number;sha256:string}>>}>;
export type ManagedDatabaseRestoreExecutorOptions=Readonly<{
 agentId:string;profiles:Readonly<Partial<Record<ManagedDatabaseEngineV1,unknown>>>;imagePolicy:ImageReferencePolicyV1;clock:Clock;capabilities:CapabilityRegistry;
 replayStore:Pick<AgentReplayStore,"durable"|"lookupByFingerprintDigest">;
 verifier:Readonly<{verify(input:Input,resources:Resources,authority:ValidAuthority,signal:AbortSignal):Promise<Readonly<{containerId:string;uid:number}>>;verifyStopped(input:Input,resources:Resources,authority:ValidAuthority,signal:AbortSignal):Promise<Readonly<{containerId:string}>>}>;
 runner:Pick<DockerProcessRunner,"runBinaryFromSource">;archive:Pick<ReturnType<typeof createPrivateNativeRestoreArchive>,"readVerified">;
 redis?:Readonly<{inspector:Readonly<{inspectContainer(id:string,signal:AbortSignal):Promise<Readonly<{id:string;running:boolean}>>}>;
 stopper:Readonly<{stop(input:Input,resources:Resources,authority:ValidAuthority,signal:AbortSignal):Promise<Readonly<{containerId:string}>>}>;
 starter:Readonly<{start(input:Input,resources:Resources,authority:ValidAuthority,signal:AbortSignal):Promise<Readonly<{containerId:string;uid:number}>>}>;volumeWriter:ManagedDatabaseRestoreVolumeWriter}>;
 limits:Readonly<{deadlineMs:number;maxBytes:number}>;
}>;
function fail():never{throw new Error("Database restore execution is unavailable.");}
const nativeCommands={
 postgres:'gzip -cd | PGPASSWORD="$POSTGRES_PASSWORD" pg_restore --host=127.0.0.1 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --no-owner --no-privileges --single-transaction --clean --if-exists --exit-on-error',
 mysql:'gzip -cd | MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql --default-character-set=utf8mb4 --host=127.0.0.1 --user=root --database="$MYSQL_DATABASE"',
 mariadb:'gzip -cd | MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb --host=127.0.0.1 --user=root --database="$MARIADB_DATABASE"',
 mongodb:'[[ "$MONGO_INITDB_ROOT_PASSWORD" =~ ^[a-f0-9]{64}$ ]]; mongorestore --quiet --config=<(printf \'password: "%s"\\n\' "$MONGO_INITDB_ROOT_PASSWORD") --host=127.0.0.1 --username="$MONGO_INITDB_ROOT_USERNAME" --authenticationDatabase=admin --archive --gzip --drop --stopOnError --nsInclude="$MONGO_INITDB_DATABASE.*"'
} as const;
function quote(value:string){return "'"+value.replaceAll("'",`'"'"'`)+"'";}
function nativeArgv(engine:Exclude<ManagedDatabaseEngineV1,"redis">,containerId:string,uid:number,deadline:number){
 const script=`set -eu; stamp=$(date +%s%3N); [[ "$stamp" =~ ^[1-9][0-9]{0,15}$ ]] || exit 1; remaining=$((${deadline}-stamp-1000)); test "$remaining" -gt 0; test "$remaining" -le 60000; seconds=$(printf '%d.%03d' "$((remaining/1000))" "$((remaining%1000))"); exec timeout --signal=TERM --kill-after=1s "$seconds" bash -o pipefail -c ${quote("set -eu; "+nativeCommands[engine])}`;
 return Object.freeze(["docker","exec","--interactive","--user",String(uid),containerId,"bash","-o","pipefail","-c",script]);
}
/** Internal effect only. The receiver must already hold the durable confirmed restore claim. Never retry here. */
export function createManagedDatabaseRestoreExecutor(supplied:ManagedDatabaseRestoreExecutorOptions){
 const options={...supplied,profiles:structuredClone(supplied.profiles),imagePolicy:structuredClone(supplied.imagePolicy),limits:{...supplied.limits}},clock=options.clock,now=clock.now,has=options.capabilities.has;
 if(!/^[A-Za-z0-9_-]{1,200}$/.test(options.agentId)||!Number.isSafeInteger(options.limits.deadlineMs)||options.limits.deadlineMs<1||options.limits.deadlineMs>60000||!Number.isSafeInteger(options.limits.maxBytes)||options.limits.maxBytes<1)fail();
 return {async restore(raw:unknown,authorityInput:ConfirmedAuthority,external:AbortSignal){
  const controller=new AbortController(),cancel=()=>controller.abort();external.addEventListener("abort",cancel,{once:true});if(external.aborted)cancel();let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   if(typeof authorityInput?.assertValid!=="function"||typeof authorityInput.assertConfirmed!=="function")fail();
   const valid=authorityInput.assertValid,confirmed=authorityInput.assertConfirmed,lookup=options.replayStore.lookupByFingerprintDigest,read=options.archive.readVerified,run=options.runner.runBinaryFromSource,verify=options.verifier.verify,stopped=options.verifier.verifyStopped;
   const redis=options.redis,inspect=redis?.inspector.inspectContainer,stop=redis?.stopper.stop,startDaemon=redis?.starter.start,write=redis?.volumeWriter.restore;
   const command=managedDatabaseRestoreAgentCommandSchema.parse(structuredClone(raw)),preparation=managedDatabaseRestorePreparationSchema.parse(Object.fromEntries(Object.keys(managedDatabaseRestorePreparationSchema.shape).map(key=>[key,command[key as keyof typeof command]])));
   const original=command.originalReceipt,start=now.call(clock),deadline=Math.min(start+options.limits.deadlineMs,start+command.timeoutMs,command.lease.expiresAt);let lastNow=start;
   function current(){const time=now.call(clock);if(controller.signal.aborted||external.aborted||clock.now!==now||options.capabilities.has!==has||!has.call(options.capabilities,MANAGED_DATABASE_RESTORE_CAPABILITY)
    ||!Number.isSafeInteger(start)||start<command.backupReceipt.observedAt||!Number.isSafeInteger(time)||time<lastNow||!Number.isSafeInteger(deadline)||time>=deadline
    ||command.agentId!==options.agentId||command.inputDigest!==managedDatabaseRestoreExecutionDigest(preparation)||command.maxBytes>options.limits.maxBytes||!options.replayStore.durable||typeof lookup!=="function"
    ||authorityInput.assertValid!==valid||authorityInput.assertConfirmed!==confirmed||options.replayStore.lookupByFingerprintDigest!==lookup||options.archive.readVerified!==read||options.runner.runBinaryFromSource!==run||options.verifier.verify!==verify||options.verifier.verifyStopped!==stopped
    ||(redis&&(redis.inspector.inspectContainer!==inspect||redis.stopper.stop!==stop||redis.starter.start!==startDaemon||redis.volumeWriter.restore!==write)))fail();lastNow=time;return time;}
   const call=async<T>(work:()=>Promise<T>)=>{current();const value=await awaitAbortable(work,controller.signal);current();return value;};
   const gate=async()=>{await call(()=>valid.call(authorityInput));await call(()=>confirmed.call(authorityInput,command.authority,command.confirmationId));};
   const boundedAuthority={assertValid:gate};
   current();timer=setTimeout(cancel,deadline-start);await gate();
   const cached=managedDatabaseRuntimeReceiptSchema.parse(await call(()=>lookup!.call(options.replayStore,original.commandId,command.originalReplayFingerprint)));if(protocolPayloadFingerprint(cached)!==protocolPayloadFingerprint(original))fail();
   const {backupReceipt,maxBytes:_max,...originalPreparation}=preparation;
   const source=buildManagedDatabaseBackupSource(originalPreparation,{agentId:options.agentId,profile:options.profiles[command.engine],imagePolicy:options.imagePolicy});
   const input:Input={request:{schemaVersion:1,projectId:command.projectId,databaseId:command.databaseId,engine:command.engine},profile:options.profiles[command.engine],commandId:original.commandId,imageId:source.imageId,containerId:source.containerId,environmentFingerprint:source.environmentFingerprint};
   const resources:Resources={projectId:command.projectId,databaseId:command.databaseId,commandId:original.commandId,planDigest:source.planDigest,volume:{name:source.volumeName,createdAt:source.volumeCreatedAt},network:{name:source.networkName,id:source.networkId}};
   const snapshot=await call(()=>read.call(options.archive,preparation,controller.signal)),bytes=Buffer.from(snapshot.bytes),expected={archiveId:backupReceipt.archiveId,archiveBytes:backupReceipt.archiveBytes,archiveSha256:backupReceipt.archiveSha256,manifestSha256:backupReceipt.manifestSha256,format:backupReceipt.format,integrity:"verified",redacted:true};
   const metadata=snapshot.metadata;if(Reflect.ownKeys(metadata).length!==Object.keys(expected).length)fail();for(const key of Object.keys(expected)){const descriptor=Object.getOwnPropertyDescriptor(metadata,key);if(!descriptor||!("value" in descriptor)||descriptor.value!==expected[key as keyof typeof expected])fail();}
   if(bytes.length!==backupReceipt.archiveBytes||bytes.length>command.maxBytes||createHash("sha256").update(bytes).digest("hex")!==backupReceipt.archiveSha256||source.format!==backupReceipt.format)fail();await gate();
   const engine=command.engine;
   if(engine==="redis")validateManagedDatabaseRestoreTar(bytes,command.maxBytes);
   let result:Readonly<{bytes:number;sha256:string}>,uid:number|undefined;
   if(engine==="redis"){
    if(!redis||!inspect||!stop||!startDaemon||!write)fail();const observed=await call(()=>inspect!.call(redis.inspector,source.containerId,controller.signal));if(observed.id!==source.containerId||typeof observed.running!=="boolean")fail();await gate();
    if(observed.running){const stoppedResult=await call(()=>stop!.call(redis.stopper,input,resources,boundedAuthority,controller.signal));if(stoppedResult.containerId!==source.containerId)fail();await gate();}
    if((await call(()=>stopped.call(options.verifier,input,resources,boundedAuthority,controller.signal))).containerId!==source.containerId)fail();await gate();
    result=await call(()=>write!.call(redis.volumeWriter,input,resources,bytes,boundedAuthority,controller.signal,deadline,command.commandId));await gate();
    if(result.bytes!==bytes.length||result.sha256!==backupReceipt.archiveSha256||(await call(()=>stopped.call(options.verifier,input,resources,boundedAuthority,controller.signal))).containerId!==source.containerId)fail();await gate();
    const started=await call(()=>startDaemon!.call(redis.starter,input,resources,boundedAuthority,controller.signal));if(started.containerId!==source.containerId)fail();uid=started.uid;
   }else{
    const ready=await call(()=>verify.call(options.verifier,input,resources,boundedAuthority,controller.signal));if(ready.containerId!==source.containerId||!Number.isSafeInteger(ready.uid)||ready.uid<1||ready.uid>4294967294)fail();uid=ready.uid;await gate();
    result=await call(()=>run.call(options.runner,nativeArgv(engine,source.containerId,uid!,deadline),controller.signal,bytes));
    if(result.bytes!==bytes.length||result.sha256!==backupReceipt.archiveSha256)fail();
   }
   await gate();const final=await call(()=>verify.call(options.verifier,input,resources,boundedAuthority,controller.signal));if(final.containerId!==source.containerId||final.uid!==uid||!Number.isSafeInteger(final.uid)||final.uid<1||final.uid>4294967294)fail();await gate();
   const receipt=managedDatabaseRestoreReceiptSchema.parse({schemaVersion:1,action:command.action,projectId:command.projectId,databaseId:command.databaseId,engine:command.engine,profileId:command.profileId,agentId:command.agentId,commandId:command.commandId,originalCommandId:original.commandId,backupCommandId:backupReceipt.commandId,confirmationId:command.confirmationId,inputDigest:command.inputDigest,planDigest:command.planDigest,environmentFingerprint:command.environmentFingerprint,correlationId:command.context.correlationId,containerId:source.containerId,imageId:source.imageId,volumeName:source.volumeName,networkName:source.networkName,networkId:source.networkId,volumeCreatedAt:source.volumeCreatedAt,archiveId:backupReceipt.archiveId,archiveBytes:backupReceipt.archiveBytes,archiveSha256:backupReceipt.archiveSha256,manifestSha256:backupReceipt.manifestSha256,format:backupReceipt.format,observedAt:current(),status:"restored",storage:"original",health:"passed",redacted:true});
   const {cancellationRequested:_cancel,...query}=command;if(!managedDatabaseRestoreReceiptMatches(query,receipt))fail();return Object.freeze(receipt);
  }catch{return fail();}finally{controller.abort();if(timer)clearTimeout(timer);external.removeEventListener("abort",cancel);}
 }};
}
