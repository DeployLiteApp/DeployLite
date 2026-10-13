import { MANAGED_DATABASE_RUNTIME_CAPABILITY, MANAGED_DATABASE_STOP_CAPABILITY, managedDatabaseRuntimePreparationSchema,
  managedDatabaseRuntimeReceiptQuerySchema, managedDatabaseRuntimeReceiptSchema, managedDatabaseHealthPreparationSchema,
  managedDatabaseStopReceiptQuerySchema, managedDatabaseStopReceiptSchema, managedDatabaseStartPreparationSchema, projectControlAuthoritySchema,
  type ManagedDatabaseHealthPreparationV1, type ManagedDatabaseStartPreparationV1 } from "@deploylite/contracts";
import { awaitAbortable, managedDatabaseRuntimeExecutionDigest, managedDatabaseRuntimeReplayFingerprintDigest,
  managedDatabaseStopExecutionDigest, managedDatabaseStopReplayFingerprintDigest, managedDatabaseStopReceiptMatches,
  type ControlCommand, type ProjectUpdateControlRepository } from "@deploylite/domain";
import { managedDatabaseRuntimeReceiptMatches, type ManagedDatabaseRuntimeAgentTransport } from "./managed-database-runtime-transport.js";
import type { ManagedDatabaseStopAgentTransport } from "./managed-database-stop-transport.js";
export type ManagedDatabaseSourceRecoveryAccess = Readonly<{controls: Pick<ProjectUpdateControlRepository, "findProjectUpdatesByInputDigest">;
  originalTransport: Pick<ManagedDatabaseRuntimeAgentTransport, "available" | "readReceipt">;
  stopTransport: Pick<ManagedDatabaseStopAgentTransport, "available" | "readReceipt">; agentId: string; deadlineMs: number; now(): number}>;
export type ManagedDatabaseSourceRecoveryInput = Readonly<{preparation: ReturnType<typeof managedDatabaseRuntimePreparationSchema.parse>;
  context: Readonly<{requestId: string; correlationId: string}>; signal?: AbortSignal; authorize(): Promise<boolean>; current(): boolean}>;
