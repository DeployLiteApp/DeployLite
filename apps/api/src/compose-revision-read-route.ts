import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import { composeRevisionSchema, composeRevisionHistoryQuerySchema, composeRevisionHistoryPageSchema } from "@deploylite/contracts";
import { PolicyEvaluator, type AuditRepository, type ControlGrantRepository, type ComposeRevisionRepository, type ProjectRepository } from "@deploylite/domain";

export type ComposeRevisionReadCapability = Pick<ComposeRevisionRepository, "findRevision" | "listRevisions"> & { available(): boolean };
type Options = {
  prefix: string; projects: ProjectRepository; grants: ControlGrantRepository; audit: AuditRepository; revisions?: ComposeRevisionReadCapability;
  requireAuth: preHandlerAsyncHookHandler; requireRole: preHandlerAsyncHookHandler;
  ok(request: FastifyRequest, data: unknown): unknown;
  error(request: FastifyRequest, code: string, message: string): unknown;
};
const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const paramsSchema = z.object({ projectId: id, composeId: id, revisionId: id.optional() }).strict();
const storedPage = z.object({ revisions: z.array(composeRevisionSchema).max(100), total: z.number().int().min(0).max(2_147_483_647), limit: z.number().int().min(1).max(100), offset: z.number().int().min(0).max(1_000_000) }).strict();

/** Reads intent metadata only, through the same role/project permission as preview. */
export function registerComposeRevisionReadRoutes(app: FastifyInstance, options: Options): void {
  const handler = async (request: FastifyRequest, reply: import("fastify").FastifyReply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send(options.error(request, "VALIDATION_ERROR", "Request validation failed."));
    const { projectId, composeId, revisionId } = params.data;
    const audit = async (action: string, reason?: string) => {
      try {
        await options.audit.append({ actorUserId: request.auth!.user.id, action, targetType: "project", targetId: projectId,
          ...request.correlationContext, metadata: { projectId, ...(reason ? { reason } : {}) } });
      } catch { throw new Error("Compose revision read audit is unavailable."); }
    };
    const unavailable = async () => {
      await audit("compose.revisions.read.unavailable", "storage-unavailable");
      return reply.code(503).send(options.error(request, "COMPOSE_REVISION_READ_UNAVAILABLE", "Compose revision history is unavailable."));
    };
    const decision = new PolicyEvaluator().evaluate({ actorId: request.auth!.user.id, role: request.auth!.user.role, action: "project.deploy",
      scope: { kind: "project", projectId }, correlationId: request.correlationContext.correlationId, grants: await options.grants.listForActor(request.auth!.user.id) });
    if (!decision.allowed) {
      await audit("compose.revisions.read.denied", decision.code);
      return reply.code(403).send(options.error(request, decision.code, "Compose revision read is not authorized."));
    }
    const query = composeRevisionHistoryQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send(options.error(request, "VALIDATION_ERROR", "Request validation failed."));
    if (!await options.projects.findById(projectId)) return reply.code(404).send(options.error(request, "NOT_FOUND", "Project was not found."));
    const reader = options.revisions;
    if (!reader) return unavailable();
    try { if (reader.available() !== true) return unavailable(); } catch { return unavailable(); }

    let data: unknown;
    try {
      if (revisionId) {
        const raw = await reader.findRevision(projectId, revisionId);
        if (!raw || raw.id !== revisionId || raw.projectId !== projectId || raw.composeId !== composeId) return reply.code(404).send(options.error(request, "NOT_FOUND", "Compose revision was not found."));
        const revision = composeRevisionSchema.safeParse(raw);
        if (!revision.success) return unavailable();
        data = { revision: revision.data };
      } else {
        const raw = storedPage.safeParse(await reader.listRevisions(projectId, composeId, query.data));
        if (!raw.success || raw.data.limit !== query.data.limit || raw.data.offset !== query.data.offset
          || raw.data.revisions.length > query.data.limit || raw.data.total < raw.data.revisions.length
          || (raw.data.revisions.length > 0 && raw.data.total < query.data.offset + raw.data.revisions.length)
          || raw.data.revisions.some((revision) => revision.projectId !== projectId || revision.composeId !== composeId)) return unavailable();
        const page = composeRevisionHistoryPageSchema.safeParse({ ...query.data, total: raw.data.total,
          revisions: raw.data.revisions.map((revision) => ({ schemaVersion: revision.schemaVersion, id: revision.id, projectId: revision.projectId,
            composeId: revision.composeId, number: revision.number, createdBy: revision.createdBy, createdAt: revision.createdAt,
            configDigest: revision.preview.configDigest, policyVersion: revision.preview.policyVersion,
            serviceCount: revision.preview.services.length, networkCount: revision.preview.networks.length, volumeCount: revision.preview.volumes.length,
            executionAllowed: false })) });
        if (!page.success) return unavailable();
        data = page.data;
      }
    } catch { return unavailable(); }
    await audit(revisionId ? "compose.revision.read" : "compose.revisions.read");
    return options.ok(request, data);
  };
  const prefix = `${options.prefix}/projects/:projectId/compose/:composeId/revisions`;
  app.get(prefix, { preHandler: [options.requireAuth, options.requireRole] }, handler);
  app.get(`${prefix}/:revisionId`, { preHandler: [options.requireAuth, options.requireRole] }, handler);
}
