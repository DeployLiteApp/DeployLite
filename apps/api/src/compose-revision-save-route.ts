import type { FastifyInstance, FastifyRequest, FastifyReply, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import { composeRevisionSaveRequestSchema, composeRevisionSavedSchema, composeResourcePageSchema, composeRevisionHistoryQuerySchema, type ImageReferencePolicyV1 } from "@deploylite/contracts";
import { PolicyEvaluator, prepareComposeRevisionSave, ComposePreviewError, ComposeRevisionError, IdempotencyConflictError,
  type ComposeRevisionSaveStore, type AuditRepository, type ControlGrantRepository, type ProjectRepository } from "@deploylite/domain";

type Options = { prefix: string; projects: ProjectRepository; grants: ControlGrantRepository; audit: AuditRepository; revisions?: ComposeRevisionSaveStore;
  imagePolicy: ImageReferencePolicyV1; requireAuth: preHandlerAsyncHookHandler; requireRole: preHandlerAsyncHookHandler;
  ok(request: FastifyRequest, data: unknown): unknown; error(request: FastifyRequest, code: string, message: string): unknown };
const paramsSchema = z.object({ projectId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/) }).strict();
const keySchema = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
export function registerComposeRevisionSaveRoutes(app: FastifyInstance, options: Options): void {
  const handle = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = paramsSchema.safeParse(request.params); if (!params.success) return reply.code(400).send(options.error(request, "VALIDATION_ERROR", "Request validation failed."));
    const projectId = params.data.projectId, writing = request.method === "POST";
    const audit = async (action: string, reason?: string) => { try { await options.audit.append({ actorUserId: request.auth!.user.id, action, targetType: "project", targetId: projectId,
      ...request.correlationContext, metadata: { projectId, ...(reason ? { reason } : {}) } }); } catch { throw new Error("Compose audit is unavailable."); } };
    const unavailable = () => reply.code(503).send(options.error(request, writing ? "COMPOSE_REVISION_SAVE_UNAVAILABLE" : "COMPOSE_REVISION_READ_UNAVAILABLE", "Compose storage is unavailable."));
    const decision = new PolicyEvaluator().evaluate({ actorId: request.auth!.user.id, role: request.auth!.user.role, action: writing ? "project.update" : "project.deploy",
      scope: { kind: "project", projectId }, correlationId: request.correlationContext.correlationId, grants: await options.grants.listForActor(request.auth!.user.id) });
    if (!decision.allowed) { await audit(writing ? "compose.revision.save.denied" : "compose.resources.read.denied", decision.code); return reply.code(403).send(options.error(request, decision.code, "Compose access is not authorized.")); }
    const query = writing ? z.object({}).strict().safeParse(request.query) : composeRevisionHistoryQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send(options.error(request, "VALIDATION_ERROR", "Request validation failed."));
    const key = writing ? keySchema.safeParse(request.headers["x-control-idempotency-key"]) : null;
    if (writing && !key?.success) return reply.code(400).send(options.error(request, "IDEMPOTENCY_KEY_REQUIRED", "A bounded idempotency key is required."));
    if (!await options.projects.findById(projectId)) return reply.code(404).send(options.error(request, "NOT_FOUND", "Project was not found."));
    const store = options.revisions;
    let available = false; try { available = store?.available() === true; } catch { /* fixed refusal below */ }
    if (!store || !available) { await audit(writing ? "compose.revision.save.unavailable" : "compose.resources.read.unavailable", "storage-unavailable"); return unavailable(); }
    if (!writing) {
      const paging = composeRevisionHistoryQuerySchema.parse(query.data); let data;
      try {
        const page = composeResourcePageSchema.safeParse(await store.listResources(projectId, paging));
        if (!page.success || page.data.limit !== paging.limit || page.data.offset !== paging.offset || page.data.resources.length > paging.limit
          || (page.data.total < paging.offset + page.data.resources.length && page.data.resources.length > 0) || page.data.resources.some((resource) => resource.projectId !== projectId)) return unavailable();
        data = page.data;
      } catch { return unavailable(); }
      await audit("compose.resources.read"); return options.ok(request, data);
    }
    const body = composeRevisionSaveRequestSchema.safeParse(request.body); if (!body.success) return reply.code(400).send(options.error(request, "VALIDATION_ERROR", "Request validation failed."));
    try {
      const input = prepareComposeRevisionSave({ ...body.data, projectId, actorId: request.auth!.user.id, idempotencyKey: key?.success ? key.data : "",
        correlationId: request.correlationContext.correlationId, requestId: request.correlationContext.requestId, now: new Date() }, options.imagePolicy);
      const saved = composeRevisionSavedSchema.safeParse(await store.save(input));
      if (!saved.success || saved.data.revision.projectId !== projectId || saved.data.revision.createdBy !== request.auth!.user.id
        || saved.data.commandId !== saved.data.revision.id || saved.data.revision.preview.configDigest !== input.preview.configDigest
        || (body.data.composeId !== null && saved.data.revision.composeId !== body.data.composeId)) return unavailable();
      return reply.code(saved.data.idempotent ? 200 : 201).send(options.ok(request, saved.data));
    } catch (error) {
      if (error instanceof IdempotencyConflictError) return reply.code(409).send(options.error(request, error.code, "Idempotency input conflicts with an earlier save."));
      if (error instanceof ComposeRevisionError) return reply.code(error.code === "COMPOSE_REVISION_INVALID" ? 400 : 409).send(options.error(request, error.code, "Compose revision request is not eligible."));
      if (error instanceof ComposePreviewError) return reply.code(400).send(options.error(request, error.code, "Compose document is outside the supported policy."));
      return unavailable();
    }
  };
  const config = { preHandler: [options.requireAuth, options.requireRole] };
  app.post(`${options.prefix}/projects/:projectId/compose`, config, handle);
  app.get(`${options.prefix}/projects/:projectId/compose`, config, handle);
}