export type ManagedDatabaseRecoveredSources = Readonly<{source: ManagedDatabaseHealthPreparationV1 | null; startPreparation: ManagedDatabaseStartPreparationV1 | null}>;
function unavailable(): never { throw new Error("Database original sources are unavailable."); }
/** Historical proofs identify original resources, never current readiness or new effect authority. */
export async function recoverManagedDatabaseSources(supplied: ManagedDatabaseSourceRecoveryAccess, input: ManagedDatabaseSourceRecoveryInput): Promise<ManagedDatabaseRecoveredSources> {
  const options = {...supplied}, context = {...input.context}, controller = new AbortController(), cancel = () => controller.abort();
  const reader = options.controls.findProjectUpdatesByInputDigest, originalRead = options.originalTransport.readReceipt, stopRead = options.stopTransport.readReceipt;
  const authorize = input.authorize, current = input.current;
  input.signal?.addEventListener("abort", cancel, {once: true}); if (input.signal?.aborted) cancel();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!Number.isSafeInteger(options.deadlineMs) || options.deadlineMs < 1 || options.deadlineMs > 60000
      || !/^[A-Za-z0-9_-]{1,200}$/.test(options.agentId) || !context.requestId || !context.correlationId || !reader) unavailable();
    const base = managedDatabaseRuntimePreparationSchema.parse(structuredClone(input.preparation));
    const start = options.now(), deadline = start + options.deadlineMs;
    const bounded = <T>(work: () => Promise<T>) => awaitAbortable(work, controller.signal);
    function clock() {
      const now = options.now();
      if (controller.signal.aborted || !current() || current !== input.current || authorize !== input.authorize
        || Object.entries(options).some(([key, value]) => supplied[key as keyof typeof supplied] !== value)
        || options.controls.findProjectUpdatesByInputDigest !== reader || options.originalTransport.readReceipt !== originalRead || options.stopTransport.readReceipt !== stopRead
        || !Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(deadline) || !Number.isSafeInteger(now) || now < start || now >= deadline) unavailable();
      return now;
    }
    async function fence() {clock(); if (!await bounded(authorize)) unavailable(); return clock();}
    function authorityFor(command: ControlCommand, digest: string) {
      if (command.action !== "project.update" || command.scope.kind !== "project" || command.scope.projectId !== base.projectId
        || command.status !== "completed" || command.inputDigest !== digest || !command.id || !command.correlationId
        || !(command.expiresAt instanceof Date) || !Number.isFinite(command.expiresAt.getTime())) unavailable();
      const authority = projectControlAuthoritySchema.parse(structuredClone(command.projectExecutionAuthority));
      if (authority.commandId !== command.id || authority.projectId !== base.projectId || authority.inputDigest !== digest
        || authority.projectLease.expiresAt > command.expiresAt.getTime()) unavailable();
      return authority;
    }
    function receiptClock(value: number) {if (!Number.isSafeInteger(value) || value < 0 || value > clock()) unavailable();}
    clock(); timer = setTimeout(cancel, options.deadlineMs); await fence();
    if (!options.originalTransport.available()) unavailable();
    const digest = managedDatabaseRuntimeExecutionDigest(base);
    const originals = structuredClone(await bounded(() => reader.call(options.controls, base.projectId, digest))); await fence();
    let source: ManagedDatabaseHealthPreparationV1 | null = null;
    const originalIds = new Set<string>();
    for (const command of originals) {
      const authority = authorityFor(command, digest);
      if (originalIds.has(command.id)) unavailable(); originalIds.add(command.id);
      const query = managedDatabaseRuntimeReceiptQuerySchema.parse({...base, action: "database.runtime", operation: "database.runtime.apply", agentId: options.agentId,
        commandId: command.id, inputDigest: digest, idempotencyKey: command.idempotencyKey, requiredCapabilities: [MANAGED_DATABASE_RUNTIME_CAPABILITY], authority,
        lease: authority.projectLease, context: {requestId: context.requestId, correlationId: command.correlationId}, timeoutMs: options.deadlineMs});
      const cached = await bounded(() => options.originalTransport.readReceipt({command, input: base, agentId: options.agentId}, authority,
        {...query.context, signal: controller.signal})); await fence();
      if (!cached) unavailable();
      const receipt = managedDatabaseRuntimeReceiptSchema.parse(cached); receiptClock(receipt.observedAt);
      if (!managedDatabaseRuntimeReceiptMatches(query, receipt)) unavailable();
      if (receipt.status === "ready") {
        if (source) unavailable();
        source = managedDatabaseHealthPreparationSchema.parse({...base, originalReceipt: receipt, originalReplayFingerprint: managedDatabaseRuntimeReplayFingerprintDigest(query)});
      }
    }
    if (!source) {if (originals.length) unavailable(); await fence(); return {source: null, startPreparation: null};}
    const stopDigest = managedDatabaseStopExecutionDigest(source);
    const stops = structuredClone(await bounded(() => reader.call(options.controls, base.projectId, stopDigest))); await fence();
    let startPreparation: ManagedDatabaseStartPreparationV1 | null = null;
    const stopIds = new Set<string>();
    for (const command of stops) {
      const authority = authorityFor(command, stopDigest);
      if (!options.stopTransport.available() || stopIds.has(command.id)) unavailable(); stopIds.add(command.id);
      const query = managedDatabaseStopReceiptQuerySchema.parse({...source, action: "database.runtime.stop", operation: "database.runtime.stop", agentId: options.agentId,
        commandId: command.id, inputDigest: stopDigest, idempotencyKey: command.idempotencyKey, requiredCapabilities: [MANAGED_DATABASE_STOP_CAPABILITY], authority,
        lease: authority.projectLease, context: {requestId: context.requestId, correlationId: command.correlationId}, timeoutMs: options.deadlineMs});
      const cached = await bounded(() => options.stopTransport.readReceipt({command, input: source!, agentId: options.agentId}, authority,
        {...query.context, signal: controller.signal})); await fence();
      if (!cached) unavailable();
      const receipt = managedDatabaseStopReceiptSchema.parse(cached); receiptClock(receipt.observedAt);
      if (!managedDatabaseStopReceiptMatches(query, receipt)) unavailable();
      const preparation = managedDatabaseStartPreparationSchema.parse({...source, originalStopReceipt: receipt,
        originalStopReplayFingerprint: managedDatabaseStopReplayFingerprintDigest(query)});
      if (startPreparation?.originalStopReceipt.observedAt === receipt.observedAt) unavailable();
      if (!startPreparation || receipt.observedAt > startPreparation.originalStopReceipt.observedAt) startPreparation = preparation;
    }
    await fence(); return {source, startPreparation};
  } catch { return unavailable(); }
  finally {clearTimeout(timer); input.signal?.removeEventListener("abort", cancel);}
}
