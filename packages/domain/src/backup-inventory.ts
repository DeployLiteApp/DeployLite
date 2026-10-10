import { composeVolumeBackupReceiptSchema } from "@deploylite/contracts";

export class BackupInventoryEvidenceError extends Error {
  constructor() { super("Backup inventory evidence cannot be accepted safely."); this.name = "BackupInventoryEvidenceError"; }
}
function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function reject(): never { throw new BackupInventoryEvidenceError(); }

/**
 * Called with an authenticated transport receipt and server-owned ledger/audit
 * records. Shape validation alone does not authenticate a caller-supplied receipt.
 * No runtime mutation or inventory write occurs here.
 */
export function prepareBackupInventoryRecord(raw: unknown) {
  const input = object(raw);
  if (!input) reject();
  const parsed = composeVolumeBackupReceiptSchema.safeParse(input.receipt);
  if (!parsed.success) reject();
  const receipt = parsed.data, command = object(input.command), audit = object(input.audit);
  const scope = command && object(command.scope), metadata = audit && object(audit.metadata);
  if (!command || !audit || !scope || !metadata || input.expectedAgentId !== receipt.agentId
    || command.status !== "completed" || command.action !== "project.update" || scope.kind !== "project"
    || scope.projectId !== receipt.projectId || command.id !== receipt.commandId
    || command.inputDigest !== receipt.inputDigest || command.correlationId !== receipt.correlationId
    || typeof command.actorId !== "string" || command.actorId.length === 0
    || audit.actorUserId !== command.actorId || audit.action !== "compose.volume.backup.executed"
    || audit.targetType !== "project" || audit.targetId !== receipt.projectId || audit.correlationId !== receipt.correlationId) reject();
  const fields = ["projectId", "commandId", "inputDigest", "volumeKey", "destinationId", "archiveId", "archiveBytes", "entries",
    "archiveSha256", "manifestSha256", "consistency", "status"] as const;
  if (fields.some(field => metadata[field] !== receipt[field])) reject();
  const createdAtMs = audit.createdAt instanceof Date ? audit.createdAt.getTime() : NaN;
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0 || !Number.isSafeInteger(input.observedAtMs)
    || typeof input.observedAtMs !== "number" || input.observedAtMs < createdAtMs) reject();
  return {schemaVersion: 1 as const, receipt, createdAtMs};
}
export type BackupInventoryRecord = ReturnType<typeof prepareBackupInventoryRecord>;
export type BackupInventoryReader = Readonly<{
  available(): boolean;
  list(projectId: string, volumeKey: string, destinationId: string): Promise<readonly BackupInventoryRecord[]>;
}>;

/** The caller must authenticate the agent transport before submitting a receipt. */
export type BackupInventoryWriter = Readonly<{
  available(): boolean;
  recordAuthenticatedReceipt(receipt: unknown): Promise<BackupInventoryRecord>;
}>;
