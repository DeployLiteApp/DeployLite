import {captureComposeVolumeBackupToSink,type ComposeVolumeBackupSource} from "./docker-compose-volume-backup.js";
import {managedDatabaseBackupAgentCommandSchema, managedDatabaseBackupPreparationSchema, managedDatabaseBackupReceiptSchema, managedDatabaseRuntimeReceiptSchema, MANAGED_DATABASE_BACKUP_CAPABILITY, protocolPayloadFingerprint, type Clock, type CapabilityRegistry, type ImageReferencePolicyV1, type ManagedDatabaseEngineV1} from "@deploylite/contracts";
import {awaitAbortable, managedDatabaseBackupExecutionDigest, managedDatabaseBackupSourceDigest, managedDatabaseBackupReceiptMatches} from "@deploylite/domain";
import type {AgentReplayStore} from "../../agent-transport.js";
import type {DockerProcessRunner} from "./docker-process-runner.js";
import type {createManagedDatabaseReadinessVerifier} from "./docker-managed-database-readiness.js";
import type {createPrivateNativeBackupArchive} from "./docker-managed-database-backup-archive.js";
import type {ComposeVolumeBackupAuthority} from "./docker-compose-volume-backup.js";
import {buildManagedDatabaseBackupSource,buildConsistentManagedDatabaseBackupArgv} from "./docker-managed-database-backup-source.js";

