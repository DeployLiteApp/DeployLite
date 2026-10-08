import { composeResourceCleanupConfirmationViewSchema, composeResourceCleanupPreviewSchema, composeResourceCleanupReceiptSchema,
  type ComposeResourceCleanupReceiptV1 } from "@deploylite/contracts";
import { redactSecrets } from "@deploylite/config";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { ComposeResourceCleanupError, createConfirmation, digestControlInput, evaluateConfirmation, IdempotencyConflictError,
  validatePreparedComposeResourceCleanup, type ComposeResourceCleanupStore, type ComposeResourceCleanupSubject,
  type ComposeResourceCleanupRecord, type ControlCommand, type ControlConfirmation, type PreparedComposeResourceCleanup } from "@deploylite/domain";
import type { DeployLiteDb } from "../client.js";
import { auditEvents, controlCommandConfirmations, controlCommands } from "../schema.js";

type FaultStage = "command-inserted" | "confirmation-inserted" | "prepared-audit-written" | "confirmation-consumed" | "command-admitted" | "admitted-audit-written";
const identifier = /^[A-Za-z0-9_-]{1,200}$/;
function fail(code: ConstructorParameters<typeof ComposeResourceCleanupError>[0]): never { throw new ComposeResourceCleanupError(code); }
async function safe<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) { if (error instanceof ComposeResourceCleanupError || error instanceof IdempotencyConflictError) throw error; fail("COMPOSE_CLEANUP_FAILED"); }
}
function commandFrom(row: typeof controlCommands.$inferSelect): ControlCommand {
  if (row.scopeKind !== "project") fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED");
  return { id: row.id, actorId: row.actorUserId, action: row.action as ControlCommand["action"], scope: { kind: "project", projectId: row.scopeKey },
    inputDigest: row.inputDigest, idempotencyKey: row.idempotencyKey, correlationId: row.correlationId, status: row.status as ControlCommand["status"],
    expiresAt: row.expiresAt, ...(row.result ? { result: row.result as ControlCommand["result"] } : {}),
    ...(row.executionAuthority ? { executionAuthority: row.executionAuthority } : {}) };
}
function confirmationFrom(row: typeof controlCommandConfirmations.$inferSelect): ControlConfirmation {
  if (row.scopeKind !== "project") fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED");
  return { id: row.id, commandId: row.commandId, actorId: row.actorUserId, action: row.action as ControlConfirmation["action"],
    scope: { kind: "project", projectId: row.scopeKey }, inputDigest: row.inputDigest, classification: row.classification as ControlConfirmation["classification"],
    expiresAt: row.expiresAt, consumedAt: row.consumedAt };
}

/** Durable cleanup admission over the existing command, confirmation and audit tables. */
export class DbComposeResourceCleanupStore implements ComposeResourceCleanupStore {
  constructor(private readonly db: DeployLiteDb, private readonly clock: () => number = Date.now, private readonly injectFault?: (stage: FaultStage) => void) {}
  available(): boolean { return true; }

  async save(raw: PreparedComposeResourceCleanup, requestId: string, signal?: AbortSignal): Promise<ComposeResourceCleanupReceiptV1> {
    return safe(async () => {
      const prepared = structuredClone(raw), now = this.now(); validatePreparedComposeResourceCleanup(prepared, now); this.identity(requestId); this.check(signal);
      return await this.db.transaction(async tx => {
        this.check(signal);
        const input = prepared.command, [inserted] = await tx.insert(controlCommands).values({ id: input.id, actorUserId: input.actorId, action: input.action,
          scopeKind: input.scope.kind, scopeKey: prepared.preview.projectId, inputDigest: input.inputDigest, idempotencyKey: input.idempotencyKey,
          correlationId: input.correlationId, status: "pending_confirmation", result: null, executionAuthority: null, expiresAt: input.expiresAt }).onConflictDoNothing().returning();
        this.check(signal);
        if (!inserted) {
          const [existing] = await tx.select().from(controlCommands).where(and(eq(controlCommands.actorUserId, input.actorId), eq(controlCommands.action, "project.delete"),
            eq(controlCommands.scopeKind, "project"), eq(controlCommands.scopeKey, prepared.preview.projectId), eq(controlCommands.idempotencyKey, input.idempotencyKey))).limit(1).for("update");
          if (!existing) fail("COMPOSE_CLEANUP_FAILED");
          const current = commandFrom(existing);
          if (current.inputDigest !== input.inputDigest) throw new IdempotencyConflictError();
          const record = await this.recordFor(tx, current, now, signal);
          return this.toReceipt(record.command, record.confirmation.id, prepared.preview, true);
        }
        this.injectFault?.("command-inserted"); this.check(signal);
        const confirmation = createConfirmation({ command: input, classification: "destructive" });
        const [storedConfirmation] = await tx.insert(controlCommandConfirmations).values({ id: confirmation.id, commandId: input.id, actorUserId: input.actorId,
          action: input.action, scopeKind: "project", scopeKey: prepared.preview.projectId, inputDigest: input.inputDigest, classification: "destructive",
          expiresAt: confirmation.expiresAt, consumedAt: null }).returning();
        if (!storedConfirmation) fail("COMPOSE_CLEANUP_FAILED");
        this.injectFault?.("confirmation-inserted"); this.check(signal);
        await this.writeAudit(tx, input, confirmation.id, prepared.preview.projectId, requestId, "prepared");
        this.injectFault?.("prepared-audit-written"); this.check(signal);
        return this.toReceipt(input, confirmation.id, prepared.preview, false);
      });
    });
  }

