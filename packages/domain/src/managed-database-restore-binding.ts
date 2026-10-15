import type {BackupInventoryReader} from "./backup-inventory.js";
import {awaitAbortable} from "./deployment-contract/docker-image-executor.js";
import {managedDatabaseBackupReceiptSchema,managedDatabaseRestoreSelectionSchema,managedDatabaseRestorePreparationSchema,managedDatabaseRestoreConfirmationPreparationSchema} from "@deploylite/contracts";
import {createConfirmation,createControlCommand,digestControlInput} from "./control-plane.js";
import {managedDatabaseStopExecutionBinding} from "./managed-database-stop-binding.js";
import {managedDatabaseBackupSourceDigest} from "./managed-database-backup-binding.js";
function unavailable():never{throw new Error("Database restore confirmation is unavailable.");}
/** Intent only. Authenticated inventory, archive verification and consumed authority precede effects. */
export function managedDatabaseRestoreExecutionBinding(raw:unknown){
 try{
  const parsed=managedDatabaseRestorePreparationSchema.parse(structuredClone(raw));
  const {backupReceipt,maxBytes,...preparation}=parsed;
  const source=managedDatabaseStopExecutionBinding(preparation),original=source.originalReceipt;
  const dimensions=["projectId","databaseId","engine","profileId","planDigest","environmentFingerprint"] as const;
  const resources=["containerId","imageId","volumeName","networkName","networkId","volumeCreatedAt"] as const;
  const consistency={postgres:"native-snapshot",mysql:"global-read-lock",mariadb:"global-read-lock",mongodb:"quiesced-writes",redis:"all-consumers-stopped"};
  if(dimensions.some(key=>backupReceipt[key]!==source[key])||resources.some(key=>backupReceipt[key]!==original[key])
   ||backupReceipt.agentId!==original.agentId||backupReceipt.originalCommandId!==original.commandId
   ||backupReceipt.observedAt<original.observedAt||backupReceipt.archiveBytes>maxBytes
   ||backupReceipt.consistency!==consistency[source.engine]
   ||backupReceipt.sourceDigest!==managedDatabaseBackupSourceDigest({...preparation,destinationId:backupReceipt.destinationId,maxBytes}))unavailable();
  return {...source,operation:"database.runtime.restore" as const,backupReceipt,maxBytes};
 }catch{return unavailable();}
}
export function managedDatabaseRestoreExecutionDigest(raw:unknown):string{return digestControlInput(managedDatabaseRestoreExecutionBinding(raw));}
/** Existing command/confirmation grammar. No runtime grant, protection release or data effect. */
export function prepareManagedDatabaseRestoreConfirmation(raw:unknown){
 try{
  const input=managedDatabaseRestoreConfirmationPreparationSchema.parse(structuredClone(raw));
  const binding=managedDatabaseRestoreExecutionBinding(input.preparation),expiry=input.now+input.commandTtlMs,expiresAt=new Date(expiry);
  if(!Number.isSafeInteger(expiry)||!Number.isFinite(expiresAt.getTime())||binding.backupReceipt.observedAt>input.now)unavailable();
  const command=createControlCommand({actorId:input.actorId,action:binding.action,scope:binding.scope,input:binding,
   idempotencyKey:input.idempotencyKey,correlationId:input.correlationId,expiresAt});
  const confirmation=createConfirmation({command,classification:"destructive",expiresAt:new Date(expiry)});
  return Object.freeze({command,confirmation});
 }catch{return unavailable();}
}

export async function selectManagedDatabaseRestoreInventory(raw:unknown,ports:Readonly<{
 expectedAgentId:string;inventory:BackupInventoryReader;clock:Readonly<{now():number}>
}>,signal?:AbortSignal){
 try{
  const selection=managedDatabaseRestoreSelectionSchema.parse(structuredClone(raw));
  const {archiveId,destinationId,expectedArchiveSha256,expectedManifestSha256,...source}=selection;
  const target=managedDatabaseStopExecutionBinding((({maxBytes:_max,...value})=>value)(source));
  const current=()=>{if(signal?.aborted||!ports.inventory.available()||ports.expectedAgentId!==target.originalReceipt.agentId)unavailable();};
  const observe=async()=>{
   current();const records=await awaitAbortable(()=>ports.inventory.list(target.projectId,"db-"+target.databaseId,destinationId),signal);current();
   if(records.length>10000)unavailable();
   const candidates=records.filter(row=>row.receipt.archiveId===archiveId);if(candidates.length!==1)unavailable();
   const record=candidates[0]!,receipt=managedDatabaseBackupReceiptSchema.parse(record.receipt),now=ports.clock.now();
   if(record.schemaVersion!==1||!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(record.createdAtMs)||record.createdAtMs<0||record.createdAtMs>now
    ||receipt.observedAt>now||receipt.destinationId!==destinationId||receipt.archiveSha256!==expectedArchiveSha256||receipt.manifestSha256!==expectedManifestSha256)unavailable();
   return {binding:managedDatabaseRestoreExecutionBinding({...source,backupReceipt:receipt}),digest:digestControlInput(record)};
  };
  const first=await observe(),second=await observe();if(first.digest!==second.digest)unavailable();current();return second.binding;
 }catch{return unavailable();}
}
