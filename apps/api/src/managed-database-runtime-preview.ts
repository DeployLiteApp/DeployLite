import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import type { EnvSecretCipher } from "@deploylite/config";
import { managedDatabaseProfileRequestSchema, managedDatabaseRuntimePreparationSchema, type ImageReferencePolicyV1 } from "@deploylite/contracts";
import { awaitAbortable, digestControlInput, managedDatabaseCredentialKey, materializeManagedDatabaseRuntime, planManagedDatabaseProfile, PolicyEvaluator,
  type ManagedDatabaseCredentialCreationRepository, type ProjectRepository, type ControlGrantRepository, type AuditRepository } from "@deploylite/domain";
import type { ManagedDatabaseCredentialConfiguration } from "./managed-database-credentials-route.js";
export type ManagedDatabaseRuntimePreviewOptions = Readonly<{
  prefix: string; configuration?: ManagedDatabaseCredentialConfiguration; secrets?: ManagedDatabaseCredentialCreationRepository;
  cipher?: EnvSecretCipher; imagePolicy: ImageReferencePolicyV1; projects: Pick<ProjectRepository, "findById">;
  grants: Pick<ControlGrantRepository, "listForActor">; audit: Pick<AuditRepository, "append">;
  requireAuth: preHandlerAsyncHookHandler; requireRole: preHandlerAsyncHookHandler;
  ok(request: unknown, data: unknown): unknown; error(request: unknown, code: string, message: string): unknown;
}>;
const paramsSchema = managedDatabaseProfileRequestSchema.pick({ projectId: true, databaseId: true }).strict();
const bodySchema = managedDatabaseProfileRequestSchema.pick({ schemaVersion: true, engine: true }).strict();
/** Effect-free native preparation over existing encrypted credentials; never creates or exposes values. */
export function registerManagedDatabaseRuntimePreviewRoute(app: FastifyInstance, options: ManagedDatabaseRuntimePreviewOptions): void {
  app.post(`${options.prefix}/projects/:projectId/databases/:databaseId/runtime/preview`, {
    bodyLimit: 16384, preHandler: [options.requireAuth, options.requireRole]
  }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params), body = bodySchema.safeParse(request.body);
    const reject = (status: number, code: string) => reply.code(status).send(options.error(request, code, "Database runtime preparation is unavailable or outside policy."));
    if (!params.success || !body.success) return reject(400, "VALIDATION_ERROR");
    const user = request.auth?.user, context = request.correlationContext;
    if (!user || !context) return reject(401, "UNAUTHENTICATED");
    const input = { ...params.data, ...body.data }, configuration = options.configuration;
    const deadline = configuration?.deadlineMs;
    const validDeadline = Number.isSafeInteger(deadline) && deadline! > 0 && deadline! <= 60000;
    const controller = new AbortController(), cancel = () => controller.abort();
    const timer = setTimeout(cancel, validDeadline ? deadline : 60000);
    request.raw.once("aborted", cancel); if (request.raw.aborted) cancel();
    const bounded = <T>(work: () => Promise<T>) => awaitAbortable(work, controller.signal);
    const authorized = async () => new PolicyEvaluator().evaluate({ actorId: user.id, role: user.role, action: "project.update",
      scope: { kind: "project", projectId: input.projectId }, correlationId: context.correlationId,
      grants: await bounded(() => options.grants.listForActor(user.id)) }).allowed;
    try {
      if (!await authorized()) return reject(403, "FORBIDDEN");
      const project = await bounded(() => options.projects.findById(input.projectId));
      if (!project) return reject(404, "NOT_FOUND");
      const profile = configuration?.profiles.get(input.engine), store = configuration?.store ?? options.secrets, cipher = options.cipher;
      if (project.id !== input.projectId || !configuration || !validDeadline || !profile || !store || !cipher) return reject(503, "DATABASE_RUNTIME_UNAVAILABLE");
      const policy = structuredClone(options.imagePolicy), plan = planManagedDatabaseProfile(input, profile, policy);
      const current = () => {
        try { return !controller.signal.aborted && options.configuration === configuration && configuration.deadlineMs === deadline
          && configuration.profiles.get(input.engine) === profile && (configuration.store ?? options.secrets) === store && options.cipher === cipher
          && digestControlInput(options.imagePolicy) === digestControlInput(policy)
          && planManagedDatabaseProfile(input, profile, policy).planDigest === plan.planDigest; } catch { return false; }
      };
      if (!current() || !await authorized() || !current()) return reject(503, "DATABASE_RUNTIME_UNAVAILABLE");
      const row = await bounded(() => store.find(input.projectId, managedDatabaseCredentialKey(input.projectId, input.databaseId)));
      if (!row || !current()) return reject(503, "DATABASE_RUNTIME_UNAVAILABLE");
      const runtime = materializeManagedDatabaseRuntime(input, profile, { imagePolicy: policy, cipher, credentials: row });
      const preparation = managedDatabaseRuntimePreparationSchema.parse({ ...input, profileId: plan.profileId,
        planDigest: plan.planDigest, environmentFingerprint: runtime.environmentFingerprint });
      if (!current() || !await authorized() || !current()) return reject(503, "DATABASE_RUNTIME_UNAVAILABLE");
      await bounded(() => options.audit.append({ actorUserId: user.id, action: "database.runtime.previewed", targetType: "project", targetId: input.projectId,
        ...context, metadata: { ...preparation, redacted: true } }));
      if (!current() || !await authorized() || !current()) return reject(503, "DATABASE_RUNTIME_UNAVAILABLE");
      return options.ok(request, { preparation, plan, credentialRef: { secretRefId: row.id, redacted: true } });
    } catch { return reject(503, "DATABASE_RUNTIME_UNAVAILABLE"); }
    finally { clearTimeout(timer); request.raw.off("aborted", cancel); }
  });
}
