import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { BackupRetentionPreviewError, PolicyEvaluator, awaitAbortable, prepareBackupRetentionPreview, type AuditRepository, type BackupInventoryReader, type BackupRetentionProtectionReader, type ControlGrantRepository, type ProjectRepository } from "@deploylite/domain";
import { backupRetentionPreviewRequestSchema } from "@deploylite/contracts";
import { z } from "zod";
export type BackupRetentionPreviewAccess = Readonly<{agentId: string; inventory?: BackupInventoryReader; protections: BackupRetentionProtectionReader; deadlineMs: number}>;
type Options = Readonly<{prefix: string; projects: ProjectRepository; grants: ControlGrantRepository; audit: AuditRepository;
  access?: ReadonlyMap<string, BackupRetentionPreviewAccess>; inventoryFactory?: (agentId: string) => BackupInventoryReader;
  requireAuth: preHandlerAsyncHookHandler; requireRole: preHandlerAsyncHookHandler;
  ok(request: unknown, data: unknown): unknown; error(request: unknown, code: string, message: string): unknown}>;
export function registerBackupRetentionPreviewRoute(app: FastifyInstance, options: Options): void {
  app.post(`${options.prefix}/projects/:projectId/backups/retention/preview`,
    {bodyLimit: 16_384, preHandler: [options.requireAuth, options.requireRole]}, async (request, reply) => {
      const params = z.object({projectId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/)}).strict().safeParse(request.params);
      const body = backupRetentionPreviewRequestSchema.safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send(options.error(request, "VALIDATION_ERROR", "Request validation failed."));
      const projectId = params.data.projectId, user = request.auth?.user, context = request.correlationContext;
      if (!user || !context) return reply.code(401).send(options.error(request, "UNAUTHENTICATED", "Authentication required."));
      const access = options.access?.get(projectId), agentId = access?.agentId, deadlineMs = access?.deadlineMs, controller = new AbortController();
      const validDeadline = access && Number.isSafeInteger(access.deadlineMs) && access.deadlineMs > 0 && access.deadlineMs <= 60_000;
      const cancel = () => controller.abort(), timer = setTimeout(cancel, validDeadline ? access.deadlineMs : 60_000);
      request.raw.once("aborted", cancel); if (request.raw.aborted) cancel();
      const audit = async (action: string, metadata: Record<string, unknown>) => {
        try { await awaitAbortable(() => options.audit.append({actorUserId: user.id, action, targetType: "project", targetId: projectId,
          ...context, metadata: {projectId, ...metadata}}), controller.signal); return true; } catch { return false; }
      };
      const fail = async (status: number, code: string, reason: string) => {
        const audited = await audit("backup.retention.preview.rejected", {reason});
        return reply.code(audited ? status : 503).send(options.error(request, audited ? code : "BACKUP_RETENTION_UNAVAILABLE", "Backup retention preview is unavailable or outside policy."));
      };
      try {
        const decision = new PolicyEvaluator().evaluate({actorId: user.id, role: user.role, action: "project.update", scope: {kind: "project", projectId},
          correlationId: context.correlationId, grants: await awaitAbortable(() => options.grants.listForActor(user.id), controller.signal)});
        if (!decision.allowed) return await fail(403, decision.code, "permission-denied");
        const project = await awaitAbortable(() => options.projects.findById(projectId), controller.signal);
        if (!project) return await fail(404, "NOT_FOUND", "project-not-found");
        if (project.id !== projectId || !access || !validDeadline || !agentId || !/^[A-Za-z0-9_-]{1,200}$/.test(agentId)) return await fail(503, "BACKUP_RETENTION_UNAVAILABLE", "access-unavailable");
        const configuredInventory = access.inventory, factory = options.inventoryFactory;
        const inventory = configuredInventory ?? factory?.(agentId), protections = access.protections;
        if (!inventory) return await fail(503, "BACKUP_RETENTION_UNAVAILABLE", "inventory-unavailable");
        const current = () => options.access?.get(projectId) === access && access.inventory === configuredInventory
          && access.agentId === agentId && access.deadlineMs === deadlineMs && access.protections === protections
          && options.inventoryFactory === factory && inventory.available() && protections.available();
        const plan = await prepareBackupRetentionPreview(projectId, body.data, {expectedAgentId: agentId,
          inventory: {available: () => current() && inventory.available(), list: (...args) => inventory.list(...args)},
          protections: {available: () => current() && protections.available(), list: (...args) => protections.list(...args)}}, controller.signal);
        if (!current()) return await fail(503, "BACKUP_RETENTION_UNAVAILABLE", "access-changed");
        if (!await audit("backup.retention.preview", {inventoryDigest: plan.inventoryDigest, planDigest: plan.planDigest,
          retainedCount: plan.retainedArchiveIds.length, candidateCount: plan.deletionCandidates.length})) return await fail(503, "BACKUP_RETENTION_UNAVAILABLE", "audit-unavailable");
        if (!current() || controller.signal.aborted) return await fail(503, "BACKUP_RETENTION_UNAVAILABLE", "access-changed");
        return options.ok(request, {plan});
      } catch (error) {
        const stale = error instanceof BackupRetentionPreviewError && ["stale-inventory", "stale-protection"].includes(error.code);
        return await fail(stale ? 409 : 503, stale ? "BACKUP_RETENTION_STALE" : "BACKUP_RETENTION_UNAVAILABLE", stale ? error.code : "unavailable");
      } finally { clearTimeout(timer); request.raw.off("aborted", cancel); }
    });
}
