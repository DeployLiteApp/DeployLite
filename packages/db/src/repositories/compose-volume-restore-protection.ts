import {and, eq, sql} from "drizzle-orm";
import {composeVolumeRestoreSourceBinding, composeVolumeRestoreSourceInputDigest, digestControlInput, evaluateConfirmation,
  prepareBackupInventoryRecord, type ControlCommand, type ControlConfirmation} from "@deploylite/domain";
import type {DeployLiteDb} from "../client.js";
import {auditEvents, backupInventory, composeVolumeRestoreProtections, backupRetirementReservations, controlCommands, controlCommandConfirmations} from "../schema.js";
import {toCommand} from "./control-plane.js";

type Transaction = Parameters<Parameters<DeployLiteDb["transaction"]>[0]>[0];
type Protection = typeof composeVolumeRestoreProtections.$inferSelect;
function unavailable(): never {throw new Error("P3 restore archive protection is unavailable.");}
function instant(value: unknown): number {
  if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime()) || value.getTime() < 0) unavailable();
  return value.getTime();
}
const scope = (projectId: string, volumeKey: string, destinationId: string) => and(
  eq(composeVolumeRestoreProtections.projectId, projectId), eq(composeVolumeRestoreProtections.volumeKey, volumeKey), eq(composeVolumeRestoreProtections.destinationId, destinationId));
const nonceDigest = (value: ControlConfirmation) => digestControlInput({...value,
  expiresAt: instant(value.expiresAt), consumedAt: value.consumedAt === null ? null : instant(value.consumedAt)});

