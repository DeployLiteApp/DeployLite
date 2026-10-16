import type {FastifyInstance} from "fastify";
import {z} from "zod";
import {backupInventoryReceiptSchema, composeVolumeBackupPlanningProfileSchema, managedDatabaseBackupReceiptSchema, managedDatabaseProfileRequestSchema} from "@deploylite/contracts";
import {awaitAbortable, digestControlInput, PolicyEvaluator, type AuditEventInput, type BackupInventoryReader} from "@deploylite/domain";
import type {ManagedDatabaseBackupAccess} from "./managed-database-backup.js";
import type {ManagedDatabaseRuntimePreviewOptions} from "./managed-database-runtime-preview.js";
import type {ComposeVolumeBackupPlanAccess} from "./compose-volume-backup-plan-route.js";

type Access = Pick<ManagedDatabaseBackupAccess, "agentId" | "now" | "deadlineMs" | "maxBytes"> & Readonly<{
  inventory: Pick<BackupInventoryReader, "available"> & Partial<Pick<BackupInventoryReader, "list">>;
}>;
type Planning = Pick<ComposeVolumeBackupPlanAccess, "profiles"> & Readonly<{store: Pick<ComposeVolumeBackupPlanAccess["store"], "available">}>;
export type ManagedDatabaseBackupsRouteOptions = Pick<ManagedDatabaseRuntimePreviewOptions,
  "prefix" | "projects" | "grants" | "requireAuth" | "requireRole" | "ok" | "error"> & Readonly<{
  executions?: ReadonlyMap<string, Access>;
  planning?: ReadonlyMap<string, Planning>;
  audit: Readonly<{append(event: AuditEventInput): Promise<unknown>}>;
}>;
const paramsSchema = managedDatabaseProfileRequestSchema.pick({projectId: true, databaseId: true}).strict();
const querySchema = z.object({destinationId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).optional()}).strict();
const recordSchema = z.object({schemaVersion: z.literal(1), receipt: backupInventoryReceiptSchema,
  createdAtMs: z.number().int().safe().nonnegative()}).strict();
const nativeRecordSchema = recordSchema.extend({receipt: managedDatabaseBackupReceiptSchema});

