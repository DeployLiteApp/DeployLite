import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { COMPOSE_PREVIEW_MAX_BYTES, COMPOSE_RESOURCE_INSPECTION_CAPABILITY, composeAttachmentPreviewSchema, composeNetworkAttachmentCommandInputSchema,
  composeNetworkAttachmentReceiptSchema, composeResourceAttachmentCommandSchema, FenceError, type ComposeNetworkAttachmentReceiptV1, type ProjectControlAuthorityV1 } from "@deploylite/contracts";
import { awaitAbortable, ComposePreviewError, ComposeResourceInspectionError, composeResourceAttachmentExecutionDigest, createComposePreview,
  digestControlInput, IdempotencyConflictError, PolicyEvaluator, prepareComposeAttachmentControlCommand,
  type AuditEventInput, type ControlCommand, type ProjectUpdateControlRepository, type PreparedComposeAttachmentCommand } from "@deploylite/domain";
import type { ComposeResourceRouteOptions } from "./compose-resource-inspection-route.js";

export type ComposeNetworkAttachmentAgentTransport = Readonly<{
  available(): boolean;
  dispatchComposeNetworkAttachment(prepared: PreparedComposeAttachmentCommand, authority: ProjectControlAuthorityV1,
    context: Readonly<{ requestId: string; correlationId: string; signal?: AbortSignal }>): Promise<ComposeNetworkAttachmentReceiptV1>;
  readComposeNetworkAttachmentReceipt(prepared: PreparedComposeAttachmentCommand, authority: ProjectControlAuthorityV1,
    context: Readonly<{ requestId: string; correlationId: string; signal?: AbortSignal }>): Promise<ComposeNetworkAttachmentReceiptV1 | null>;
}>;
export type ComposeNetworkAttachmentExecutionAccess = Readonly<{ controls: ProjectUpdateControlRepository; transport: ComposeNetworkAttachmentAgentTransport; commandTtlMs: number }>;
type Options = ComposeResourceRouteOptions & Readonly<{ execution?: ReadonlyMap<string, ComposeNetworkAttachmentExecutionAccess> }>;
const identity = /^[A-Za-z0-9_-]{1,200}$/;

