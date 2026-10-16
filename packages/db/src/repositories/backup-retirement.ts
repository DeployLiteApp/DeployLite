import {and, eq, sql} from "drizzle-orm";
import {backupRetirementBinding, backupRetirementInputDigest, digestControlInput, evaluateConfirmation,
  type ControlCommand, type ControlConfirmation} from "@deploylite/domain";
import type {DeployLiteDb} from "../client.js";
import {backupInventory, backupRestoreProtections, backupRetirementReservations, controlCommands, controlCommandConfirmations} from "../schema.js";
import {toCommand} from "./control-plane.js";

function unavailable(): never { throw new Error("Archive retirement is unavailable."); }
/** No provider activation. P3 protection semantics and execution remain undelivered. */
export class DbBackupRetirementStore {
  constructor(private readonly db: DeployLiteDb, private readonly expectedAgentId: string, private readonly clock = Date.now) {}
  executionAvailable() { return false; }
  async reserve(raw: unknown, suppliedCommand: ControlCommand, suppliedConfirmation: ControlConfirmation) {
    try {
      const binding = backupRetirementBinding(structuredClone(raw)), receipt = binding.receipt;
      const command = structuredClone(suppliedCommand), confirmation = structuredClone(suppliedConfirmation);
      const inputDigest = backupRetirementInputDigest(binding), now = this.clock();
      if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(new Date(now).getTime()) || receipt.agentId !== this.expectedAgentId
        || command.action !== "project.update" || command.scope.kind !== "project" || command.scope.projectId !== receipt.projectId
        || command.status !== "pending_confirmation" || command.inputDigest !== inputDigest || command.id === receipt.commandId
        || command.projectExecutionAuthority || command.executionAuthority || command.result) unavailable();
      return await this.db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`deploylite:execution:${receipt.projectId}`}, 0))`);
        const [stored] = await tx.select().from(controlCommands).where(eq(controlCommands.id, command.id)).limit(1).for("share");
        const nonces = await tx.select().from(controlCommandConfirmations).where(eq(controlCommandConfirmations.commandId, command.id)).limit(2).for("share");
        if (!stored || stored.executionAuthority || stored.expiresAt.getTime() !== command.expiresAt.getTime() || nonces.length !== 1 || digestControlInput(toCommand(stored)) !== digestControlInput(command)) unavailable();
        const nonce = nonces[0]!;
        if (nonce.id !== confirmation.id || nonce.commandId !== command.id || nonce.actorUserId !== command.actorId
          || nonce.action !== command.action || nonce.scopeKind !== "project" || nonce.scopeKey !== receipt.projectId
          || nonce.inputDigest !== inputDigest || nonce.classification !== "destructive" || nonce.consumedAt !== null
          || nonce.expiresAt.getTime() !== command.expiresAt.getTime()
          || digestControlInput({...confirmation, expiresAt: confirmation.expiresAt.getTime()}) !== digestControlInput({
            id: nonce.id, commandId: command.id, actorId: nonce.actorUserId, action: command.action, scope: command.scope,
            inputDigest, classification: "destructive", expiresAt: nonce.expiresAt.getTime(), consumedAt: null})) unavailable();
        const archiveScope = and(eq(backupInventory.projectId, receipt.projectId), eq(backupInventory.volumeKey, receipt.volumeKey),
          eq(backupInventory.destinationId, receipt.destinationId), eq(backupInventory.archiveId, receipt.archiveId));
        const [archive] = await tx.select().from(backupInventory).where(archiveScope).limit(1).for("share");
        if (!archive || archive.commandId !== receipt.commandId || digestControlInput(archive.receipt) !== digestControlInput(receipt)
          || !Number.isSafeInteger(archive.createdAt.getTime()) || archive.createdAt.getTime() < 0 || archive.createdAt.getTime() > now) unavailable();
        const protectedRows = await tx.select().from(backupRestoreProtections).where(and(
          eq(backupRestoreProtections.projectId, receipt.projectId), eq(backupRestoreProtections.volumeKey, receipt.volumeKey),
          eq(backupRestoreProtections.destinationId, receipt.destinationId), eq(backupRestoreProtections.archiveId, receipt.archiveId))).limit(1).for("share");
        if (protectedRows.length) unavailable(); // Expiry never releases original restore protection.
        const reservationScope = and(eq(backupRetirementReservations.projectId, receipt.projectId), eq(backupRetirementReservations.volumeKey, receipt.volumeKey),
          eq(backupRetirementReservations.destinationId, receipt.destinationId), eq(backupRetirementReservations.archiveId, receipt.archiveId));
        const existing = await tx.select().from(backupRetirementReservations).where(reservationScope).limit(2).for("share");
        const values = {commandId: command.id, confirmationId: nonce.id, projectId: receipt.projectId, volumeKey: receipt.volumeKey,
          destinationId: receipt.destinationId, archiveId: receipt.archiveId, inputDigest, binding, createdAt: new Date(now)};
        if (existing.length) {
          const original = existing[0]!;
          if (existing.length !== 1 || !(original.createdAt instanceof Date) || !Number.isSafeInteger(original.createdAt.getTime()) || original.createdAt.getTime() < 0
            || original.createdAt.getTime() > now || digestControlInput({...original, createdAt: 0}) !== digestControlInput({...values, createdAt: 0})) unavailable();
          // Durable observation after lost reply/expiry. Never consume, renew, claim or redispatch.
          return {reserved: true as const, executionAllowed: false as const, commandId: command.id};
        }
        evaluateConfirmation(command, confirmation, new Date(now));
        const [inserted] = await tx.insert(backupRetirementReservations).values(values).onConflictDoNothing().returning();
        if (!inserted || digestControlInput(inserted) !== digestControlInput(values)) unavailable();
        return {reserved: true as const, executionAllowed: false as const, commandId: command.id};
      });
    } catch { return unavailable(); }
  }
}
