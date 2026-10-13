import {createHash} from "node:crypto";
import {managedDatabaseDeleteReceiptQuerySchema,managedDatabaseDeleteReceiptSchema,protocolPayloadFingerprint} from "@deploylite/contracts";
import {createConfirmation,createControlCommand,digestControlInput} from "./control-plane.js";
import {managedDatabaseStopExecutionBinding} from "./managed-database-stop-binding.js";
import {managedDatabaseStartExecutionBinding} from "./managed-database-start-binding.js";
type ConfirmationInput={preparation:unknown;actorId:string;idempotencyKey:string;correlationId:string;now:number;commandTtlMs:number};
function parseInput(raw:unknown):ConfirmationInput {
 if(!raw||typeof raw!=="object"||Array.isArray(raw))unavailable();
 const value=raw as Record<string,unknown>,keys=["preparation","actorId","idempotencyKey","correlationId","now","commandTtlMs"];
 if(Object.keys(value).length!==keys.length||Object.keys(value).some(key=>!keys.includes(key)))unavailable();
 const {preparation,actorId,idempotencyKey,correlationId,now,commandTtlMs}=value;
 const identity=(value:unknown):value is string=>typeof value==="string"&&/^[A-Za-z0-9_-]{1,200}$/.test(value);
 if(!identity(actorId)||!identity(idempotencyKey)||typeof correlationId!=="string"||correlationId.length<1||correlationId.length>256||/[\x00-\x1f\x7f]/.test(correlationId)
  ||typeof now!=="number"||!Number.isSafeInteger(now)||now<0||typeof commandTtlMs!=="number"||!Number.isSafeInteger(commandTtlMs)||commandTtlMs<1||commandTtlMs>60000)unavailable();
 return {preparation,actorId,idempotencyKey,correlationId,now,commandTtlMs};
}
function unavailable():never {throw new Error("Database deletion confirmation is unavailable.");}
/** Intent only: original cache corroboration, confirmation consumption and fresh authority precede effects. */
export function managedDatabaseDeleteExecutionBinding(raw:unknown) {
 try {
  const source=(()=>{try{return managedDatabaseStartExecutionBinding(raw);}catch{return managedDatabaseStopExecutionBinding(raw);}})();
  return {...source,operation:"database.runtime.delete" as const,storagePolicy:"retain-original" as const,stopPolicy:"if-running" as const};
 }catch{return unavailable();}
}
export function managedDatabaseDeleteExecutionDigest(raw:unknown):string {
 return digestControlInput(managedDatabaseDeleteExecutionBinding(raw));
}
/** Existing confirmation grammar; no lease, accepted grant, cleanup or runtime dispatch is issued here. */
export function prepareManagedDatabaseDeleteConfirmation(raw:unknown) {
 try {
  const input=parseInput(structuredClone(raw)),binding=managedDatabaseDeleteExecutionBinding(input.preparation);
  const expiry=input.now+input.commandTtlMs,expiresAt=new Date(expiry);
  if(!Number.isSafeInteger(expiry)||!Number.isFinite(expiresAt.getTime())||binding.originalReceipt.observedAt>input.now||("originalStopReceipt" in binding&&binding.originalStopReceipt.observedAt>input.now))unavailable();
  const command=createControlCommand({actorId:input.actorId,action:binding.action,scope:binding.scope,input:binding,
   idempotencyKey:input.idempotencyKey,correlationId:input.correlationId,expiresAt});
  const confirmation=createConfirmation({command,classification:"destructive",expiresAt:new Date(expiry)});
  return Object.freeze({command,confirmation});
 }catch{return unavailable();}
}

/** All original resource, approval and execution dimensions must match before command completion. */
export function managedDatabaseDeleteReceiptMatches(rawQuery:unknown,rawReceipt:unknown):boolean{
 try {
  const query=managedDatabaseDeleteReceiptQuerySchema.parse(rawQuery),receipt=managedDatabaseDeleteReceiptSchema.parse(rawReceipt);
  const {action:_action,operation:_operation,storagePolicy:_storage,stopPolicy:_stop,confirmationId:_confirmation,agentId:_agent,commandId:_command,inputDigest:_digest,idempotencyKey:_key,requiredCapabilities:_caps,authority:_authority,lease:_lease,context:_context,timeoutMs:_timeout,...preparation}=query;
  if(query.inputDigest!==managedDatabaseDeleteExecutionDigest(preparation))return false;
  const original=query.originalReceipt;
  return receipt.agentId===query.agentId&&receipt.commandId===query.commandId&&receipt.originalCommandId===original.commandId
   &&receipt.originalStopCommandId===(query.originalStopReceipt?.commandId??null)&&receipt.confirmationId===query.confirmationId
   &&receipt.projectId===query.projectId&&receipt.databaseId===query.databaseId&&receipt.engine===query.engine&&receipt.profileId===query.profileId
   &&receipt.inputDigest===query.inputDigest&&receipt.planDigest===query.planDigest&&receipt.environmentFingerprint===query.environmentFingerprint
   &&receipt.correlationId===query.context.correlationId&&receipt.containerId===original.containerId&&receipt.imageId===original.imageId
   &&receipt.volumeName===original.volumeName&&receipt.networkName===original.networkName&&receipt.networkId===original.networkId
   &&receipt.volumeCreatedAt===original.volumeCreatedAt&&receipt.observedAt>=Math.max(original.observedAt,query.originalStopReceipt?.observedAt??0);
 }catch{return false;}
}
/** Canonical signed replay identity grants no effects and ignores only read request and timeout. */
export function managedDatabaseDeleteReplayFingerprint(raw:unknown):string{
 const value=managedDatabaseDeleteReceiptQuerySchema.parse(raw);
 const {context,timeoutMs:_timeout,...identity}=value;
 return protocolPayloadFingerprint({...identity,correlationId:context.correlationId});
}
export function managedDatabaseDeleteReplayFingerprintDigest(raw:unknown):string{return createHash("sha256").update(managedDatabaseDeleteReplayFingerprint(raw)).digest("hex");}
