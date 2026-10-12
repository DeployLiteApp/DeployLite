import {managedDatabaseHealthAgentQuerySchema,managedDatabaseHealthObservationSchema,protocolPayloadFingerprint} from "@deploylite/contracts";
import {managedDatabaseRuntimeExecutionDigest} from "./managed-database-runtime-binding.js";
/** Existing immutable apply identity proves the readonly source; no fresh project command is created. */
export function managedDatabaseHealthSourceBinding(raw:unknown){
 try {
  const query=managedDatabaseHealthAgentQuerySchema.parse(raw);
  const {originalReceipt,originalReplayFingerprint:_fp,action:_action,agentId:_agent,requiredCapabilities:_caps,context:_ctx,timeoutMs:_timeout,...preparation}=query;
  if(originalReceipt.inputDigest!==managedDatabaseRuntimeExecutionDigest(preparation)||!Number.isSafeInteger(originalReceipt.observedAt))throw new Error("detached");
  return query;
 }catch{throw new Error("Database health source is unavailable.");}
}
/** Live observations bind current request/time, never the historical creation's readiness. */
export function managedDatabaseHealthObservationMatches(rawQuery:unknown,rawObservation:unknown,before:number,after:number):boolean{
 try {
  const query=managedDatabaseHealthSourceBinding(rawQuery),observation=managedDatabaseHealthObservationSchema.parse(rawObservation),original=query.originalReceipt;
  if(!Number.isSafeInteger(before)||before<0||!Number.isSafeInteger(after)||after<before||after-before>=query.timeoutMs
   ||observation.observedAt<before||observation.observedAt>after||observation.observedAt<original.observedAt)return false;
  const fields=["projectId","databaseId","engine","planDigest","environmentFingerprint","containerId","imageId","volumeName","networkName","networkId","volumeCreatedAt"] as const;
  return observation.agentId===query.agentId&&observation.originalCommandId===original.commandId&&observation.profileId===query.profileId
   &&protocolPayloadFingerprint(observation.context)===protocolPayloadFingerprint(query.context)&&fields.every(key=>observation[key]===original[key]);
 }catch{return false;}
}
