import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { COMPOSE_PREVIEW_MAX_BYTES, COMPOSE_RESOURCE_INSPECTION_CAPABILITY, composeVolumeBackupExecuteApiRequestSchema,
  composeVolumeBackupReceiptSchema, FenceError, type ComposeVolumeBackupPlanV1, type ComposeVolumeBackupPlanningProfile,
  type ComposeVolumeBackupReceiptV1, type ProjectControlAuthorityV1 } from "@deploylite/contracts";
import { awaitAbortable, ComposeBackupPlanningError, ComposePreviewError, composeVolumeBackupExecutionBinding,
  composeVolumeBackupExecutionDigest, createComposePreview, createControlCommand, digestControlInput, IdempotencyConflictError, PolicyEvaluator, prepareComposeVolumeBackupPlan,
  type AuditEventInput, type ComposeVolumeBackupPlanStore,
  type ControlGrantRepository, type ProjectRepository, type ProjectUpdateControlRepository, type PreparedComposeVolumeBackupPlan } from "@deploylite/domain";
import type { PreparedComposeVolumeBackupCommand } from "./agent-transport.js";
import type { ComposeResourceRouteOptions } from "./compose-resource-inspection-route.js";

export type ComposeVolumeBackupPlanAccess = Readonly<{ profiles: ReadonlyMap<string, ComposeVolumeBackupPlanningProfile>; store: ComposeVolumeBackupPlanStore }>;
export type ComposeVolumeBackupAgentTransport = Readonly<{
  available(): boolean;
  dispatchComposeVolumeBackup(prepared: PreparedComposeVolumeBackupCommand, authority: ProjectControlAuthorityV1,
    context: Readonly<{ requestId: string; correlationId: string; signal?: AbortSignal }>): Promise<ComposeVolumeBackupReceiptV1>;
  readComposeVolumeBackupReceipt(prepared: PreparedComposeVolumeBackupCommand, authority: ProjectControlAuthorityV1,
    context: Readonly<{ requestId: string; correlationId: string; signal?: AbortSignal }>): Promise<ComposeVolumeBackupReceiptV1 | null>;
}>;
export type ComposeVolumeBackupExecutionAccess = Readonly<{ controls: ProjectUpdateControlRepository; transport: ComposeVolumeBackupAgentTransport }>;
type Options = ComposeResourceRouteOptions & Readonly<{
  planning?: ReadonlyMap<string, ComposeVolumeBackupPlanAccess>;
  execution?: ReadonlyMap<string, ComposeVolumeBackupExecutionAccess>;
}>;

const identity = /^[A-Za-z0-9_-]{1,200}$/;
function fail(code: ConstructorParameters<typeof ComposeBackupPlanningError>[0]): never { throw new ComposeBackupPlanningError(code); }
function conflict(code: string): boolean {
  return code === "IDEMPOTENCY_CONFLICT" || ["COMPOSE_BACKUP_FOREIGN", "COMPOSE_BACKUP_STALE", "COMPOSE_BACKUP_IN_USE", "COMPOSE_BACKUP_EXPIRED", "COMPOSE_BACKUP_CONFLICT"].includes(code);
}
function validateReceipt(raw: unknown, command: PreparedComposeVolumeBackupCommand): ComposeVolumeBackupReceiptV1 {
  const parsed = composeVolumeBackupReceiptSchema.safeParse(raw);
  if (!parsed.success) fail("COMPOSE_BACKUP_INVALID");
  const receipt = parsed.data;
  if (receipt.agentId !== command.agentId || receipt.commandId !== command.commandId || receipt.projectId !== command.projectId
    || receipt.inputDigest !== command.inputDigest || receipt.correlationId !== command.context.correlationId
    || receipt.volumeKey !== command.plan.volumeKey || receipt.destinationId !== command.plan.destinationId) fail("COMPOSE_BACKUP_INVALID");
  return receipt;
}
function executionCommand(input: ComposeVolumeBackupPlanV1, projectId: string, actorId: string, idempotencyKey: string, correlationId: string, expiresAt: Date) {
  const binding = composeVolumeBackupExecutionBinding({ projectId, idempotencyKey, plan: input });
  return { ...createControlCommand({ actorId, action: "project.update", scope: { kind: "project", projectId }, input: binding,
    idempotencyKey, correlationId, expiresAt }), status: "eligible" as const };
}
function validateControlCommand(command: Awaited<ReturnType<ProjectUpdateControlRepository["resolve"]>>["command"], actorId: string, projectId: string, idempotencyKey: string, inputDigest: string): void {
  if (command.actorId !== actorId || command.action !== "project.update" || command.scope.kind !== "project" || command.scope.projectId !== projectId
    || command.idempotencyKey !== idempotencyKey || command.inputDigest !== inputDigest || !(command.expiresAt instanceof Date)
    || !Number.isSafeInteger(command.expiresAt.valueOf())) throw new FenceError("Project update command scope rejected");
}
function authorityFor(command: Awaited<ReturnType<ProjectUpdateControlRepository["resolve"]>>["command"], projectId: string, inputDigest: string): ProjectControlAuthorityV1 | null {
  const authority = command.projectExecutionAuthority;
  if (!authority) return null;
  if (authority.projectId !== projectId || authority.commandId !== command.id || authority.inputDigest !== inputDigest
    || authority.projectLease.projectId !== projectId) throw new FenceError("Project update authority scope rejected");
  return structuredClone(authority);
}
function preparedCommand(input: z.infer<typeof composeVolumeBackupExecuteApiRequestSchema>, projectId: string, agentId: string,
  command: Awaited<ReturnType<ProjectUpdateControlRepository["resolve"]>>["command"], requestId: string, correlationId: string): PreparedComposeVolumeBackupCommand {
  return { schemaVersion: 1, action: "compose.volume.backup", agentId, commandId: command.id, projectId,
    operation: "compose.volume.backup.execute", idempotencyKey: command.idempotencyKey, inputDigest: command.inputDigest,
    canonicalDocument: input.document, plan: structuredClone(input.plan), context: { requestId, correlationId } };
}

