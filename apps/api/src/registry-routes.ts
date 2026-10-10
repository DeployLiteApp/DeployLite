import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { registryCredentialKey, REGISTRY_SECRET_PREFIX, ENCRYPTION_KEY_VERSION, type EnvSecretCipher } from '@deploylite/config';
import { PolicyEvaluator, type AuditRepository, type CanonicalRoleName, type ControlGrantRepository, type EnvSecretValueRepository, type ProjectRepository } from '@deploylite/domain';
import { z } from 'zod';
import { registryConfigurationSchema } from '@deploylite/contracts';

type Options = Readonly<{ prefix: string; projects: Pick<ProjectRepository, 'findById'>; secrets: EnvSecretValueRepository;
  cipher?: EnvSecretCipher; trustedHosts: readonly string[]; grants: Pick<ControlGrantRepository, 'listForActor'>;
  audit: Pick<AuditRepository, 'append'>; requireAuth: preHandlerAsyncHookHandler; requireRole: preHandlerAsyncHookHandler;
  ok(request: unknown, data: unknown): unknown; error(request: unknown, code: string, message: string): unknown }>;
type Request = FastifyRequest & { auth?: { user: { id: string; role: CanonicalRoleName } };
  correlationContext?: { requestId: string; correlationId: string } };
const paramsSchema = z.object({ projectId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/) }).strict();
const configurationSchema = registryConfigurationSchema;
const prefix = REGISTRY_SECRET_PREFIX;
const key = registryCredentialKey;

/** Application-scoped configuration uses the existing cipher and secret repository; no daemon login or credential output. */
export function registerRegistryRoutes(app: FastifyInstance, options: Options): void {
  const path = `${options.prefix}/projects/:projectId/registries`;
  for (const method of ['GET', 'PUT'] as const) app.route({ method, url: path, preHandler: [options.requireAuth, options.requireRole],
    handler: async (raw, reply) => {
      const request = raw as Request, auth = request.auth, context = request.correlationContext;
      const fail = (status: number, code: string) => reply.code(status).send(options.error(request, code, 'Registry configuration is unavailable.'));
      if (!auth || !context) return fail(401, 'UNAUTHENTICATED');
      const params = paramsSchema.safeParse(request.params); if (!params.success) return fail(400, 'VALIDATION_ERROR');
      const projectId = params.data.projectId;
      try {
        const grants = await options.grants.listForActor(auth.user.id);
        const decision = new PolicyEvaluator().evaluate({ actorId: auth.user.id, role: auth.user.role, action: 'project.update',
          scope: { kind: 'project', projectId }, correlationId: context.correlationId, grants });
        if (!decision.allowed) return fail(403, decision.code);
        if (!await options.projects.findById(projectId)) return fail(404, 'NOT_FOUND');
        if (!options.cipher) return fail(503, 'SECRET_KEY_UNAVAILABLE');
        if (method === 'GET') {
          const rows = await options.secrets.listEncryptedByProject(projectId);
          const registries = rows.filter(row => row.scope === 'project' && row.key.startsWith(prefix)).map(row => {
            const stored = configurationSchema.parse(JSON.parse(options.cipher!.decrypt(Buffer.from(row.encryptedValue).toString('base64'))));
            if (row.key !== key(stored.registryHost) || !options.trustedHosts.includes(stored.registryHost)) throw new Error('Invalid stored registry configuration');
            return { registryHost: stored.registryHost, authenticationConfigured: Boolean(stored.username && stored.password) };
          });
          return options.ok(request, { registries });
        }
        const body = configurationSchema.safeParse(request.body);
        if (!body.success || !options.trustedHosts.includes(body.data.registryHost)) return fail(400, 'VALIDATION_ERROR');
        const stored = { registryHost: body.data.registryHost, ...(body.data.username ? { username: body.data.username, password: body.data.password } : {}) };
        const bytes = JSON.stringify(stored), encryptedValue = Buffer.from(options.cipher.encrypt(bytes), 'base64');
        // A durable authorization audit is required before a secret write; failures never reflect submitted values.
        await options.audit.append({ actorUserId: auth.user.id, action: 'registry.configuration.write_authorized', targetType: 'project', targetId: projectId,
          requestId: context.requestId, correlationId: context.correlationId,
          metadata: { registryHost: stored.registryHost, authenticationConfigured: Boolean(stored.username), redacted: true } });
        await options.secrets.upsert({ projectId, key: key(stored.registryHost), scope: 'project', encryptedValue,
          valueFingerprint: options.cipher.fingerprint(bytes), keyVersion: ENCRYPTION_KEY_VERSION });
        return options.ok(request, { registry: { registryHost: stored.registryHost, authenticationConfigured: Boolean(stored.username) } });
      } catch { return fail(503, 'REGISTRY_CONFIGURATION_UNAVAILABLE'); }
    }
  });
}
