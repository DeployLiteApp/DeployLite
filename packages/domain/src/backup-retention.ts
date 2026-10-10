import { backupRetentionRequestSchema } from "@deploylite/contracts";
import { digestControlInput } from "./control-plane.js";
export class BackupRetentionError extends Error {
  constructor(readonly code: "invalid-input" | "scope-mismatch" | "ambiguous-archive" | "stale-protection") {
    super("Backup retention cannot be planned safely."); this.name = "BackupRetentionError";
  }
}
/** Pure preview; candidates require fresh verification and ordinary authority before deletion. */
export function planBackupRetention(raw: unknown) {
  const parsed = backupRetentionRequestSchema.safeParse(raw);
  if (!parsed.success) throw new BackupRetentionError("invalid-input");
  const input = parsed.data, ids = new Set<string>();
  for (const {receipt} of input.backups) {
    if (receipt.projectId !== input.projectId || receipt.volumeKey !== input.volumeKey || receipt.destinationId !== input.destinationId)
      throw new BackupRetentionError("scope-mismatch");
    if (ids.has(receipt.archiveId)) throw new BackupRetentionError("ambiguous-archive");
    ids.add(receipt.archiveId);
  }
  const protectedIds = new Set(input.protectedArchiveIds);
  if (protectedIds.size !== input.protectedArchiveIds.length || [...protectedIds].some(id => !ids.has(id)))
    throw new BackupRetentionError("stale-protection");
  const ordered = [...input.backups].sort((a,b) => b.createdAtMs - a.createdAtMs || (a.receipt.archiveId < b.receipt.archiveId ? -1 : a.receipt.archiveId > b.receipt.archiveId ? 1 : 0));
  const retained = new Set(ordered.slice(0,input.keepNewest).map(item => item.receipt.archiveId));
  const metadata = ordered.map(({receipt,createdAtMs}) => ({archiveId: receipt.archiveId, archiveSha256: receipt.archiveSha256,
    manifestSha256: receipt.manifestSha256, createdAtMs}));
  const plan = {schemaVersion: 1 as const, operation: "backup.retention.preview" as const, executionAllowed: false as const,
    projectId: input.projectId, volumeKey: input.volumeKey, destinationId: input.destinationId, keepNewest: input.keepNewest,
    protectedArchiveIds: [...protectedIds].sort(),
    inventoryDigest: digestControlInput({projectId: input.projectId, volumeKey: input.volumeKey, destinationId: input.destinationId, archives: metadata}),
    retainedArchiveIds: metadata.filter(item => retained.has(item.archiveId) || protectedIds.has(item.archiveId)).map(item => item.archiveId),
    deletionCandidates: metadata.filter(item => !retained.has(item.archiveId) && !protectedIds.has(item.archiveId))};
  return {...plan, planDigest: digestControlInput(plan)};
}