  async find(raw: ComposeResourceCleanupSubject, signal?: AbortSignal): Promise<ComposeResourceCleanupRecord> {
    return safe(async () => {
      const subject = structuredClone(raw); this.identity(subject.actorId, subject.projectId, subject.idempotencyKey, subject.confirmationId); this.check(signal);
      const now = this.now();
      return await this.db.transaction(async tx => {
        this.check(signal);
        const [row] = await tx.select().from(controlCommands).where(and(eq(controlCommands.actorUserId, subject.actorId), eq(controlCommands.action, "project.delete"),
          eq(controlCommands.scopeKind, "project"), eq(controlCommands.scopeKey, subject.projectId), eq(controlCommands.idempotencyKey, subject.idempotencyKey))).limit(1).for("update");
        if (!row) fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED");
        return this.recordFor(tx, commandFrom(row), now, signal, subject.confirmationId);
      });
    });
  }

  async admit(raw: PreparedComposeResourceCleanup, rawView: Parameters<ComposeResourceCleanupStore["admit"]>[1], requestId: string, signal?: AbortSignal): Promise<ComposeResourceCleanupReceiptV1> {
    return safe(async () => {
      const prepared = structuredClone(raw), view = composeResourceCleanupConfirmationViewSchema.safeParse(structuredClone(rawView));
      const now = this.now(); validatePreparedComposeResourceCleanup(prepared, now); this.identity(requestId); this.check(signal);
      if (!view.success || digestControlInput(view.data) !== digestControlInput({ ...prepared.preview, commandId: prepared.command.id,
        confirmationId: view.data.confirmationId, confirmationValidated: true })) fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED");
      return await this.db.transaction(async tx => {
        this.check(signal);
        const [row] = await tx.select().from(controlCommands).where(eq(controlCommands.id, prepared.command.id)).limit(1).for("update");
        if (!row) fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED");
        const current = commandFrom(row);
        if (digestControlInput({ ...current, status: "pending_confirmation" }) !== digestControlInput(prepared.command)
          || current.scope.kind !== "project" || current.scope.projectId !== prepared.preview.projectId || !["pending_confirmation", "eligible"].includes(current.status)) fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED");
        const [confirmationRow] = await tx.select().from(controlCommandConfirmations).where(eq(controlCommandConfirmations.commandId, current.id)).limit(1).for("update");
        if (!confirmationRow) fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED");
        const confirmation = confirmationFrom(confirmationRow);
        if (confirmation.id !== view.data.confirmationId || current.id !== view.data.commandId || confirmation.commandId !== current.id) fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED");
        await this.requireAudit(tx, current, confirmation.id, "prepared"); this.check(signal);
        if (current.status === "eligible") {
          if (!(confirmation.consumedAt instanceof Date) || !Number.isSafeInteger(confirmation.consumedAt.valueOf()) || confirmation.consumedAt.valueOf() > now) fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED");
          try { evaluateConfirmation(current, { ...confirmation, consumedAt: null }, new Date(now)); } catch { fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED"); }
          await this.requireAudit(tx, current, confirmation.id, "admitted");
          return this.toReceipt(current, confirmation.id, prepared.preview, true);
        }
        try { evaluateConfirmation(current, confirmation, new Date(now)); } catch { fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED"); }
        const [consumed] = await tx.update(controlCommandConfirmations).set({ consumedAt: new Date(now) }).where(and(eq(controlCommandConfirmations.id, confirmation.id),
          eq(controlCommandConfirmations.commandId, current.id), eq(controlCommandConfirmations.actorUserId, current.actorId), eq(controlCommandConfirmations.action, current.action),
          eq(controlCommandConfirmations.scopeKind, current.scope.kind), eq(controlCommandConfirmations.scopeKey, current.scope.projectId), eq(controlCommandConfirmations.inputDigest, current.inputDigest),
          eq(controlCommandConfirmations.classification, "destructive"), isNull(controlCommandConfirmations.consumedAt), gt(controlCommandConfirmations.expiresAt, new Date(now)))).returning();
        if (!consumed) fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED");
        this.injectFault?.("confirmation-consumed"); this.check(signal);
        const [eligible] = await tx.update(controlCommands).set({ status: "eligible", updatedAt: new Date(now) }).where(and(eq(controlCommands.id, current.id), eq(controlCommands.status, "pending_confirmation"))).returning();
        if (!eligible || eligible.result || eligible.executionAuthority) fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED");
        this.injectFault?.("command-admitted"); this.check(signal);
        await this.writeAudit(tx, current, confirmation.id, prepared.preview.projectId, requestId, "admitted");
        this.injectFault?.("admitted-audit-written"); this.check(signal);
        return this.toReceipt(commandFrom(eligible), confirmation.id, prepared.preview, false);
      });
    });
  }

  private now(): number { const value = this.clock(); if (!Number.isSafeInteger(value)) fail("COMPOSE_CLEANUP_FAILED"); return value; }
  private check(signal?: AbortSignal): void { if (signal?.aborted) fail("COMPOSE_CLEANUP_FAILED"); }
  private identity(...values: string[]): void { if (!values.every(value => typeof value === "string" && identifier.test(value))) fail("COMPOSE_CLEANUP_INVALID"); }
  private toReceipt(command: ControlCommand, confirmationId: string, preview: PreparedComposeResourceCleanup["preview"], idempotent: boolean): ComposeResourceCleanupReceiptV1 {
    if (!(command.expiresAt instanceof Date) || !Number.isSafeInteger(command.expiresAt.valueOf())) fail("COMPOSE_CLEANUP_FAILED");
    return composeResourceCleanupReceiptSchema.parse({ commandId: command.id, confirmationId, expiresAt: command.expiresAt.toISOString(),
      status: command.status, idempotent, preview });
  }

  private async recordFor(tx: Parameters<Parameters<DeployLiteDb["transaction"]>[0]>[0], command: ControlCommand, now: number, signal?: AbortSignal, requiredConfirmationId?: string): Promise<ComposeResourceCleanupRecord> {
    if (!(command.expiresAt instanceof Date) || !Number.isSafeInteger(command.expiresAt.valueOf()) || command.expiresAt.valueOf() <= now
      || !["pending_confirmation", "eligible"].includes(command.status) || command.result || command.executionAuthority || command.scope.kind !== "project") fail("COMPOSE_CLEANUP_EXPIRED");
    const [row] = await tx.select().from(controlCommandConfirmations).where(eq(controlCommandConfirmations.commandId, command.id)).limit(1).for("update");
    if (!row) fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED");
    const confirmation = confirmationFrom(row);
    if (requiredConfirmationId && confirmation.id !== requiredConfirmationId) fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED");
    if (command.status === "pending_confirmation") {
      try { evaluateConfirmation(command, confirmation, new Date(now)); } catch { fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED"); }
    } else {
      if (!(confirmation.consumedAt instanceof Date) || !Number.isSafeInteger(confirmation.consumedAt.valueOf()) || confirmation.consumedAt.valueOf() > now) fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED");
      try { evaluateConfirmation(command, { ...confirmation, consumedAt: null }, new Date(now)); } catch { fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED"); }
    }
    await this.requireAudit(tx, command, confirmation.id, "prepared"); this.check(signal);
    if (command.status === "eligible") await this.requireAudit(tx, command, confirmation.id, "admitted");
    return { command, confirmation };
  }

  private async requireAudit(tx: Parameters<Parameters<DeployLiteDb["transaction"]>[0]>[0], command: ControlCommand, confirmationId: string, suffix: "prepared" | "admitted"): Promise<void> {
    const [event] = await tx.select({ id: auditEvents.id }).from(auditEvents).where(and(eq(auditEvents.actorUserId, command.actorId), eq(auditEvents.action, `compose.resource.cleanup.${suffix}`),
      eq(auditEvents.targetType, "project"), eq(auditEvents.targetId, command.scope.kind === "project" ? command.scope.projectId : ""),
      sql`${auditEvents.metadata} ->> 'commandId' = ${command.id}`, sql`${auditEvents.metadata} ->> 'confirmationId' = ${confirmationId}`)).limit(1);
    if (!event) fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED");
  }

  private async writeAudit(tx: Parameters<Parameters<DeployLiteDb["transaction"]>[0]>[0], command: ControlCommand, confirmationId: string, projectId: string, requestId: string,
    suffix: "prepared" | "admitted"): Promise<void> {
    const [event] = await tx.insert(auditEvents).values({ actorUserId: command.actorId, action: `compose.resource.cleanup.${suffix}`, targetType: "project", targetId: projectId,
      requestId, correlationId: command.correlationId, metadata: redactSecrets({ projectId, commandId: command.id, confirmationId }) }).returning({ id: auditEvents.id });
    if (!event) fail("COMPOSE_CLEANUP_FAILED");
  }
}
