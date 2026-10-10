import { backupRetentionPreviewRequestSchema, backupRetentionRequestSchema } from "@deploylite/contracts";
import type { BackupInventoryReader } from "./backup-inventory.js";
import { planBackupRetention } from "./backup-retention.js";
import { awaitAbortable } from "./deployment-contract/docker-image-executor.js";
export type BackupRetentionProtectionReader = Readonly<{
  available(): boolean;
  list(projectId: string, volumeKey: string, destinationId: string): Promise<readonly string[]>;
}>;
export type BackupRetentionPreviewPorts = Readonly<{expectedAgentId: string; inventory: BackupInventoryReader; protections: BackupRetentionProtectionReader}>;
export class BackupRetentionPreviewError extends Error {
  constructor(readonly code: "invalid-input" | "unavailable" | "stale-inventory" | "stale-protection") {
    super("Backup retention preview cannot be prepared safely."); this.name = "BackupRetentionPreviewError";
  }
}
/** Effect-free observation fences; deletion must independently revalidate under ordinary authority. */
export async function prepareBackupRetentionPreview(projectId: string, raw: unknown, ports: BackupRetentionPreviewPorts, signal?: AbortSignal) {
  const parsed = backupRetentionPreviewRequestSchema.safeParse(raw);
  if (!parsed.success || !backupRetentionRequestSchema.shape.projectId.safeParse(projectId).success) throw new BackupRetentionPreviewError("invalid-input");
  const input = parsed.data;
  const current = () => {
    if (signal?.aborted || !ports.inventory.available() || !ports.protections.available()) throw new BackupRetentionPreviewError("unavailable");
  };
  const snapshot = async () => {
    current();
    const [backups, protectedArchiveIds] = await Promise.all([
      awaitAbortable(() => ports.inventory.list(projectId, input.volumeKey, input.destinationId), signal),
      awaitAbortable(() => ports.protections.list(projectId, input.volumeKey, input.destinationId), signal)
    ]);
    current();
    if (backups.some(row => row.schemaVersion !== 1 || row.receipt.agentId !== ports.expectedAgentId)) throw new BackupRetentionPreviewError("unavailable");
    return planBackupRetention({schemaVersion: 1, projectId, volumeKey: input.volumeKey, destinationId: input.destinationId,
      keepNewest: input.keepNewest, backups: backups.map(({receipt, createdAtMs}) => ({receipt, createdAtMs})), protectedArchiveIds});
  };
  try {
    const first = await snapshot();
    if (input.expectedInventoryDigest && first.inventoryDigest !== input.expectedInventoryDigest) throw new BackupRetentionPreviewError("stale-inventory");
    const second = await snapshot();
    if (first.inventoryDigest !== second.inventoryDigest) throw new BackupRetentionPreviewError("stale-inventory");
    if (first.planDigest !== second.planDigest) throw new BackupRetentionPreviewError("stale-protection");
    return first;
  } catch (error) {
    if (error instanceof BackupRetentionPreviewError) throw error;
    throw new BackupRetentionPreviewError("unavailable");
  }
}