type Verifier = ReturnType<typeof createManagedDatabaseReadinessVerifier>;
function fail():never {throw new Error("Database backup execution is unavailable.");}
/** Internal capture only. The receiver must still claim/authenticate the backup command before activation. */
export function createManagedDatabaseBackupExecutor(supplied:Readonly<{
  agentId:string;
  profiles:Readonly<Partial<Record<ManagedDatabaseEngineV1,unknown>>>;
  imagePolicy:ImageReferencePolicyV1;
  capabilities:CapabilityRegistry;
  clock:Clock;
  replayStore:Pick<AgentReplayStore,"durable"|"lookupByFingerprintDigest">;
  verifier:Pick<Verifier,"verify">&Partial<Pick<Verifier,"verifyStopped">>;
  volumeSource?:ComposeVolumeBackupSource;
  runner:Pick<DockerProcessRunner,"runBinaryToSink">;
  archive:Pick<ReturnType<typeof createPrivateNativeBackupArchive>,"write">;
  limits:Readonly<{deadlineMs:number;maxBytes:number}>;
}>) {
  const options={...supplied,profiles:structuredClone(supplied.profiles),imagePolicy:structuredClone(supplied.imagePolicy),limits:{...supplied.limits}};
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(options.agentId) || !Number.isSafeInteger(options.limits.deadlineMs)
    || options.limits.deadlineMs < 1 || options.limits.deadlineMs > 60000
    || !Number.isSafeInteger(options.limits.maxBytes) || options.limits.maxBytes < 1) fail();
  return {async execute(raw:unknown, authority:ComposeVolumeBackupAuthority, external:AbortSignal) {
    const controller=new AbortController(),cancel=()=>controller.abort();
    external.addEventListener("abort",cancel,{once:true});if(external.aborted)cancel();
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const command=managedDatabaseBackupAgentCommandSchema.parse(structuredClone(raw));
      const preparation=managedDatabaseBackupPreparationSchema.parse(Object.fromEntries(
        Object.keys(managedDatabaseBackupPreparationSchema.innerType().shape).map(key=>[key,command[key as keyof typeof command]])
      ));
      if (!["postgres","mysql","mariadb","redis"].includes(command.engine) || command.inputDigest !== managedDatabaseBackupExecutionDigest(preparation)
        || command.maxBytes > options.limits.maxBytes || !options.replayStore.durable
        || typeof options.replayStore.lookupByFingerprintDigest !== "function") fail();
      const original=command.originalReceipt,start=options.clock.now();
      const deadline=Math.min(start+Math.min(command.timeoutMs,options.limits.deadlineMs),command.lease.expiresAt,authority.expiresAt??Number.MAX_SAFE_INTEGER);
      function current() {
        const now=options.clock.now();
        if (controller.signal.aborted || external.aborted || !Number.isSafeInteger(start) || start < original.observedAt
          || !Number.isSafeInteger(now) || now < start || !Number.isSafeInteger(deadline) || now >= deadline
          || command.agentId !== options.agentId || !options.capabilities.has(MANAGED_DATABASE_BACKUP_CAPABILITY)
          || authority.projectId !== command.projectId || authority.commandId !== command.commandId || authority.inputDigest !== command.inputDigest) fail();
        return now;
      }
      async function call<T>(work:()=>Promise<T>):Promise<T> {
        current();const value=await awaitAbortable(work,controller.signal);current();return value;
      }
      async function gate(){await call(()=>authority.assertValid());}
      current();timer=setTimeout(cancel,deadline-start);await gate();
      const cached=managedDatabaseRuntimeReceiptSchema.parse(await call(()=>options.replayStore.lookupByFingerprintDigest!(original.commandId,command.originalReplayFingerprint)));
      if (protocolPayloadFingerprint(cached) !== protocolPayloadFingerprint(original)) fail();
      const profile=options.profiles[command.engine];
      const {destinationId:_destination,maxBytes:_bytes,...originalPreparation}=preparation;
      const source=buildManagedDatabaseBackupSource(originalPreparation,{agentId:options.agentId,profile,imagePolicy:options.imagePolicy});
      const redis=command.engine==="redis";
      if(redis?(!options.volumeSource||typeof options.verifier.verifyStopped!=="function"||source.consistencyRequirement!=="all-consumers-stopped"):(!source.argv||!["native-snapshot","global-read-lock"].includes(source.consistencyRequirement)))fail();
      const input={request:{schemaVersion:1 as const,projectId:command.projectId,databaseId:command.databaseId,engine:command.engine},profile,
        commandId:original.commandId,imageId:source.imageId,containerId:source.containerId,environmentFingerprint:source.environmentFingerprint};
      const resources={projectId:command.projectId,databaseId:command.databaseId,commandId:original.commandId,planDigest:source.planDigest,
        volume:{name:source.volumeName,createdAt:source.volumeCreatedAt},network:{name:source.networkName,id:source.networkId}};
      const boundedAuthority={...authority,expiresAt:deadline,assertValid:gate};
      async function verify(){
        if(redis){const value=await call(()=>options.verifier.verifyStopped!(input,resources,boundedAuthority,controller.signal));if(value.containerId!==source.containerId)fail();}
        else{const value=await call(()=>options.verifier.verify(input,resources,boundedAuthority,controller.signal));if(value.containerId!==source.containerId||!Number.isSafeInteger(value.uid)||value.uid<1||value.uid>4294967294)fail();}
        await gate();
      }
      await verify();
      const sourceDigest=managedDatabaseBackupSourceDigest(preparation);
      const result=await call(()=>options.archive.write({projectId:command.projectId,commandId:command.commandId,inputDigest:command.inputDigest,
        agentId:command.agentId,correlationId:command.context.correlationId,destinationId:command.destinationId,sourceDigest,format:source.format},
        async(write,signal)=>{
          await gate();
          let bytes=0;
          const boundedWrite=async(chunk:Uint8Array)=>{
            current();if(!(chunk instanceof Uint8Array)||chunk.length>command.maxBytes-bytes)fail();
            bytes+=chunk.length;await write(chunk);current();
          };
          const captured=await call(()=>redis?captureComposeVolumeBackupToSink(options.volumeSource!,source.volumeName,command.maxBytes,boundedWrite,signal,current):options.runner.runBinaryToSink(buildConsistentManagedDatabaseBackupArgv(source,deadline),signal,boundedWrite));
          if(captured.bytes!==bytes)fail();
          await verify();return captured;
        },boundedAuthority,controller.signal));
      await gate();
      const receipt=managedDatabaseBackupReceiptSchema.parse({schemaVersion:1,projectId:command.projectId,databaseId:command.databaseId,engine:command.engine,
        action:command.action,agentId:command.agentId,commandId:command.commandId,originalCommandId:original.commandId,profileId:command.profileId,
        inputDigest:command.inputDigest,planDigest:command.planDigest,environmentFingerprint:command.environmentFingerprint,correlationId:command.context.correlationId,
        containerId:source.containerId,imageId:source.imageId,volumeName:source.volumeName,networkName:source.networkName,networkId:source.networkId,
        volumeCreatedAt:source.volumeCreatedAt,volumeKey:"db-"+command.databaseId,observedAt:current(),destinationId:command.destinationId,sourceDigest,format:source.format,
        consistency:source.consistencyRequirement,status:result.idempotent?"already-created":"created",storage:"verified",...result});
      const {cancellationRequested:_cancel,...query}=command;
      if (!managedDatabaseBackupReceiptMatches(query,receipt)) fail();
      return Object.freeze(receipt);
    } catch {
      return fail();
    } finally {
      controller.abort();if(timer!==undefined)clearTimeout(timer);external.removeEventListener("abort",cancel);
    }
  }};
}