/** Revalidates the preview, claims existing project.update authority, and reconciles by the agent's durable receipt. */
export function registerComposeVolumeBackupExecutionRoute(app: FastifyInstance, options: Options): void {
  app.post(`${options.prefix}/projects/:projectId/compose/volumes/backup/execute`, { bodyLimit: 131_072, preHandler: [options.requireAuth, options.requireRole] }, async (request, reply) => {
    const { projectId } = z.object({ projectId: z.string().regex(identity) }).parse(request.params), actorId = request.auth!.user.id;
    const auditFailure = (reason: string) => options.audit.append({ actorUserId: actorId, action: "compose.volume.backup.execution.rejected", targetType: "project", targetId: projectId,
      ...request.correlationContext, metadata: { projectId, reason } });
    const idempotencyKey = request.headers["idempotency-key"], parsed = composeVolumeBackupExecuteApiRequestSchema.safeParse(request.body);
    if (!parsed.success || typeof idempotencyKey !== "string" || !identity.test(idempotencyKey)
      || new TextEncoder().encode(parsed.data.document).length > COMPOSE_PREVIEW_MAX_BYTES
      || parsed.data.plan.projectId !== projectId || parsed.data.plan.volumeKey !== parsed.data.key
      || parsed.data.plan.configDigest !== parsed.data.expectedConfigDigest || parsed.data.plan.stateDigest !== parsed.data.expectedStateDigest
      || parsed.data.plan.destinationId !== parsed.data.destinationId) {
      await auditFailure("invalid-request"); return reply.code(400).send(options.error(request, "VALIDATION_ERROR", "Request validation failed."));
    }
    const input = parsed.data;
    const decision = new PolicyEvaluator().evaluate({ actorId, role: request.auth!.user.role, action: "project.update", scope: { kind: "project", projectId },
      correlationId: request.correlationContext.correlationId, grants: await options.grants.listForActor(actorId) });
    if (!decision.allowed) { await auditFailure(decision.code); return reply.code(403).send(options.error(request, decision.code, "Backup execution is not authorized.")); }
    if (!await options.projects.findById(projectId)) return reply.code(404).send(options.error(request, "NOT_FOUND", "Project was not found."));

    const inspection = options.access?.get(projectId), planning = options.planning?.get(projectId), execution = options.execution?.get(projectId);
    if (!inspection || !planning || !execution || !planning.store.available() || !execution.transport.available()
      || !inspection.capabilities.has(COMPOSE_RESOURCE_INSPECTION_CAPABILITY)) {
      await auditFailure("capability-unavailable"); return reply.code(503).send(options.error(request, "COMPOSE_BACKUP_UNAVAILABLE", "Backup execution is unavailable or outside policy."));
    }
    const capturedInspection = { ...inspection, imagePolicy: structuredClone(options.imagePolicy) };
    const capturedPlanning = planning, capturedExecution = execution, profileMap = planning.profiles, store = planning.store, controls = execution.controls, transport = execution.transport;
    const profile = profileMap.get(input.destinationId);
    if (!profile || profile.projectId !== projectId || profile.agentId !== inspection.agentId || profile.owner !== inspection.owner
      || profile.destinationId !== input.destinationId) {
      await auditFailure("profile-unavailable"); return reply.code(503).send(options.error(request, "COMPOSE_BACKUP_UNAVAILABLE", "Backup execution is unavailable or outside policy."));
    }
    const profileDigest = digestControlInput(profile);
    let now: number;
    try { now = inspection.clock.now(); } catch { now = Number.NaN; }
    if (!Number.isSafeInteger(now) || now < 0) { await auditFailure("clock-unavailable"); return reply.code(503).send(options.error(request, "COMPOSE_BACKUP_UNAVAILABLE", "Backup execution is unavailable or outside policy.")); }
    const expectedDigest = composeVolumeBackupExecutionDigest({ projectId, idempotencyKey, plan: input.plan });
    const current = () => {
      if (!capturedInspection.capabilities.has(COMPOSE_RESOURCE_INSPECTION_CAPABILITY) || !store.available() || !transport.available()
        || options.access?.get(projectId) !== inspection || options.planning?.get(projectId) !== capturedPlanning
        || options.execution?.get(projectId) !== capturedExecution || capturedPlanning.store !== store || capturedPlanning.profiles !== profileMap
        || profileMap.get(input.destinationId) !== profile || digestControlInput(profile) !== profileDigest
        || profile.owner !== capturedInspection.owner || profile.agentId !== capturedInspection.agentId) fail("COMPOSE_BACKUP_UNAVAILABLE");
    };
    const controller = new AbortController(), cancel = () => controller.abort();
    const timer = setTimeout(cancel, Math.min(60_000, Math.max(capturedInspection.deadlineMs, input.plan.limits.maxDurationMs)));
    request.raw.once("aborted", cancel); if (request.raw.aborted) cancel();
    const context = { requestId: request.correlationContext.requestId, correlationId: request.correlationContext.correlationId, signal: controller.signal };
    const successAudit = (command: PreparedComposeVolumeBackupCommand, receipt: ComposeVolumeBackupReceiptV1): AuditEventInput => ({
      actorUserId: actorId, action: "compose.volume.backup.executed", targetType: "project", targetId: projectId,
      requestId: context.requestId, correlationId: command.context.correlationId,
      metadata: { projectId, commandId: command.commandId, inputDigest: command.inputDigest, volumeKey: receipt.volumeKey, destinationId: receipt.destinationId,
        archiveId: receipt.archiveId, archiveBytes: receipt.archiveBytes, entries: receipt.entries, archiveSha256: receipt.archiveSha256,
        manifestSha256: receipt.manifestSha256, consistency: receipt.consistency, status: receipt.status }
    });
    try {
      current();
      const controlInput = composeVolumeBackupExecutionBinding({ projectId, idempotencyKey, plan: input.plan });
      const stored = await awaitAbortable(() => controls.findProjectUpdateByIdempotency(actorId, projectId, idempotencyKey), controller.signal);
      if (stored && stored.inputDigest !== expectedDigest) throw new IdempotencyConflictError();
      let control = stored;
      let authority = control ? authorityFor(control, projectId, expectedDigest) : null;
      if (control) validateControlCommand(control, actorId, projectId, idempotencyKey, expectedDigest);
      if (control && authority) {
        const persistedContext = { ...context, correlationId: control.correlationId };
        const cachedCommand = preparedCommand(input, projectId, inspection.agentId, control, context.requestId, persistedContext.correlationId);
        const cached = await awaitAbortable(() => transport.readComposeVolumeBackupReceipt(cachedCommand, authority!, persistedContext), controller.signal);
        current();
        if (cached) {
          const receipt = validateReceipt(cached, cachedCommand);
          if (control.status === "completed") return options.ok(request, { backup: receipt });
          const completed = await awaitAbortable(() => controls.completeProjectUpdate(control!, authority!, successAudit(cachedCommand, receipt)), controller.signal);
          if (completed.status !== "completed") fail("COMPOSE_BACKUP_FAILED");
          return options.ok(request, { backup: receipt });
        }
        if (control.status === "completed") fail("COMPOSE_BACKUP_FAILED");
      }
      if (controller.signal.aborted) fail("COMPOSE_BACKUP_FAILED");
      const preview = createComposePreview(input.document, projectId, capturedInspection.imagePolicy);
      if (preview.configDigest !== input.expectedConfigDigest) fail("COMPOSE_BACKUP_STALE");
      const preparedPlan: PreparedComposeVolumeBackupPlan = await awaitAbortable(() => prepareComposeVolumeBackupPlan({ document: input.document, projectId,
        key: input.key, expectedConfigDigest: input.expectedConfigDigest, expectedStateDigest: input.expectedStateDigest, destinationId: input.destinationId }, {
        inspection: capturedInspection, capabilities: capturedInspection.capabilities, profiles: profileMap, actorId, role: request.auth!.user.role,
        correlationId: context.correlationId, requestId: context.requestId, idempotencyKey, grants: options.grants, deadlineMs: capturedInspection.deadlineMs
      }, controller.signal), controller.signal);
      current();
      if (digestControlInput(preparedPlan.plan) !== digestControlInput(input.plan)) fail("COMPOSE_BACKUP_STALE");
      const operationWindowMs = Math.min(preparedPlan.plan.limits.maxDurationMs, 60_000);
      if (preparedPlan.plan.limits.planTtlMs < operationWindowMs + 5_000) fail("COMPOSE_BACKUP_UNAVAILABLE");
      if (!control) {
        const expiresAt = new Date(preparedPlan.preparedAtMs + operationWindowMs + 5_000);
        const candidate = executionCommand(preparedPlan.plan, projectId, actorId, idempotencyKey, context.correlationId, expiresAt);
        const resolved = await awaitAbortable(() => controls.resolve(candidate), controller.signal);
        control = resolved.command;
        validateControlCommand(control, actorId, projectId, idempotencyKey, expectedDigest);
        if (control.inputDigest !== composeVolumeBackupExecutionDigest({ projectId, idempotencyKey, plan: preparedPlan.plan })) throw new IdempotencyConflictError();
        authority = authorityFor(control, projectId, expectedDigest);
      }
      if (!control) fail("COMPOSE_BACKUP_FAILED");
      if (!authority) {
        const claimed = await awaitAbortable(() => controls.claimProjectUpdate(control!), controller.signal);
        control = claimed.command;
        authority = claimed.authority ?? authorityFor(control, projectId, expectedDigest);
      }
      if (!authority || authority.projectId !== projectId || authority.commandId !== control.id || authority.inputDigest !== control.inputDigest
        || authority.projectLease.expiresAt <= (inspection.clock.now())) fail("COMPOSE_BACKUP_EXPIRED");
      const dispatchContext = { ...context, correlationId: control.correlationId };
      const command = preparedCommand({ ...input, plan: preparedPlan.plan }, projectId, preparedPlan.agentId, control, context.requestId, dispatchContext.correlationId);
      let receipt: ComposeVolumeBackupReceiptV1;
      try { receipt = validateReceipt(await awaitAbortable(() => transport.dispatchComposeVolumeBackup(command, authority!, dispatchContext), controller.signal), command); }
      catch (dispatchError) {
        if (controller.signal.aborted) throw dispatchError;
        try {
          const reconciled = await awaitAbortable(() => transport.readComposeVolumeBackupReceipt(command, authority!, dispatchContext), controller.signal);
          if (!reconciled) throw dispatchError;
          receipt = validateReceipt(reconciled, command);
        } catch { throw dispatchError; }
      }
      current();
      const completed = await awaitAbortable(() => controls.completeProjectUpdate(control!, authority!, successAudit(command, receipt)), controller.signal);
      if (completed.status !== "completed") fail("COMPOSE_BACKUP_FAILED");
      return options.ok(request, { backup: receipt });
    } catch (error) {
      const code = error instanceof ComposeBackupPlanningError || error instanceof ComposePreviewError || error instanceof IdempotencyConflictError
        ? error.code : error instanceof FenceError ? "COMPOSE_BACKUP_CONFLICT" : "COMPOSE_BACKUP_FAILED";
      const status = code === "COMPOSE_BACKUP_FORBIDDEN" ? 403 : conflict(code) ? 409 : 503;
      await auditFailure(code);
      return reply.code(status).send(options.error(request, code, "Backup execution is unavailable or outside the supported policy."));
    } finally { clearTimeout(timer); request.raw.off("aborted", cancel); }
  });
}
