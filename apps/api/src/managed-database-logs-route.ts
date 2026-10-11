import type {FastifyInstance} from "fastify";
import {managedDatabaseRuntimePreparationSchema, managedDatabaseLogsPreparationSchema} from "@deploylite/contracts";
import {awaitAbortable, planManagedDatabaseProfile, PolicyEvaluator} from "@deploylite/domain";
import {observeManagedDatabaseLogs, type ManagedDatabaseLogsAccess} from "./managed-database-logs.js";
import type {ManagedDatabaseRuntimePreviewOptions} from "./managed-database-runtime-preview.js";
export type ManagedDatabaseLogsRouteOptions = Omit<ManagedDatabaseRuntimePreviewOptions, "audit"> & Readonly<{executions?: ReadonlyMap<string, ManagedDatabaseLogsAccess>}>;
const paramsSchema = managedDatabaseRuntimePreparationSchema.pick({projectId: true, databaseId: true}).strict();
const bodySchema = managedDatabaseLogsPreparationSchema.innerType().omit({projectId: true, databaseId: true}).strict();
/** Existing authenticated project authorization; logs never read private environment or mutate commands. */
export function registerManagedDatabaseLogsRoute(app: FastifyInstance, options: ManagedDatabaseLogsRouteOptions): void {
  app.post(`${options.prefix}/projects/:projectId/databases/:databaseId/runtime/logs`, {bodyLimit: 16384, preHandler: [options.requireAuth, options.requireRole]}, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params), body = bodySchema.safeParse(request.body);
    const reject = (status: number, code: string) => reply.code(status).send(options.error(request, code, "Database logs is unavailable or outside policy."));
    if (!params.success || !body.success) return reject(400, "VALIDATION_ERROR");
    const user = request.auth?.user, context = request.correlationContext;
    if (!user || !context) return reject(401, "UNAUTHENTICATED");
    const parsed = managedDatabaseLogsPreparationSchema.safeParse({...params.data, ...body.data});
    if (!parsed.success) return reject(400, "VALIDATION_ERROR");
    const preparation = parsed.data, execution = options.executions?.get(preparation.projectId);
    const profileInput = {schemaVersion: preparation.schemaVersion, projectId: preparation.projectId, databaseId: preparation.databaseId, engine: preparation.engine};
    const validDeadline = Number.isSafeInteger(execution?.deadlineMs) && execution!.deadlineMs > 0 && execution!.deadlineMs <= 60000;
    const controller = new AbortController(), cancel = () => controller.abort(), timer = setTimeout(cancel, validDeadline ? execution!.deadlineMs : 60000);
    request.raw.once("aborted", cancel); if (request.raw.aborted) cancel();
    const bounded = <T>(work: () => Promise<T>) => awaitAbortable(work, controller.signal);
    const authorize = async () => new PolicyEvaluator().evaluate({actorId: user.id, role: user.role, action: "project.update", scope: {kind: "project", projectId: preparation.projectId},
      correlationId: context.correlationId, grants: await bounded(() => options.grants.listForActor(user.id))}).allowed;
    try {
      if (!await authorize()) return reject(403, "FORBIDDEN");
      if (!execution || !validDeadline) return reject(503, "DATABASE_RUNTIME_UNAVAILABLE");
      const project = await bounded(() => options.projects.findById(preparation.projectId));
      if (!project) return reject(404, "NOT_FOUND"); if (project.id !== preparation.projectId) return reject(503, "DATABASE_RUNTIME_UNAVAILABLE");
      let privateCurrent = () => true;
      const current = () => !controller.signal.aborted && options.executions?.get(preparation.projectId) === execution && privateCurrent();
      const admit = async () => {
        const configuration = options.configuration, projectIds = configuration?.projectIds, profile = configuration?.profiles.get(preparation.engine), policy = structuredClone(options.imagePolicy);
        if (!configuration || projectIds !== undefined && !projectIds.has(preparation.projectId) || !profile) throw new Error("unavailable");
        const plan = planManagedDatabaseProfile(profileInput, profile, policy);
        if (plan.planDigest !== preparation.planDigest || plan.profileId !== preparation.profileId) throw new Error("stale");
        privateCurrent = () => {
          try {return options.configuration === configuration && configuration.projectIds === projectIds && (projectIds === undefined || projectIds.has(preparation.projectId)) &&
            configuration.profiles.get(preparation.engine) === profile && planManagedDatabaseProfile(profileInput, profile, options.imagePolicy).planDigest === preparation.planDigest;}
          catch {return false;}
        };
        if (!current() || !await authorize() || !current()) throw new Error("unavailable");
      };
      const observation = await observeManagedDatabaseLogs(execution, {preparation, context, authorize, current, admit, signal: controller.signal});
      return options.ok(request, {observation});
    } catch {return reject(503, "DATABASE_RUNTIME_UNAVAILABLE");}
    finally {clearTimeout(timer); request.raw.off("aborted", cancel);}
  });
}
