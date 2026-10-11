import { MANAGED_DATABASE_RUNTIME_CAPABILITY, managedDatabaseRuntimePreparationSchema, managedDatabaseRuntimeReceiptQuerySchema,
  managedDatabaseRuntimeReceiptSchema, projectControlAuthoritySchema, type ProjectControlAuthorityV1 } from "@deploylite/contracts";
import { awaitAbortable, createControlCommand, managedDatabaseRuntimeExecutionBinding, managedDatabaseRuntimeExecutionDigest,
  type ControlCommand, type ProjectUpdateControlRepository } from "@deploylite/domain";
import { managedDatabaseRuntimeReceiptMatches, type ManagedDatabaseRuntimeAgentTransport, type PreparedManagedDatabaseRuntime } from "./managed-database-runtime-transport.js";
export type ManagedDatabaseRuntimeApplyAccess = Readonly<{
  controls: ProjectUpdateControlRepository; transport: ManagedDatabaseRuntimeAgentTransport; agentId: string;
  now(): number; commandTtlMs: number; deadlineMs: number;
}>;
export type ManagedDatabaseRuntimeApplyInput = Readonly<{
  preparation: ReturnType<typeof managedDatabaseRuntimePreparationSchema.parse>; actorId: string; idempotencyKey: string;
  context: Readonly<{ requestId: string; correlationId: string }>; signal?: AbortSignal;
  authorize(): Promise<boolean>; current(): boolean; environment(): Promise<Readonly<Record<string, string>>>;
}>;
function unavailable(): never { throw new Error("Database native apply is unavailable."); }
/** Existing project command/lease and agent cache own execution; missing original evidence is never re-executed. */
export async function applyManagedDatabaseRuntime(options: ManagedDatabaseRuntimeApplyAccess, input: ManagedDatabaseRuntimeApplyInput) {
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
    const preparation = managedDatabaseRuntimePreparationSchema.parse(structuredClone(input.preparation));
    const digest = managedDatabaseRuntimeExecutionDigest(preparation), controls = options.controls, transport = options.transport;
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
    const preparedFor = (command: ControlCommand): PreparedManagedDatabaseRuntime => ({ command: structuredClone(command), input: structuredClone(preparation), agentId: options.agentId });
    const contextFor = (command: ControlCommand) => ({ requestId: context.requestId, correlationId: command.correlationId, signal: controller.signal });
    const receiptFor = (raw: unknown, command: ControlCommand, authority: ProjectControlAuthorityV1) => {
      const receipt = managedDatabaseRuntimeReceiptSchema.parse(structuredClone(raw));
      const query = managedDatabaseRuntimeReceiptQuerySchema.parse({ ...preparation, action: "database.runtime", operation: "database.runtime.apply",
        agentId: options.agentId, commandId: command.id, idempotencyKey: command.idempotencyKey, inputDigest: digest,
        requiredCapabilities: [MANAGED_DATABASE_RUNTIME_CAPABILITY], authority, lease: authority.projectLease,
        context: { requestId: context.requestId, correlationId: command.correlationId }, timeoutMs: options.deadlineMs });
      if (!managedDatabaseRuntimeReceiptMatches(query, receipt)) unavailable();
      return receipt;
    };
    const finish = async (command: ControlCommand, authority: ProjectControlAuthorityV1, raw: unknown, idempotent: boolean) => {
      if (command.status !== "dispatching" && command.status !== "completed") unavailable();
      const receipt = receiptFor(raw, command, authority); await fence();
      if (command.status !== "completed") {
        await bounded(() => controls.validateProjectUpdateAuthority(authority, now())); await fence();
        const completed = await bounded(() => controls.completeProjectUpdate(structuredClone(command), structuredClone(authority), {
          actorUserId: actorId, action: receipt.status === "ready" ? "database.runtime.applied" : "database.runtime.apply.failed",
          targetType: "project", targetId: preparation.projectId, requestId: context.requestId, correlationId: command.correlationId,
          metadata: { preparation, receipt, redacted: true }
        }));
        checkCommand(completed); if (completed.id !== command.id || completed.status !== "completed") unavailable(); command = completed;
      }
      await fence(); return { command, receipt, applied: receipt.status === "ready", idempotent };
    };
    await fence(); if (!transport.available()) unavailable();
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
    const environment = Object.freeze({ ...await bounded(() => input.environment()) }); await fence();
    if (!command) {
      const tentative = { ...createControlCommand({ actorId: actorId, action: "project.update", scope: { kind: "project", projectId: preparation.projectId },
        input: managedDatabaseRuntimeExecutionBinding(preparation), idempotencyKey: idempotencyKey,
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
      try { receipt = await bounded(() => transport.dispatch(preparedFor(command!), structuredClone(authority), environment, contextFor(command!))); }
      catch {
        await fence(); receipt = await bounded(() => transport.readReceipt(preparedFor(command!), authority, contextFor(command!)));
        if (!receipt) unavailable();
      }
    }
    return await finish(command, authority, receipt, false);
  } catch { return unavailable(); }
  finally { if (timer) clearTimeout(timer); input.signal?.removeEventListener("abort", cancel); }
}
