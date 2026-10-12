import {MANAGED_DATABASE_RUNTIME_CAPABILITY, MANAGED_DATABASE_LOGS_CAPABILITY, managedDatabaseLogsPreparationSchema, managedDatabaseRuntimeReceiptSchema, projectControlAuthoritySchema,
  protocolPayloadFingerprint, type ManagedDatabaseLogsPreparationV1} from "@deploylite/contracts";
import {awaitAbortable, managedDatabaseLogsSourceBinding, managedDatabaseLogsObservationMatches, managedDatabaseRuntimeReplayFingerprintDigest, type ProjectUpdateControlRepository} from "@deploylite/domain";
import type {ManagedDatabaseRuntimeAgentTransport} from "./managed-database-runtime-transport.js";
import type {ManagedDatabaseLogsTransport} from "./managed-database-logs-transport.js";
export type ManagedDatabaseLogsAccess = Readonly<{
  controls: ProjectUpdateControlRepository; originalTransport: ManagedDatabaseRuntimeAgentTransport; transport: ManagedDatabaseLogsTransport;
  agentId: string; deadlineMs: number; now(): number;
}>;
export type ManagedDatabaseLogsInput = Readonly<{
  preparation: ManagedDatabaseLogsPreparationV1; context: Readonly<{requestId: string; correlationId: string}>; signal?: AbortSignal;
  authorize(): Promise<boolean>; current(): boolean; admit(): Promise<void>;
}>;
function fail(): never {throw new Error("Database logs is unavailable.");}
/** Current project access grants logs; expired completed creation identifies immutable original evidence. */
export async function observeManagedDatabaseLogs(supplied: ManagedDatabaseLogsAccess, input: ManagedDatabaseLogsInput) {
  const originalReader = supplied.controls.findProjectUpdateById, cacheReader = supplied.originalTransport.readReceipt, logReader = supplied.transport.observe;
  const options = {...supplied}, context = {...input.context}, controller = new AbortController(), cancel = () => controller.abort();
  input.signal?.addEventListener("abort", cancel, {once: true}); if (input.signal?.aborted) cancel();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!Number.isSafeInteger(options.deadlineMs) || options.deadlineMs < 1 || options.deadlineMs > 60000) fail();
    const preparation = managedDatabaseLogsPreparationSchema.parse(structuredClone(input.preparation));
    const query = managedDatabaseLogsSourceBinding({...preparation, action: "database.runtime.logs", agentId: options.agentId, requiredCapabilities: [MANAGED_DATABASE_LOGS_CAPABILITY], context, timeoutMs: options.deadlineMs});
    const start = options.now(), deadline = start + options.deadlineMs, bounded = <T>(work: () => Promise<T>) => awaitAbortable(work, controller.signal);
    const current = () => {
      const now = options.now();
      if (controller.signal.aborted || !input.current() || options.controls.findProjectUpdateById !== originalReader || options.originalTransport.readReceipt !== cacheReader || options.transport.observe !== logReader ||
          Object.entries(options).some(([key, value]) => supplied[key as keyof typeof supplied] !== value) || !Number.isSafeInteger(start) || start < preparation.originalReceipt.observedAt ||
          !Number.isSafeInteger(deadline) || !Number.isSafeInteger(now) || now < start || now >= deadline || preparation.selection.since !== undefined && Date.parse(preparation.selection.since) > start) fail();
      return now;
    };
    async function fence() {current(); if (!await bounded(input.authorize)) fail(); current();}
    current(); timer = setTimeout(cancel, options.deadlineMs); await fence(); await bounded(input.admit); await fence();
    const reader = options.controls.findProjectUpdateById;
    if (!reader || !options.originalTransport.available() || !options.transport.available()) fail();
    const row = await bounded(() => reader!.call(options.controls, preparation.projectId, preparation.originalReceipt.commandId)); await fence();
    const original = preparation.originalReceipt;
    if (!row || row.action !== "project.update" || row.scope.kind !== "project" || row.scope.projectId !== preparation.projectId || row.status !== "completed" ||
        row.id !== original.commandId || row.inputDigest !== original.inputDigest || row.correlationId !== original.correlationId || !(row.expiresAt instanceof Date) || !Number.isFinite(row.expiresAt.getTime())) fail();
    const command = structuredClone(row), authority = projectControlAuthoritySchema.parse(structuredClone(row.projectExecutionAuthority));
    if (authority.projectId !== preparation.projectId || authority.commandId !== command.id || authority.inputDigest !== command.inputDigest || authority.projectLease.expiresAt > command.expiresAt.getTime()) fail();
    // Log selectors never enter the original apply fingerprint or cache input.
    const {originalReceipt, originalReplayFingerprint, selection: _selection, ...base} = preparation;
    const originalQuery = {...base, action: "database.runtime", operation: "database.runtime.apply", agentId: options.agentId, commandId: command.id, idempotencyKey: command.idempotencyKey,
      inputDigest: command.inputDigest, requiredCapabilities: [MANAGED_DATABASE_RUNTIME_CAPABILITY], authority, lease: authority.projectLease,
      context: {requestId: context.requestId, correlationId: command.correlationId}, timeoutMs: options.deadlineMs};
    if (managedDatabaseRuntimeReplayFingerprintDigest(originalQuery) !== originalReplayFingerprint) fail();
    const cached = await bounded(() => options.originalTransport.readReceipt({command, input: base, agentId: options.agentId}, authority, {requestId: context.requestId, correlationId: command.correlationId, signal: controller.signal})); await fence();
    if (!cached || protocolPayloadFingerprint(managedDatabaseRuntimeReceiptSchema.parse(cached)) !== protocolPayloadFingerprint(originalReceipt)) fail();
    const observation = await bounded(() => options.transport.observe(preparation, {...context, signal: controller.signal})); await fence();
    if (!managedDatabaseLogsObservationMatches(query, observation, start, current())) fail();
    return observation;
  } catch {return fail();}
  finally {if (timer !== undefined) clearTimeout(timer); input.signal?.removeEventListener("abort", cancel);}
}
