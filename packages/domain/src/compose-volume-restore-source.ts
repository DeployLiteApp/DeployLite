import {composeVolumeBackupReceiptSchema} from "@deploylite/contracts";
import {createConfirmation, createControlCommand, digestControlInput} from "./control-plane.js";

function unavailable(): never {throw new Error("Archive restore source is unavailable.");}
function exactObject(raw: unknown, expectedKeys: readonly string[]) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) unavailable();
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).sort().join() !== [...expectedKeys].sort().join()) unavailable();
  return record;
}
function safeInstant(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0 || !Number.isSafeInteger(new Date(raw).getTime())) unavailable();
  return raw;
}
/** Pure source provenance binding. Parsing does not authenticate a caller-supplied inventory record. */
export function composeVolumeRestoreSourceBinding(raw: unknown) {
  try {
    const input = exactObject(structuredClone(raw), ["schemaVersion", "operation", "executionAllowed", "source"]);
    const source = exactObject(input.source, ["schemaVersion", "receipt", "createdAtMs"]);
    if (input.schemaVersion !== 1 || input.operation !== "compose.volume.restore.source" || input.executionAllowed !== false || source.schemaVersion !== 1) unavailable();
    const receipt = composeVolumeBackupReceiptSchema.parse(source.receipt);
    return {schemaVersion: 1 as const, operation: "compose.volume.restore.source" as const, executionAllowed: false as const,
      source: {schemaVersion: 1 as const, receipt, createdAtMs: safeInstant(source.createdAtMs)}};
  } catch {return unavailable();}
}
export function composeVolumeRestoreSourceInputDigest(raw: unknown): string {
  return digestControlInput(composeVolumeRestoreSourceBinding(raw));
}
/** New preparatory intent only, using existing pending command/destructive nonce grammar.
 * The caller owns authenticated inventory selection and current grants; retained/protected archives stay selectable.
 * Original command/nonce persistence and durable protection require the later SQL adapter, not this pure producer.
 * No route, runtime provider, claim, nonce consumption or restore/delete effect is introduced. */
export function prepareComposeVolumeRestoreSourceConfirmation(raw: unknown) {
  try {
    const input = exactObject(structuredClone(raw), ["source", "projectId", "expectedAgentId", "volumeKey", "destinationId", "archiveId", "backupCommandId",
      "expectedArchiveSha256", "expectedManifestSha256", "actorId", "idempotencyKey", "correlationId", "now", "commandTtlMs"]);
    const identityKeys = ["projectId", "expectedAgentId", "volumeKey", "destinationId", "archiveId", "backupCommandId", "actorId", "idempotencyKey", "correlationId"];
    for (const key of identityKeys) if (typeof input[key] !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(input[key] as string)) unavailable();
    for (const key of ["expectedArchiveSha256", "expectedManifestSha256"])
      if (typeof input[key] !== "string" || !/^[a-f0-9]{64}$/.test(input[key] as string)) unavailable();
    const now = safeInstant(input.now);
    if (typeof input.commandTtlMs !== "number" || !Number.isSafeInteger(input.commandTtlMs) || input.commandTtlMs <= 0) unavailable();
    const expiresAt = new Date(safeInstant(now + input.commandTtlMs));
    const binding = composeVolumeRestoreSourceBinding({schemaVersion: 1, operation: "compose.volume.restore.source", executionAllowed: false, source: input.source});
    const receipt = binding.source.receipt;
    const expectedReceiptFields = {projectId: "projectId", agentId: "expectedAgentId", volumeKey: "volumeKey", destinationId: "destinationId",
      archiveId: "archiveId", commandId: "backupCommandId", archiveSha256: "expectedArchiveSha256", manifestSha256: "expectedManifestSha256"} as const;
    for (const [field, key] of Object.entries(expectedReceiptFields)) if (receipt[field as keyof typeof expectedReceiptFields] !== input[key]) unavailable();
    if (binding.source.createdAtMs > now) unavailable();
    const command = createControlCommand({actorId: input.actorId as string, action: "project.update", scope: {kind: "project", projectId: receipt.projectId},
      input: binding, idempotencyKey: input.idempotencyKey as string, correlationId: input.correlationId as string, expiresAt});
    const confirmation = createConfirmation({command, classification: "destructive", expiresAt});
    return {binding, command, confirmation};
  } catch {return unavailable();}
}
