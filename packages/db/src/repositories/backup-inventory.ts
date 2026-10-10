import { and, eq, sql } from "drizzle-orm";
import { composeVolumeBackupReceiptSchema } from "@deploylite/contracts";
import { BackupInventoryEvidenceError, digestControlInput, prepareBackupInventoryRecord,
  type BackupInventoryReader, type BackupInventoryRecord } from "@deploylite/domain";
import type { DeployLiteDb } from "../client.js";
import { auditEvents, backupInventory, controlCommands } from "../schema.js";

function reject(): never { throw new BackupInventoryEvidenceError(); }
const scope = (projectId: string, volumeKey: string, destinationId: string) => and(
  eq(backupInventory.projectId, projectId), eq(backupInventory.volumeKey, volumeKey), eq(backupInventory.destinationId, destinationId));

/** Only called after server-side transport authentication; never accepts HTTP inventory input. */
export class DbBackupInventoryStore implements BackupInventoryReader {
  constructor(private readonly db: DeployLiteDb, private readonly expectedAgentId: string, private readonly clock = Date.now) {}
  available() { return true; }

  async recordAuthenticatedReceipt(raw: unknown): Promise<BackupInventoryRecord> {
    const parsed = composeVolumeBackupReceiptSchema.safeParse(raw);
    if (!parsed.success || parsed.data.agentId !== this.expectedAgentId) reject();
    const receipt = parsed.data;
    return this.db.transaction(async tx => {
      const [command] = await tx.select().from(controlCommands).where(eq(controlCommands.id, receipt.commandId)).limit(1).for("share");
      if (!command) reject();
      const audits = await tx.select().from(auditEvents).where(and(
        eq(auditEvents.action, "compose.volume.backup.executed"), eq(auditEvents.targetType, "project"),
        eq(auditEvents.targetId, receipt.projectId), eq(auditEvents.correlationId, receipt.correlationId),
        sql`${auditEvents.metadata} ->> 'commandId' = ${receipt.commandId}`)).limit(2).for("share");
      if (audits.length !== 1) reject();
      const audit = audits[0]!;
      // Cache replay may change only status/idempotent. Preserve the original durable event.
      const status = audit.metadata.status;
      if (status !== "created" && status !== "already-created") reject();
      const record = prepareBackupInventoryRecord({receipt: {...receipt, status, idempotent: status === "already-created"},
        expectedAgentId: this.expectedAgentId, observedAtMs: this.clock(), audit,
        command: {id: command.id, actorId: command.actorUserId, action: command.action, status: command.status,
          scope: {kind: command.scopeKind, projectId: command.scopeKey}, inputDigest: command.inputDigest, correlationId: command.correlationId}});
      const values = {projectId: receipt.projectId, volumeKey: receipt.volumeKey, destinationId: receipt.destinationId,
        archiveId: receipt.archiveId, commandId: receipt.commandId, auditId: audit.id,
        receipt: record.receipt, createdAt: new Date(record.createdAtMs)};
      const [inserted] = await tx.insert(backupInventory).values(values).onConflictDoNothing().returning();
      if (inserted) return record;
      const [existing] = await tx.select().from(backupInventory).where(and(
        scope(receipt.projectId, receipt.volumeKey, receipt.destinationId), eq(backupInventory.archiveId, receipt.archiveId))).limit(1);
      if (!existing || existing.commandId !== values.commandId || existing.auditId !== values.auditId
        || digestControlInput(this.read(existing, receipt.projectId, receipt.volumeKey, receipt.destinationId)) !== digestControlInput(record)) reject();
      return record;
    });
  }

  async list(projectId: string, volumeKey: string, destinationId: string): Promise<BackupInventoryRecord[]> {
    const rows = await this.db.select().from(backupInventory).where(scope(projectId, volumeKey, destinationId))
      .orderBy(backupInventory.archiveId).limit(10_001);
    // A truncated inventory must never silently become a deletion preview.
    if (rows.length > 10_000) reject();
    return rows.map(row => this.read(row, projectId, volumeKey, destinationId));
  }

  private read(row: typeof backupInventory.$inferSelect, projectId: string, volumeKey: string, destinationId: string): BackupInventoryRecord {
    const parsed = composeVolumeBackupReceiptSchema.safeParse(row.receipt);
    const createdAtMs = row.createdAt.getTime();
    if (!parsed.success || parsed.data.agentId !== this.expectedAgentId || parsed.data.projectId !== projectId
      || parsed.data.volumeKey !== volumeKey || parsed.data.destinationId !== destinationId
      || row.projectId !== projectId || row.volumeKey !== volumeKey || row.destinationId !== destinationId
      || parsed.data.archiveId !== row.archiveId || parsed.data.commandId !== row.commandId
      || !Number.isSafeInteger(createdAtMs) || createdAtMs < 0 || createdAtMs > this.clock()) reject();
    return {schemaVersion: 1, receipt: parsed.data, createdAtMs};
  }
}
