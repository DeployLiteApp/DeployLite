import { MANAGED_DATABASE_RUNTIME_CAPABILITY, MANAGED_DATABASE_BACKUP_CAPABILITY, managedDatabaseBackupPreparationSchema, managedDatabaseBackupReceiptQuerySchema,
  managedDatabaseBackupReceiptSchema, managedDatabaseRuntimeReceiptSchema, protocolPayloadFingerprint, projectControlAuthoritySchema, type ProjectControlAuthorityV1 } from "@deploylite/contracts";
import { awaitAbortable, nativeBackupInventoryAuditMetadata, createControlCommand, managedDatabaseBackupExecutionBinding, managedDatabaseBackupExecutionDigest,
  managedDatabaseBackupReceiptMatches, managedDatabaseRuntimeReplayFingerprintDigest,
  managedDatabaseBackupReplayFingerprintDigest, type ControlCommand, type ProjectUpdateControlRepository, type BackupInventoryWriter } from "@deploylite/domain";
import { type ManagedDatabaseBackupAgentTransport, type PreparedManagedDatabaseBackup } from "./managed-database-backup-transport.js";
import type { ManagedDatabaseRuntimeAgentTransport } from "./managed-database-runtime-transport.js";
export type ManagedDatabaseBackupAccess = Readonly<{
  controls: ProjectUpdateControlRepository; originalTransport: ManagedDatabaseRuntimeAgentTransport; transport: ManagedDatabaseBackupAgentTransport; agentId: string;
  inventory: BackupInventoryWriter; now(): number; commandTtlMs: number; deadlineMs: number;
}>;
export type ManagedDatabaseBackupInput = Readonly<{
  preparation: ReturnType<typeof managedDatabaseBackupPreparationSchema.parse>; actorId: string; idempotencyKey: string;
  context: Readonly<{ requestId: string; correlationId: string }>; signal?: AbortSignal;
  authorize(): Promise<boolean>; current(): boolean; admit(): Promise<void>;
}>;
function unavailable(): never { throw new Error("Database native backup is unavailable."); }
/** Existing project command/lease and agent cache own execution; missing original evidence is never re-executed. */
export async function backupManagedDatabaseRuntime(options: ManagedDatabaseBackupAccess, input: ManagedDatabaseBackupInput) {
  const snapshot = { ...options }, actorId = input.actorId, idempotencyKey = input.idempotencyKey, context = { ...input.context };
  const controller = new AbortController(), cancel = () => controller.abort();
  input.signal?.addEventListener("abort", cancel, { once: true }); if (input.signal?.aborted) cancel();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (![options.deadlineMs, options.commandTtlMs].every(value => Number.isSafeInteger(value) && value > 0 && value <= 60000)
      || !/^[A-Za-z0-9_-]{1,200}$/.test(options.agentId) || !/^[A-Za-z0-9_-]{1,200}$/.test(idempotencyKey)
      || !actorId || !context.requestId || !context.correlationId) unavailable();
    timer = setTimeout(cancel, options.deadlineMs);
    const bounded = <T>(work: () => Promise<T>) => awaitAbortable(work, controller.signal);
    const fence = async () => {
      if (Object.entries(snapshot).some(([key, value]) => options[key as keyof typeof options] !== value)
        || controller.signal.aborted || !input.current() || !await bounded(() => input.authorize()) || !input.current() || controller.signal.aborted) unavailable();
    };
    const preparation = managedDatabaseBackupPreparationSchema.parse(structuredClone(input.preparation));
    const digest = managedDatabaseBackupExecutionDigest(preparation), controls = options.controls, transport = options.transport;
    const now = () => { const value = options.now(); if (!Number.isSafeInteger(value) || value < 0) unavailable(); return value; };
    const checkCommand = (command: ControlCommand) => {
      if (command.actorId !== actorId || command.action !== "project.update" || command.scope.kind !== "project"
        || command.scope.projectId !== preparation.projectId || command.inputDigest !== digest || command.idempotencyKey !== idempotencyKey
        || !command.id || !command.correlationId || !(command.expiresAt instanceof Date) || !Number.isFinite(command.expiresAt.getTime())) unavailable();
      return command;
    };
    const authorityFor = (command: ControlCommand) => {
      const authority = projectControlAuthoritySchema.parse(structuredClone(command.projectExecutionAuthority));
      if (authority.commandId !== command.id || authority.projectId !== preparation.projectId || authority.inputDigest !== digest
        || authority.projectLease.expiresAt > command.expiresAt.getTime()) unavailable();
      return authority;
    };
    const preparedFor = (command: ControlCommand): PreparedManagedDatabaseBackup => ({ command: structuredClone(command), input: structuredClone(preparation), agentId: options.agentId });
    const contextFor = (command: ControlCommand) => ({ requestId: context.requestId, correlationId: command.correlationId, signal: controller.signal });
    const receiptFor = (raw: unknown, command: ControlCommand, authority: ProjectControlAuthorityV1) => {
      const receipt = managedDatabaseBackupReceiptSchema.parse(structuredClone(raw));
      const query = managedDatabaseBackupReceiptQuerySchema.parse({ ...preparation, action: "database.runtime.backup", operation: "database.runtime.backup",
        agentId: options.agentId, commandId: command.id, idempotencyKey: command.idempotencyKey, inputDigest: digest,
        requiredCapabilities: [MANAGED_DATABASE_BACKUP_CAPABILITY], authority, lease: authority.projectLease,
        context: { requestId: context.requestId, correlationId: command.correlationId }, timeoutMs: options.deadlineMs });
      if (!managedDatabaseBackupReceiptMatches(query, receipt)) unavailable();
      return { receipt, originalBackupReplayFingerprint: managedDatabaseBackupReplayFingerprintDigest(query) };
    };
    const finish = async (command: ControlCommand, authority: ProjectControlAuthorityV1, raw: unknown, idempotent: boolean) => {
      if (command.status !== "dispatching" && command.status !== "completed") unavailable();
      const { receipt, originalBackupReplayFingerprint } = receiptFor(raw, command, authority); await fence();
      if (command.status !== "completed") {
        await bounded(() => controls.validateProjectUpdateAuthority(authority, now())); await fence();
        const completed = await bounded(() => controls.completeProjectUpdate(structuredClone(command), structuredClone(authority), {
          actorUserId: actorId, action: "database.runtime.backup.executed",
          targetType: "project", targetId: preparation.projectId, requestId: context.requestId, correlationId: command.correlationId,
          metadata: nativeBackupInventoryAuditMetadata(receipt)
        }));
        checkCommand(completed); if (completed.id !== command.id || completed.status !== "completed") unavailable(); command = completed;
      }
      await fence();
      const inventory = await bounded(() => options.inventory.recordAuthenticatedReceipt(receipt));
      await fence();
      const stored = managedDatabaseBackupReceiptSchema.parse(inventory.receipt);
      const canonical = (value: typeof receipt) => ({ ...value, status: "created", idempotent: false });
      if (inventory.schemaVersion !== 1 || !Number.isSafeInteger(inventory.createdAtMs) || inventory.createdAtMs < 0
        || inventory.createdAtMs > now() || protocolPayloadFingerprint(canonical(stored)) !== protocolPayloadFingerprint(canonical(receipt))) unavailable();
      return { command, receipt, originalBackupReplayFingerprint, backupCreated: true, idempotent, inventory };
    };
    await fence(); if (!transport.available() || !options.inventory?.available()) unavailable();
    let command = await bounded(() => controls.findProjectUpdateByIdempotency(actorId, preparation.projectId, idempotencyKey));
    await fence();
    if (command) {
      command = checkCommand(structuredClone(command));
      if (command.projectExecutionAuthority) {
        const authority = authorityFor(command);
        const cached = await bounded(() => transport.readReceipt(preparedFor(command!), authority, contextFor(command!)));
        if (cached) return await finish(command, authority, cached, true);
        unavailable();
      }
      if (command.status !== "eligible" || command.expiresAt.getTime() <= now()) unavailable();
    }
    await bounded(() => input.admit()); await fence();
    if (!controls.findProjectUpdateById || !options.originalTransport.available() || preparation.originalReceipt.agentId !== options.agentId) unavailable();
    const original = await bounded(() => controls.findProjectUpdateById!(preparation.projectId, preparation.originalReceipt.commandId));
    await fence();
    if (!original || original.action !== "project.update" || original.scope.kind !== "project"
      || original.scope.projectId !== preparation.projectId || original.status !== "completed"
      || original.id !== preparation.originalReceipt.commandId || original.correlationId !== preparation.originalReceipt.correlationId
      || original.inputDigest !== preparation.originalReceipt.inputDigest) unavailable();
    const originalAuthority = projectControlAuthoritySchema.parse(structuredClone(original.projectExecutionAuthority));
    if (originalAuthority.commandId !== original.id || originalAuthority.projectId !== preparation.projectId
      || originalAuthority.inputDigest !== original.inputDigest || originalAuthority.projectLease.expiresAt > original.expiresAt.getTime()) unavailable();
    const { originalReceipt, originalReplayFingerprint, destinationId: _destinationId, maxBytes: _maxBytes, ...originalPreparation } = preparation;
    const originalQuery = { ...originalPreparation, action: "database.runtime", operation: "database.runtime.apply",
      agentId: options.agentId, commandId: original.id, idempotencyKey: original.idempotencyKey, inputDigest: original.inputDigest,
      requiredCapabilities: [MANAGED_DATABASE_RUNTIME_CAPABILITY], authority: originalAuthority, lease: originalAuthority.projectLease,
      context: { requestId: context.requestId, correlationId: original.correlationId }, timeoutMs: options.deadlineMs };
    if (managedDatabaseRuntimeReplayFingerprintDigest(originalQuery) !== originalReplayFingerprint) unavailable();
    const cachedOriginal = await bounded(() => options.originalTransport.readReceipt(
      { command: structuredClone(original), input: structuredClone(originalPreparation), agentId: options.agentId },
      originalAuthority, { requestId: context.requestId, correlationId: original.correlationId, signal: controller.signal }));
    await fence();
    if (!cachedOriginal || protocolPayloadFingerprint(managedDatabaseRuntimeReceiptSchema.parse(cachedOriginal)) !== protocolPayloadFingerprint(originalReceipt)) unavailable();
    if (!command) {
      const tentative = { ...createControlCommand({ actorId: actorId, action: "project.update", scope: { kind: "project", projectId: preparation.projectId },
        input: managedDatabaseBackupExecutionBinding(preparation), idempotencyKey: idempotencyKey,
        correlationId: context.correlationId, expiresAt: new Date(now() + options.commandTtlMs) }), status: "eligible" as const };
      command = checkCommand((await bounded(() => controls.resolve(tentative))).command); await fence();
    }
    if (command.projectExecutionAuthority) {
      const authority = authorityFor(command), cached = await bounded(() => transport.readReceipt(preparedFor(command!), authority, contextFor(command!)));
      if (cached) return await finish(command, authority, cached, true); unavailable();
    }
    if (command.status !== "eligible" || command.expiresAt.getTime() <= now()) unavailable();
    const claimedId = command.id, claimedCorrelation = command.correlationId;
    const claimed = await bounded(() => controls.claimProjectUpdate(structuredClone(command!))); await fence();
    command = checkCommand(structuredClone(claimed.command));
    if (command.id !== claimedId || command.correlationId !== claimedCorrelation || !claimed.claimed || command.status !== "dispatching" || !claimed.authority) unavailable();
    const authority = authorityFor({ ...command, projectExecutionAuthority: claimed.authority });
    if (command.projectExecutionAuthority && JSON.stringify(projectControlAuthoritySchema.parse(command.projectExecutionAuthority)) !== JSON.stringify(authority)) unavailable();
    await bounded(() => controls.validateProjectUpdateAuthority(authority, now())); await fence();
    let receipt = await bounded(() => transport.readReceipt(preparedFor(command!), authority, contextFor(command!)));
    if (!receipt) {
      await bounded(() => controls.validateProjectUpdateAuthority(authority, now())); await fence();
      try { receipt = await bounded(() => transport.dispatch(preparedFor(command!), structuredClone(authority), contextFor(command!))); }
      catch {
        await fence(); receipt = await bounded(() => transport.readReceipt(preparedFor(command!), authority, contextFor(command!)));
        if (!receipt) unavailable();
      }
    }
    return await finish(command, authority, receipt, false);
  } catch { return unavailable(); }
  finally { if (timer) clearTimeout(timer); input.signal?.removeEventListener("abort", cancel); }
}