/** Private authenticated-inventory composition only. No caller HTTP authentication, command resolution, claim or execution. */
export class DbComposeVolumeRestoreProtectionStore {
  constructor(private readonly db: DeployLiteDb, private readonly expectedAgentId: string, private readonly clock = Date.now) {}
  executionAvailable() {return false;}
  private now(minimum = 0) {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < minimum || !Number.isSafeInteger(new Date(value).getTime())
      || !/^[A-Za-z0-9_-]{1,200}$/.test(this.expectedAgentId)) unavailable();
    return value;
  }
  private async read(tx: Transaction, row: Protection, minimum: number) {
    const binding = composeVolumeRestoreSourceBinding(row.sourceBinding), receipt = binding.source.receipt;
    const inputDigest = composeVolumeRestoreSourceInputDigest(binding);
    const expected = {projectId: receipt.projectId, volumeKey: receipt.volumeKey, destinationId: receipt.destinationId, archiveId: receipt.archiveId,
      backupCommandId: receipt.commandId, archiveSha256: receipt.archiveSha256, manifestSha256: receipt.manifestSha256, inputDigest};
    if (receipt.agentId !== this.expectedAgentId || row.restoreCommandId === receipt.commandId
      || Object.entries(expected).some(([key, value]) => row[key as keyof Protection] !== value)) unavailable();
    const [stored] = await tx.select().from(controlCommands).where(eq(controlCommands.id, row.restoreCommandId)).limit(1).for("share");
    const nonces = await tx.select().from(controlCommandConfirmations).where(eq(controlCommandConfirmations.commandId, row.restoreCommandId)).limit(2).for("share");
    const [archive] = await tx.select().from(backupInventory).where(and(eq(backupInventory.projectId, row.projectId),
      eq(backupInventory.volumeKey, row.volumeKey), eq(backupInventory.destinationId, row.destinationId), eq(backupInventory.archiveId, row.archiveId))).limit(1).for("share");
    if (!stored || nonces.length !== 1 || !archive || archive.commandId !== receipt.commandId) unavailable();
    const nonce = nonces[0]!;
    if (stored.id !== row.restoreCommandId || stored.action !== "project.update" || stored.scopeKind !== "project" || stored.scopeKey !== row.projectId
      || stored.inputDigest !== inputDigest || !["pending_confirmation", "dispatching", "completed"].includes(stored.status)
      || nonce.id !== row.confirmationId || nonce.commandId !== stored.id || nonce.actorUserId !== stored.actorUserId
      || nonce.action !== stored.action || nonce.scopeKind !== "project" || nonce.scopeKey !== row.projectId
      || nonce.inputDigest !== inputDigest || nonce.classification !== "destructive" || instant(nonce.expiresAt) !== instant(stored.expiresAt)) unavailable();
    const [backup] = await tx.select().from(controlCommands).where(eq(controlCommands.id, archive.commandId)).limit(1).for("share");
    const [audit] = await tx.select().from(auditEvents).where(eq(auditEvents.id, archive.auditId)).limit(1).for("share");
    const retired = await tx.select().from(backupRetirementReservations).where(and(eq(backupRetirementReservations.projectId, row.projectId),
      eq(backupRetirementReservations.volumeKey, row.volumeKey), eq(backupRetirementReservations.destinationId, row.destinationId),
      eq(backupRetirementReservations.archiveId, row.archiveId))).limit(1).for("share");
    const now = this.now(minimum);
    if (!backup || !audit || audit.id !== archive.auditId || retired.length || instant(row.createdAt) > now
      || (nonce.consumedAt !== null && instant(nonce.consumedAt) > now)) unavailable();
    const source = prepareBackupInventoryRecord({receipt: archive.receipt, expectedAgentId: this.expectedAgentId, audit, observedAtMs: now,
      command: {id: backup.id, actorId: backup.actorUserId, action: backup.action, status: backup.status,
        scope: {kind: backup.scopeKind, projectId: backup.scopeKey}, inputDigest: backup.inputDigest, correlationId: backup.correlationId}});
    if (instant(archive.createdAt) !== source.createdAtMs || digestControlInput(source) !== digestControlInput(binding.source)
      || archive.projectId !== row.projectId || archive.volumeKey !== row.volumeKey || archive.destinationId !== row.destinationId || archive.archiveId !== row.archiveId) unavailable();
    const confirmation: ControlConfirmation = {id: nonce.id, commandId: stored.id, actorId: nonce.actorUserId, action: "project.update",
      scope: {kind: "project", projectId: row.projectId}, inputDigest, classification: "destructive", expiresAt: nonce.expiresAt, consumedAt: nonce.consumedAt};
    return {command: toCommand(stored), confirmation, now};
  }
  /** The caller supplies the already-resolved ORIGINAL command and nonce; fresh tentative retry identities fail closed. */
  async protect(raw: unknown, suppliedCommand: ControlCommand, suppliedConfirmation: ControlConfirmation): Promise<void> {
    try {
      const binding = composeVolumeRestoreSourceBinding(structuredClone(raw)), receipt = binding.source.receipt;
      const command = structuredClone(suppliedCommand), confirmation = structuredClone(suppliedConfirmation), minimum = this.now();
      const inputDigest = composeVolumeRestoreSourceInputDigest(binding);
      if (command.action !== "project.update" || command.scope.kind !== "project" || command.scope.projectId !== receipt.projectId
        || command.status !== "pending_confirmation" || command.inputDigest !== inputDigest || command.id === receipt.commandId
        || command.executionAuthority || command.projectExecutionAuthority || command.result) unavailable();
      await this.db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`deploylite:execution:${receipt.projectId}`}, 0))`);
        const rows = await tx.select().from(composeVolumeRestoreProtections).where(eq(composeVolumeRestoreProtections.restoreCommandId, command.id)).limit(2).for("share");
        if (rows.length > 1) unavailable();
        const values = {restoreCommandId: command.id, confirmationId: confirmation.id, projectId: receipt.projectId, volumeKey: receipt.volumeKey,
          destinationId: receipt.destinationId, archiveId: receipt.archiveId, backupCommandId: receipt.commandId,
          inputDigest, archiveSha256: receipt.archiveSha256, manifestSha256: receipt.manifestSha256, sourceBinding: binding, createdAt: new Date(minimum)};
        const proof = await this.read(tx, rows[0] ?? values, minimum);
        if (instant(proof.command.expiresAt) !== instant(command.expiresAt) || digestControlInput(proof.command) !== digestControlInput(command)
          || nonceDigest(proof.confirmation) !== nonceDigest(confirmation)) unavailable();
        const now = this.now(proof.now);
        if (rows.length) {
          if (digestControlInput({...rows[0], createdAt: 0}) !== digestControlInput({...values, createdAt: 0})) unavailable();
          return; // Exact durable observation; never renew, replace, claim, consume or release.
        }
        evaluateConfirmation(command, confirmation, new Date(now)); values.createdAt = new Date(now);
        const [inserted] = await tx.insert(composeVolumeRestoreProtections).values(values).onConflictDoNothing().returning();
        const originals = inserted ? [inserted] : await tx.select().from(composeVolumeRestoreProtections)
          .where(eq(composeVolumeRestoreProtections.restoreCommandId, command.id)).limit(2).for("share");
        if (inserted && instant(inserted.createdAt) !== now) unavailable();
        if (originals.length !== 1 || digestControlInput({...originals[0], createdAt: 0}) !== digestControlInput({...values, createdAt: 0})) unavailable();
        if (!inserted) await this.read(tx, originals[0]!, now);
      });
    } catch {return unavailable();}
  }
  async list(projectId: string, volumeKey: string, destinationId: string): Promise<readonly string[]> {
    try {
      let now = this.now();
      if (![projectId, volumeKey, destinationId].every(value => /^[A-Za-z0-9_-]{1,200}$/.test(value))) unavailable();
      return await this.db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`deploylite:execution:${projectId}`}, 0))`);
        const rows = await tx.select().from(composeVolumeRestoreProtections).where(scope(projectId, volumeKey, destinationId))
          .orderBy(composeVolumeRestoreProtections.restoreCommandId).limit(10001);
        if (rows.length > 10000 || new Set(rows.map(row => row.restoreCommandId)).size !== rows.length) unavailable();
        for (const row of rows) {
          if (row.projectId !== projectId || row.volumeKey !== volumeKey || row.destinationId !== destinationId) unavailable();
          now = (await this.read(tx, row, now)).now;
        }
        this.now(now); return [...new Set(rows.map(row => row.archiveId))].sort();
      });
    } catch {return unavailable();}
  }
}
