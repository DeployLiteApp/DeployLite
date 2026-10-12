import {createHash} from "node:crypto";
import {managedDatabaseStartPreparationSchema,managedDatabaseStartReceiptQuerySchema,managedDatabaseStartReceiptSchema,protocolPayloadFingerprint} from "@deploylite/contracts";
import {digestControlInput} from "./control-plane.js";
import {managedDatabaseStopExecutionBinding,managedDatabaseStopExecutionDigest} from "./managed-database-stop-binding.js";
/** Bind both original commands before fresh start authority may authorize an effect. */
export function managedDatabaseStartExecutionBinding(raw:unknown){
  try {
    const preparation=managedDatabaseStartPreparationSchema.parse(raw);
    const {originalStopReceipt,originalStopReplayFingerprint,...stopPreparation}=preparation;
    managedDatabaseStopExecutionBinding(stopPreparation);
    if(originalStopReceipt.inputDigest!==managedDatabaseStopExecutionDigest(stopPreparation)) throw new Error("detached");
    return {...preparation,action:"project.update" as const,scope:{kind:"project" as const,projectId:preparation.projectId},operation:"database.runtime.start" as const};
  } catch {throw new Error("Database start preparation is unavailable.");}
}
export function managedDatabaseStartExecutionDigest(raw:unknown):string {return digestControlInput(managedDatabaseStartExecutionBinding(raw));}
export function managedDatabaseStartReceiptMatches(rawQuery:unknown,rawReceipt:unknown):boolean {
  try {
    const query=managedDatabaseStartReceiptQuerySchema.parse(rawQuery),receipt=managedDatabaseStartReceiptSchema.parse(rawReceipt);
    const preparation={schemaVersion:query.schemaVersion,projectId:query.projectId,databaseId:query.databaseId,engine:query.engine,
      profileId:query.profileId,planDigest:query.planDigest,environmentFingerprint:query.environmentFingerprint,
      originalReceipt:query.originalReceipt,originalReplayFingerprint:query.originalReplayFingerprint,
      originalStopReceipt:query.originalStopReceipt,originalStopReplayFingerprint:query.originalStopReplayFingerprint};
    if(query.inputDigest!==managedDatabaseStartExecutionDigest(preparation)) return false;
    const original=query.originalReceipt;
    return receipt.agentId===query.agentId && receipt.commandId===query.commandId && receipt.inputDigest===query.inputDigest
      && receipt.correlationId===query.context.correlationId && receipt.originalCommandId===original.commandId
      && receipt.originalStopCommandId===query.originalStopReceipt.commandId && receipt.profileId===query.profileId
      && receipt.projectId===query.projectId && receipt.databaseId===query.databaseId && receipt.engine===query.engine
      && receipt.planDigest===query.planDigest && receipt.environmentFingerprint===query.environmentFingerprint
      && receipt.containerId===original.containerId && receipt.imageId===original.imageId && receipt.networkId===original.networkId
      && receipt.volumeName===original.volumeName && receipt.networkName===original.networkName
      && receipt.volumeCreatedAt===original.volumeCreatedAt && receipt.observedAt>=query.originalStopReceipt.observedAt;
  } catch {return false;}
}
/** Canonical replay identity ignores only read request and transport timeout. */
export function managedDatabaseStartReplayFingerprint(raw:unknown):string {
  const value=managedDatabaseStartReceiptQuerySchema.parse(raw);
  return protocolPayloadFingerprint({action:value.action,agentId:value.agentId,commandId:value.commandId,projectId:value.projectId,
    databaseId:value.databaseId,engine:value.engine,profileId:value.profileId,planDigest:value.planDigest,environmentFingerprint:value.environmentFingerprint,
    originalReceipt:value.originalReceipt,originalReplayFingerprint:value.originalReplayFingerprint,
    originalStopReceipt:value.originalStopReceipt,originalStopReplayFingerprint:value.originalStopReplayFingerprint,
    idempotencyKey:value.idempotencyKey,inputDigest:value.inputDigest,correlationId:value.context.correlationId,authority:value.authority,lease:value.lease});
}
export function managedDatabaseStartReplayFingerprintDigest(raw:unknown):string {return createHash("sha256").update(managedDatabaseStartReplayFingerprint(raw)).digest("hex");}
