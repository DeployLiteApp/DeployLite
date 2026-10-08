import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { COMPOSE_PREVIEW_MAX_BYTES, COMPOSE_RESOURCE_INSPECTION_CAPABILITY, composeResourceCleanupInputSchema,
  composeResourceCleanupReceiptSchema, composeResourceCleanupExecutionReceiptSchema, type ComposeResourceCleanupExecutionReceiptV1,
  type ComposeResourceCleanupReceiptV1, type ComposeResourceCleanupConfirmationViewV1 } from "@deploylite/contracts";
import { awaitAbortable, ComposePreviewError, ComposeResourceCleanupError, createComposePreview, digestControlInput, evaluateConfirmation,
  composeResourceCleanupExecutionDigest, IdempotencyConflictError, PolicyEvaluator, prepareComposeResourceCleanup, validateConfirmedComposeResourceCleanup,
  type ComposeResourceCleanupRecord, type ComposeResourceCleanupStore, type PreparedComposeResourceCleanup } from "@deploylite/domain";
import type { ComposeResourceRouteOptions } from "./compose-resource-inspection-route.js";

export type ComposeResourceCleanupAccess = Readonly<{ store: ComposeResourceCleanupStore; confirmationTtlMs: number }>;
export type PreparedComposeResourceCleanupCommand = Readonly<{ schemaVersion: 1; action: "compose.resource.cleanup"; agentId: string; commandId: string;
  cleanupCommandId: string; confirmationId: string; projectId: string; inputDigest: string; cleanupInputDigest: string; context: Readonly<{ requestId: string; correlationId: string }>;
  kind: "network" | "volume"; key: string; runtimeName: string; configDigest: string; stateDigest: string }>;
export type ComposeResourceCleanupAgentTransport = Readonly<{ available(): boolean;
  dispatchComposeResourceCleanup(command: PreparedComposeResourceCleanupCommand, signal?: AbortSignal): Promise<ComposeResourceCleanupExecutionReceiptV1>;
  readComposeResourceCleanupReceipt(command: PreparedComposeResourceCleanupCommand, signal?: AbortSignal): Promise<ComposeResourceCleanupExecutionReceiptV1 | null> }>;
