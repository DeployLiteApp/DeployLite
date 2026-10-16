import type { FastifyInstance } from "fastify";
import {z} from "zod";
import { managedDatabaseRuntimePreparationSchema, managedDatabaseRestoreSelectionSchema, managedDatabaseRestorePreparationSchema } from "@deploylite/contracts";
import { awaitAbortable, planManagedDatabaseProfile, PolicyEvaluator, selectManagedDatabaseRestoreInventory } from "@deploylite/domain";
import { applyManagedDatabaseRestore, type ManagedDatabaseRestoreApplyAccess } from "./managed-database-restore-apply.js";
import type { ManagedDatabaseRuntimePreviewOptions } from "./managed-database-runtime-preview.js";
export type ManagedDatabaseRestoreApplyRouteOptions = Omit<ManagedDatabaseRuntimePreviewOptions, "audit"> & Readonly<{
  executions?: ReadonlyMap<string, ManagedDatabaseRestoreApplyAccess>;
}>;
const paramsSchema = managedDatabaseRuntimePreparationSchema.pick({ projectId: true, databaseId: true }).strict();
const bodySchema = managedDatabaseRestoreSelectionSchema.omit({ projectId: true, databaseId: true }).extend({confirmationId:z.string().regex(/^[A-Za-z0-9_-]{1,200}$/)}).strict();
/** Public selectors resolve only through server inventory; the original protected nonce owns one effect. */
export function registerManagedDatabaseRestoreApplyRoute(app: FastifyInstance, options: ManagedDatabaseRestoreApplyRouteOptions): void {
  app.post(`${options.prefix}/projects/:projectId/databases/:databaseId/runtime/restore/apply`, {
    bodyLimit: 16384, preHandler: [options.requireAuth, options.requireRole]
  }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params), body = bodySchema.safeParse(request.body), key = request.headers["idempotency-key"];
    const reject = (status: number, code: string) => reply.code(status).send(options.error(request, code, "Database confirmed restore is unavailable or outside policy."));
    if (!params.success || !body.success || typeof key !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(key)) return reject(400, "VALIDATION_ERROR");
    const user = request.auth?.user, context = request.correlationContext;
    if (!user || !context) return reject(401, "UNAUTHENTICATED");
    const {confirmationId,...sourceBody}=body.data;
    const parsed = managedDatabaseRestoreSelectionSchema.safeParse({ ...params.data, ...sourceBody });
    if (!parsed.success) return reject(400, "VALIDATION_ERROR");
    const preparation = parsed.data, execution = options.executions?.get(preparation.projectId);
    const profileInput = { schemaVersion: preparation.schemaVersion, projectId: preparation.projectId, databaseId: preparation.databaseId, engine: preparation.engine };
    const validDeadline = Number.isSafeInteger(execution?.deadlineMs) && execution!.deadlineMs > 0 && execution!.deadlineMs <= 60000;
    const controller = new AbortController(), cancel = () => controller.abort();
    const timer = setTimeout(cancel, validDeadline ? execution!.deadlineMs : 60000);
    request.raw.once("aborted", cancel); if (request.raw.aborted) cancel();
    const bounded = <T>(work: () => Promise<T>) => awaitAbortable(work, controller.signal);
    const authorize = async () => new PolicyEvaluator().evaluate({ actorId: user.id, role: user.role, action: "project.update",
      scope: { kind: "project", projectId: preparation.projectId }, correlationId: context.correlationId,
      grants: await bounded(() => options.grants.listForActor(user.id)) }).allowed;
    try {
      if (!await authorize()) return reject(403, "FORBIDDEN");
      if (!execution || !validDeadline) return reject(503, "DATABASE_RUNTIME_UNAVAILABLE");
      const project = await bounded(() => options.projects.findById(preparation.projectId));
      if (!project) return reject(404, "NOT_FOUND");
      if (project.id !== preparation.projectId) return reject(503, "DATABASE_RUNTIME_UNAVAILABLE");
      let privateCurrent = () => true;
      const current = () => !controller.signal.aborted && options.executions?.get(preparation.projectId) === execution && privateCurrent();
      const admit = async () => {
        const configuration = options.configuration, projectIds = configuration?.projectIds;
        const profile = configuration?.profiles.get(preparation.engine), policy = structuredClone(options.imagePolicy);
        if (!configuration || (projectIds !== undefined && !projectIds.has(preparation.projectId)) || !profile) throw new Error("unavailable");
        const plan = planManagedDatabaseProfile(profileInput, profile, policy);
        if (plan.planDigest !== preparation.planDigest || plan.profileId !== preparation.profileId) throw new Error("stale");
        privateCurrent = () => {
          try { return options.configuration === configuration && configuration.projectIds === projectIds && (projectIds === undefined || projectIds.has(preparation.projectId))
            && configuration.profiles.get(preparation.engine) === profile
            && planManagedDatabaseProfile(profileInput, profile, options.imagePolicy).planDigest === preparation.planDigest; } catch { return false; }
        };
        if (!current() || !await authorize() || !current()) throw new Error("unavailable");

      };
      const list=execution.inventory.list,available=execution.inventory.available,clock=execution.now;
      const start=clock.call(execution);let lastNow=start;
      const selected=await bounded(()=>selectManagedDatabaseRestoreInventory(preparation,{
        expectedAgentId:execution.agentId,
        clock:{now:()=>{const now=clock.call(execution);if(!Number.isSafeInteger(now)||now<lastNow||now>=start+execution.deadlineMs||!current()||execution.now!==clock)throw new Error("unavailable");lastNow=now;return now;}},
        inventory:{available:()=>current()&&execution.inventory.list===list&&execution.inventory.available===available&&available.call(execution.inventory),list:async(...args)=>{
          if(!current()||!await authorize()||!current())throw new Error("unavailable");
          const rows=await bounded(()=>list.call(execution.inventory,...args));
          if(!current()||execution.inventory.list!==list||!await authorize()||!current())throw new Error("unavailable");return rows;
        }}},controller.signal));
      const {action:_action,scope:_scope,operation:_operation,...source}=selected;
      const verified=managedDatabaseRestorePreparationSchema.parse(source);
      const outcome = await applyManagedDatabaseRestore(execution, { preparation:verified, confirmationId, actorId: user.id, idempotencyKey: key, context,
        authorize, current, admit, signal: controller.signal });
      const { id, status, action, scope, inputDigest, idempotencyKey, correlationId, expiresAt } = outcome.command;
      return options.ok(request, { ...outcome, command: { id, status, action, scope, inputDigest, idempotencyKey, correlationId, expiresAt } });
    } catch { return reject(503, "DATABASE_RUNTIME_UNAVAILABLE"); }
    finally { clearTimeout(timer); request.raw.off("aborted", cancel); }
  });
}
