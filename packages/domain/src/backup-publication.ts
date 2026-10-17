import {createHash} from "node:crypto";
import {composeVolumeBackupAgentCommandSchema,managedDatabaseBackupAgentCommandSchema,protocolPayloadFingerprint,type ProjectControlAuthorityV1} from "@deploylite/contracts";
import {composeVolumeBackupExecutionDigest} from "./compose-volume-backup-execution.js";
import {managedDatabaseBackupExecutionDigest} from "./managed-database-backup-binding.js";
export type BackupPublicationScope=Readonly<{projectId:string;commandId:string;inputDigest:string;correlationId:string;idempotencyKey:string;destinationId:string;volumeKey:string;archiveId:string;expiresAt:number;timeoutMs:number;authorityFingerprint:string}>;
/** Only issued/adopted work can be drained; a producer that never settles has no bounded drain guarantee. */
export type BackupPublicationHeld=Readonly<{expiresAt:number;assertCurrent():Promise<void>;adopt<T>(work:()=>Promise<T>):Promise<T>}>;
export interface BackupPublicationBarrier {
  run<T>(command:unknown,authority:ProjectControlAuthorityV1,signal:AbortSignal,work:(held:BackupPublicationHeld)=>Promise<T>):Promise<T>;
}
/** Signature/grant authentication remains the caller's responsibility. No caller paths or actor claim. */
export function backupPublicationScope(raw:unknown):BackupPublicationScope{
  try{
    const copy=structuredClone(raw);
    const command=typeof copy==="object"&&copy!==null&&"action"in copy&&copy.action==="database.runtime.backup"
      ?managedDatabaseBackupAgentCommandSchema.parse(copy):composeVolumeBackupAgentCommandSchema.parse(copy);
    let destinationId:string,volumeKey:string,digest:string;
    if(command.action==="database.runtime.backup"){
      const {action:_action,operation:_operation,agentId:_agent,commandId:_command,inputDigest:_digest,idempotencyKey:_key,requiredCapabilities:_capabilities,authority:_authority,lease:_lease,context:_context,timeoutMs:_timeout,cancellationRequested:_cancel,...preparation}=command;
      digest=managedDatabaseBackupExecutionDigest(preparation);destinationId=command.destinationId;volumeKey="db-"+command.databaseId;
    }else{digest=composeVolumeBackupExecutionDigest(command);destinationId=command.plan.destinationId;volumeKey=command.plan.volumeKey;}
    const expiresAt=command.authority.projectLease.expiresAt;
    if(digest!==command.inputDigest||!Number.isSafeInteger(new Date(expiresAt).getTime()))throw new Error();
    // The existing native and P3 directory identity excludes volumeKey; do not change that algorithm.
    const archiveId="backup_"+createHash("sha256").update(command.projectId+"\0"+command.commandId+"\0"+destinationId).digest("hex").slice(0,32);
    return Object.freeze({projectId:command.projectId,commandId:command.commandId,inputDigest:digest,correlationId:command.context.correlationId,idempotencyKey:command.idempotencyKey,destinationId,volumeKey,archiveId,expiresAt,timeoutMs:command.timeoutMs,authorityFingerprint:protocolPayloadFingerprint(command.authority)});
  }catch{throw new Error("Backup publication is unavailable.");}
}
