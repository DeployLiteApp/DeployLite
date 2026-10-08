import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import { composePreviewRequestSchema, type ImageReferencePolicyV1 } from "@deploylite/contracts";
import { ComposePreviewError, createComposePreview, PolicyEvaluator, type AuditRepository, type ControlGrantRepository, type ProjectRepository } from "@deploylite/domain";

type Options = {
  prefix: string; projects: ProjectRepository; grants: ControlGrantRepository; audit: AuditRepository; imagePolicy: ImageReferencePolicyV1;
  requireAuth: preHandlerAsyncHookHandler; requireRole: preHandlerAsyncHookHandler;
  ok(request: FastifyRequest, data: unknown): unknown;
  error(request: FastifyRequest, code: string, message: string): unknown;
};
export function registerComposePreviewRoute(app: FastifyInstance, options: Options): void {
  app.post(`${options.prefix}/projects/:projectId/compose/preview`, { bodyLimit: 131_072, preHandler: [options.requireAuth, options.requireRole] }, async (request, reply) => {
    const { projectId } = z.object({ projectId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/) }).parse(request.params);
    const actorId = request.auth!.user.id;
    const audit = (action: string, metadata: Record<string, unknown>) => options.audit.append({ actorUserId: actorId, action, targetType: "project", targetId: projectId,
      ...request.correlationContext, metadata: { projectId, ...metadata } });
    const decision = new PolicyEvaluator().evaluate({ actorId, role: request.auth!.user.role, action: "project.deploy", scope: { kind: "project", projectId },
      correlationId: request.correlationContext.correlationId, grants: await options.grants.listForActor(actorId) });
    if (!decision.allowed) {
      await audit("compose.preview.denied", { reason: decision.code });
      return reply.code(403).send(options.error(request, decision.code, "Compose preview is not authorized."));
    }
    if (!await options.projects.findById(projectId)) return reply.code(404).send(options.error(request, "NOT_FOUND", "Project was not found."));
    const body = composePreviewRequestSchema.safeParse(request.body);
    if (!body.success) {
      await audit("compose.preview.rejected", { reason: "invalid-request" });
      return reply.code(400).send(options.error(request, "VALIDATION_ERROR", "Request validation failed."));
    }
    try {
      const preview = createComposePreview(body.data.document, projectId, options.imagePolicy);
      await audit("compose.preview", { inputDigest: preview.configDigest, serviceCount: preview.services.length, networkCount: preview.networks.length, volumeCount: preview.volumes.length });
      return options.ok(request, { preview });
    } catch (error) {
      if (!(error instanceof ComposePreviewError)) throw error;
      await audit("compose.preview.rejected", { reason: error.code });
      return reply.code(400).send(options.error(request, error.code, error.message));
    }
  });
}
