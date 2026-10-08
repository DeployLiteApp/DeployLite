import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import { COMPOSE_RESOURCE_INSPECTION_CAPABILITY, composeAttachmentPreviewRequestSchema, composeResourceInspectionRequestSchema,
  type CapabilityRegistry, type ComposeAttachmentPreviewV1, type ComposeResourceInspectionViewV1, type ImageReferencePolicyV1 } from "@deploylite/contracts";
import { awaitAbortable, ComposePreviewError, ComposeResourceInspectionError, createComposeAttachmentPreview,
  createComposePreview, createComposeResourceInspectionView, PolicyEvaluator,
  type AuditRepository, type ComposeAttachmentPreviewDependencies, type ControlGrantRepository, type ProjectRepository } from "@deploylite/domain";

export type ComposeResourceInspectionAccess = Omit<ComposeAttachmentPreviewDependencies, "imagePolicy"> & Readonly<{ capabilities: CapabilityRegistry; deadlineMs: number }>;
export type ComposeResourceRouteOptions = Readonly<{
  prefix: string; projects: ProjectRepository; grants: ControlGrantRepository; audit: AuditRepository; imagePolicy: ImageReferencePolicyV1;
  access?: ReadonlyMap<string, ComposeResourceInspectionAccess>; requireAuth: preHandlerAsyncHookHandler; requireRole: preHandlerAsyncHookHandler;
  ok(request: FastifyRequest, data: unknown): unknown; error(request: FastifyRequest, code: string, message: string): unknown;
}>;
export function registerComposeResourceInspectionRoutes(app: FastifyInstance, options: ComposeResourceRouteOptions): void {
  for (const mode of ["inspect", "attachment"] as const) {
    const path = mode === "inspect" ? "resources/inspect" : "attachments/preview";
    const action = mode === "inspect" ? "compose.resource.inspect" : "compose.attachment.preview";
    app.post(`${options.prefix}/projects/:projectId/compose/${path}`, { bodyLimit: 131_072, preHandler: [options.requireAuth, options.requireRole] }, async (request, reply) => {
      const { projectId } = z.object({ projectId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/) }).parse(request.params);
      const actorId = request.auth!.user.id;
      const audit = (name: string, metadata: Record<string, unknown>) => options.audit.append({ actorUserId: actorId, action: name, targetType: "project", targetId: projectId,
        ...request.correlationContext, metadata: { projectId, ...metadata } });
      const decision = new PolicyEvaluator().evaluate({ actorId, role: request.auth!.user.role, action: "project.deploy", scope: { kind: "project", projectId },
        correlationId: request.correlationContext.correlationId, grants: await options.grants.listForActor(actorId) });
      if (!decision.allowed) { await audit(action + ".denied", { reason: decision.code }); return reply.code(403).send(options.error(request, decision.code, "Resource inspection is not authorized.")); }
      if (!await options.projects.findById(projectId)) return reply.code(404).send(options.error(request, "NOT_FOUND", "Project was not found."));
      const body = mode === "inspect" ? composeResourceInspectionRequestSchema.safeParse(request.body) : composeAttachmentPreviewRequestSchema.safeParse(request.body);
      if (!body.success) { await audit(action + ".rejected", { reason: "invalid-request" }); return reply.code(400).send(options.error(request, "VALIDATION_ERROR", "Request validation failed.")); }
      const input = { ...body.data, projectId };
      let result: ComposeResourceInspectionViewV1 | ComposeAttachmentPreviewV1;
      try {
        const preview = createComposePreview(input.document, projectId, options.imagePolicy);
        if (preview.configDigest !== input.expectedConfigDigest) throw new ComposeResourceInspectionError("COMPOSE_RESOURCE_STALE");
        const configured = options.access?.get(projectId);
        if (!configured || !configured.capabilities.has(COMPOSE_RESOURCE_INSPECTION_CAPABILITY)) throw new ComposeResourceInspectionError("COMPOSE_INSPECTION_UNSUPPORTED");
        const captured = { ...configured, imagePolicy: structuredClone(options.imagePolicy) };
        if (!Number.isSafeInteger(captured.deadlineMs) || captured.deadlineMs < 1 || captured.deadlineMs > 60_000) throw new ComposeResourceInspectionError("COMPOSE_INSPECTION_INVALID");
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new ComposeResourceInspectionError("COMPOSE_INSPECTION_LIMIT")), captured.deadlineMs);
        const cancel = () => controller.abort(new ComposeResourceInspectionError("COMPOSE_INSPECTION_CANCELED"));
        request.raw.once("aborted", cancel);
        try {
          result = await awaitAbortable<ComposeResourceInspectionViewV1 | ComposeAttachmentPreviewV1>(() => mode === "inspect"
            ? createComposeResourceInspectionView(input, captured, controller.signal)
            : createComposeAttachmentPreview(composeAttachmentPreviewRequestSchema.extend({ projectId: z.literal(projectId) }).parse(input), captured, controller.signal), controller.signal);
          if (!captured.capabilities.has(COMPOSE_RESOURCE_INSPECTION_CAPABILITY)) throw new ComposeResourceInspectionError("COMPOSE_INSPECTION_UNSUPPORTED");
          if (options.access?.get(projectId) !== configured) throw new ComposeResourceInspectionError("COMPOSE_RESOURCE_STALE");
        } finally { clearTimeout(timer); request.raw.off("aborted", cancel); }
      } catch (error) {
        const failure = error instanceof ComposePreviewError || error instanceof ComposeResourceInspectionError ? error : new ComposeResourceInspectionError("COMPOSE_INSPECTION_FAILED");
        const conflict = ["COMPOSE_RESOURCE_STALE", "COMPOSE_RESOURCE_FOREIGN", "COMPOSE_RESOURCE_CONFLICT", "COMPOSE_RESOURCE_IN_USE", "COMPOSE_ATTACHMENT_CONFLICT"].includes(failure.code);
        const status = failure instanceof ComposePreviewError ? 400 : conflict ? 409 : 503;
        await audit(action + ".rejected", { reason: failure.code });
        return reply.code(status).send(options.error(request, failure.code, "Resource inspection is unavailable or outside the supported policy."));
      }
      await audit(action, { targetType: input.kind, key: input.key, inputDigest: result.configDigest, valueFingerprint: result.stateDigest,
        serviceCount: result.status === "observed" ? result.containers.length : 1, networkCount: input.kind === "network" ? 1 : 0, volumeCount: input.kind === "volume" ? 1 : 0 });
      return options.ok(request, mode === "inspect" ? { inspection: result } : { preview: result });
    });
  }
}