export type ComposeResourceCleanupExecutionAccess = Readonly<{ transport: ComposeResourceCleanupAgentTransport }>;
type Options = ComposeResourceRouteOptions & Readonly<{ cleanup?: ReadonlyMap<string, ComposeResourceCleanupAccess>; execution?: ReadonlyMap<string, ComposeResourceCleanupExecutionAccess> }>;
const identity = /^[A-Za-z0-9_-]{1,200}$/;
function fail(code: ConstructorParameters<typeof ComposeResourceCleanupError>[0]): never { throw new ComposeResourceCleanupError(code); }
function commandBinding(command: PreparedComposeResourceCleanup["command"]): PreparedComposeResourceCleanup["command"] {
  return { id: command.id, actorId: command.actorId, action: command.action, scope: structuredClone(command.scope), inputDigest: command.inputDigest,
    idempotencyKey: command.idempotencyKey, correlationId: command.correlationId, status: "pending_confirmation", expiresAt: command.expiresAt };
}
function receipt(raw: unknown, prepared: PreparedComposeResourceCleanup, now: number, confirmationId?: string): ComposeResourceCleanupReceiptV1 {
  const parsed = composeResourceCleanupReceiptSchema.safeParse(raw); if (!parsed.success) fail("COMPOSE_CLEANUP_INVALID"); const value = parsed.data;
  const expiry = Date.parse(value.expiresAt), terminal = value.status === "dispatching" || value.status === "completed";
  if (digestControlInput(value.preview) !== digestControlInput(prepared.preview) || !Number.isSafeInteger(now) || !Number.isSafeInteger(expiry)
    || (!terminal && expiry <= now) || expiry > prepared.command.expiresAt.valueOf()
    || ((!value.idempotent || confirmationId !== undefined) && expiry !== prepared.command.expiresAt.valueOf())
    || ((!value.idempotent || confirmationId !== undefined) && value.commandId !== prepared.command.id)
    || (confirmationId !== undefined && value.confirmationId !== confirmationId)) fail("COMPOSE_CLEANUP_INVALID");
  if (value.execution && (value.execution.agentId !== prepared.agentId || value.execution.commandId !== prepared.command.id
    || value.execution.cleanupCommandId !== prepared.command.id || value.execution.confirmationId !== value.confirmationId
    || value.execution.projectId !== prepared.preview.projectId || value.execution.inputDigest !== prepared.command.inputDigest
    || value.execution.cleanupInputDigest !== composeResourceCleanupExecutionDigest(prepared, value.confirmationId)
    || value.execution.correlationId !== prepared.command.correlationId || value.execution.kind !== prepared.preview.kind
    || value.execution.key !== prepared.preview.key || value.execution.configDigest !== prepared.preview.configDigest
    || value.execution.stateDigest !== prepared.preview.stateDigest)) fail("COMPOSE_CLEANUP_INVALID");
  return value;
}
function executionCommand(prepared: PreparedComposeResourceCleanup, confirmationId: string, requestId: string, runtimeName: string): PreparedComposeResourceCleanupCommand {
  return { schemaVersion: 1, action: "compose.resource.cleanup", agentId: prepared.agentId, commandId: prepared.command.id, cleanupCommandId: prepared.command.id,
    confirmationId, projectId: prepared.preview.projectId, inputDigest: prepared.command.inputDigest,
    cleanupInputDigest: composeResourceCleanupExecutionDigest(prepared, confirmationId), context: { requestId, correlationId: prepared.command.correlationId },
    kind: prepared.preview.kind, key: prepared.preview.key, runtimeName, configDigest: prepared.preview.configDigest, stateDigest: prepared.preview.stateDigest };
}
function validateExecutionReceipt(raw: unknown, command: PreparedComposeResourceCleanupCommand): ComposeResourceCleanupExecutionReceiptV1 {
  const parsed = composeResourceCleanupExecutionReceiptSchema.safeParse(raw); if (!parsed.success) fail("COMPOSE_CLEANUP_INVALID"); const value = parsed.data;
  if (value.agentId !== command.agentId || value.commandId !== command.commandId || value.cleanupCommandId !== command.cleanupCommandId
    || value.confirmationId !== command.confirmationId || value.projectId !== command.projectId || value.inputDigest !== command.inputDigest
    || value.cleanupInputDigest !== command.cleanupInputDigest || value.correlationId !== command.context.correlationId || value.kind !== command.kind
    || value.key !== command.key || value.runtimeName !== command.runtimeName || value.configDigest !== command.configDigest || value.stateDigest !== command.stateDigest) fail("COMPOSE_CLEANUP_INVALID");
  return value;
}

