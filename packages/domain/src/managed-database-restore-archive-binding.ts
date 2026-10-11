import {managedDatabaseRestoreArchiveAgentQuerySchema,managedDatabaseRestoreArchiveObservationSchema,protocolPayloadFingerprint} from "@deploylite/contracts";
import {managedDatabaseRestoreExecutionBinding,managedDatabaseRestoreExecutionDigest} from "./managed-database-restore-binding.js";
function unavailable():never{throw new Error("Restore archive source is unavailable.");}
export function managedDatabaseRestoreArchiveSourceBinding(raw:unknown){
 try{
  const query=managedDatabaseRestoreArchiveAgentQuerySchema.parse(structuredClone(raw));
  const {action:_action,agentId,requiredCapabilities:_capabilities,context:_context,timeoutMs:_timeout,...preparation}=query;
  const binding=managedDatabaseRestoreExecutionBinding(preparation);
  if(agentId!==binding.originalReceipt.agentId||agentId!==binding.backupReceipt.agentId)unavailable();
  return query;
 }catch{return unavailable();}
}
/** Bound metadata alone confers neither permission to read bytes nor confirmation/execution authority. */
export function managedDatabaseRestoreArchiveObservationMatches(rawQuery:unknown,rawObservation:unknown,before:number,after:number):boolean{
 try{
  const query=managedDatabaseRestoreArchiveSourceBinding(rawQuery),observation=managedDatabaseRestoreArchiveObservationSchema.parse(structuredClone(rawObservation));
  const {action:_action,agentId:_agent,requiredCapabilities:_capabilities,context:_context,timeoutMs:_timeout,...preparation}=query;
  const receipt=query.backupReceipt;
  if(!Number.isSafeInteger(before)||before<receipt.observedAt||!Number.isSafeInteger(after)||after<before||after-before>=query.timeoutMs
   ||observation.observedAt<before||observation.observedAt>after||observation.agentId!==query.agentId||observation.projectId!==query.projectId
   ||observation.databaseId!==query.databaseId||observation.engine!==query.engine||observation.inputDigest!==managedDatabaseRestoreExecutionDigest(preparation)
   ||protocolPayloadFingerprint(observation.context)!==protocolPayloadFingerprint(query.context))return false;
  return (["archiveId","archiveBytes","archiveSha256","manifestSha256","format"] as const).every(key=>observation[key]===receipt[key]);
 }catch{return false;}
}
