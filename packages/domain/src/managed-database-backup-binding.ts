import {createHash} from "node:crypto";
import {managedDatabaseBackupPreparationSchema, managedDatabaseBackupReceiptQuerySchema, managedDatabaseBackupReceiptSchema, protocolPayloadFingerprint} from "@deploylite/contracts";
import {digestControlInput} from "./control-plane.js";
import {managedDatabaseStopExecutionBinding} from "./managed-database-stop-binding.js";

function unavailable():never {
  throw new Error("Database backup preparation is unavailable.");
}
/** Reuse the original native execution and project-update scope; no backup effect is granted here. */
export function managedDatabaseBackupExecutionBinding(raw:unknown) {
  try {
    const preparation = managedDatabaseBackupPreparationSchema.parse(raw);
    const {destinationId, maxBytes, ...source} = preparation;
    const original = managedDatabaseStopExecutionBinding(source);
    return {...original, operation:"database.runtime.backup" as const, destinationId, maxBytes};
  } catch {
    return unavailable();
  }
}
export function managedDatabaseBackupExecutionDigest(raw:unknown):string {
  return digestControlInput(managedDatabaseBackupExecutionBinding(raw));
}
/** Original physical/cached source identity is stable across destinations and byte budgets. */
export function managedDatabaseBackupSourceDigest(raw:unknown):string {
  const {destinationId:_destination, maxBytes:_limit, action:_action, scope:_scope, operation:_operation, ...source} = managedDatabaseBackupExecutionBinding(raw);
  return digestControlInput(source);
}
function preparationFromQuery(raw:unknown) {
  const query = managedDatabaseBackupReceiptQuerySchema.parse(raw);
  const {action:_action, operation:_operation, agentId:_agent, commandId:_command, inputDigest:_digest,
    idempotencyKey:_key, requiredCapabilities:_capabilities, authority:_authority, lease:_lease,
    context:_context, timeoutMs:_timeout, ...preparation} = query;
  return {query, preparation};
}
/** Only complete source-bound evidence can complete the existing project command. */
export function managedDatabaseBackupReceiptMatches(rawQuery:unknown, rawReceipt:unknown):boolean {
  try {
    const {query, preparation} = preparationFromQuery(rawQuery);
    const receipt = managedDatabaseBackupReceiptSchema.parse(rawReceipt);
    if (query.inputDigest !== managedDatabaseBackupExecutionDigest(preparation)
      || receipt.sourceDigest !== managedDatabaseBackupSourceDigest(preparation)
      || receipt.archiveBytes > query.maxBytes) return false;
    const original = query.originalReceipt;
    const fields = ["projectId", "databaseId", "engine", "planDigest", "environmentFingerprint"] as const;
    const physical = ["containerId", "imageId", "volumeName", "networkName", "networkId", "volumeCreatedAt"] as const;
    return receipt.agentId === query.agentId && receipt.commandId === query.commandId
      && receipt.originalCommandId === original.commandId && receipt.profileId === query.profileId
      && receipt.inputDigest === query.inputDigest && receipt.correlationId === query.context.correlationId
      && receipt.destinationId === query.destinationId && receipt.observedAt >= original.observedAt
      && fields.every(field => receipt[field] === query[field])
      && physical.every(field => receipt[field] === original[field]);
  } catch {
    return false;
  }
}
/** Read retries change only request identity and timeout; never destination, source or authority. */
export function managedDatabaseBackupReplayFingerprint(raw:unknown):string {
  const query = managedDatabaseBackupReceiptQuerySchema.parse(raw);
  const {context, timeoutMs:_timeout, ...identity} = query;
  return protocolPayloadFingerprint({...identity, correlationId:context.correlationId});
}
export function managedDatabaseBackupReplayFingerprintDigest(raw:unknown):string {
  return createHash("sha256").update(managedDatabaseBackupReplayFingerprint(raw)).digest("hex");
}