/** Cleanup execution requires an explicitly injected transport; no cleanup adapter is installed by default. */
export function registerComposeResourceCleanupRoutes(app: FastifyInstance, options: Options): void {
  for (const mode of ["preview", "confirm"] as const) {
    app.post(`${options.prefix}/projects/:projectId/compose/resources/cleanup/${mode}`, { bodyLimit: 131_072, preHandler: [options.requireAuth, options.requireRole] }, async (request, reply) => {
      const { projectId } = z.object({ projectId: z.string().regex(identity) }).parse(request.params), actorId = request.auth!.user.id;
      const audit = (suffix: string, reason: string) => options.audit.append({ actorUserId: actorId, action: `compose.resource.cleanup.${suffix}`, targetType: "project", targetId: projectId,
        ...request.correlationContext, metadata: { projectId, reason } });
      const decision = new PolicyEvaluator().evaluate({ actorId, role: request.auth!.user.role, action: "project.delete", scope: { kind: "project", projectId },
        correlationId: request.correlationContext.correlationId, grants: await options.grants.listForActor(actorId) });
      if (!decision.allowed) { await audit("denied", decision.code); return reply.code(403).send(options.error(request, decision.code, "Cleanup admission is not authorized.")); }
      if (!await options.projects.findById(projectId)) return reply.code(404).send(options.error(request, "NOT_FOUND", "Project was not found."));
      const parsed = composeResourceCleanupInputSchema.omit({ projectId: true }).safeParse(request.body), idempotencyKey = request.headers["idempotency-key"], confirmationId = request.headers["x-control-confirmation-id"];
      if (!parsed.success || typeof idempotencyKey !== "string" || !identity.test(idempotencyKey) || new TextEncoder().encode(parsed.data.document).length > COMPOSE_PREVIEW_MAX_BYTES
        || (mode === "confirm" && (typeof confirmationId !== "string" || !identity.test(confirmationId)))) {
        await audit("rejected", "invalid-request"); return reply.code(400).send(options.error(request, "VALIDATION_ERROR", "Request validation failed."));
      }
      const input = { ...parsed.data, projectId }; let result: ComposeResourceCleanupReceiptV1;
      try {
        if (createComposePreview(input.document, projectId, options.imagePolicy).configDigest !== input.expectedConfigDigest) fail("COMPOSE_CLEANUP_STALE");
        const selected = options.access?.get(projectId), configured = options.cleanup?.get(projectId);
        if (!selected || !configured || !selected.capabilities.has(COMPOSE_RESOURCE_INSPECTION_CAPABILITY) || !configured.store.available()
          || !Number.isSafeInteger(selected.deadlineMs) || selected.deadlineMs < 1 || selected.deadlineMs > 60_000
          || !Number.isSafeInteger(configured.confirmationTtlMs) || configured.confirmationTtlMs < 1 || configured.confirmationTtlMs > 900_000) fail("COMPOSE_CLEANUP_UNAVAILABLE");
        const selectedExecution = options.execution?.get(projectId);
        const inspection = { ...selected, imagePolicy: structuredClone(options.imagePolicy) }, store = configured.store, ttl = configured.confirmationTtlMs;
        const deps = { inspection, capabilities: inspection.capabilities, actorId, role: request.auth!.user.role, correlationId: request.correlationContext.correlationId,
          idempotencyKey, grants: options.grants, deadlineMs: inspection.deadlineMs, confirmationTtlMs: ttl };
        const controller = new AbortController(), cancel = () => controller.abort(new ComposeResourceCleanupError("COMPOSE_CLEANUP_FAILED"));
        const timer = setTimeout(cancel, inspection.deadlineMs); request.raw.once("aborted", cancel); if (request.raw.aborted) cancel();
        const current = () => {
          if (!inspection.capabilities.has(COMPOSE_RESOURCE_INSPECTION_CAPABILITY) || !store.available()) fail("COMPOSE_CLEANUP_UNAVAILABLE");
          if (options.access?.get(projectId) !== selected || options.cleanup?.get(projectId) !== configured || configured.store !== store || configured.confirmationTtlMs !== ttl
            || options.execution?.get(projectId) !== selectedExecution
            || selected.owner !== inspection.owner || selected.agentId !== inspection.agentId || selected.inspector !== inspection.inspector || selected.clock !== inspection.clock
            || selected.maxAgeMs !== inspection.maxAgeMs || selected.deadlineMs !== inspection.deadlineMs || selected.capabilities !== inspection.capabilities
            || digestControlInput(options.imagePolicy) !== digestControlInput(inspection.imagePolicy)) fail("COMPOSE_CLEANUP_STALE");
        };
        try {
          let prepared: PreparedComposeResourceCleanup | undefined, view: ComposeResourceCleanupConfirmationViewV1 | undefined;
          let confirmationIdForExecution: string | undefined, recoveryOnly = false;
          if (mode === "preview") prepared = await awaitAbortable(() => prepareComposeResourceCleanup(input, deps, controller.signal), controller.signal);
          else {
            const record: ComposeResourceCleanupRecord = structuredClone(await awaitAbortable(() => store.find({ actorId, projectId, idempotencyKey, confirmationId: confirmationId as string }, controller.signal), controller.signal));
            current(); const command = record.command, confirmation = record.confirmation, now = inspection.clock.now();
            if (command.actorId !== actorId || command.idempotencyKey !== idempotencyKey || command.action !== "project.delete"
              || !["pending_confirmation", "eligible", "dispatching", "completed"].includes(command.status)
              || command.scope.kind !== "project" || command.scope.projectId !== projectId || confirmation.id !== confirmationId
              || !(command.expiresAt instanceof Date) || !Number.isSafeInteger(command.expiresAt.valueOf())
              || !(confirmation.expiresAt instanceof Date) || !Number.isSafeInteger(confirmation.expiresAt.valueOf()) || confirmation.expiresAt.valueOf() !== command.expiresAt.valueOf()
              || command.executionAuthority || command.projectExecutionAuthority) fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED");
            const preparedAtMs = command.expiresAt.valueOf() - ttl;
            if (!Number.isSafeInteger(preparedAtMs)) fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED");
            confirmationIdForExecution = confirmation.id;
            if (command.status === "pending_confirmation") view = await awaitAbortable(() => validateConfirmedComposeResourceCleanup(input, command, confirmation, deps, controller.signal), controller.signal);
            else if (command.status === "eligible") {
              if (!(confirmation.consumedAt instanceof Date) || !Number.isSafeInteger(confirmation.consumedAt.valueOf()) || confirmation.consumedAt.valueOf() > now || confirmation.consumedAt.valueOf() < preparedAtMs) fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED");
              try { evaluateConfirmation(command, { ...confirmation, consumedAt: null }, new Date(now)); } catch { fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED"); }
              const fresh = await awaitAbortable(() => prepareComposeResourceCleanup(input, deps, controller.signal), controller.signal);
              if (fresh.command.inputDigest !== command.inputDigest) fail("COMPOSE_CLEANUP_STALE");
              view = { ...fresh.preview, commandId: command.id, confirmationId: confirmation.id, confirmationValidated: true };
              const { commandId: _commandId, confirmationId: _confirmationId, confirmationValidated: _validated, ...currentPreview } = view;
              prepared = { command: { ...command, status: "pending_confirmation" }, preview: currentPreview, owner: inspection.owner, agentId: inspection.agentId, preparedAtMs };
            } else {
              if (!(confirmation.consumedAt instanceof Date) || !Number.isSafeInteger(confirmation.consumedAt.valueOf()) || confirmation.consumedAt.valueOf() > command.expiresAt.valueOf()) fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED");
              const currentPreview = { schemaVersion: 1 as const, operation: "compose.resource.cleanup" as const, status: "preview" as const,
                executionAllowed: false as const, requiresConfirmation: true as const, projectId, kind: input.kind, key: input.key,
                configDigest: input.expectedConfigDigest, stateDigest: input.expectedStateDigest, confirmationTtlMs: ttl };
              const expectedInputDigest = digestControlInput({ ...currentPreview, owner: inspection.owner, agentId: inspection.agentId });
              if (expectedInputDigest !== command.inputDigest) fail("COMPOSE_CLEANUP_STALE");
              prepared = { command: commandBinding(command), preview: currentPreview, owner: inspection.owner, agentId: inspection.agentId, preparedAtMs };
              recoveryOnly = true;
            }
            if (!prepared) {
              const { commandId: _commandId, confirmationId: _confirmationId, confirmationValidated: _validated, ...currentPreview } = view!;
              prepared = { command: commandBinding(command), preview: currentPreview, owner: inspection.owner, agentId: inspection.agentId, preparedAtMs };
            }
          }
          current();
          if (!prepared) fail("COMPOSE_CLEANUP_FAILED");
          let raw = await awaitAbortable(() => mode === "preview" ? store.save(structuredClone(prepared!), request.correlationContext.requestId, controller.signal)
            : recoveryOnly ? store.claimExecution(structuredClone(prepared!), confirmationIdForExecution!, request.correlationContext.requestId, controller.signal)
              : store.admit(structuredClone(prepared!), view!, request.correlationContext.requestId, controller.signal), controller.signal);
          current(); result = receipt(raw, prepared, inspection.clock.now(), confirmationIdForExecution);
          if (mode === "confirm" && confirmationIdForExecution && result.status === "eligible" && selectedExecution) {
            if (!selectedExecution.transport.available()) fail("COMPOSE_CLEANUP_UNAVAILABLE");
            raw = await awaitAbortable(() => store.claimExecution(structuredClone(prepared!), confirmationIdForExecution!, request.correlationContext.requestId, controller.signal), controller.signal);
            current(); result = receipt(raw, prepared, inspection.clock.now(), confirmationIdForExecution);
          }
          if (mode === "confirm" && confirmationIdForExecution && result.status === "dispatching") {
            if (!selectedExecution?.transport.available()) fail("COMPOSE_CLEANUP_UNAVAILABLE");
            const compose = createComposePreview(input.document, projectId, options.imagePolicy), resource = (input.kind === "network" ? compose.networks : compose.volumes).find(candidate => candidate.key === input.key);
            if (!resource) fail("COMPOSE_CLEANUP_STALE");
            const transport = selectedExecution.transport, command = executionCommand(prepared, confirmationIdForExecution,
              request.correlationContext.requestId, resource.runtimeName);
            let execution: ComposeResourceCleanupExecutionReceiptV1 | null = null;
            if (result.idempotent) execution = await awaitAbortable(() => transport.readComposeResourceCleanupReceipt(command, controller.signal), controller.signal);
            if (!execution) {
              try { execution = await awaitAbortable(() => transport.dispatchComposeResourceCleanup(command, controller.signal), controller.signal); }
              catch (dispatchError) {
                if (controller.signal.aborted) throw dispatchError;
                const recovered = await awaitAbortable(() => transport.readComposeResourceCleanupReceipt(command, controller.signal), controller.signal);
                if (!recovered) throw dispatchError;
                execution = recovered;
              }
            }
            current();
            const terminal = validateExecutionReceipt(execution, command);
            raw = await awaitAbortable(() => store.completeExecution(structuredClone(prepared!), confirmationIdForExecution!, terminal,
              request.correlationContext.requestId, controller.signal), controller.signal);
            current(); result = receipt(raw, prepared, inspection.clock.now(), confirmationIdForExecution);
          }
        } finally { clearTimeout(timer); request.raw.off("aborted", cancel); }
      } catch (error) {
        const code = error instanceof ComposeResourceCleanupError || error instanceof ComposePreviewError || error instanceof IdempotencyConflictError ? error.code : "COMPOSE_CLEANUP_FAILED";
        const conflict = ["IDEMPOTENCY_CONFLICT", "COMPOSE_CLEANUP_FOREIGN", "COMPOSE_CLEANUP_STALE", "COMPOSE_CLEANUP_IN_USE", "COMPOSE_CLEANUP_EXPIRED", "COMPOSE_CLEANUP_CONFIRMATION_REJECTED"].includes(code);
        await audit("rejected", code); return reply.code(error instanceof ComposePreviewError ? 400 : code === "COMPOSE_CLEANUP_FORBIDDEN" ? 403 : conflict ? 409 : 503)
          .send(options.error(request, code, "Cleanup admission is unavailable or outside the supported policy."));
      }
      return options.ok(request, { cleanup: result });
    });
  }
}