/** Existing inventory and destination ports; this view grants no backup or restore effect. */
export function registerManagedDatabaseBackupsRoute(app: FastifyInstance, options: ManagedDatabaseBackupsRouteOptions): void {
  app.get(`${options.prefix}/projects/:projectId/databases/:databaseId/backups`, {
    preHandler: [options.requireAuth, options.requireRole]
  }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params), query = querySchema.safeParse(request.query);
    const reject = (status: number, code: string) => reply.code(status).send(options.error(request, code, "Database backups could not be read."));
    if (!params.success || !query.success || request.body !== undefined) return reject(400, "VALIDATION_ERROR");
    const user = request.auth?.user, context = request.correlationContext;
    if (!user || !context) return reject(401, "UNAUTHENTICATED");
    const expectedActor = request.headers["x-deploylite-expected-actor-id"];
    if (expectedActor !== undefined && expectedActor !== user.id) return reject(409, "ACTOR_CHANGED");
    const {projectId, databaseId} = params.data, destinationId = query.data.destinationId;
    const execution = options.executions?.get(projectId), planning = options.planning?.get(projectId);
    const deadlineMs = execution?.deadlineMs, validDeadline = Number.isSafeInteger(deadlineMs) && deadlineMs! > 0 && deadlineMs! <= 60000;
    const controller = new AbortController(), cancel = () => controller.abort();
    const timer = setTimeout(cancel, validDeadline ? deadlineMs : 60000);
    request.raw.once("aborted", cancel); if (request.raw.aborted) cancel();
    const bounded = <T>(work: () => Promise<T>) => awaitAbortable(work, controller.signal);
    const authorize = async () => new PolicyEvaluator().evaluate({actorId: user.id, role: user.role, action: "project.update",
      scope: {kind: "project", projectId}, correlationId: context.correlationId,
      grants: await bounded(() => options.grants.listForActor(user.id))}).allowed;
    const unavailable = (): never => {throw new Error("unavailable");};
    try {
      if (!await authorize()) return reject(403, "FORBIDDEN");
      const project = await bounded(() => options.projects.findById(projectId));
      if (!project) return reject(404, "NOT_FOUND");
      if (project.id !== projectId || !execution || !planning || !validDeadline
        || !/^[A-Za-z0-9_-]{1,200}$/.test(execution.agentId)) unavailable();
      const source = execution!, plan = planning!, inventory = source.inventory, profiles = plan.profiles, store = plan.store;
      const list = inventory.list, available = inventory.available, storeAvailable = store.available, clock = source.now;
      const agentId = source.agentId, maxBytes = z.number().int().safe().positive().parse(source.maxBytes);
      const start = clock.call(source), deadline = start + deadlineMs!; let lastNow = start;
      if (typeof list !== "function" || typeof available !== "function" || typeof storeAvailable !== "function"
        || !Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(deadline) || profiles.size > 10000) unavailable();
      const profileDigest = digestControlInput([...profiles]);
      const current = () => {
        const now = clock.call(source);
        if (controller.signal.aborted || !Number.isSafeInteger(now) || now < lastNow || now >= deadline
          || options.executions?.get(projectId) !== source || options.planning?.get(projectId) !== plan
          || source.inventory !== inventory || inventory.list !== list || inventory.available !== available
          || source.now !== clock || source.agentId !== agentId || source.maxBytes !== maxBytes || source.deadlineMs !== deadlineMs
          || plan.profiles !== profiles || digestControlInput([...profiles]) !== profileDigest || plan.store !== store || store.available !== storeAvailable
          || !available.call(inventory) || !storeAvailable.call(store)) unavailable();
        lastNow = now; return now;
      };
      const fence = async () => {current(); if (!await authorize()) unavailable(); current();};
      await fence();
      const destinations = [...profiles].map(([key, raw]) => {
        const profile = composeVolumeBackupPlanningProfileSchema.parse(raw);
        if (key !== profile.destinationId || profile.owner !== "deploylite" || profile.projectId !== projectId
          || profile.agentId !== agentId || deadlineMs! > profile.maxDurationMs) unavailable();
        return {destinationId: key, maxBytes: Math.min(maxBytes, profile.maxBytes)};
      }).sort((left, right) => left.destinationId.localeCompare(right.destinationId));
      if (!destinations.length || (destinationId !== undefined && !destinations.some(value => value.destinationId === destinationId))) unavailable();
      const read = async () => {
        await fence();
        if (!destinationId) return {backups: [], digest: digestControlInput([])};
        const rows = structuredClone(await bounded(() => list!.call(inventory, projectId, "db-" + databaseId, destinationId)));
        await fence(); if (rows.length > 10000) unavailable();
        const archives = new Set<string>(), commands = new Set<string>();
        const evidence = rows.map(raw => {
          const row = recordSchema.parse(raw), receipt = row.receipt;
          if (receipt.projectId !== projectId || receipt.volumeKey !== "db-" + databaseId
            || receipt.destinationId !== destinationId || receipt.agentId !== agentId
            || (receipt.action === "database.runtime.backup" && (receipt.databaseId !== databaseId || row.createdAtMs < receipt.observedAt))
            || row.createdAtMs > current() || archives.has(receipt.archiveId) || commands.has(receipt.commandId)) unavailable();
          archives.add(receipt.archiveId); commands.add(receipt.commandId); return row;
        }).sort((left, right) => left.receipt.commandId.localeCompare(right.receipt.commandId));
        const backups = evidence.filter(row => row.receipt.action === "database.runtime.backup").map(row => nativeRecordSchema.parse(row))
          .sort((left, right) => right.createdAtMs - left.createdAtMs || left.receipt.commandId.localeCompare(right.receipt.commandId));
        return {backups, digest: digestControlInput(evidence)};
      };
      const initial = await read(), backups = initial.backups;
      await bounded(() => options.audit.append({actorUserId: user.id, action: "database.backups.read", targetType: "project", targetId: projectId,
        ...context, metadata: {destinationId: destinationId ?? null, backupCount: backups.length, redacted: true}}));
      await fence(); if ((await read()).digest !== initial.digest) unavailable(); await fence();
      const response = options.ok(request, {destinations, backups});
      if (Buffer.byteLength(JSON.stringify(response), "utf8") > 2 * 1024 * 1024) unavailable();
      return response;
    } catch {return reject(503, "DATABASE_BACKUPS_UNAVAILABLE");}
    finally {clearTimeout(timer); request.raw.off("aborted", cancel);}
  });
}