function fail(code: ConstructorParameters<typeof ComposeResourceInspectionError>[0]): never { throw new ComposeResourceInspectionError(code); }
function validateControl(command: ControlCommand, actorId: string, projectId: string, idempotencyKey: string): void {
  if (command.actorId !== actorId || command.action !== "project.update" || command.scope.kind !== "project" || command.scope.projectId !== projectId
    || command.idempotencyKey !== idempotencyKey || !(command.expiresAt instanceof Date) || !Number.isSafeInteger(command.expiresAt.valueOf())) {
    throw new FenceError("Project update attachment command scope rejected");
  }
}
function authorityFor(command: ControlCommand, projectId: string): ProjectControlAuthorityV1 | null {
  const authority = command.projectExecutionAuthority;
  if (!authority) return null;
  if (authority.action !== "project.update" || authority.projectId !== projectId || authority.commandId !== command.id
    || authority.inputDigest !== command.inputDigest || authority.projectLease.projectId !== projectId) throw new FenceError("Project update attachment authority scope rejected");
  return structuredClone(authority);
}
function reconstruct(raw: z.infer<typeof composeNetworkAttachmentCommandInputSchema>, command: ControlCommand, agentId: string,
  imagePolicy: ComposeResourceRouteOptions["imagePolicy"], idempotencyKey: string): PreparedComposeAttachmentCommand {
  const configuration = createComposePreview(raw.document, raw.projectId, imagePolicy);
  if (configuration.configDigest !== raw.expectedConfigDigest) fail("COMPOSE_RESOURCE_STALE");
  const resource = configuration.networks.find(candidate => candidate.key === raw.key), service = configuration.services.find(candidate => candidate.name === raw.service);
  if (!resource || !service || service.networks.includes(raw.key) !== (raw.action === "attach")) fail("COMPOSE_ATTACHMENT_CONFLICT");
  for (const alreadySatisfied of [false, true]) {
    const request = composeResourceAttachmentCommandSchema.parse({ schemaVersion: 1, action: "project.update", scope: { kind: "project", projectId: raw.projectId },
      operation: "compose.resource.attachment", idempotencyKey, correlationId: command.correlationId, projectId: raw.projectId, kind: "network",
      key: raw.key, runtimeName: resource.runtimeName, service: raw.service, attachmentAction: raw.action, configDigest: raw.expectedConfigDigest,
      stateDigest: raw.expectedStateDigest, containerId: raw.expectedContainerId, alreadySatisfied });
    if (composeResourceAttachmentExecutionDigest(request) !== command.inputDigest) continue;
    const preview = composeAttachmentPreviewSchema.parse({ schemaVersion: 1, status: "preview", executionAllowed: false, projectId: raw.projectId,
      kind: "network", key: raw.key, service: raw.service, action: raw.action, configDigest: raw.expectedConfigDigest,
      stateDigest: raw.expectedStateDigest, containerId: raw.expectedContainerId, alreadySatisfied });
    return { command: structuredClone(command), request, preview, canonicalDocument: configuration.canonicalDocument, agentId, created: false };
  }
  throw new IdempotencyConflictError();
}
function validateReceipt(raw: unknown, prepared: PreparedComposeAttachmentCommand): ComposeNetworkAttachmentReceiptV1 {
  const parsed = composeNetworkAttachmentReceiptSchema.safeParse(raw);
  if (!parsed.success) fail("COMPOSE_INSPECTION_INVALID");
  const receipt = parsed.data;
  if (receipt.agentId !== prepared.agentId || receipt.commandId !== prepared.command.id || receipt.projectId !== prepared.request.projectId
    || receipt.inputDigest !== prepared.command.inputDigest || receipt.correlationId !== prepared.command.correlationId
    || receipt.key !== prepared.request.key || receipt.runtimeName !== prepared.request.runtimeName || receipt.service !== prepared.request.service
    || receipt.attachmentAction !== prepared.request.attachmentAction || receipt.containerId !== prepared.request.containerId) fail("COMPOSE_INSPECTION_INVALID");
  return receipt;
}
export function registerComposeNetworkAttachmentExecutionRoute(app: FastifyInstance, options: Options): void {
  app.post(`${options.prefix}/projects/:projectId/compose/attachments/apply`, { bodyLimit: 131_072, preHandler: [options.requireAuth, options.requireRole] }, async (request, reply) => {
    const { projectId } = z.object({ projectId: z.string().regex(identity) }).parse(request.params), actorId = request.auth!.user.id;
    const auditFailure = (reason: string) => options.audit.append({ actorUserId: actorId, action: "compose.resource.attachment.rejected", targetType: "project", targetId: projectId,
      ...request.correlationContext, metadata: { projectId, reason } });
    const idempotencyKey = request.headers["idempotency-key"], parsed = composeNetworkAttachmentCommandInputSchema.omit({ projectId: true }).safeParse(request.body);
    if (!parsed.success || typeof idempotencyKey !== "string" || !identity.test(idempotencyKey)
      || new TextEncoder().encode(parsed.data.document).length > COMPOSE_PREVIEW_MAX_BYTES) {
      await auditFailure("invalid-request");
      return reply.code(400).send(options.error(request, "VALIDATION_ERROR", "Request validation failed."));
    }
    const input = { ...parsed.data, projectId };
    const decision = new PolicyEvaluator().evaluate({ actorId, role: request.auth!.user.role, action: "project.update", scope: { kind: "project", projectId },
      correlationId: request.correlationContext.correlationId, grants: await options.grants.listForActor(actorId) });
    if (!decision.allowed) {
      await auditFailure(decision.code);
      return reply.code(403).send(options.error(request, decision.code, "Network attachment is not authorized."));
    }
    if (!await options.projects.findById(projectId)) return reply.code(404).send(options.error(request, "NOT_FOUND", "Project was not found."));
    const inspection = options.access?.get(projectId), execution = options.execution?.get(projectId);
    if (!inspection || !execution || !inspection.capabilities.has(COMPOSE_RESOURCE_INSPECTION_CAPABILITY) || !execution.transport.available()
      || !Number.isSafeInteger(inspection.deadlineMs) || inspection.deadlineMs < 1 || inspection.deadlineMs > 60_000
      || !Number.isSafeInteger(execution.commandTtlMs) || execution.commandTtlMs < 1 || execution.commandTtlMs > 60_000) {
      await auditFailure("capability-unavailable");
      return reply.code(503).send(options.error(request, "COMPOSE_ATTACHMENT_UNSUPPORTED", "Network attachment is unavailable or outside policy."));
    }
    const capturedInspection = { ...inspection, imagePolicy: structuredClone(options.imagePolicy) };
    const controls = execution.controls, transport = execution.transport;
    const current = () => {
      if (!capturedInspection.capabilities.has(COMPOSE_RESOURCE_INSPECTION_CAPABILITY) || !transport.available()
        || options.access?.get(projectId) !== inspection || options.execution?.get(projectId) !== execution
        || execution.controls !== controls || execution.transport !== transport
        || inspection.owner !== capturedInspection.owner || inspection.agentId !== capturedInspection.agentId
        || inspection.inspector !== capturedInspection.inspector || inspection.clock !== capturedInspection.clock
        || inspection.deadlineMs !== capturedInspection.deadlineMs || inspection.maxAgeMs !== capturedInspection.maxAgeMs
        || digestControlInput(options.imagePolicy) !== digestControlInput(capturedInspection.imagePolicy)) fail("COMPOSE_RESOURCE_STALE");
    };
    const controller = new AbortController(), cancel = () => controller.abort(new ComposeResourceInspectionError("COMPOSE_INSPECTION_CANCELED"));
    const timer = setTimeout(cancel, inspection.deadlineMs);
    request.raw.once("aborted", cancel);
    if (request.raw.aborted) cancel();
    const context = { requestId: request.correlationContext.requestId, correlationId: request.correlationContext.correlationId, signal: controller.signal };
    const successAudit = (command: ControlCommand, receipt: ComposeNetworkAttachmentReceiptV1): AuditEventInput => ({
      actorUserId: actorId, action: "compose.resource.attachment.executed", targetType: "project", targetId: projectId,
      requestId: context.requestId, correlationId: command.correlationId,
      metadata: { projectId, commandId: command.id, inputDigest: command.inputDigest, kind: "network", key: receipt.key, service: receipt.service,
        attachmentAction: receipt.attachmentAction, physicalIdentity: receipt.resourceId, beforeStateDigest: receipt.beforeStateDigest,
        afterStateDigest: receipt.afterStateDigest, status: receipt.status, reconciled: receipt.reconciled }
    });
    try {
      current();
      let command = await awaitAbortable(() => controls.findProjectUpdateByIdempotency(actorId, projectId, idempotencyKey), controller.signal);
      let prepared: PreparedComposeAttachmentCommand;
      let authority: ProjectControlAuthorityV1 | null = null;
      if (command) {
        validateControl(command, actorId, projectId, idempotencyKey);
        prepared = reconstruct(input, command, inspection.agentId, capturedInspection.imagePolicy, idempotencyKey);
        authority = authorityFor(command, projectId);
        if (authority) {
          const cached = await awaitAbortable(() => transport.readComposeNetworkAttachmentReceipt(prepared, authority!, context), controller.signal);
          current();
          if (cached) {
            const receipt = validateReceipt(cached, prepared);
            if (command.status !== "completed") {
              const completed = await awaitAbortable(() => controls.completeProjectUpdate(command!, authority!, successAudit(command!, receipt)), controller.signal);
              if (completed.status !== "completed") fail("COMPOSE_INSPECTION_FAILED");
            }
            return options.ok(request, { attachment: receipt });
          }
          if (command.status === "completed") fail("COMPOSE_INSPECTION_FAILED");
        } else if (command.status !== "eligible") {
          fail("COMPOSE_RESOURCE_STALE");
        }
      } else {
        const rawPrepared = await awaitAbortable(() => prepareComposeAttachmentControlCommand(input, { ...capturedInspection, actorId,
          role: request.auth!.user.role, grants: options.grants, controlCommands: controls, correlationId: context.correlationId,
          idempotencyKey, commandTtlMs: execution.commandTtlMs }, controller.signal), controller.signal);
        current();
        command = rawPrepared.command;
        validateControl(command, actorId, projectId, idempotencyKey);
        const requestForCommand = { ...rawPrepared.request, correlationId: command.correlationId };
        prepared = { ...rawPrepared, command, request: requestForCommand };
        authority = authorityFor(command, projectId);
      }
      if (!command) fail("COMPOSE_INSPECTION_FAILED");
      const now = inspection.clock.now();
      if (!Number.isSafeInteger(now) || now < 0) fail("COMPOSE_INSPECTION_FAILED");
      if (command.status === "completed" && !authority) fail("COMPOSE_INSPECTION_FAILED");
      if (command.status !== "completed" && command.expiresAt.valueOf() <= now) fail("COMPOSE_RESOURCE_STALE");
      if (!authority) {
        const claimed = await awaitAbortable(() => controls.claimProjectUpdate(command!), controller.signal);
        command = claimed.command;
        authority = claimed.authority ?? authorityFor(command, projectId);
      }
      if (!authority || authority.projectId !== projectId || authority.commandId !== command.id || authority.inputDigest !== command.inputDigest
        || authority.projectLease.expiresAt <= inspection.clock.now()) fail("COMPOSE_RESOURCE_STALE");
      current();
      const dispatchContext = { ...context, correlationId: command.correlationId };
      let receipt: ComposeNetworkAttachmentReceiptV1 | null = await awaitAbortable(() => transport.readComposeNetworkAttachmentReceipt(prepared, authority!, dispatchContext), controller.signal);
      if (!receipt) {
        try { receipt = await awaitAbortable(() => transport.dispatchComposeNetworkAttachment(prepared, authority, dispatchContext), controller.signal); }
        catch (dispatchError) {
          if (controller.signal.aborted) throw dispatchError;
          const recovered = await awaitAbortable(() => transport.readComposeNetworkAttachmentReceipt(prepared, authority, dispatchContext), controller.signal);
          if (!recovered) throw dispatchError;
          receipt = recovered;
        }
      }
      current();
      const terminal = validateReceipt(receipt, prepared);
      const completed = await awaitAbortable(() => controls.completeProjectUpdate(command!, authority!, successAudit(command!, terminal)), controller.signal);
      if (completed.status !== "completed") fail("COMPOSE_INSPECTION_FAILED");
      return options.ok(request, { attachment: terminal });
    } catch (error) {
      const code = error instanceof ComposeResourceInspectionError || error instanceof ComposePreviewError || error instanceof IdempotencyConflictError
        ? error.code : error instanceof FenceError ? "COMPOSE_ATTACHMENT_CONFLICT" : "COMPOSE_INSPECTION_FAILED";
      const conflict = ["IDEMPOTENCY_CONFLICT", "COMPOSE_RESOURCE_STALE", "COMPOSE_RESOURCE_IN_USE", "COMPOSE_RESOURCE_FOREIGN", "COMPOSE_ATTACHMENT_CONFLICT"].includes(code);
      await auditFailure(code);
      return reply.code(code === "COMPOSE_ATTACHMENT_FORBIDDEN" ? 403 : conflict ? 409 : 503)
        .send(options.error(request, code, "Network attachment is unavailable or outside the supported policy."));
    } finally {
      clearTimeout(timer);
      request.raw.off("aborted", cancel);
    }
  });
}
