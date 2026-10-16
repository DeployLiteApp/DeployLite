import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { BackupRetentionPreviewError, PolicyEvaluator, awaitAbortable, digestControlInput, planManagedDatabaseProfile, prepareBackupRetentionPreview, type AuditRepository, type BackupInventoryReader, type BackupRetentionProtectionReader, type ControlGrantRepository, type ProjectRepository } from "@deploylite/domain";
import { backupInventoryReceiptSchema, backupRetentionPreviewRequestSchema, composeVolumeBackupPlanningProfileSchema, managedDatabaseProfileRequestSchema, type ImageReferencePolicyV1 } from "@deploylite/contracts";
import { z } from "zod";
import type {ManagedDatabaseCredentialConfiguration} from "./managed-database-credentials-route.js";
import type {ComposeVolumeBackupPlanAccess} from "./compose-volume-backup-plan-route.js";
export type BackupRetentionPreviewAccess = Readonly<{agentId: string; inventory?: BackupInventoryReader; protections: BackupRetentionProtectionReader; deadlineMs: number;
  native?: Readonly<{configuration: ManagedDatabaseCredentialConfiguration; imagePolicy: ImageReferencePolicyV1; planning: ReadonlyMap<string, ComposeVolumeBackupPlanAccess>}>;
}>;
type Options = Readonly<{prefix: string; projects: ProjectRepository; grants: ControlGrantRepository; audit: AuditRepository;
  access?: ReadonlyMap<string, BackupRetentionPreviewAccess>; configuredAccess?: ReadonlyMap<string, BackupRetentionPreviewAccess>; inventoryFactory?: (agentId: string) => BackupInventoryReader;
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
      const selectedAccess = () => options.access?.get(projectId) ?? options.configuredAccess?.get(projectId);
      const access = selectedAccess(), agentId = access?.agentId, deadlineMs = access?.deadlineMs, controller = new AbortController();
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
        const authorize = async () => new PolicyEvaluator().evaluate({actorId: user.id, role: user.role, action: "project.update", scope: {kind: "project", projectId},
          correlationId: context.correlationId, grants: await awaitAbortable(() => options.grants.listForActor(user.id), controller.signal)});
        const decision = await authorize();
        if (!decision.allowed) return await fail(403, decision.code, "permission-denied");
        const project = await awaitAbortable(() => options.projects.findById(projectId), controller.signal);
        if (!project) return await fail(404, "NOT_FOUND", "project-not-found");
        if (project.id !== projectId || !access || !validDeadline || !agentId || !/^[A-Za-z0-9_-]{1,200}$/.test(agentId)) return await fail(503, "BACKUP_RETENTION_UNAVAILABLE", "access-unavailable");
        const configuredInventory = access.inventory, factory = options.inventoryFactory;
        const inventory = configuredInventory ?? factory?.(agentId), protections = access.protections;
        if (!inventory) return await fail(503, "BACKUP_RETENTION_UNAVAILABLE", "inventory-unavailable");
        const inventoryList = inventory.list, inventoryAvailable = inventory.available, protectionList = protections.list, protectionAvailable = protections.available;
        const native = access.native;
        let nativeCurrent = () => true;
        let validateInventory = (_rows: readonly unknown[]) => {};
        if (native) {
          if (!body.data.volumeKey.startsWith("db-")) throw new Error("unavailable");
          const databaseId = managedDatabaseProfileRequestSchema.shape.databaseId.parse(body.data.volumeKey.slice(3));
          const configuration = native.configuration, profiles = configuration.profiles, projectIds = configuration.projectIds;
          const policy = native.imagePolicy, planning = native.planning, destinationAccess = planning.get(projectId);
          const destinationProfiles = destinationAccess?.profiles, destinationStore = destinationAccess?.store;
          const destination = destinationProfiles?.get(body.data.destinationId), parsedDestination = composeVolumeBackupPlanningProfileSchema.parse(destination);
          if (!projectIds?.has(projectId) || configuration.deadlineMs !== deadlineMs || !destinationAccess || !destinationStore?.available()
            || parsedDestination.owner !== "deploylite" || parsedDestination.agentId !== agentId || parsedDestination.projectId !== projectId
            || parsedDestination.destinationId !== body.data.destinationId || parsedDestination.maxDurationMs < deadlineMs!) throw new Error("unavailable");
          const plans = new Map([...profiles].map(([engine, profile]) => [engine, planManagedDatabaseProfile({schemaVersion: 1, projectId, databaseId, engine}, profile, policy)]));
          const profilesDigest = digestControlInput([...profiles]), policyDigest = digestControlInput(policy), destinationDigest = digestControlInput(destination);
          const storeAvailable = destinationStore.available;
          nativeCurrent = () => {
            try {return access.native === native && native.configuration === configuration && native.imagePolicy === policy && native.planning === planning
              && configuration.profiles === profiles && configuration.projectIds === projectIds && projectIds.has(projectId) && configuration.deadlineMs === deadlineMs
              && digestControlInput([...profiles]) === profilesDigest && digestControlInput(policy) === policyDigest
              && planning.get(projectId) === destinationAccess && destinationAccess.profiles === destinationProfiles && destinationAccess.store === destinationStore
              && destinationStore.available === storeAvailable && storeAvailable.call(destinationStore)
              && destinationProfiles?.get(body.data.destinationId) === destination && digestControlInput(destination) === destinationDigest;
            } catch {return false;}
          };
          const recordSchema = z.object({schemaVersion: z.literal(1), receipt: backupInventoryReceiptSchema, createdAtMs: z.number().int().safe().nonnegative()}).strict();
          validateInventory = rows => {
            for (const raw of rows) {
              const row = recordSchema.parse(raw), receipt = row.receipt;
              if (receipt.action === "database.runtime.backup") {
                const plan = plans.get(receipt.engine);
                if (!plan || receipt.databaseId !== databaseId || receipt.profileId !== plan.profileId || receipt.planDigest !== plan.planDigest
                  || row.createdAtMs < receipt.observedAt) throw new Error("unavailable");
              }
            }
          };
        }
        const current = () => selectedAccess() === access && access.inventory === configuredInventory
          && access.agentId === agentId && access.deadlineMs === deadlineMs && access.protections === protections
          && options.inventoryFactory === factory && inventory.list === inventoryList && inventory.available === inventoryAvailable
          && protections.list === protectionList && protections.available === protectionAvailable
          && access.native === native && inventoryAvailable.call(inventory) && protectionAvailable.call(protections) && nativeCurrent();
        const fence = async () => {if (!current() || controller.signal.aborted || !(await authorize()).allowed || !current() || controller.signal.aborted) throw new Error("unavailable");};
        await fence();
        const ports = {expectedAgentId: agentId,
          inventory: {available: current, list: async (...args: [string, string, string]) => {await fence(); const rows = await inventoryList.call(inventory, ...args); await fence(); validateInventory(rows); return rows;}},
          protections: {available: current, list: async (...args: [string, string, string]) => {await fence(); const ids = await protectionList.call(protections, ...args); await fence(); return ids;}}};
        const plan = await prepareBackupRetentionPreview(projectId, body.data, ports, controller.signal);
        await fence();
        if (!await audit("backup.retention.preview", {inventoryDigest: plan.inventoryDigest, planDigest: plan.planDigest,
          retainedCount: plan.retainedArchiveIds.length, candidateCount: plan.deletionCandidates.length})) return await fail(503, "BACKUP_RETENTION_UNAVAILABLE", "audit-unavailable");
        await fence();
        const finalPlan = await prepareBackupRetentionPreview(projectId, {...body.data, expectedInventoryDigest: plan.inventoryDigest}, ports, controller.signal);
        if (finalPlan.planDigest !== plan.planDigest) throw new BackupRetentionPreviewError("stale-protection");
        await fence();
        return options.ok(request, {plan});
      } catch (error) {
        const stale = error instanceof BackupRetentionPreviewError && ["stale-inventory", "stale-protection"].includes(error.code);
        return await fail(stale ? 409 : 503, stale ? "BACKUP_RETENTION_STALE" : "BACKUP_RETENTION_UNAVAILABLE", stale ? error.code : "unavailable");
      } finally { clearTimeout(timer); request.raw.off("aborted", cancel); }
    });
}
