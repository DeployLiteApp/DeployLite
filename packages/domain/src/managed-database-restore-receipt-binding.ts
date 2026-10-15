import {createHash} from "node:crypto";
import {managedDatabaseRestoreReceiptQuerySchema,managedDatabaseRestoreReceiptSchema,protocolPayloadFingerprint} from "@deploylite/contracts";
import {managedDatabaseRestoreExecutionDigest} from "./managed-database-restore-binding.js";
/** Only an exact original source/archive/approval receipt can complete a restore command. */
export function managedDatabaseRestoreReceiptMatches(rawQuery:unknown,rawReceipt:unknown):boolean{
 try{
  const query=managedDatabaseRestoreReceiptQuerySchema.parse(structuredClone(rawQuery)),receipt=managedDatabaseRestoreReceiptSchema.parse(structuredClone(rawReceipt));
  const {action:_action,operation:_operation,confirmationId:_nonce,agentId:_agent,commandId:_command,inputDigest:_digest,idempotencyKey:_key,requiredCapabilities:_caps,authority:_authority,lease:_lease,context:_context,timeoutMs:_timeout,...preparation}=query;
  if(query.inputDigest!==managedDatabaseRestoreExecutionDigest(preparation))return false;
  const original=query.originalReceipt,backup=query.backupReceipt;
  const dimensions=["projectId","databaseId","engine","profileId","planDigest","environmentFingerprint"] as const;
  const resources=["containerId","imageId","volumeName","networkName","networkId","volumeCreatedAt"] as const;
  const archives=["archiveId","archiveBytes","archiveSha256","manifestSha256","format"] as const;
  return receipt.agentId===query.agentId && receipt.commandId===query.commandId && receipt.originalCommandId===original.commandId && receipt.backupCommandId===backup.commandId
   && receipt.confirmationId===query.confirmationId && receipt.inputDigest===query.inputDigest && receipt.correlationId===query.context.correlationId
   && receipt.observedAt>=backup.observedAt && receipt.observedAt<=query.lease.expiresAt
   && dimensions.every(key=>receipt[key]===query[key]) && resources.every(key=>receipt[key]===original[key]) && archives.every(key=>receipt[key]===backup[key]);
 }catch{return false;}
}
/** Canonical original replay identity ignores only readonly request and timeout; no new authority is issued. */
export function managedDatabaseRestoreReplayFingerprint(raw:unknown):string{
 const value=managedDatabaseRestoreReceiptQuerySchema.parse(structuredClone(raw)),{context,timeoutMs:_timeout,...identity}=value;
 return protocolPayloadFingerprint({...identity,correlationId:context.correlationId});
}
export function managedDatabaseRestoreReplayFingerprintDigest(raw:unknown):string{return createHash("sha256").update(managedDatabaseRestoreReplayFingerprint(raw)).digest("hex");}
