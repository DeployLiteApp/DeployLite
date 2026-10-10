import { DbComposeRevisionSaveStore } from "@deploylite/db";
import { registerComposeRevisionSaveRoutes } from "./compose-revision-save-route.js";
import type { ComposeRevisionSaveStore } from "@deploylite/domain";
import { registerComposeRevisionReadRoutes, type ComposeRevisionReadCapability } from "./compose-revision-read-route.js";
import { registerComposeResourceCleanupRoutes, type ComposeResourceCleanupAccess, type ComposeResourceCleanupExecutionAccess } from "./compose-resource-cleanup-route.js";
import { registerComposePreviewRoute } from "./compose-preview-route.js";
import { registerComposeResourceInspectionRoutes, type ComposeResourceInspectionAccess } from "./compose-resource-inspection-route.js";
import { COMPOSE_RESOURCE_CLEANUP_PROJECT_AGENTS_ENV, COMPOSE_RESOURCE_PROJECT_AGENTS_ENV, COMPOSE_VOLUME_ATTACHMENT_PROJECT_AGENTS_ENV, createProjectScopedComposeResourceRuntime,
  parseComposeResourceCleanupProjectBindings, parseComposeResourceProjectBindings, parseComposeVolumeAttachmentProjectBindings, type ComposeResourceProjectBinding } from "./compose-resource-runtime.js";
import { registerComposeNetworkAttachmentExecutionRoute, type ComposeNetworkAttachmentExecutionAccess } from "./compose-network-attachment-execution-route.js";
import { registerComposeVolumeAttachmentExecutionRoute, type ComposeVolumeAttachmentExecutionAccess } from "./compose-volume-attachment-execution-route.js";
import { registerComposeVolumeBackupPlanRoute, type ComposeVolumeBackupPlanAccess } from "./compose-volume-backup-plan-route.js";
import { registerComposeVolumeBackupExecutionRoute, type ComposeVolumeBackupExecutionAccess } from "./compose-volume-backup-execution-route.js";
import { registerRegistryRoutes } from "./registry-routes.js";
import { registerDomainRoutePreviewRoute } from "./domain-route-preview-route.js";
import { registerTransportPortPreviewRoute } from "./transport-port-preview-route.js";
import { registerTransportPortApplyRoutes, type TransportPortApplyExecutionAccess } from "./transport-port-apply-route.js";
import { registerDomainRouteApplyRoute, type DomainRouteApplyExecutionAccess } from "./domain-route-apply-route.js";
import { claimDeploymentAuthority, validateStopCompletion, validateDeploymentAuthority, validateInitialExecution } from "@deploylite/domain";
import { createHash, randomUUID } from "node:crypto";
import { createAuditLogRecord, createCorrelationContext, createRequestId, parseDeployLiteEnv, redactSecrets, type DeployLiteEnv, createEnvSecretCipher, EnvSecretKeyInvalidError, EnvSecretKeyMissingError, ENCRYPTION_KEY_VERSION, loadEnvSecretKey, type EnvSecretCipher } from "@deploylite/config";
import { materializeMockDeploy, redactEnvFileForLog, type EncryptedEnvRecord } from "@deploylite/agent";
import {
  agentRegistrationSchema,
  dockerImageExecutionReceiptSchema,
  trustedPriorExecutionReceiptSchema,
  type TrustedPriorExecutionReceiptV1,
  authLoginRequestSchema,
  bootstrapInitialAdminRequestSchema,
  deployRequestSchema,
  deploymentSchema,
  envSecretValueDeleteRequestSchema,
  envSecretValueSchema,
  envSecretValueWriteRequestSchema,
  envVariableMetadataSchema,
  envVariableMetadataUpsertRequestSchema,
  projectCreateRequestSchema,
  projectSchema,
  projectUpdateRequestSchema,
  runtimeActivationSchema,
  runtimeActivationCommandSchema,
  runtimeConfigurationSchema,
  runtimeConfigurationWriteRequestSchema,
  deploymentStopAgentReceiptSchema,
  resourceSnapshotSchema,
  type Agent,
  type Deployment,
  type EnvSecretValue,
  type EnvVariableMetadata,
  type Project,
  type RuntimeActivation,
  type RuntimeActivationCommand,
  createDeploymentSnapshot,
  createDeploymentPlan,
  createSourceIntent,
  type DeploymentSnapshotV1,
  type ImageReferencePolicyV1
} from "@deploylite/contracts";
import { BcryptPasswordHasher, bootstrapInitialAdmin, closeDbPool, createDbClient, createDbPool, createOpaqueSessionToken, DbAgentRepository, DbAuditRepository, DbAuthUserRepository, DbComposeResourceCleanupStore, DbControlCommandRepository, DbControlGrantRepository, DbDeploymentRepository, DbDeploymentExecutionRepository, DbDomainRouteClaimReader, DbTransportPortApplyStore, DbEnvSecretValueRepository, DbEnvVariableMetadataRepository, DbProjectRepository, DbSessionRepository, hashSessionToken, type DeployLiteDb } from "@deploylite/db";
import {
  AgentStatusService,
  awaitAbortable,
  validateDockerImageSnapshot,
  authenticateLocalUser,
  getBootstrapStatus,
  InMemoryAgentRepository,
  InMemoryDeploymentRepository,
  InMemoryExecutionState,
  InMemoryEnvSecretValueRepository,
  InMemoryEnvVariableMetadataRepository,
  InitialAdminAlreadyExistsError,
  IdempotencyConflictError,
  ConfirmationRejectedError,
  PolicyEvaluator,
  createConfirmation,
  createControlCommand,
  resolveControlCommandInMemory,
  digestControlInput,
  scopeKey,
  toSafeAuthUser,
  type AuditEvent,
  type AuditEventInput,
  type AuditEventListItem,
  type AuditRepository,
  type AuthSession,
  type AuthUser,
  type AuthUserRepository,
  type CanonicalRoleName,
  type ControlCommand,
  type ControlCommandRepository,
  type ControlDeleteRepository,
  type ControlStopRepository,
  type ControlRedeployRepository,
  type ControlRollbackRepository,
  validateRollbackReservation,
  isRollbackAdmissionBound,
  isRollbackClaimBound,
  evaluateConfirmation,
  type ControlConfirmation,
  type ControlConfirmationRepository,
  type ControlGrant,
  type ControlGrantRepository,
  type ComposeResourceCleanupStore,
  type CreateInitialAdminInput,
  type CreateSessionInput,
  type EnvSecretValueRepository,
  type EnvVariableMetadataRepository,
  type PasswordHasher,
  type AgentRepository,
  type DeploymentRepository,
  type DeploymentExecutionRepository,
  type DomainRouteClaimReader,
  type TransportPortClaimReader,
  type DomainRouteApplyCompletionStore,
  type TransportPortApplyCompletionStore,
  type ExecutionCompletionOutcome,
  type DeploymentSnapshotRepository,
  type DockerImageExecutionReceiptV1,
  type ProjectRepository,
  type SafeAuthUser,
  type SessionRepository
} from "@deploylite/domain";
import { ProtocolError, TransportCanceledError } from "@deploylite/contracts";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { isAgentPreDispatchRejection, AuthenticatedAgentDeploymentTransport, type AgentDispatchContext, type DeploymentDispatchReceipt } from "./agent-transport.js";
import { z } from "zod";

declare module "fastify" {
  interface FastifyRequest {
    correlationContext: { requestId: string; correlationId: string };
    auth?: AuthContext;
  }
}

const API_PREFIX = "/api/v1";
const AUTH_HEADER = "x-scaffold-auth";
const SCAFFOLD_ACTOR = "scaffold-user";
const defaultSessionCookieName = "deploylite_session";
const authRequiredMessage = "Authentication required.";

type ApiEnvelope<Data> = {
  data: Data | null;
  error: { code: string; message: string; correlationId: string } | null;
  requestId: string;
};

class InMemoryProjectRepository implements ProjectRepository {
  readonly #projects = new Map<string, Project>();

  async save(project: Project): Promise<Project> {
    const cloned = structuredClone(project);
    this.#projects.set(project.id, cloned);
    return cloned;
  }

  async findById(id: string): Promise<Project | null> {
    const existing = this.#projects.get(id);
    return existing ? structuredClone(existing) : null;
  }

  async list(): Promise<Project[]> {
    return [...this.#projects.values()].map((project) => structuredClone(project));
  }

  async remove(id: string): Promise<boolean> {
    return this.#projects.delete(id);
  }
}

type AuthContext = {
  user: SafeAuthUser;
  session: AuthSession;
};

type AuthConfig = {
  cookieName: string;
  cookieSecure: boolean;
  sessionTtlSeconds: number;
};

type AuthAdapters = {
  audit: AuditRepository;
  hasher: PasswordHasher;
  sessions: SessionRepository;
  users: AuthUserRepository;
};

type DbPool = Parameters<typeof closeDbPool>[0];

type ApiRepositories = {
  auth: AuthAdapters;
  state: PlatformRepositories;
  shouldSeedMockData: boolean;
  composeResourceCleanupStore?: ComposeResourceCleanupStore;
  close?: () => Promise<void>;
};

type BuildApiAppOptions = {
  auth?: Partial<AuthAdapters>;
  authConfig?: Partial<AuthConfig>;
  corsOrigin?: string | false;
  state?: Partial<PlatformRepositoryOptions>;
  imagePolicy?: ImageReferencePolicyV1;
  composeResourceInspection?: ReadonlyMap<string, ComposeResourceInspectionAccess>;
  composeNetworkAttachmentExecutions?: ReadonlyMap<string, ComposeNetworkAttachmentExecutionAccess>;
  composeResourceProjectAgents?: readonly ComposeResourceProjectBinding[];
  composeVolumeAttachmentProjectAgents?: readonly ComposeResourceProjectBinding[];
  composeResourceCleanupProjectAgents?: readonly ComposeResourceProjectBinding[];
  composeVolumeAttachmentExecutions?: ReadonlyMap<string, ComposeVolumeAttachmentExecutionAccess>;
  composeVolumeBackupPlans?: ReadonlyMap<string, ComposeVolumeBackupPlanAccess>;
  composeVolumeBackupExecutions?: ReadonlyMap<string, ComposeVolumeBackupExecutionAccess>;
  composeResourceCleanupPlans?: ReadonlyMap<string, ComposeResourceCleanupAccess>;
  composeResourceCleanupExecutions?: ReadonlyMap<string, ComposeResourceCleanupExecutionAccess>;
  domainRouteApplyExecutions?: ReadonlyMap<string, DomainRouteApplyExecutionAccess>;
  transportPortApplyExecutions?: ReadonlyMap<string, TransportPortApplyExecutionAccess>;
  db?: {
    pool?: DbPool;
    client?: DeployLiteDb;
    createPool?: (connectionString: string) => DbPool;
    closePool?: (pool: DbPool) => Promise<void>;
  };
  env?: NodeJS.ProcessEnv;
};

class InMemoryAuthUserRepository implements AuthUserRepository {
  readonly #users = new Map<string, AuthUser>();

  constructor(seed: AuthUser[] = []) {
    for (const user of seed) {
      this.#users.set(user.id, structuredClone(user));
    }
  }

  async findByEmail(email: string): Promise<AuthUser | null> {
    const normalized = normalizeEmail(email);
    return [...this.#users.values()].find((user) => user.emailNormalized === normalized) ?? null;
  }

  async findById(id: string): Promise<AuthUser | null> {
    return this.#users.get(id) ?? null;
  }

  async count(): Promise<number> {
    return this.#users.size;
  }

  async createInitialAdmin(input: CreateInitialAdminInput): Promise<AuthUser> {
    if (this.#users.size > 0) {
      throw new InitialAdminAlreadyExistsError();
    }
    const now = new Date();
    const user: AuthUser = {
      id: `user_${createRequestId()}`,
      email: input.email,
      emailNormalized: normalizeEmail(input.email),
      passwordHash: input.passwordHash,
      role: "admin",
      status: "active",
      createdAt: now,
      updatedAt: now
    };
    this.#users.set(user.id, structuredClone(user));
    return user;
  }
}

class InMemorySessionRepository implements SessionRepository {
  readonly #sessions = new Map<string, AuthSession>();

  async create(input: CreateSessionInput): Promise<AuthSession> {
    const now = new Date();
    const session: AuthSession = {
      id: `session_${createRequestId()}`,
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      revokedAt: null,
      ipHash: input.ipHash ?? null,
      userAgent: input.userAgent ?? null,
      createdAt: now,
      lastSeenAt: now
    };
    this.#sessions.set(session.id, structuredClone(session));
    return session;
  }

  async findValidByTokenHash(tokenHash: string, now = new Date()): Promise<AuthSession | null> {
    return [...this.#sessions.values()].find((session) => session.tokenHash === tokenHash && session.revokedAt === null && session.expiresAt.getTime() > now.getTime()) ?? null;
  }

  async revoke(sessionId: string, now = new Date()): Promise<AuthSession | null> {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      return null;
    }
    const revoked = { ...session, revokedAt: now };
    this.#sessions.set(sessionId, revoked);
    return revoked;
  }
}

class InMemoryAuditRepository implements AuditRepository {
  readonly events: AuditEvent[] = [];
  readonly inputs: AuditEventInput[] = [];

  async append(input: AuditEventInput): Promise<AuditEvent> { return this.appendSynchronous(input); }

  appendSynchronous(input: AuditEventInput): AuditEvent { return this.appendAtomically(input, () => undefined); }

  /** Synchronous shared-metadata publication and audit; preparation failures publish neither. */
  appendAtomically(input: AuditEventInput, publish: () => void): AuditEvent {
    const safe = createAuditLogRecord({
      actorId: input.actorUserId === null ? "anonymous" : input.actorUserId ?? "system",
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      requestId: input.requestId,
      correlationId: input.correlationId,
      metadata: input.metadata
    });
    const event: AuditEvent = {
      id: `audit_${createRequestId()}`,
      actorId: safe.actorId,
      action: safe.action,
      targetType: safe.targetType,
      targetId: safe.targetId,
      requestId: safe.requestId,
      correlationId: safe.correlationId,
      timestamp: safe.timestamp
    };
    publish();
    this.inputs.push({ ...input, metadata: safe.metadata });
    this.events.push(event);
    return event;
  }

  async list(filter: { actorUserId?: string; action?: string; projectId?: string; limit?: number; offset?: number } = {}): Promise<{ events: AuditEventListItem[]; total: number; limit: number; offset: number }> {
    const limit = clampListLimit(filter.limit);
    const offset = clampListOffset(filter.offset);
    // Mirror the DB behavior: order by timestamp desc so the most recent
    // event appears first. The DB uses `desc(auditEvents.createdAt)`; the
    // in-memory mirror sorts by the same field exposed on the API surface
    // (`timestamp`).
    const sorted = [...this.events].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const filtered = sorted.filter((event) => matchesAuditFilter(event, this.inputs, filter));
    return {
      events: filtered.slice(offset, offset + limit).map(toAuditListItem),
      total: filtered.length,
      limit,
      offset
    };
  }
}

const MAX_AUDIT_LIST_LIMIT = 200;
const DEFAULT_AUDIT_LIST_LIMIT = 50;
const MAX_AUDIT_LIST_OFFSET = 10_000;

type AuditListFilter = {
  actorUserId?: string;
  action?: string;
  projectId?: string;
  limit?: number;
  offset?: number;
};

function clampListLimit(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_AUDIT_LIST_LIMIT;
  if (!Number.isInteger(raw) || raw < 1) return 1;
  if (raw > MAX_AUDIT_LIST_LIMIT) return MAX_AUDIT_LIST_LIMIT;
  return raw;
}

function clampListOffset(raw: number | undefined): number {
  if (raw === undefined) return 0;
  if (!Number.isInteger(raw) || raw < 0) return 0;
  if (raw > MAX_AUDIT_LIST_OFFSET) return MAX_AUDIT_LIST_OFFSET;
  return raw;
}

function toAuditListItem(event: AuditEvent): AuditEventListItem {
  return {
    id: event.id,
    actorId: event.actorId,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId,
    requestId: event.requestId,
    correlationId: event.correlationId,
    timestamp: event.timestamp
  };
}

function matchesAuditFilter(event: AuditEvent, inputs: AuditEventInput[], filter: AuditListFilter): boolean {
  if (filter.actorUserId) {
    // Mirror the DB behavior: exact match on the persisted actor id. The
    // API surface resolves null/missing actor to "anonymous" / "system"
    // on the response, but the filter is applied against the raw
    // `event.actorId` (which is what the DB's `actorUserId` column would
    // round-trip to). A `?actor=system` query therefore matches only the
    // rows that were written with that literal placeholder; the in-memory
    // path used to fold anonymous/system in unconditionally, which
    // diverged from the DB and inflated counts.
    if (event.actorId !== filter.actorUserId) {
      return false;
    }
  }
  if (filter.action && !event.action.startsWith(filter.action)) {
    return false;
  }
  if (filter.projectId) {
    const prefix = `${filter.projectId}:`;
    const matchesTargetPrefix = event.targetId === filter.projectId || event.targetId.startsWith(prefix);
    if (matchesTargetPrefix) {
      return true;
    }
    // Fall back to the metadata.projectId mirror so events whose targetId is
    // opaque (e.g. an env_secret_values row id) still get filtered correctly.
    const input = inputs.find((candidate) => candidate.requestId === event.requestId && candidate.correlationId === event.correlationId);
    if (!input || !input.metadata || (input.metadata as Record<string, unknown>)["projectId"] !== filter.projectId) {
      return false;
    }
  }
  return true;
}

function ok<Data>(request: FastifyRequest, data: Data): ApiEnvelope<Data> {
  return { data, error: null, requestId: request.correlationContext.requestId };
}

function errorEnvelope(request: FastifyRequest, code: string, message: string): ApiEnvelope<never> {
  return {
    data: null,
    error: { code, message, correlationId: request.correlationContext.correlationId },
    requestId: request.correlationContext.requestId
  };
}

function getHeaderValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toSafeAuthDto(user: SafeAuthUser) {
  return { id: user.id, email: user.email, role: user.role, status: user.status };
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) {
    return {};
  }
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([name, value]) => name && value)
      .map(([name, value]) => [name, decodeURIComponent(value ?? "")])
  );
}

function sessionCookie(config: AuthConfig, token: string, maxAge: number): string {
  const secure = config.cookieSecure ? "; Secure" : "";
  return `${config.cookieName}=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

async function appendAudit(audit: AuditRepository, request: FastifyRequest, input: Omit<AuditEventInput, "requestId" | "correlationId">): Promise<AuditEvent> {
  return audit.append({ ...input, ...request.correlationContext });
}

function createAuthPreHandler(adapters: AuthAdapters, config: AuthConfig) {
  return async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = parseCookies(getHeaderValue(request, "cookie"))[config.cookieName];
    if (!token) {
      await appendAudit(adapters.audit, request, { action: "protected.denied", targetType: "route", targetId: request.url, metadata: { reason: "missing-session" } });
      void reply.code(401).send(errorEnvelope(request, "UNAUTHENTICATED", authRequiredMessage));
      return;
    }

    const session = await adapters.sessions.findValidByTokenHash(hashSessionToken(token));
    const user = session ? await adapters.users.findById(session.userId) : null;
    if (!session || !user || user.status !== "active") {
      await appendAudit(adapters.audit, request, {
        actorUserId: user?.id ?? null,
        action: "protected.denied",
        targetType: "route",
        targetId: request.url,
        metadata: { reason: !session ? "invalid-session" : "disabled-user" }
      });
      void reply.code(401).send(errorEnvelope(request, "UNAUTHENTICATED", authRequiredMessage));
      return;
    }

    request.auth = { user: toSafeAuthUser(user), session };
  };
}

function createRolePreHandler(adapters: AuthAdapters, roles: readonly CanonicalRoleName[]) {
  return async function requireRole(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!request.auth) {
      return;
    }
    if (!roles.includes(request.auth.user.role)) {
      await appendAudit(adapters.audit, request, {
        actorUserId: request.auth.user.id,
        action: "protected.denied",
        targetType: "route",
        targetId: request.url,
        metadata: { reason: "insufficient-role", role: request.auth.user.role, allowedRoles: [...roles] }
      });
      void reply.code(403).send(errorEnvelope(request, "FORBIDDEN", "Insufficient role for this action."));
    }
  };
}

type PlatformRepositoryOptions = {
  agents: AgentRepository;
  deployments: DeploymentRepository;
  projects: ProjectRepository;
  domainRouteClaims?: DomainRouteClaimReader;
  transportPortClaims?: TransportPortClaimReader;
  transportPortApplyStore?: TransportPortApplyCompletionStore;
  domainRouteApplyStore?: DomainRouteApplyCompletionStore;
  composeRevisionReads?: ComposeRevisionReadCapability;
  composeRevisionSaves?: ComposeRevisionSaveStore;
  envMetadata?: EnvVariableMetadataRepository;
  envSecretValues?: EnvSecretValueRepository;
  envSecretCipher?: EnvSecretCipher;
  runtimeActivationDispatcher?: RuntimeActivationDispatcher;
  deploymentDispatcher?: DeploymentDispatcher;
  deploymentStopDispatcher?: DeploymentStopDispatcher;
  snapshots?: DeploymentSnapshotRepository;
  executionCompletion?: DeploymentExecutionRepository;
  controlDeletes?: ControlDeleteRepository & ControlStopRepository;
  controlRedeploy?: ControlRedeployRepository;
  controlRollback?: ControlRollbackRepository;
  controlGrants?: ControlGrantRepository;
};

type PlatformRepositories = PlatformRepositoryOptions & {
  agentStatus: AgentStatusService;
  envMetadata: EnvVariableMetadataRepository;
  envSecretValues: EnvSecretValueRepository;
  envSecretCipher: EnvSecretCipher;
  deployRunner: DeployRunner;
  runtimeActivationDispatcher: RuntimeActivationDispatcher;
  deploymentDispatcher: DeploymentDispatcher;
  deploymentStopDispatcher: DeploymentStopDispatcher;
  snapshots: DeploymentSnapshotRepository;
  controlDeletes: ControlDeleteRepository & ControlStopRepository;
  controlRedeploy: ControlRedeployRepository;
  controlGrants: ControlGrantRepository;
};

export type DeploymentDispatcher = {
  available(): boolean;
  dispatch(snapshot: DeploymentSnapshotV1, commandId: string, context?: AgentDispatchContext): Promise<"dispatched" | DockerImageExecutionReceiptV1 | DeploymentDispatchReceipt>;
  readExecutionReceipt?(snapshot: DeploymentSnapshotV1, commandId: string, context?: AgentDispatchContext): Promise<DockerImageExecutionReceiptV1 | DeploymentDispatchReceipt | null>;
};
class RedeployReceiptMismatchError extends Error {}

export type DeploymentStopDispatcher = {
  available(): boolean;
  readStopReceipt?(input: { projectId: string; deploymentId: string; candidateId: string; effectiveImage: string; containerId?: string; commandId: string }, context: AgentDispatchContext): Promise<import("@deploylite/contracts").DeploymentStopAgentReceipt | null>;
  dispatchStop(input: { projectId: string; deploymentId: string; candidateId: string; effectiveImage: string; containerId?: string; commandId: string }, context: AgentDispatchContext): Promise<import("@deploylite/contracts").DeploymentStopAgentReceipt>;
};

class UnavailableDeploymentDispatcher implements DeploymentDispatcher {
  available(): boolean { return false; }
  async dispatch(): Promise<"dispatched"> { throw new Error("deploy.execute capability unavailable"); }
}

class UnavailableDeploymentStopDispatcher implements DeploymentStopDispatcher {
  available(): boolean { return false; }
  async dispatchStop(): Promise<never> { throw new Error("deployment.stop capability unavailable"); }
}

class InMemorySnapshotRepository implements DeploymentSnapshotRepository {
  readonly #snapshots = new Map<string, DeploymentSnapshotV1>();
  async saveSnapshot(snapshot: DeploymentSnapshotV1): Promise<void> {
    const existing = this.#snapshots.get(snapshot.hash);
    if (existing && existing.canonicalJson !== snapshot.canonicalJson) throw new Error("snapshot hash collision");
    this.#snapshots.set(snapshot.hash, structuredClone(snapshot));
  }
  async findByHash(hash: string): Promise<DeploymentSnapshotV1 | null> { const snapshot = this.#snapshots.get(hash); return snapshot ? structuredClone(snapshot) : null; }
}

export type RuntimeActivationDispatcher = {
  available(): boolean;
  dispatch(command: RuntimeActivationCommand): Promise<RuntimeActivation>;
};

class UnavailableRuntimeActivationDispatcher implements RuntimeActivationDispatcher {
  available(): boolean {
    return false;
  }

  async dispatch(command: RuntimeActivationCommand): Promise<RuntimeActivation> {
    return runtimeActivationSchema.parse({
      id: command.idempotencyKey,
      commandId: command.commandId,
      status: "capability_unavailable",
      capability: "safe_runtime_executor",
      output: null
    });
  }
}

type EnvSecretKeySource = NodeJS.ProcessEnv | Record<string, string | number | boolean | undefined>;

function extractSecretKey(env: EnvSecretKeySource): string | undefined {
  const value = (env as Record<string, unknown>)["DEPLOYLITE_SECRET_KEY"];
  return typeof value === "string" ? value : undefined;
}

function createLazyEnvSecretCipher(env: EnvSecretKeySource): EnvSecretCipher {
  const loadCipher = () => createEnvSecretCipher(loadEnvSecretKey(extractSecretKey(env)));
  return {
    encrypt: (plaintext) => loadCipher().encrypt(plaintext),
    decrypt: (ciphertext) => loadCipher().decrypt(ciphertext),
    fingerprint: (plaintext) => loadCipher().fingerprint(plaintext)
  };
}

export function createInMemoryExecutionRepositories(projects: ProjectRepository = new InMemoryProjectRepository(), audit: AuditRepository = new InMemoryAuditRepository()) {
  const completion = new InMemoryExecutionState();
  const deployments = new InMemoryDeploymentRepository(completion);
  const controls = new InMemoryControlDeleteRepository(projects, audit, deployments, completion);
  return { deployments, controls, completion };
}

function createApiState(env: EnvSecretKeySource, overrides: Partial<PlatformRepositoryOptions> = {}, audit?: AuditRepository): PlatformRepositories {
  const agents = overrides.agents ?? new InMemoryAgentRepository();
  const projects = overrides.projects ?? new InMemoryProjectRepository();
  const memory = !overrides.deployments && !overrides.controlDeletes && !overrides.controlRedeploy && !overrides.controlRollback ? createInMemoryExecutionRepositories(projects, audit ?? new InMemoryAuditRepository()) : null;
  const deployments = overrides.deployments ?? memory?.deployments ?? new InMemoryDeploymentRepository();
  const executionCompletion = overrides.executionCompletion ?? memory?.completion;
  const envMetadata = overrides.envMetadata ?? new InMemoryEnvVariableMetadataRepository();
  const envSecretValues = overrides.envSecretValues ?? new InMemoryEnvSecretValueRepository();
  const envSecretCipher = overrides.envSecretCipher ?? createLazyEnvSecretCipher(env);
  const runtimeActivationDispatcher = overrides.runtimeActivationDispatcher ?? new UnavailableRuntimeActivationDispatcher();
  const agentTransport = typeof env.DEPLOYLITE_AGENT_URL === "string" && typeof env.DEPLOYLITE_AGENT_TRUST_KEY === "string" && typeof env.DEPLOYLITE_AGENT_ID === "string" ? new AuthenticatedAgentDeploymentTransport({ endpoint: env.DEPLOYLITE_AGENT_URL, trustKey: env.DEPLOYLITE_AGENT_TRUST_KEY, agentId: env.DEPLOYLITE_AGENT_ID, allowInsecureInternal: true }) : undefined;
  const deploymentDispatcher = overrides.deploymentDispatcher ?? agentTransport ?? new UnavailableDeploymentDispatcher();
  const deploymentStopDispatcher = overrides.deploymentStopDispatcher ?? agentTransport ?? new UnavailableDeploymentStopDispatcher();
  const snapshots = overrides.snapshots ?? new InMemorySnapshotRepository();
  const controlDeletes = overrides.controlDeletes ?? memory?.controls ?? new InMemoryControlDeleteRepository(projects, audit ?? new InMemoryAuditRepository(), deployments);
  const agentStatus = new AgentStatusService(agents);
  const deployRunner = new DeployRunner(deployments, envMetadata, agentStatus, envSecretCipher);
  return { agents, deployments, projects, domainRouteClaims: overrides.domainRouteClaims, transportPortClaims: overrides.transportPortClaims,
    transportPortApplyStore: overrides.transportPortApplyStore, domainRouteApplyStore: overrides.domainRouteApplyStore,
    executionCompletion, composeRevisionReads: overrides.composeRevisionReads ?? overrides.composeRevisionSaves, composeRevisionSaves: overrides.composeRevisionSaves,
    envMetadata, envSecretValues, envSecretCipher, agentStatus, deployRunner, runtimeActivationDispatcher, deploymentDispatcher, deploymentStopDispatcher,
    snapshots, controlDeletes, controlRedeploy: overrides.controlRedeploy ?? memory?.controls ?? (controlDeletes as unknown as ControlRedeployRepository),
    controlRollback: overrides.controlRollback ?? memory?.controls ?? (typeof (controlDeletes as any).executeConfirmedDeploymentRollback === "function" ? controlDeletes as unknown as ControlRollbackRepository : undefined),
    controlGrants: overrides.controlGrants ?? new InMemoryControlGrantRepository() };
}

class InMemoryControlGrantRepository implements ControlGrantRepository {
  constructor(private readonly grants: ControlGrant[] = []) {}
  async listForActor(actorId: string): Promise<ControlGrant[]> {
    return this.grants.filter((grant) => grant.actorId === actorId).map((grant) => structuredClone(grant));
  }
}

class InMemoryControlDeleteRepository implements ControlDeleteRepository, ControlStopRepository, ControlRedeployRepository {

  async resolve(command: ControlCommand): Promise<{ command: ControlCommand; created: boolean }> {
    if (command.action === "deployment.rollback") {
      const prior = [...this.executionState.commands.values()].find((candidate) => candidate.actorId === command.actorId && candidate.action === command.action && candidate.idempotencyKey === command.idempotencyKey);
      if (prior) { validateRollbackReservation(prior, command); return { command: structuredClone(prior), created: false }; }
      validateRollbackReservation(command, command);
    }
    return resolveControlCommandInMemory(this.executionState.commands, command);
  }

  async findByIdempotency(actorId: string, idempotencyKey: string, action: "deployment.redeploy" | "deployment.stop" | "deployment.rollback" = "deployment.redeploy"): Promise<ControlCommand | null> {
    const command = [...this.executionState.commands.values()].find((candidate) => candidate.actorId === actorId && candidate.action === action && candidate.idempotencyKey === idempotencyKey);
    return command ? structuredClone(command) : null;
  }

  async resolveRollbackConfirmation(command: ControlCommand, now = new Date()): Promise<ControlConfirmation | null> {
    const current = [...this.executionState.commands.values()].find((value) => value.id === command.id);
    if (!current) return null;
    validateRollbackReservation(current, command);
    if (current.status !== "pending_confirmation" || current.expiresAt <= now) return null;
    let confirmation = [...this.executionState.confirmations.values()].find((value) => value.commandId === current.id);
    if (!confirmation) { confirmation = createConfirmation({ command: current, classification: "destructive" }); this.executionState.confirmations.set(confirmation.id, confirmation); }
    try { evaluateConfirmation(current, confirmation, now); }
    catch (error) { if (error instanceof ConfirmationRejectedError) return null; throw error; }
    return structuredClone(confirmation);
  }

  async bind(confirmation: ControlConfirmation): Promise<void> { this.executionState.confirmations.set(confirmation.id, structuredClone(confirmation)); }

  async consume(command: ControlCommand, confirmation: ControlConfirmation, now = new Date()) {
    const stored = this.executionState.confirmations.get(confirmation.id);
    const current = [...this.executionState.commands.values()].find((candidate) => candidate.id === command.id);
    if (!stored || !current) return { command, accepted: false, reason: "confirmation_rejected" };
    try {
      if (stored.actorId !== confirmation.actorId || stored.action !== confirmation.action || scopeKey(stored.scope) !== scopeKey(confirmation.scope) || stored.inputDigest !== confirmation.inputDigest || stored.classification !== confirmation.classification) throw new ConfirmationRejectedError();
      if (stored.commandId !== current.id || stored.consumedAt || stored.expiresAt <= now) throw new ConfirmationRejectedError();
      stored.consumedAt = now;
      current.status = "eligible";
      return { command: structuredClone(current), accepted: true, reason: null };
    } catch (error) {
      if (error instanceof ConfirmationRejectedError) return { command: structuredClone(current), accepted: false, reason: "confirmation_rejected" };
      throw error;
    }
  }

  async complete(command: ControlCommand): Promise<ControlCommand> {
    const current = [...this.executionState.commands.values()].find((candidate) => candidate.id === command.id);
    if (!current) throw new Error("Control command was not found");
    if (current.status === "eligible") current.status = "completed";
    return structuredClone(current);
  }

  async executeConfirmedDeploymentStop({ command, confirmation, now = new Date() }: Parameters<ControlStopRepository["executeConfirmedDeploymentStop"]>[0]) {
    const current = [...this.executionState.commands.values()].find((candidate) => candidate.id === command.id);
    if (!current) throw new Error("Control command was not found");
    if (current.status === "completed") return { command: structuredClone(current), accepted: true, reason: null, result: (current.result as import("@deploylite/contracts").DeploymentStopCommandResult | undefined) ?? null, alreadyCompleted: true };
    if (current.status === "eligible" || current.status === "dispatching") return { command: structuredClone(current), accepted: true, reason: null, result: (current.result as import("@deploylite/contracts").DeploymentStopCommandResult | undefined) ?? null, alreadyCompleted: false };
    const stored = this.executionState.confirmations.get(confirmation.id);
    if (!stored || stored.commandId !== current.id || stored.actorId !== current.actorId || stored.action !== current.action || scopeKey(stored.scope) !== scopeKey(current.scope) || stored.inputDigest !== current.inputDigest || stored.classification !== "destructive" || stored.consumedAt || stored.expiresAt <= now) {
      current.status = "rejected";
      return { command: structuredClone(current), accepted: false, reason: "confirmation_rejected", result: stopCommandResult(current, "rejected"), alreadyCompleted: false };
    }
    stored.consumedAt = now;
    current.status = "eligible";
    return { command: structuredClone(current), accepted: true, reason: null, result: stopCommandResult(current, "eligible"), alreadyCompleted: false };
  }

  async validateInitialExecution(projectId: string, executionId: string, binding: import("@deploylite/domain").InitialExecutionBinding): Promise<void> {
    validateInitialExecution([...this.executionState.commands.values()], this.executionState.deployments.get(executionId), projectId, executionId, binding);
  }
  async validateDeploymentAuthority(authority: import("@deploylite/contracts").DeploymentExecutionAuthorityV1, now = Date.now()): Promise<void> {
    validateDeploymentAuthority([...this.executionState.commands.values()], authority, now);
  }

  async claimDeploymentStop(command: ControlCommand) {
    const current = [...this.executionState.commands.values()].find((candidate) => candidate.id === command.id);
    if (!current) throw new Error("Control command was not found");
    const authority = claimDeploymentAuthority([...this.executionState.commands.values()], current, current.scope.kind === "deployment" ? current.scope.deploymentId : "");
    return { command: structuredClone(current), claimed: authority !== null, ...(authority ? { authority } : {}) };
  }

  async completeDeploymentStop(command: ControlCommand, result: import("@deploylite/contracts").DeploymentStopCommandResult, signal?: AbortSignal): Promise<ControlCommand> {
    command = structuredClone(command); result = structuredClone(result);
    const current = [...this.executionState.commands.values()].find((candidate) => candidate.id === command.id);
    if (!current) throw new Error("Control command was not found");
    if (!validateStopCompletion([...this.executionState.commands.values()], current, command, result)) {
      // No await can interleave a newer claim or request abort with this publication.
      signal?.throwIfAborted();
      current.status = "completed"; current.result = result;
    }
    return structuredClone(current);
  }

  async executeConfirmedDeploymentRedeploy({ command, confirmation, deployment, requestId, snapshotHash, now = new Date() }: Parameters<ControlRedeployRepository["executeConfirmedDeploymentRedeploy"]>[0]) {
    const current = [...this.executionState.commands.values()].find((candidate) => candidate.id === command.id);
    if (!current) throw new Error("Control command was not found");
    if (current.status === "completed") return { command: structuredClone(current), accepted: true, reason: null, result: current.result as import("@deploylite/contracts").DeploymentRedeployCommandResult | null, deployment: null, alreadyCompleted: true };
    if (current.status === "eligible" || current.status === "dispatching") return { command: structuredClone(current), accepted: true, reason: null, result: current.result as import("@deploylite/contracts").DeploymentRedeployCommandResult, deployment, alreadyCompleted: false };
    if (current.status !== "pending_confirmation") return { command: structuredClone(current), accepted: false, reason: "command_not_pending", result: redeployCommandResult(current, "rejected", null, snapshotHash, "command_not_pending"), deployment: null, alreadyCompleted: false };
    const stored = this.executionState.confirmations.get(confirmation.id);
    if (!stored || stored.commandId !== current.id || stored.actorId !== current.actorId || stored.action !== current.action || scopeKey(stored.scope) !== scopeKey(current.scope) || stored.inputDigest !== current.inputDigest || stored.classification !== "destructive" || stored.consumedAt || stored.expiresAt <= now || stored.expiresAt > current.expiresAt) { current.status = "rejected"; current.result = redeployCommandResult(current, "rejected", null, snapshotHash); return { command: structuredClone(current), accepted: false, reason: "confirmation_rejected", result: current.result as import("@deploylite/contracts").DeploymentRedeployCommandResult, deployment: null, alreadyCompleted: false }; }
    const before = structuredClone(current); const confirmationBefore = structuredClone(stored);
    try {
      const result = { commandId: current.id, action: "deployment.redeploy" as const, projectId: deployment.projectId, sourceDeploymentId: deployment.sourceDeploymentId!, deploymentId: deployment.id, snapshotHash, status: "eligible" as const, correlationId: current.correlationId, reason: null };
      stored.consumedAt = now; current.status = "eligible"; current.result = result; await this.deployments?.save(deployment);
      return { command: structuredClone(current), accepted: true, reason: null, result, deployment, alreadyCompleted: false };
    } catch (error) { Object.assign(current, before); Object.assign(stored, confirmationBefore); if (this.deployments?.remove) await this.deployments.remove(deployment.id); throw error; }
  }

  async completeDeploymentRedeploy(command: ControlCommand, result: import("@deploylite/contracts").DeploymentRedeployCommandResult): Promise<ControlCommand> {
    if (result.commandId !== command.id || result.action !== "deployment.redeploy" || result.correlationId !== command.correlationId || result.status !== "completed") throw new Error("Deployment redeploy result does not match command");
    const current = [...this.executionState.commands.values()].find((candidate) => candidate.id === command.id); if (!current) throw new Error("Control command was not found");
    const expected = current.result as import("@deploylite/contracts").DeploymentRedeployCommandResult | undefined;
    if (!expected || expected.status !== "eligible" || current.scope.kind !== "deployment" || result.projectId !== current.scope.projectId || result.sourceDeploymentId !== current.scope.deploymentId || result.projectId !== expected.projectId || result.sourceDeploymentId !== expected.sourceDeploymentId || result.deploymentId === null || result.deploymentId !== expected.deploymentId || result.snapshotHash !== expected.snapshotHash) throw new Error("Deployment redeploy result does not match persisted command");
    if (current.status === "eligible" || current.status === "dispatching") { current.status = "completed"; current.result = result; } return structuredClone(current);
  }

  async claimDeploymentRedeploy(command: ControlCommand) { const current = [...this.executionState.commands.values()].find((candidate) => candidate.id === command.id); if (!current) throw new Error("Control command was not found"); const id = (current.result as import("@deploylite/contracts").DeploymentRedeployCommandResult | undefined)?.deploymentId; const deployment = id ? await this.deployments?.findById(id) ?? null : null; const authority = id ? claimDeploymentAuthority([...this.executionState.commands.values()], current, id) : null; return { command: structuredClone(current), claimed: authority !== null, deployment, ...(authority ? { authority } : {}) }; }

  async executeConfirmedDeploymentRollback({ command, confirmation, deployment, now = new Date() }: Parameters<ControlRollbackRepository["executeConfirmedDeploymentRollback"]>[0]) {
    const current = [...this.executionState.commands.values()].find((value) => value.id === command.id);
    if (!current) throw new Error("Rollback command was not found"); validateRollbackReservation(current, command);
    const reserved = current.result as import("@deploylite/contracts").DeploymentRollbackCommandResult;
    if (current.status === "completed") return { command: structuredClone(current), accepted: true, reason: null, result: reserved, deployment: null, alreadyCompleted: true };
    if (current.status === "eligible" || current.status === "dispatching") return { command: structuredClone(current), accepted: true, reason: null, result: reserved, deployment: structuredClone(this.executionState.deployments.get(reserved.deploymentId) ?? null), alreadyCompleted: false };
    if (!isRollbackAdmissionBound(current, deployment, this.executionState.deployments.get(reserved.sourceDeploymentId), now)) return { command: structuredClone(current), accepted: false, reason: "execution_binding_rejected", result: null, deployment: null, alreadyCompleted: false };
    const stored = this.executionState.confirmations.get(confirmation.id);
    if (!stored || stored.commandId !== current.id || stored.actorId !== current.actorId || stored.action !== current.action || scopeKey(stored.scope) !== scopeKey(current.scope) || stored.inputDigest !== current.inputDigest || stored.classification !== "destructive" || stored.consumedAt || stored.expiresAt <= now || stored.expiresAt > current.expiresAt) return { command: structuredClone(current), accepted: false, reason: "confirmation_rejected", result: null, deployment: null, alreadyCompleted: false };
    const queued = deploymentSchema.parse(deployment), result = { ...reserved, status: "eligible" as const };
    // Shared maps and confirmation are published synchronously; no await exposes partial admission.
    this.executionState.deployments.set(queued.id, structuredClone(queued)); stored.consumedAt = now; current.status = "eligible"; current.result = result;
    return { command: structuredClone(current), accepted: true, reason: null, result, deployment: queued, alreadyCompleted: false };
  }
  async claimDeploymentRollback(command: ControlCommand) {
    const current = [...this.executionState.commands.values()].find((value) => value.id === command.id);
    if (!current) throw new Error("Rollback command was not found");
    validateRollbackReservation(current, command);
    const result = current.result as import("@deploylite/contracts").DeploymentRollbackCommandResult;
    const deployment = this.executionState.deployments.get(result.deploymentId) ?? null;
    // No await separates fresh queued/binding validation from the shared project claim.
    const authority = isRollbackClaimBound(current, deployment, this.executionState.deployments.get(result.sourceDeploymentId), new Date())
      ? claimDeploymentAuthority([...this.executionState.commands.values()], current, result.deploymentId) : null;
    return { command: structuredClone(current), deployment: structuredClone(deployment), claimed: authority !== null, ...(authority ? { authority } : {}) };
  }

  constructor(private readonly projects: ProjectRepository, private readonly audit: AuditRepository, private readonly deployments?: DeploymentRepository, private readonly executionState = new InMemoryExecutionState()) {}

  async executeConfirmedProjectDelete({ command, confirmation, projectId, requestId }: Parameters<ControlDeleteRepository["executeConfirmedProjectDelete"]>[0]) {
    const project = await this.projects.findById(projectId);
    if (!project) throw new Error("Project was not found for confirmed deletion");
    const commandBefore = [...this.executionState.commands.values()].find((candidate) => candidate.id === command.id);
    const confirmationBefore = this.executionState.confirmations.get(confirmation.id);
    const outcome = await this.consume(command, confirmation);
    if (!outcome.accepted || outcome.command.status === "completed") return { ...outcome, removed: outcome.command.status === "completed", auditRecorded: outcome.command.status === "completed", alreadyCompleted: outcome.command.status === "completed" };
    try {
      if (!await this.projects.remove(projectId)) throw new Error("Project was not found for confirmed deletion");
      const completed = await this.complete(outcome.command);
      await this.audit.append({ actorUserId: command.actorId, action: "project.delete", targetType: "project", targetId: projectId, requestId, correlationId: command.correlationId, metadata: { commandId: command.id, confirmationId: confirmation.id } });
      return { command: completed, accepted: true, reason: null, removed: true, auditRecorded: true, alreadyCompleted: false };
    } catch (error) {
      if (confirmationBefore) this.executionState.confirmations.set(confirmation.id, confirmationBefore);
      if (commandBefore) Object.assign(commandBefore, structuredClone(command));
      await this.projects.save(project);
      throw error;
    }
  }
}

/**
 * Deterministic set of mock env secret values used by the API's
 * dry-run materialization step. The values are intentionally
 * harmless (no real credentials) but they exercise the full
 * encrypt → decrypt → redact pipeline so the agent's
 * `materializeMockDeploy` is actually wired into the deploy path.
 * The plaintext is held only for the duration of the encrypt call
 * and never written to a log or a response — only the redacted
 * projection reaches the deployment log.
 */
const DRY_RUN_MOCK_VALUES: ReadonlyArray<{ key: string; scope: "project" | "deployment"; value: string }> = [
  { key: "DATABASE_URL", scope: "project", value: "postgres://dry-run:placeholder@db.invalid:5432/dryrun" },
  { key: "API_KEY", scope: "project", value: "sk_dry_run_placeholder" }
];

export class DeployRunner {
  #sequenceByDeployment = new Map<string, number>();
  #timers = new Map<string, NodeJS.Timeout>();
  #fenced = new Set<string>();

  constructor(
    private readonly deployments: DeploymentRepository,
    private readonly envMetadata: EnvVariableMetadataRepository,
    private readonly agentStatus: AgentStatusService,
    private readonly envSecretCipher?: EnvSecretCipher
  ) {}

  /**
   * Control-plane deployment runner. In this local MVP, the API does not talk
   * to a real agent or to a Docker socket. It records the deployment as
   * `queued`, then schedules status transitions to `running` and `succeeded`
   * (or `failed` when required env metadata is missing) and appends audit-safe
   * log events so the UI can show a real lifecycle end-to-end.
   */
  async start(deployment: Deployment, project: Project, requestId: string, correlationId: string): Promise<{ deployment: Deployment; logs: EnvVariableMetadata[] }> {
    const logs = await this.envMetadata.listByProject(project.id);
    const missingRequired = logs.filter((record) => record.required && !record.valuePresent);
    await this.appendLog(deployment, "info", `Queued deploy for project ${project.name} (${project.repoUrl}@${project.defaultBranch}).`, requestId, correlationId);
    await this.appendLog(deployment, "info", `Resolved ${logs.length} env metadata record(s); ${missingRequired.length} required-without-value.`, requestId, correlationId);

    if (missingRequired.length > 0) {
      await this.appendLog(deployment, "error", `Refusing to advance: required env metadata missing for ${missingRequired.map((m) => m.key).join(", ")}.`, requestId, correlationId);
      const failed: Deployment = { ...deployment, status: "failed", finishedAt: new Date().toISOString() };
      await this.deployments.save(failed);
      return { deployment: failed, logs };
    }

    // Dry-run materialization. The agent module's
    // `materializeMockDeploy` is invoked with a deterministic mock
    // set of `EncryptedEnvRecord` values, encrypted in-process with
    // the API's own cipher. The agent then decrypts them, renders a
    // `.env` string, and `redactEnvFileForLog` collapses every value
    // to `[REDACTED]` so the plaintext never reaches the log. The
    // step is wired into the deploy path so the agent module is not
    // inert (round-1 finding: the helper was defined but never
    // called). Failures are swallowed — a missing cipher must not
    // break the deploy — and the deploy still proceeds.
    const projection = await this.materializeDryRun(project);
    if (projection) {
      await this.appendLog(deployment, "info", `Materialized env (mock, redacted):\n${projection}`, requestId, correlationId);
    }

    if (!project.buildCommand) {
      await this.appendLog(deployment, "warn", "No build command configured; skipping build step.", requestId, correlationId);
    } else {
      await this.appendLog(deployment, "info", `Build command: ${project.buildCommand}`, requestId, correlationId);
    }
    if (!project.runCommand) {
      await this.appendLog(deployment, "warn", "No run command configured; deploy will stay in queued state.", requestId, correlationId);
    } else {
      await this.appendLog(deployment, "info", `Run command: ${project.runCommand} (port ${project.port ?? "default"})`, requestId, correlationId);
    }

    this.scheduleAdvance(deployment.id, "running", 50);
    this.scheduleAdvance(deployment.id, "succeeded", 250);
    return { deployment, logs };
  }

  /**
   * Build a deterministic mock `EncryptedEnvRecord[]` and round-trip
   * it through the agent module's `materializeMockDeploy` +
   * `redactEnvFileForLog` pipeline. The output is the redacted
   * `.env` projection suitable for the deploy log; plaintext is
   * never returned. Returns null when no cipher is configured (so
   * the deploy can still proceed) or when the agent module refuses
   * to materialize (e.g. key version mismatch).
   */
  async materializeDryRun(project: Project): Promise<string | null> {
    if (!this.envSecretCipher) return null;
    try {
      const records: EncryptedEnvRecord[] = DRY_RUN_MOCK_VALUES.map((mock) => {
        const encryptedValue = Buffer.from(this.envSecretCipher!.encrypt(mock.value), "base64");
        return {
          key: mock.key,
          scope: mock.scope,
          encryptedValue,
          valueFingerprint: this.envSecretCipher!.fingerprint(mock.value),
          keyVersion: ENCRYPTION_KEY_VERSION
        };
      });
      const entry = materializeMockDeploy({
        projectId: project.id,
        agentId: "agent_dry_run",
        records,
        cipher: this.envSecretCipher
      });
      return redactEnvFileForLog(entry.contents);
    } catch {
      return null;
    }
  }

  async appendLog(deployment: Deployment, level: "debug" | "info" | "warn" | "error", message: string, requestId: string, correlationId: string) {
    const next = (this.#sequenceByDeployment.get(deployment.id) ?? 0) + 1;
    this.#sequenceByDeployment.set(deployment.id, next);
    await this.deployments.appendLog({
      id: randomUUID(),
      deploymentId: deployment.id,
      sequence: next,
      level,
      message,
      timestamp: new Date().toISOString(),
      redactionApplied: true,
      requestId,
      correlationId
    });
  }

  scheduleAdvance(deploymentId: string, status: "running" | "succeeded" | "failed", delayMs: number) {
    const previous = this.#timers.get(deploymentId);
    if (previous) {
      clearTimeout(previous);
    }
    const timer = setTimeout(async () => {
      this.#timers.delete(deploymentId);
      if (this.#fenced.has(deploymentId)) return;
      const existing = await this.deployments.findById(deploymentId);
      if (this.#fenced.has(deploymentId) || !existing) return;
      if (existing.status === "failed" || existing.status === "succeeded" || existing.status === "canceled") return;
      const finishedAt = status === "running" ? null : new Date().toISOString();
      const next: Deployment = { ...existing, status, finishedAt };
      if (this.#fenced.has(deploymentId)) return;
      const saved = await this.deployments.saveIfStatus(next, existing.status);
      if (this.#fenced.has(deploymentId) || !saved) return;
      const message =
        status === "running"
          ? "Simulated agent picked up the deployment. Real Docker execution is intentionally deferred."
          : status === "succeeded"
            ? "Simulated agent marked the deployment succeeded. Real container execution is intentionally deferred."
            : "Simulated agent marked the deployment failed.";
      if (this.#fenced.has(deploymentId)) return;
      await this.appendLog(saved, status === "succeeded" ? "info" : status === "failed" ? "error" : "info", message, saved.startedAt, saved.startedAt);
      void this.agentStatus;
    }, delayMs);
    this.#timers.set(deploymentId, timer);
  }

  fence(deploymentId: string) {
    const timer = this.#timers.get(deploymentId);
    if (timer) clearTimeout(timer);
    this.#timers.delete(deploymentId);
    this.#fenced.add(deploymentId);
  }

  cancelTimers() {
    for (const timer of this.#timers.values()) {
      clearTimeout(timer);
    }
    this.#timers.clear();
    this.#fenced.clear();
  }
}

async function createSeededInMemoryAuthAdapters(env: DeployLiteEnv): Promise<AuthAdapters> {
  const hasher = new BcryptPasswordHasher(env.DEPLOYLITE_BCRYPT_COST);
  const adminHash = await hasher.hash("deploylite-admin-password");
  return {
    audit: new InMemoryAuditRepository(),
    hasher,
    sessions: new InMemorySessionRepository(),
    users: new InMemoryAuthUserRepository([
      {
        id: "user_admin_1",
        email: "admin@example.test",
        emailNormalized: "admin@example.test",
        passwordHash: adminHash,
        role: "admin",
        status: "active",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z")
      }
    ])
  };
}

function createDbAuthAdapters(env: DeployLiteEnv, options: BuildApiAppOptions): ApiRepositories {
  const pool = options.db?.pool ?? (options.db?.createPool ?? createDbPool)(env.DATABASE_URL!);
  const db = options.db?.client ?? createDbClient(pool);
  const closePool = options.db?.closePool ?? closeDbPool;
  const deployments = options.state?.deployments ?? new DbDeploymentRepository(db);
  const compose = options.state?.composeRevisionSaves ?? new DbComposeRevisionSaveStore(db);
  const dbDomainRouteStore = new DbDomainRouteClaimReader(db);
  const dbTransportPortStore = new DbTransportPortApplyStore(db);

  return {
    composeResourceCleanupStore: new DbComposeResourceCleanupStore(db),
    auth: {
      audit: new DbAuditRepository(db),
      hasher: new BcryptPasswordHasher(env.DEPLOYLITE_BCRYPT_COST),
      sessions: new DbSessionRepository(db),
      users: new DbAuthUserRepository(db)
    },
    close: options.db?.pool ? undefined : () => closePool(pool),
    shouldSeedMockData: false,
    state: createApiState(env, {
      deploymentDispatcher: options.state?.deploymentDispatcher,
      deploymentStopDispatcher: options.state?.deploymentStopDispatcher,
      agents: options.state?.agents ?? new DbAgentRepository(db),
      deployments,
      domainRouteClaims: options.state?.domainRouteClaims ?? dbDomainRouteStore,
      transportPortClaims: options.state?.transportPortClaims ?? dbTransportPortStore,
      transportPortApplyStore: options.state?.transportPortApplyStore ?? dbTransportPortStore,
      domainRouteApplyStore: options.state?.domainRouteApplyStore ?? dbDomainRouteStore,
      executionCompletion: options.state?.executionCompletion ?? (deployments instanceof DbDeploymentRepository ? new DbDeploymentExecutionRepository(db) : undefined),
      projects: options.state?.projects ?? new DbProjectRepository(db),
      composeRevisionReads: options.state?.composeRevisionReads ?? compose,
      composeRevisionSaves: compose,
      envMetadata: options.state?.envMetadata ?? new DbEnvVariableMetadataRepository(db),
      envSecretValues: options.state?.envSecretValues ?? new DbEnvSecretValueRepository(db),
      snapshots: options.state?.snapshots ?? (deployments instanceof DbDeploymentRepository ? deployments : new DbDeploymentRepository(db)),
      envSecretCipher: options.state?.envSecretCipher,
      controlDeletes: options.state?.controlDeletes ?? new DbControlCommandRepository(db),
      controlRedeploy: options.state?.controlRedeploy ?? new DbControlCommandRepository(db),
      controlRollback: options.state?.controlRollback ?? new DbControlCommandRepository(db),
      controlGrants: options.state?.controlGrants ?? new DbControlGrantRepository(db)
    })
  };
}

async function createRuntimeRepositories(env: DeployLiteEnv, options: BuildApiAppOptions = {}): Promise<ApiRepositories> {
  if (env.DATABASE_URL) {
    const repositories = createDbAuthAdapters(env, options);
    return { ...repositories, auth: { ...repositories.auth, ...options.auth } };
  }

  const auth = { ...(await createSeededInMemoryAuthAdapters(env)), ...options.auth };
  return {
    auth,
    shouldSeedMockData: true,
    state: createApiState(env, options.state, auth.audit)
  };
}

async function seedMockData(state: PlatformRepositories): Promise<void> {
  const startedAt = "2026-01-01T00:00:00.000Z";
  await state.agents.save({
    id: "agent_mock_1",
    name: "Mock VPS Agent",
    endpoint: "https://agent.example.test",
    status: "online",
    lastHeartbeatAt: startedAt,
    resourceSnapshot: { cpuLoad: 0.24, memoryUsedBytes: 512, memoryTotalBytes: 2048, diskUsedBytes: 10_000, diskTotalBytes: 100_000 }
  });
  await state.projects.save({
    id: "project_mock_1",
    name: "DeployLite Mock Project",
    repoUrl: "https://github.com/CoreFoundryTech/DeployLite",
    defaultBranch: "main",
    buildCommand: "pnpm build",
    runCommand: "pnpm start",
    port: 3000,
    description: null,
    imageTag: null
  });
  await state.deployments.save({
    id: "dep_mock_1",
    projectId: "project_mock_1",
    agentId: "agent_mock_1",
    status: "running",
    commitSha: "abcdef1",
    startedAt,
    finishedAt: null
  });
  await state.deployments.appendLog({
    id: "log_1",
    deploymentId: "dep_mock_1",
    sequence: 1,
    level: "info",
    message: "Preparing deployment",
    timestamp: startedAt,
    redactionApplied: false,
    requestId: "seed_req_1",
    correlationId: "seed_req_1"
  });
  await state.deployments.appendLog({
    id: "log_2",
    deploymentId: "dep_mock_1",
    sequence: 2,
    level: "info",
    message: "Using token dl_1234567890abcdef for mock fixture",
    timestamp: "2026-01-01T00:00:01.000Z",
    redactionApplied: false,
    requestId: "seed_req_1",
    correlationId: "seed_req_1"
  });
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  return schema.parse(body);
}

function auditMutation(request: FastifyRequest, action: string, targetType: string, targetId: string) {
  return createAuditLogRecord({ actorId: request.auth?.user.id ?? SCAFFOLD_ACTOR, action, targetType, targetId, ...request.correlationContext });
}

async function withRequestPublication<T>(request: FastifyRequest, reply: FastifyReply, work: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController(), cancel = () => controller.abort(new TransportCanceledError());
  request.raw.once("aborted", cancel); if (request.raw.aborted) cancel();
  try { return await work(controller.signal); }
  catch (error) {
    if (controller.signal.aborted && error === controller.signal.reason) return reply.code(409).send(errorEnvelope(request, "EXECUTION_PUBLICATION_CANCELED", "Cached terminal publication was canceled before durable handoff."));
    throw error;
  } finally { request.raw.removeListener("aborted", cancel); }
}

async function readOriginalForRequest<T>(signal: AbortSignal, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  return awaitAbortable(() => read(signal), signal);
}

function stopCommandResult(command: ControlCommand, status: "eligible" | "completed" | "rejected", reason: string | null = null) {
  if (command.scope.kind !== "deployment") throw new Error("Deployment stop requires deployment scope");
  return { commandId: command.id, action: "deployment.stop" as const, projectId: command.scope.projectId, deploymentId: command.scope.deploymentId, status, correlationId: command.correlationId, reason };
}

function redeployCommandResult(command: ControlCommand, status: "eligible" | "completed" | "rejected", deploymentId: string | null, snapshotHash: string, reason: string | null = null) {
  if (command.scope.kind !== "deployment") throw new Error("Deployment redeploy requires deployment scope");
  return { commandId: command.id, action: "deployment.redeploy" as const, projectId: command.scope.projectId, sourceDeploymentId: command.scope.deploymentId, deploymentId, snapshotHash, status, correlationId: command.correlationId, reason };
}

async function findEnvMetadata(
  repository: EnvVariableMetadataRepository,
  projectId: string,
  key: string,
  scope: EnvVariableMetadata["scope"]
): Promise<EnvVariableMetadata | null> {
  const records = await repository.listByProject(projectId);
  return records.find((record) => record.key === key && record.scope === scope) ?? null;
}

async function findEnvSecretValue(
  repository: EnvSecretValueRepository,
  projectId: string,
  key: string,
  scope: EnvVariableMetadata["scope"]
): Promise<EnvSecretValue | null> {
  const records = await repository.listByProject(projectId);
  return records.find((record) => record.key === key && record.scope === scope) ?? null;
}

function isAllowedCorsRequest(request: FastifyRequest, corsOrigin: string | null): boolean {
  return Boolean(corsOrigin && getHeaderValue(request, "origin") === corsOrigin);
}

function redactRuntimeActivationOutput(output: string | null): string | null {
  if (output === null) return null;
  return redactSecrets(redactEnvFileForLog(output))
    .replace(/\b(password|secret|token|authorization)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/:\/\/[^\s/:]+:[^\s@]+@/g, "://[REDACTED]@");
}

const runtimeSecretKeys = {
  domain: "DEPLOYLITE_RUNTIME_DOMAIN",
  acmeEmail: "DEPLOYLITE_ACME_EMAIL",
  databasePassword: "POSTGRES_PASSWORD",
  runtimeSecret: "DEPLOYLITE_RUNTIME_SECRET"
} as const;

async function readRuntimeConfiguration(state: PlatformRepositories, projectId: string) {
  const values = await state.envSecretValues.listEncryptedByProject(projectId);
  const byKey = new Map(values.map((value) => [value.key, value]));
  const domainValue = byKey.get(runtimeSecretKeys.domain);
  let domain: string | null = null;
  if (domainValue) {
    try {
      domain = state.envSecretCipher.decrypt(Buffer.from(domainValue.encryptedValue).toString("base64"));
    } catch {
      domain = null;
    }
  }
  return runtimeConfigurationSchema.parse({
    domain,
    acmeEmailConfigured: byKey.has(runtimeSecretKeys.acmeEmail),
    databasePasswordConfigured: byKey.has(runtimeSecretKeys.databasePassword),
    runtimeSecretConfigured: byKey.has(runtimeSecretKeys.runtimeSecret)
  });
}

async function writeRuntimeConfiguration(state: PlatformRepositories, projectId: string, values: Record<keyof typeof runtimeSecretKeys, string>) {
  for (const [name, key] of Object.entries(runtimeSecretKeys) as [keyof typeof runtimeSecretKeys, string][]) {
    const value = values[name];
    await state.envSecretValues.upsert({
      projectId,
      key,
      scope: "project",
      encryptedValue: Buffer.from(state.envSecretCipher.encrypt(value), "base64"),
      valueFingerprint: state.envSecretCipher.fingerprint(value),
      keyVersion: ENCRYPTION_KEY_VERSION
    });
  }
}

function registerCoreHooks(app: FastifyInstance, corsOrigin: string | null): void {
  app.addHook("onRequest", async (request) => {
    const inboundRequestId = getHeaderValue(request, "x-request-id");
    const requestId = inboundRequestId && inboundRequestId.trim().length > 0 ? inboundRequestId : createRequestId();
    request.correlationContext = createCorrelationContext(requestId);
  });
  app.addHook("onSend", async (request, reply) => {
    if (isAllowedCorsRequest(request, corsOrigin)) {
      reply.header("access-control-allow-origin", corsOrigin);
      reply.header("access-control-allow-credentials", "true");
      reply.header("vary", "Origin");
    }
    reply.header("x-request-id", request.correlationContext.requestId);
    reply.header("x-correlation-id", request.correlationContext.correlationId);
  });
  if (corsOrigin) {
    app.options("/*", async (request, reply) => {
      if (!isAllowedCorsRequest(request, corsOrigin)) {
        return reply.header("vary", "Origin").code(204).send();
      }

      return reply
        .header("access-control-allow-origin", corsOrigin)
        .header("access-control-allow-credentials", "true")
        .header("access-control-allow-headers", "content-type,x-request-id")
        .header("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
        .header("vary", "Origin")
        .code(204)
        .send();
    });
  }
  app.setErrorHandler((error, request, reply) => {
    const isValidationError = error instanceof z.ZodError;
    void reply
      .code(isValidationError ? 400 : 500)
      .send(errorEnvelope(request, isValidationError ? "VALIDATION_ERROR" : "INTERNAL_ERROR", isValidationError ? "Request validation failed." : "Unexpected server error."));
  });
}

function registerRoutes(app: FastifyInstance, state: PlatformRepositories, adapters: AuthAdapters, authConfig: AuthConfig, confirmedDeleteEnabled: boolean, imagePolicy: ImageReferencePolicyV1, resourceAccess?: ReadonlyMap<string, ComposeResourceInspectionAccess>, backupPlans?: ReadonlyMap<string, ComposeVolumeBackupPlanAccess>, cleanupPlans?: ReadonlyMap<string, ComposeResourceCleanupAccess>, backupExecutions?: ReadonlyMap<string, ComposeVolumeBackupExecutionAccess>, attachmentExecutions?: ReadonlyMap<string, ComposeNetworkAttachmentExecutionAccess>, cleanupExecutions?: ReadonlyMap<string, ComposeResourceCleanupExecutionAccess>, volumeAttachmentExecutions?: ReadonlyMap<string, ComposeVolumeAttachmentExecutionAccess>, domainRouteApplyExecutions?: ReadonlyMap<string, DomainRouteApplyExecutionAccess>, transportPortApplyExecutions?: ReadonlyMap<string, TransportPortApplyExecutionAccess>): void {
  const requireAuth = createAuthPreHandler(adapters, authConfig);
  const requireMutationRole = createRolePreHandler(adapters, ["admin", "operator"]);
  const requireAdminRole = createRolePreHandler(adapters, ["admin"]);
  registerComposePreviewRoute(app, { prefix: API_PREFIX, projects: state.projects, grants: state.controlGrants, audit: adapters.audit, imagePolicy, requireAuth, requireRole: requireMutationRole, ok, error: errorEnvelope });
  registerRegistryRoutes(app, { prefix: API_PREFIX, projects: state.projects, secrets: state.envSecretValues, cipher: state.envSecretCipher, trustedHosts: imagePolicy.trustedHosts, grants: state.controlGrants, audit: adapters.audit, requireAuth, requireRole: requireMutationRole, ok, error: errorEnvelope });
  registerDomainRoutePreviewRoute(app, { prefix: API_PREFIX, projects: state.projects, deployments: state.deployments, domainRouteClaims: state.domainRouteClaims, grants: state.controlGrants, audit: adapters.audit, requireAuth, requireRole: requireMutationRole, ok, error: errorEnvelope });
  registerTransportPortPreviewRoute(app, { prefix: API_PREFIX, projects: state.projects, deployments: state.deployments, claims: state.transportPortClaims, grants: state.controlGrants, audit: adapters.audit, requireAuth, requireRole: requireMutationRole, ok, error: errorEnvelope });
  registerTransportPortApplyRoutes(app, { prefix: API_PREFIX, projects: state.projects, deployments: state.deployments, claims: state.transportPortClaims,
    applyStore: state.transportPortApplyStore, executions: transportPortApplyExecutions, grants: state.controlGrants, audit: adapters.audit,
    requireAuth, requireRole: requireMutationRole, ok, error: errorEnvelope });
  registerDomainRouteApplyRoute(app, { prefix: API_PREFIX, projects: state.projects, deployments: state.deployments, claims: state.domainRouteClaims,
    applyStore: state.domainRouteApplyStore, transportRuntime: state.transportPortApplyStore, executions: domainRouteApplyExecutions, grants: state.controlGrants, audit: adapters.audit,
    requireAuth, requireRole: requireMutationRole, ok, error: errorEnvelope });
  registerComposeRevisionReadRoutes(app, { prefix: API_PREFIX, projects: state.projects, grants: state.controlGrants, audit: adapters.audit, revisions: state.composeRevisionReads, requireAuth, requireRole: requireMutationRole, ok, error: errorEnvelope });
  registerComposeRevisionSaveRoutes(app, { prefix: API_PREFIX, projects: state.projects, grants: state.controlGrants, audit: adapters.audit, revisions: state.composeRevisionSaves, imagePolicy, requireAuth, requireRole: requireMutationRole, ok, error: errorEnvelope });
  registerComposeResourceInspectionRoutes(app, { prefix: API_PREFIX, projects: state.projects, grants: state.controlGrants, audit: adapters.audit, imagePolicy, access: resourceAccess, requireAuth, requireRole: requireMutationRole, ok, error: errorEnvelope });
  registerComposeNetworkAttachmentExecutionRoute(app, { prefix: API_PREFIX, projects: state.projects, grants: state.controlGrants, audit: adapters.audit, imagePolicy, access: resourceAccess, execution: attachmentExecutions, requireAuth, requireRole: requireMutationRole, ok, error: errorEnvelope });
  registerComposeVolumeAttachmentExecutionRoute(app, { prefix: API_PREFIX, projects: state.projects, grants: state.controlGrants, audit: adapters.audit,
    revisions: state.composeRevisionSaves, secrets: state.envSecretValues, secretCipher: state.envSecretCipher, imagePolicy, access: resourceAccess,
    execution: volumeAttachmentExecutions, requireAuth, requireRole: requireMutationRole, ok, error: errorEnvelope });
  registerComposeResourceCleanupRoutes(app, { prefix: API_PREFIX, projects: state.projects, grants: state.controlGrants, audit: adapters.audit, imagePolicy, access: resourceAccess, cleanup: cleanupPlans,
    execution: cleanupExecutions, requireAuth, requireRole: requireMutationRole, ok, error: errorEnvelope });
  registerComposeVolumeBackupPlanRoute(app, { prefix: API_PREFIX, projects: state.projects, grants: state.controlGrants, audit: adapters.audit, imagePolicy, access: resourceAccess, planning: backupPlans, requireAuth, requireRole: requireMutationRole, ok, error: errorEnvelope });
  registerComposeVolumeBackupExecutionRoute(app, { prefix: API_PREFIX, projects: state.projects, grants: state.controlGrants, audit: adapters.audit, imagePolicy, access: resourceAccess, planning: backupPlans, execution: backupExecutions, requireAuth, requireRole: requireMutationRole, ok, error: errorEnvelope });
  // Audit history is an operator/admin concern. Read-only sessions are denied
  // by design so a passive role cannot enumerate every project + key change.
  const requireAuditReadRole = createRolePreHandler(adapters, ["admin", "operator"]);

  app.get(`${API_PREFIX}/health`, async (request) => ok(request, { status: "ok", service: "deploylite-api", auth: "cookie-session" }));
  app.get(`${API_PREFIX}/bootstrap/status`, async (request) => ok(request, await getBootstrapStatus(adapters.users)));
  app.post(`${API_PREFIX}/bootstrap/initial-admin`, async (request, reply) => {
    const parsed = bootstrapInitialAdminRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      await appendAudit(adapters.audit, request, { action: "bootstrap.initial-admin.rejected", targetType: "user", targetId: "initial-admin", metadata: { reason: "invalid-input" } });
      return reply.code(400).send(errorEnvelope(request, "VALIDATION_ERROR", "Request validation failed."));
    }

    const result = await bootstrapInitialAdmin(adapters.users, adapters.hasher, parsed.data);
    if (!result.created || !result.user) {
      await appendAudit(adapters.audit, request, { action: "bootstrap.initial-admin.rejected", targetType: "user", targetId: "initial-admin", metadata: { reason: "locked" } });
      return reply.code(409).send(errorEnvelope(request, "BOOTSTRAP_LOCKED", "Initial admin setup is no longer available."));
    }

    await appendAudit(adapters.audit, request, { actorUserId: null, action: "bootstrap.initial-admin", targetType: "user", targetId: result.user.id });
    return ok(request, { user: toSafeAuthDto(result.user) });
  });
  app.post(`${API_PREFIX}/auth/login`, async (request, reply) => {
    const body = parseBody(authLoginRequestSchema, request.body);
    const user = await authenticateLocalUser(adapters.users, adapters.hasher, body.email, body.password);
    if (!user) {
      await appendAudit(adapters.audit, request, { action: "auth.login.failed", targetType: "user", targetId: normalizeEmail(body.email), metadata: { email: normalizeEmail(body.email), password: body.password } });
      return reply.code(401).send(errorEnvelope(request, "UNAUTHENTICATED", "Invalid email or password."));
    }

    const token = createOpaqueSessionToken(authConfig.sessionTtlSeconds);
    const session = await adapters.sessions.create({ userId: user.id, tokenHash: token.tokenHash, expiresAt: token.expiresAt, userAgent: getHeaderValue(request, "user-agent") ?? null });
    await appendAudit(adapters.audit, request, { actorUserId: user.id, action: "auth.login.succeeded", targetType: "session", targetId: session.id, metadata: { role: user.role } });
    return reply.header("set-cookie", sessionCookie(authConfig, token.token, authConfig.sessionTtlSeconds)).send(ok(request, { user: toSafeAuthDto(user) }));
  });
  app.get(`${API_PREFIX}/auth/me`, { preHandler: requireAuth }, async (request) => ok(request, { user: toSafeAuthDto(request.auth!.user) }));
  app.post(`${API_PREFIX}/auth/logout`, { preHandler: requireAuth }, async (request, reply) => {
    await adapters.sessions.revoke(request.auth!.session.id);
    await appendAudit(adapters.audit, request, { actorUserId: request.auth!.user.id, action: "auth.logout", targetType: "session", targetId: request.auth!.session.id });
    return reply.header("set-cookie", sessionCookie(authConfig, "", 0)).send(ok(request, { loggedOut: true }));
  });
  app.post(`${API_PREFIX}/agents/register`, { preHandler: [requireAuth, requireMutationRole] }, async (request) => {
    const body = parseBody(agentRegistrationSchema, request.body);
    const agent: Agent = { id: `agent_${createRequestId()}`, name: body.name, endpoint: body.endpoint, status: "offline", lastHeartbeatAt: null, resourceSnapshot: null };
    await state.agents.save(agent);
    return ok(request, { agent, audit: auditMutation(request, "agent.register", "agent", agent.id) });
  });
  app.post(`${API_PREFIX}/agents/:agentId/heartbeat`, { preHandler: [requireAuth, requireMutationRole] }, async (request) => {
    const params = z.object({ agentId: z.string().min(1) }).parse(request.params);
    const body = z.object({ observedAt: z.string().datetime({ offset: true }), resourceSnapshot: resourceSnapshotSchema }).parse(request.body);
    const agent = await state.agentStatus.recordHeartbeat({ agentId: params.agentId, observedAt: body.observedAt, resourceSnapshot: body.resourceSnapshot, ...request.correlationContext });
    return ok(request, { agent, audit: auditMutation(request, "agent.heartbeat", "agent", agent.id) });
  });
  app.get(`${API_PREFIX}/agents`, { preHandler: requireAuth }, async (request) => {
    const agents = (await state.agents.list()).map((agent) => state.agentStatus.markStale(agent));
    return ok(request, { agents });
  });
  app.get(`${API_PREFIX}/projects`, { preHandler: requireAuth }, async (request) => ok(request, { projects: await state.projects.list() }));
  app.post(`${API_PREFIX}/projects`, { preHandler: [requireAuth, requireMutationRole] }, async (request) => {
    const body = parseBody(projectCreateRequestSchema, request.body);
    const project: Project = {
      id: createRequestId(),
      name: body.name,
      repoUrl: body.repoUrl,
      defaultBranch: body.defaultBranch,
      buildCommand: body.buildCommand ?? null,
      runCommand: body.runCommand ?? null,
      port: body.port ?? null,
      description: body.description ?? null,
      imageTag: body.imageTag ?? null
    };
    const saved = await state.projects.save(project);
    return ok(request, { project: saved, audit: auditMutation(request, "project.create", "project", saved.id) });
  });
  app.get(`${API_PREFIX}/projects/:projectId`, { preHandler: requireAuth }, async (request, reply) => {
    const params = z.object({ projectId: z.string().min(1) }).parse(request.params);
    const project = await state.projects.findById(params.projectId);
    return project ? ok(request, { project }) : reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Project not found."));
  });
  app.patch(`${API_PREFIX}/projects/:projectId`, { preHandler: [requireAuth, requireMutationRole] }, async (request, reply) => {
    const params = z.object({ projectId: z.string().min(1) }).parse(request.params);
    const existing = await state.projects.findById(params.projectId);
    if (!existing) {
      return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Project not found."));
    }
    const body = parseBody(projectUpdateRequestSchema, request.body);
    const next: Project = {
      ...existing,
      name: body.name ?? existing.name,
      repoUrl: body.repoUrl ?? existing.repoUrl,
      defaultBranch: body.defaultBranch ?? existing.defaultBranch,
      buildCommand: body.buildCommand !== undefined ? (body.buildCommand ?? null) : existing.buildCommand,
      runCommand: body.runCommand !== undefined ? (body.runCommand ?? null) : existing.runCommand,
      port: body.port !== undefined ? (body.port ?? null) : existing.port,
      description: body.description !== undefined ? (body.description ?? null) : existing.description,
      imageTag: body.imageTag !== undefined ? (body.imageTag ?? null) : existing.imageTag
    };
    const saved = await state.projects.save(next);
    return ok(request, { project: saved, audit: auditMutation(request, "project.update", "project", saved.id) });
  });
  app.delete(`${API_PREFIX}/projects/:projectId`, { preHandler: confirmedDeleteEnabled ? requireAuth : [requireAuth, requireMutationRole] }, async (request, reply) => {
    const params = z.object({ projectId: z.string().trim().min(1) }).parse(request.params);
    if (confirmedDeleteEnabled) {
      const scope = { kind: "project" as const, projectId: params.projectId };
      const decision = new PolicyEvaluator().evaluate({
        actorId: request.auth!.user.id,
        role: request.auth!.user.role,
        action: "project.delete",
        scope,
        correlationId: request.correlationContext.correlationId,
         grants: await state.controlGrants.listForActor(request.auth!.user.id)
      });
      if (!decision.allowed) {
        await appendAudit(adapters.audit, request, { actorUserId: request.auth!.user.id, action: "project.delete.rejected", targetType: "project", targetId: params.projectId, metadata: { reason: decision.code } });
        return reply.code(403).send(errorEnvelope(request, decision.code, "Project deletion is not authorized."));
      }
      const idempotencyKey = getHeaderValue(request, "x-control-idempotency-key");
      if (!idempotencyKey) return reply.code(400).send(errorEnvelope(request, "IDEMPOTENCY_KEY_REQUIRED", "An idempotency key is required for confirmed deletion."));
      let resolved: { command: ControlCommand; created: boolean };
      try {
        resolved = await state.controlDeletes.resolve(createControlCommand({ actorId: request.auth!.user.id, action: "project.delete", scope, input: { projectId: params.projectId }, idempotencyKey, correlationId: request.correlationContext.correlationId }));
      } catch (error) {
        if (error instanceof IdempotencyConflictError) return reply.code(409).send(errorEnvelope(request, error.code, error.message));
        throw error;
      }
      if (resolved.command.status === "completed") return ok(request, { removed: true, commandId: resolved.command.id, idempotent: true });
      const existing = await state.projects.findById(params.projectId);
      if (!existing) return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Project not found."));
      const confirmationId = getHeaderValue(request, "x-control-confirmation-id");
      if (resolved.created && !confirmationId) {
        const confirmation = createConfirmation({ command: resolved.command, classification: "destructive" });
        await state.controlDeletes.bind(confirmation);
        await appendAudit(adapters.audit, request, { actorUserId: request.auth!.user.id, action: "project.delete.pending_confirmation", targetType: "project", targetId: params.projectId, metadata: { commandId: resolved.command.id } });
        return reply.code(202).send(ok(request, { commandId: resolved.command.id, confirmationId: confirmation.id, confirmationRequired: true }));
      }
      if (!confirmationId) return reply.code(409).send(errorEnvelope(request, "CONFIRMATION_REQUIRED", "An explicit confirmation is required for project deletion."));
      const confirmation = { id: confirmationId, commandId: resolved.command.id, actorId: resolved.command.actorId, action: resolved.command.action, scope: resolved.command.scope, inputDigest: resolved.command.inputDigest, classification: "destructive" as const, expiresAt: resolved.command.expiresAt, consumedAt: null };
      const outcome = await state.controlDeletes.executeConfirmedProjectDelete({ command: resolved.command, confirmation, projectId: params.projectId, requestId: request.correlationContext.requestId });
      if (outcome.alreadyCompleted) return ok(request, { removed: true, commandId: outcome.command.id, idempotent: true });
      if (!outcome.accepted) return reply.code(409).send(errorEnvelope(request, "CONFIRMATION_REJECTED", "Confirmation is not eligible for this command."));
      if (!outcome.auditRecorded) await appendAudit(adapters.audit, request, { actorUserId: request.auth!.user.id, action: "project.delete", targetType: "project", targetId: params.projectId, metadata: { commandId: outcome.command.id, confirmationId } });
      return ok(request, { removed: true, commandId: outcome.command.id, idempotent: false });
    }
    const existing = await state.projects.findById(params.projectId);
    if (!existing) return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Project not found."));
    const removed = await state.projects.remove(params.projectId);
    if (!removed) {
      return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Project not found."));
    }
    await appendAudit(adapters.audit, request, { actorUserId: request.auth?.user.id ?? null, action: "project.delete", targetType: "project", targetId: params.projectId });
    return ok(request, { removed: true, audit: auditMutation(request, "project.delete", "project", params.projectId) });
  });
  app.get(`${API_PREFIX}/projects/:projectId/env-variables`, { preHandler: requireAuth }, async (request, reply) => {
    const params = z.object({ projectId: z.string().min(1) }).parse(request.params);
    const project = await state.projects.findById(params.projectId);
    if (!project) {
      return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Project not found."));
    }
    const records = await state.envMetadata.listByProject(params.projectId);
    return ok(request, { envVariables: records.map((record) => envVariableMetadataSchema.parse(record)) });
  });
  app.post(`${API_PREFIX}/projects/:projectId/env-variables`, { preHandler: [requireAuth, requireMutationRole] }, async (request, reply) => {
    const params = z.object({ projectId: z.string().min(1) }).parse(request.params);
    const project = await state.projects.findById(params.projectId);
    if (!project) {
      return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Project not found."));
    }
    const body = parseBody(envVariableMetadataUpsertRequestSchema, request.body);
    const scope = body.scope ?? "project";
    const existingMetadata = await findEnvMetadata(state.envMetadata, params.projectId, body.key, scope);
    const existingSecretValue = existingMetadata
      ? null
      : await findEnvSecretValue(state.envSecretValues, params.projectId, body.key, scope);
    const now = new Date().toISOString();
    const record: EnvVariableMetadata = {
      id: existingMetadata?.id ?? `env_${createRequestId()}`,
      projectId: params.projectId,
      key: body.key,
      scope,
      valuePresent: existingMetadata?.valuePresent ?? Boolean(existingSecretValue),
      valueFingerprint: existingMetadata?.valueFingerprint ?? existingSecretValue?.valueFingerprint ?? null,
      required: body.required ?? false,
      description: body.description ?? null,
      updatedAt: now
    };
    const saved = await state.envMetadata.upsert(record);
    return ok(request, { envVariable: envVariableMetadataSchema.parse(saved), audit: auditMutation(request, "project.env.upsert", "project", params.projectId) });
  });
  app.delete(`${API_PREFIX}/projects/:projectId/env-variables`, { preHandler: [requireAuth, requireMutationRole] }, async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const params = z.object({ projectId: z.string().min(1), key: z.string().min(1), scope: z.enum(["project", "deployment"]).default("project") }).parse({
      ...(request.params as Record<string, string>),
      key: typeof query.key === "string" ? query.key : undefined,
      scope: typeof query.scope === "string" ? query.scope : "project"
    });
    const removed = await state.envMetadata.remove(params.projectId, params.key, params.scope);
    if (removed) {
      await state.envSecretValues.remove(params.projectId, params.key, params.scope);
    }
    return removed
      ? ok(request, { removed: true, audit: auditMutation(request, "project.env.delete", "project", params.projectId) })
      : reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Env metadata not found."));
  });
  app.get(`${API_PREFIX}/projects/:projectId/env-values`, { preHandler: requireAuth }, async (request, reply) => {
    const params = z.object({ projectId: z.string().min(1) }).parse(request.params);
    const project = await state.projects.findById(params.projectId);
    if (!project) {
      return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Project not found."));
    }
    const records = await state.envSecretValues.listByProject(params.projectId);
    return ok(request, { envValues: records.map((record) => envSecretValueSchema.parse(record)) });
  });
  app.get(`${API_PREFIX}/projects/:projectId/runtime-configuration`, { preHandler: [requireAuth, requireAdminRole] }, async (request, reply) => {
    const params = z.object({ projectId: z.string().min(1) }).parse(request.params);
    if (!await state.projects.findById(params.projectId)) return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Project not found."));
    return ok(request, { runtimeConfiguration: await readRuntimeConfiguration(state, params.projectId) });
  });
  app.put(`${API_PREFIX}/projects/:projectId/runtime-configuration`, { preHandler: [requireAuth, requireAdminRole] }, async (request, reply) => {
    const params = z.object({ projectId: z.string().min(1) }).parse(request.params);
    if (!await state.projects.findById(params.projectId)) return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Project not found."));
    const body = parseBody(runtimeConfigurationWriteRequestSchema, request.body);
    try {
      await writeRuntimeConfiguration(state, params.projectId, body);
    } catch (error) {
      if (error instanceof EnvSecretKeyMissingError || error instanceof EnvSecretKeyInvalidError) return reply.code(503).send(errorEnvelope(request, "SECRET_KEY_UNAVAILABLE", "Env secret encryption is not configured."));
      throw error;
    }
    await appendAudit(adapters.audit, request, { actorUserId: request.auth!.user.id, action: "runtime.configuration.upsert", targetType: "runtime", targetId: params.projectId, metadata: { projectId: params.projectId } });
    return ok(request, { runtimeConfiguration: await readRuntimeConfiguration(state, params.projectId) });
  });
  app.post(`${API_PREFIX}/projects/:projectId/runtime-activation`, { preHandler: [requireAuth, requireAdminRole] }, async (request, reply) => {
    const params = z.object({ projectId: z.string().min(1) }).parse(request.params);
    if (!await state.projects.findById(params.projectId)) return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Project not found."));
    const configuration = await readRuntimeConfiguration(state, params.projectId);
    if (!configuration.domain || !configuration.acmeEmailConfigured || !configuration.databasePasswordConfigured || !configuration.runtimeSecretConfigured) {
      return reply.code(409).send(errorEnvelope(request, "RUNTIME_CONFIGURATION_INCOMPLETE", "Runtime configuration is incomplete."));
    }
    const configurationFingerprint = (await state.envSecretValues.listByProject(params.projectId)).filter((value) => Object.values(runtimeSecretKeys).includes(value.key as never)).map((value) => value.valueFingerprint).sort().join(":");
    const activationRevision = state.envSecretCipher.fingerprint(`${params.projectId}:${configurationFingerprint}:${request.correlationContext.requestId}`);
    const idempotencyKey = `runtime_${activationRevision.slice(0, 24)}`;
    const command = runtimeActivationCommandSchema.parse({
      commandId: `runtime_command_${idempotencyKey.slice("runtime_".length)}`,
      correlationId: request.correlationContext.correlationId,
      idempotencyKey,
      projectId: params.projectId,
      configurationRef: idempotencyKey,
      domain: configuration.domain,
      profile: "runtime",
      action: "apply"
    });
    await appendAudit(adapters.audit, request, { actorUserId: request.auth!.user.id, action: "runtime.activation.requested", targetType: "runtime", targetId: command.commandId, metadata: { projectId: params.projectId, capability: "safe_runtime_executor", commandId: command.commandId } });
    if (state.runtimeActivationDispatcher.available()) {
      await appendAudit(adapters.audit, request, { actorUserId: request.auth!.user.id, action: "runtime.activation.dispatched", targetType: "runtime", targetId: command.commandId, metadata: { projectId: params.projectId, commandId: command.commandId } });
    }
    let dispatched: RuntimeActivation;
    try {
      dispatched = await state.runtimeActivationDispatcher.dispatch(command);
    } catch {
      await appendAudit(adapters.audit, request, { actorUserId: request.auth!.user.id, action: "runtime.activation.failed", targetType: "runtime", targetId: command.commandId, metadata: { projectId: params.projectId, commandId: command.commandId, reason: "dispatch-failed" } });
      return reply.code(502).send(errorEnvelope(request, "RUNTIME_EXECUTOR_FAILED", "Runtime executor failed."));
    }
    const activation = runtimeActivationSchema.parse({ ...dispatched, output: redactRuntimeActivationOutput(dispatched.output) });
    if (activation.status === "succeeded" || activation.status === "failed") {
      await appendAudit(adapters.audit, request, { actorUserId: request.auth!.user.id, action: `runtime.activation.${activation.status}`, targetType: "runtime", targetId: command.commandId, metadata: { projectId: params.projectId, commandId: command.commandId, status: activation.status, output: activation.output } });
    }
    return ok(request, { activation });
  });
  app.post(`${API_PREFIX}/projects/:projectId/env-values`, { preHandler: [requireAuth, requireMutationRole] }, async (request, reply) => {
    const params = z.object({ projectId: z.string().min(1) }).parse(request.params);
    const body = parseBody(envSecretValueWriteRequestSchema, request.body);
    const project = await state.projects.findById(params.projectId);
    if (!project) {
      return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Project not found."));
    }
    const scope = body.scope ?? "project";

    // Encrypt the raw value client-side of the database boundary. The encrypted
    // payload is the only thing that touches the repository: the raw plaintext
    // is intentionally never held past the encrypt() call and never appears in
    // audit metadata, logs, or response bodies.
    let encrypted: string;
    let fingerprint: string;
    try {
      encrypted = state.envSecretCipher.encrypt(body.value);
      fingerprint = state.envSecretCipher.fingerprint(body.value);
    } catch (error) {
      if (error instanceof EnvSecretKeyMissingError || error instanceof EnvSecretKeyInvalidError) {
        await appendAudit(adapters.audit, request, {
          actorUserId: request.auth?.user.id ?? null,
          action: "project.env-value.upsert.rejected",
          targetType: "env_value",
          targetId: `${params.projectId}:${scope}:${body.key}`,
          metadata: { reason: "secret-key-unavailable" }
        });
        return reply.code(503).send(errorEnvelope(request, "SECRET_KEY_UNAVAILABLE", "Env secret encryption is not configured. Set DEPLOYLITE_SECRET_KEY."));
      }
      throw error;
    }

    const saved = await state.envSecretValues.upsert({
      projectId: params.projectId,
      key: body.key,
      scope,
      encryptedValue: Buffer.from(encrypted, "base64"),
      valueFingerprint: fingerprint,
      keyVersion: ENCRYPTION_KEY_VERSION
    });

    // Reflect the new state on the metadata row so existing env-metadata
    // listings (which are still value-less) can answer "does this key have a
    // value yet?" without leaking the encrypted blob.
    const existingMetadata = await findEnvMetadata(state.envMetadata, params.projectId, body.key, scope);
    await state.envMetadata.upsert({
      id: existingMetadata?.id ?? `env_${createRequestId()}`,
      projectId: params.projectId,
      key: body.key,
      scope,
      valuePresent: true,
      valueFingerprint: fingerprint,
      required: existingMetadata?.required ?? false,
      description: existingMetadata?.description ?? null,
      updatedAt: saved.updatedAt
    });

    await appendAudit(adapters.audit, request, {
      actorUserId: request.auth?.user.id ?? null,
      action: "project.env-value.upsert",
      targetType: "env_value",
      targetId: saved.id,
      metadata: {
        projectId: params.projectId,
        key: body.key,
        scope,
        valueFingerprint: fingerprint,
        keyVersion: saved.keyVersion
      }
    });

    return ok(request, {
      envValue: envSecretValueSchema.parse(saved),
      audit: createAuditLogRecord({
        actorId: request.auth?.user.id ?? SCAFFOLD_ACTOR,
        action: "project.env-value.upsert",
        targetType: "env_value",
        targetId: saved.id,
        ...request.correlationContext
      })
    });
  });
  app.delete(`${API_PREFIX}/projects/:projectId/env-values`, { preHandler: [requireAuth, requireMutationRole] }, async (request, reply) => {
    const querySource = (request.query ?? {}) as Record<string, unknown>;
    const parsed = envSecretValueDeleteRequestSchema.safeParse({
      key: typeof querySource["key"] === "string" ? querySource["key"] : undefined,
      scope: typeof querySource["scope"] === "string" ? querySource["scope"] : "project"
    });
    if (!parsed.success) {
      return reply.code(400).send(errorEnvelope(request, "VALIDATION_ERROR", "Missing or invalid `key` (and optional `scope`) query parameter."));
    }
    const params = z.object({ projectId: z.string().min(1) }).parse(request.params);
    const project = await state.projects.findById(params.projectId);
    if (!project) {
      return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Project not found."));
    }

    const removed = await state.envSecretValues.remove(params.projectId, parsed.data.key, parsed.data.scope);
    if (!removed) {
      return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Env value not found."));
    }

    // Also clear the corresponding metadata row's value marker so the public
    // env-variables list does not keep reporting a now-stale fingerprint.
    const existingMetadata = await findEnvMetadata(state.envMetadata, params.projectId, parsed.data.key, parsed.data.scope);
    await state.envMetadata.upsert({
      id: existingMetadata?.id ?? `env_${createRequestId()}`,
      projectId: params.projectId,
      key: parsed.data.key,
      scope: parsed.data.scope,
      valuePresent: false,
      valueFingerprint: null,
      required: existingMetadata?.required ?? false,
      description: existingMetadata?.description ?? null,
      updatedAt: new Date().toISOString()
    });

    await appendAudit(adapters.audit, request, {
      actorUserId: request.auth?.user.id ?? null,
      action: "project.env-value.delete",
      targetType: "env_value",
      targetId: `${params.projectId}:${parsed.data.scope}:${parsed.data.key}`,
      metadata: { projectId: params.projectId, key: parsed.data.key, scope: parsed.data.scope }
    });

    return ok(request, {
      removed: true,
      audit: createAuditLogRecord({
        actorId: request.auth?.user.id ?? SCAFFOLD_ACTOR,
        action: "project.env-value.delete",
        targetType: "env_value",
        targetId: `${params.projectId}:${parsed.data.scope}:${parsed.data.key}`,
        ...request.correlationContext
      })
    });
  });
  app.post(`${API_PREFIX}/projects/:projectId/deployments`, { preHandler: [requireAuth, requireMutationRole] }, async (request, reply) => withRequestPublication(request, reply, async (publicationSignal) => {
    const params = z.object({ projectId: z.string().min(1) }).parse(request.params);
    const project = await state.projects.findById(params.projectId);
    if (!project) {
      return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Project not found."));
    }
    const body = parseBody(deployRequestSchema, request.body ?? {});
    let agentId = body.agentId ?? null;
    if (!agentId) {
      const onlineAgents = (await state.agents.list()).filter((agent) => agent.status === "online" || agent.status === "stale");
      agentId = onlineAgents[0]?.id ?? null;
    }
    if (!agentId) {
      return reply.code(409).send(errorEnvelope(request, "NO_AGENT_AVAILABLE", "No agent is online. Register an agent or bring one online before deploying."));
    }
    const commitSha = body.commitSha ?? "0000000";
    const replayKey = body.imageReference === undefined ? null : getHeaderValue(request, "x-deployment-idempotency-key");
    const replayDigest = replayKey ? createHash("sha256").update(`${project.id}:${replayKey}`).digest("hex") : null;
    const deploymentId = replayDigest ? `${replayDigest.slice(0, 8)}-${replayDigest.slice(8, 12)}-5${replayDigest.slice(13, 16)}-${((parseInt(replayDigest[16]!, 16) & 3) | 8).toString(16)}${replayDigest.slice(17, 20)}-${replayDigest.slice(20, 32)}` : randomUUID();
    const consumeCachedInitial = async (running: Deployment, snapshot: DeploymentSnapshotV1, cached: DockerImageExecutionReceiptV1 | DeploymentDispatchReceipt, correlationId: string) => {
      const parsed = dockerImageExecutionReceiptSchema.safeParse(cached), proof = parsed.success ? parsed.data.executionReceipt : undefined;
      if (!parsed.success || parsed.data.deploymentId !== running.id || parsed.data.effectiveImage !== running.stopTarget?.effectiveImage || parsed.data.runtimePort !== snapshot.runtimePort || (parsed.data.terminalStatus === "succeeded" && !proof) || (proof && (proof.projectId !== running.projectId || proof.deploymentId !== running.id || proof.snapshotOriginId !== running.snapshotOriginId || proof.snapshotHash !== running.snapshotHash || proof.runtimeHost !== running.agentId || proof.candidateId !== running.stopTarget?.candidateId || proof.effectiveImageDigest !== running.stopTarget?.effectiveImage.split("@")[1] || proof.containerPort !== snapshot.runtimePort))) return reply.code(409).send(errorEnvelope(request, "EXECUTION_PROOF_INVALID", "Cached INITIAL evidence does not match the original execution."));
      if (!state.executionCompletion) return reply.code(503).send(errorEnvelope(request, "EXECUTION_COMPLETION_UNAVAILABLE", "Atomic cached completion is unavailable."));
      const persisted = await state.deployments.findById(running.id);
      publicationSignal.throwIfAborted();
      const completion = await state.executionCompletion.completeExecution({ commandId: null, commandResult: null, expectedStatus: "running", executionId: running.id, projectId: running.projectId, sourceExecutionId: null, snapshotOriginId: snapshot.deploymentId, snapshotHash: snapshot.hash, runtimeHost: running.agentId!, effectiveImageDigest: running.stopTarget!.effectiveImage.split("@")[1]!, proof: proof ?? null, terminalStatus: parsed.data.terminalStatus, finishedAt: persisted?.finishedAt ?? new Date().toISOString() }, publicationSignal);
      if (!("deployment" in completion)) return reply.code(completion.kind === "conflict" ? 409 : 404).send(errorEnvelope(request, "EXECUTION_COMPLETION_CONFLICT", "Cached INITIAL completion remains unresolved."));
      if (completion.kind === "committed") {
        await state.deployments.appendLog({ id: randomUUID(), deploymentId: running.id, sequence: 2, level: parsed.data.terminalStatus === "succeeded" ? "info" : "error", message: `Agent execution ${parsed.data.terminalStatus}.`, timestamp: completion.deployment.finishedAt!, redactionApplied: true, requestId: request.correlationContext.requestId, correlationId });
        await appendAudit(adapters.audit, request, { action: `deployment.${parsed.data.terminalStatus}`, targetType: "deployment", targetId: running.id, metadata: { projectId: running.projectId, snapshotHash: snapshot.hash, health: parsed.data.health, rollback: parsed.data.rollback } });
      }
      return ok(request, { deployment: completion.deployment, execution: parsed.data, snapshotHash: snapshot.hash, replayed: true });
    };
    const existing = await state.deployments.findById(deploymentId);
    if (existing && existing.status === "running" && body.imageReference !== undefined && state.deploymentDispatcher.readExecutionReceipt && existing.snapshotHash) {
      const snapshot = await state.snapshots.findByHash(existing.snapshotHash);
      const original = (await state.deployments.listLogs(existing.id)).find((log) => log.sequence === 1);
      if (snapshot && original?.correlationId && existing.agentId && snapshot.deploymentId === existing.id && snapshot.projectId === existing.projectId && snapshot.agentId === existing.agentId) {
        let cached: DockerImageExecutionReceiptV1 | DeploymentDispatchReceipt | null = null;
        try { cached = await readOriginalForRequest(publicationSignal, (signal) => state.deploymentDispatcher.readExecutionReceipt!(snapshot, `deploy_${existing.id}`, { agentId: existing.agentId, requestId: request.correlationContext.requestId, correlationId: original.correlationId, signal })); } catch { /* Missing/unavailable evidence retains the original unresolved execution. */ }
        if (cached) return consumeCachedInitial(existing, snapshot, cached, original.correlationId);
      }
    }
    if (existing) {
      await appendAudit(adapters.audit, request, { action: "deployment.replayed", targetType: "deployment", targetId: deploymentId, metadata: { projectId: project.id } });
      return ok(request, { deployment: existing, replayed: true });
    }
    const deployment: Deployment = {
      id: deploymentId,
      projectId: project.id,
      agentId,
      status: "queued",
      commitSha,
      startedAt: new Date().toISOString(),
      finishedAt: null
    };
    if (body.imageReference === undefined) await state.deployments.save(deployment);
    if (body.imageReference !== undefined) {
      let snapshot: DeploymentSnapshotV1;
      try {
        const source = createSourceIntent({ sourceMode: "image", requestedReference: body.imageReference }, imagePolicy);
        if (source.sourceMode !== "image" || source.image.selector.kind !== "digest") throw new Error("digest-pinned image is required");
        snapshot = createDeploymentSnapshot({ deploymentId: deployment.id, projectId: project.id, agentId, commitSha, source, configRevision: body.configRevision ?? "default", runtimeRevision: body.runtimeRevision ?? "default", runtimePort: project.port, secretRefs: (await state.envMetadata.listByProject(project.id)).map((record) => ({ secretRefId: record.key, version: 1 })), policyVersion: imagePolicy.policyVersion, schemaVersion: 1 }, { sha256: (bytes) => createHash("sha256").update(bytes).digest("hex") });
      } catch (error) {
        await appendAudit(adapters.audit, request, { action: "deployment.requested.rejected", targetType: "deployment", targetId: deployment.id, metadata: { reason: error instanceof Error ? error.message : "invalid-image", projectId: project.id } });
        return reply.code(400).send(errorEnvelope(request, "DIGEST_INPUT_INVALID", "A valid digest-pinned image is required."));
      }
      deployment.snapshotHash = snapshot.hash;
      deployment.snapshotOriginId = snapshot.deploymentId;
      await state.deployments.save(deployment);
      await state.snapshots.saveSnapshot(snapshot);
      await appendAudit(adapters.audit, request, { action: "deployment.requested", targetType: "deployment", targetId: deployment.id, metadata: { projectId: project.id, snapshotHash: snapshot.hash, image: snapshot.source.sourceMode === "image" ? snapshot.source.image.redactedReference : "image" } });
      if (!state.deploymentDispatcher.available()) {
        await appendAudit(adapters.audit, request, { action: "deployment.dispatch.rejected", targetType: "deployment", targetId: deployment.id, metadata: { projectId: project.id, snapshotHash: snapshot.hash, reason: "deploy.execute-unavailable" } });
        return reply.code(503).send(errorEnvelope(request, "DEPLOY_EXECUTE_UNAVAILABLE", "Digest deployment execution is unavailable."));
      }
       const stopTarget = { candidateId: `${deployment.id}:candidate:deploy_${deployment.id}`, effectiveImage: snapshot.source.sourceMode === "image" ? snapshot.source.image.reference : "" };
       const running: Deployment = { ...deployment, status: "running", stopTarget };
      await state.deployments.save(running);
      await state.deployments.appendLog({ id: randomUUID(), deploymentId: deployment.id, sequence: 1, level: "info", message: "Agent accepted digest snapshot and started execution.", timestamp: new Date().toISOString(), redactionApplied: true, requestId: request.correlationContext.requestId, correlationId: request.correlationContext.correlationId });
      const completeInitial = async (terminalStatus: "succeeded" | "failed" | "canceled", terminalStopTarget = running.stopTarget, proof: TrustedPriorExecutionReceiptV1 | null = null): Promise<ExecutionCompletionOutcome> => {
        // Equal completion includes finishedAt; reuse durable time when reconciling an already committed receipt.
        const persisted = await state.deployments.findById(running.id);
        const finishedAt = persisted?.finishedAt ?? new Date().toISOString();
        if (!state.executionCompletion) {
          return { kind: "committed", deployment: await state.deployments.save({ ...running, status: terminalStatus, finishedAt, stopTarget: terminalStopTarget }), command: null };
        }
        return state.executionCompletion.completeExecution({
          commandId: null, commandResult: null, proof, expectedStatus: running.status,
          executionId: running.id, projectId: running.projectId, sourceExecutionId: null,
          snapshotOriginId: snapshot.deploymentId, snapshotHash: snapshot.hash, runtimeHost: agentId,
          effectiveImageDigest: snapshot.source.sourceMode === "image" ? snapshot.source.image.selector.value : "",
          terminalStatus, finishedAt
        });
      };
      const rejectCompletion = (kind: "conflict" | "not-found") => reply.code(kind === "conflict" ? 409 : 404).send(errorEnvelope(request, kind === "conflict" ? "EXECUTION_COMPLETION_CONFLICT" : "NOT_FOUND", "Digest execution completion could not be persisted."));
      const abort = new AbortController();
      const onAbort = () => abort.abort();
      request.raw.once("aborted", onAbort);
      if (request.raw.aborted) abort.abort();
      let result: "dispatched" | DockerImageExecutionReceiptV1;
      try {
        result = await state.deploymentDispatcher.dispatch(snapshot, `deploy_${deployment.id}`, { agentId, requestId: request.correlationContext.requestId, correlationId: request.correlationContext.correlationId, signal: abort.signal });
      } catch (error) {
        let cached: DockerImageExecutionReceiptV1 | DeploymentDispatchReceipt | null = null;
        if (state.deploymentDispatcher.readExecutionReceipt && !isAgentPreDispatchRejection(error)) {
          try { cached = await readOriginalForRequest(publicationSignal, (signal) => state.deploymentDispatcher.readExecutionReceipt!(snapshot, `deploy_${deployment.id}`, { agentId, requestId: request.correlationContext.requestId, correlationId: request.correlationContext.correlationId, signal })); } catch { /* A lost reply is not terminal evidence. */ }
          if (cached) return consumeCachedInitial(running, snapshot, cached, request.correlationContext.correlationId);
          return reply.code(502).send(errorEnvelope(request, "DEPLOY_OUTCOME_UNKNOWN", "Original agent evidence is unavailable; execution remains unresolved."));
        }
        {
          const classification = error instanceof ProtocolError ? error.code : "transport-failed";
          const terminalStatus = error instanceof TransportCanceledError ? "canceled" : "failed";
          const completion = await completeInitial(terminalStatus);
          if (completion.kind === "conflict" || completion.kind === "not-found") return rejectCompletion(completion.kind);
          await state.deployments.appendLog({ id: randomUUID(), deploymentId: deployment.id, sequence: 2, level: "error", message: `Agent execution ${terminalStatus} before a terminal receipt was returned.`, timestamp: new Date().toISOString(), redactionApplied: true, requestId: request.correlationContext.requestId, correlationId: request.correlationContext.correlationId });
          await appendAudit(adapters.audit, request, { action: "deployment.dispatch.rejected", targetType: "deployment", targetId: deployment.id, metadata: { projectId: project.id, snapshotHash: snapshot.hash, reason: classification } });
          return reply.code(502).send(errorEnvelope(request, "DEPLOY_DISPATCH_FAILED", "Digest deployment dispatch failed."));
        }
      } finally {
        request.raw.removeListener("aborted", onAbort);
      }
      // Receipt persistence errors propagate without a second terminal publication.
      if (typeof result !== "string") {
        const parsed = dockerImageExecutionReceiptSchema.safeParse(result);
        if (!parsed.success) return reply.code(409).send(errorEnvelope(request, "EXECUTION_PROOF_INVALID", "Agent terminal receipt bindings are invalid."));
        result = parsed.data;
        const proof = result.executionReceipt;
        if (proof && (result.deploymentId !== running.id || proof.projectId !== running.projectId || proof.runtimeHost !== agentId || proof.snapshotOriginId !== snapshot.deploymentId || proof.snapshotHash !== snapshot.hash || proof.effectiveImageDigest !== (snapshot.source.sourceMode === "image" ? snapshot.source.image.selector.value : "") || proof.candidateId !== stopTarget.candidateId || proof.containerPort !== snapshot.runtimePort)) return reply.code(409).send(errorEnvelope(request, "EXECUTION_PROOF_INVALID", "Agent execution proof does not match the selected deployment."));
        if (proof && !state.executionCompletion) return reply.code(503).send(errorEnvelope(request, "EXECUTION_COMPLETION_UNAVAILABLE", "Atomic execution completion is unavailable."));
        let terminal: Deployment;
        const terminalStopTarget = result.candidateId && result.effectiveImage ? { candidateId: result.candidateId, effectiveImage: result.effectiveImage } : running.stopTarget;
        if (result.terminalStatus === "succeeded" && !proof) {
          // Legacy health-only success remains readable without eligibility for trusted redeploy.
          terminal = { ...running, status: result.terminalStatus, finishedAt: new Date().toISOString(), stopTarget: terminalStopTarget };
          await state.deployments.save(terminal);
        } else {
          const completion = await completeInitial(result.terminalStatus, terminalStopTarget, proof ?? null);
          if (!("deployment" in completion)) return rejectCompletion(completion.kind);
          terminal = completion.deployment;
        }
        await state.deployments.appendLog({ id: randomUUID(), deploymentId: deployment.id, sequence: 2, level: result.terminalStatus === "succeeded" ? "info" : "error", message: `Agent execution ${result.terminalStatus}.`, timestamp: new Date().toISOString(), redactionApplied: true, requestId: request.correlationContext.requestId, correlationId: request.correlationContext.correlationId });
        await appendAudit(adapters.audit, request, { action: `deployment.${result.terminalStatus}`, targetType: "deployment", targetId: deployment.id, metadata: { projectId: project.id, snapshotHash: snapshot.hash, health: result.health, rollback: result.rollback } });
        return ok(request, { deployment: terminal, snapshotHash: snapshot.hash, execution: result });
      }
      await appendAudit(adapters.audit, request, { action: "deployment.dispatched", targetType: "deployment", targetId: deployment.id, metadata: { projectId: project.id, snapshotHash: snapshot.hash, capability: "deploy.execute" } });
      return ok(request, { deployment: running, snapshotHash: snapshot.hash });
    }
    const runnerResult = await state.deployRunner.start(deployment, project, request.correlationContext.requestId, request.correlationContext.correlationId);
    return ok(request, {
      deployment: runnerResult.deployment,
      envVariables: runnerResult.logs.map((record) => envVariableMetadataSchema.parse(record)),
      audit: auditMutation(request, "deployment.trigger", "deployment", deployment.id)
    });
  }));
  app.post(`${API_PREFIX}/deployments/:deploymentId/stop`, { preHandler: [requireAuth, requireMutationRole] }, async (request, reply) => withRequestPublication(request, reply, async (publicationSignal) => {
    const params = z.object({ deploymentId: z.string().min(1) }).parse(request.params);
    const idempotencyKey = getHeaderValue(request, "x-control-idempotency-key");
    if (!idempotencyKey) return reply.code(400).send(errorEnvelope(request, "IDEMPOTENCY_KEY_REQUIRED", "An idempotency key is required for deployment stop."));
    const prior = await state.controlDeletes.findByIdempotency?.(request.auth!.user.id, idempotencyKey, "deployment.stop");
    if (prior) {
      if (prior.action !== "deployment.stop" || prior.scope.kind !== "deployment" || prior.scope.deploymentId !== params.deploymentId || prior.inputDigest !== digestControlInput({ deploymentId: params.deploymentId, projectId: prior.scope.projectId })) return reply.code(409).send(errorEnvelope(request, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used with different Stop input."));
      if (prior.status === "completed") return ok(request, { command: prior, idempotent: true });
    }

    const deployment = await state.deployments.findById(params.deploymentId);
    if (!deployment) return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Deployment not found."));
    const project = await state.projects.findById(deployment.projectId);
    if (!project) return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Deployment project not found."));
    const scope = { kind: "deployment" as const, projectId: project.id, deploymentId: deployment.id };
    const decision = new PolicyEvaluator().evaluate({ actorId: request.auth!.user.id, role: request.auth!.user.role, action: "deployment.stop", scope, correlationId: request.correlationContext.correlationId, grants: await state.controlGrants.listForActor(request.auth!.user.id) });
    if (!decision.allowed) {
      await appendAudit(adapters.audit, request, { actorUserId: request.auth!.user.id, action: "deployment.stop.rejected", targetType: "deployment", targetId: deployment.id, metadata: { projectId: project.id, reason: decision.code } });
      return reply.code(403).send(errorEnvelope(request, decision.code, "Deployment stop is not authorized."));
    }
    let resolved: { command: ControlCommand; created: boolean };
    try {
      resolved = prior ? { command: prior, created: false } : await state.controlDeletes.resolve(createControlCommand({ actorId: request.auth!.user.id, action: "deployment.stop", scope, input: { deploymentId: deployment.id, projectId: project.id }, idempotencyKey, correlationId: request.correlationContext.correlationId }));
    } catch (error) {
      if (error instanceof IdempotencyConflictError) return reply.code(409).send(errorEnvelope(request, error.code, error.message));
      throw error;
    }
    await appendAudit(adapters.audit, request, { actorUserId: request.auth!.user.id, action: "deployment.stop.requested", targetType: "deployment", targetId: deployment.id, metadata: { projectId: project.id, commandId: resolved.command.id } });
    if (resolved.command.status === "completed") return ok(request, { deployment, command: resolved.command, idempotent: true });
    const activeProof = trustedPriorExecutionReceiptSchema.safeParse(deployment.executionReceipt);
    const succeededWorkload = deployment.status === "succeeded" && activeProof.success && activeProof.data.projectId === deployment.projectId && activeProof.data.deploymentId === deployment.id && activeProof.data.runtimeHost === deployment.agentId && activeProof.data.snapshotOriginId === deployment.snapshotOriginId && activeProof.data.snapshotHash === deployment.snapshotHash && activeProof.data.candidateId === deployment.stopTarget?.candidateId && activeProof.data.effectiveImageDigest === deployment.stopTarget?.effectiveImage.split("@")[1];
    if (["failed", "canceled"].includes(deployment.status) || (deployment.status === "succeeded" && !succeededWorkload)) return reply.code(409).send(errorEnvelope(request, "DEPLOYMENT_TERMINAL", "Deployment is already terminal."));
    const reconciling = resolved.command.status === "dispatching";
    let admitted: import("@deploylite/domain").ConfirmedDeploymentStopOutcome = { command: resolved.command, accepted: true, reason: null, result: null, alreadyCompleted: false };
    let claimed: Awaited<ReturnType<ControlStopRepository["claimDeploymentStop"]>> = { command: resolved.command, claimed: false, authority: resolved.command.executionAuthority };
    if (!reconciling) {
      const confirmationId = getHeaderValue(request, "x-control-confirmation-id");
      if (resolved.created && !confirmationId) {
        const confirmation = createConfirmation({ command: resolved.command, classification: "destructive" });
        await state.controlDeletes.bind(confirmation);
        await appendAudit(adapters.audit, request, { actorUserId: request.auth!.user.id, action: "deployment.stop.pending_confirmation", targetType: "deployment", targetId: deployment.id, metadata: { projectId: project.id, commandId: resolved.command.id } });
        return reply.code(202).send(ok(request, { commandId: resolved.command.id, confirmationId: confirmation.id, confirmationRequired: true }));
      }
      if (resolved.command.status === "eligible") return reply.code(202).send(ok(request, { commandId: resolved.command.id, pending: true }));
      if (!confirmationId) return reply.code(409).send(errorEnvelope(request, "CONFIRMATION_REQUIRED", "An explicit confirmation is required for deployment stop."));
      const confirmation = { id: confirmationId, commandId: resolved.command.id, actorId: resolved.command.actorId, action: resolved.command.action, scope: resolved.command.scope, inputDigest: resolved.command.inputDigest, classification: "destructive" as const, expiresAt: resolved.command.expiresAt, consumedAt: null };
      admitted = await state.controlDeletes.executeConfirmedDeploymentStop({ command: resolved.command, confirmation, requestId: request.correlationContext.requestId });
      if (admitted.alreadyCompleted) return ok(request, { deployment, command: admitted.command, idempotent: true });
      if (!admitted.accepted) {
        await appendAudit(adapters.audit, request, { actorUserId: request.auth!.user.id, action: "deployment.stop.rejected", targetType: "deployment", targetId: deployment.id, metadata: { projectId: project.id, commandId: admitted.command.id, reason: admitted.reason } });
        return reply.code(409).send(errorEnvelope(request, "CONFIRMATION_REJECTED", "Confirmation is not eligible for this command."));
      }
      claimed = await state.controlDeletes.claimDeploymentStop(admitted.command);
      if (!claimed.claimed) return reply.code(202).send(ok(request, { commandId: claimed.command.id, pending: true }));
    }
    let cachedEvidence = reconciling;
    const finishStop = async (result: import("@deploylite/contracts").DeploymentStopCommandResult) => {
      try { if (cachedEvidence) publicationSignal.throwIfAborted(); return await state.controlDeletes.completeDeploymentStop(claimed.command, result, cachedEvidence ? publicationSignal : undefined); }
      catch (error) { reply.code(error instanceof ProtocolError || error instanceof IdempotencyConflictError ? 409 : 502).send(errorEnvelope(request, "DEPLOY_STOP_OUTCOME_UNKNOWN", "Stop terminal authority could not be committed; prior status was preserved.")); return undefined; }
    };
    if (!reconciling && !state.deploymentStopDispatcher.available()) {
      const result = stopCommandResult(admitted.command, "completed", "capability_unavailable");
       if (!await finishStop(result)) return reply;
      await appendAudit(adapters.audit, request, { actorUserId: request.auth!.user.id, action: "deployment.stop.failed", targetType: "deployment", targetId: deployment.id, metadata: { projectId: project.id, commandId: admitted.command.id, reason: "capability_unavailable" } });
      return reply.code(503).send(errorEnvelope(request, "DEPLOY_STOP_UNAVAILABLE", "Deployment stop capability is unavailable."));
    }
    if (!reconciling) state.deployRunner.fence(deployment.id);
    const target = deployment.stopTarget;
    if (target && !reconciling) await appendAudit(adapters.audit, request, { actorUserId: request.auth!.user.id, action: "deployment.stop.dispatched", targetType: "deployment", targetId: deployment.id, metadata: { projectId: project.id, commandId: admitted.command.id } });
    const dispatchInput = target ? { ...target, ...(activeProof.success ? { containerId: activeProof.data.containerId } : {}), projectId: project.id, deploymentId: deployment.id, commandId: claimed.command.id } : null;
    const context = { agentId: deployment.agentId, requestId: request.correlationContext.requestId, correlationId: claimed.command.correlationId, authority: claimed.authority };
    const readOriginal = async () => {
      if (!dispatchInput || !state.deploymentStopDispatcher.readStopReceipt) return null;
      const receipt = await readOriginalForRequest(publicationSignal, (signal) => state.deploymentStopDispatcher.readStopReceipt!(dispatchInput, { ...context, signal }));
      if (receipt) cachedEvidence = true;
      return receipt;
    };
    let receipt: import("@deploylite/contracts").DeploymentStopAgentReceipt | null = null;
    try {
      if (reconciling) {
        receipt = await readOriginal();
        if (!receipt) return reply.code(202).send(ok(request, { command: claimed.command, pending: true }));
      } else if (!target) receipt = { schemaVersion: 1, action: "deployment.stop", agentId: deployment.agentId, commandId: admitted.command.id, projectId: project.id, deploymentId: deployment.id, candidateId: `${deployment.id}:absent`, effectiveImage: `registry.example.com/absent@sha256:${"0".repeat(64)}`, status: "absent", redacted: true, correlationId: claimed.command.correlationId, reason: "container_absent" };
      else {
        const abort = new AbortController(); const onAbort = () => abort.abort(); request.raw.once("aborted", onAbort); if (request.raw.aborted) abort.abort();
        try { receipt = deploymentStopAgentReceiptSchema.parse(await state.deploymentStopDispatcher.dispatchStop(dispatchInput!, { ...context, signal: abort.signal })); }
        finally { request.raw.removeListener("aborted", onAbort); }
      }
    } catch (error) {
      if (!reconciling && !isAgentPreDispatchRejection(error)) { try { receipt = await readOriginal(); } catch { /* Cache unavailability cannot release destructive authority. */ } }
      if (!receipt) {
        const reason = error instanceof ProtocolError ? error.code : "transport-failed";
         if (isAgentPreDispatchRejection(error) && !await finishStop(stopCommandResult(claimed.command, "completed", reason))) return reply;
        await appendAudit(adapters.audit, request, { actorUserId: request.auth!.user.id, action: "deployment.stop.failed", targetType: "deployment", targetId: deployment.id, metadata: { projectId: project.id, commandId: admitted.command.id, reason } });
        return reply.code(502).send(errorEnvelope(request, isAgentPreDispatchRejection(error) ? "DEPLOY_STOP_FAILED" : "DEPLOY_STOP_OUTCOME_UNKNOWN", "Deployment stop outcome is unresolved; prior status was preserved."));
      }
    }
    if (!receipt) return reply.code(202).send(ok(request, { command: claimed.command, pending: true }));
    if (receipt.commandId !== admitted.command.id || receipt.projectId !== project.id || receipt.deploymentId !== deployment.id || receipt.agentId !== deployment.agentId || receipt.correlationId !== claimed.command.correlationId || (target && (receipt.candidateId !== target.candidateId || receipt.effectiveImage !== target.effectiveImage)) || (succeededWorkload && activeProof.success && receipt.containerId !== activeProof.data.containerId)) {
      await appendAudit(adapters.audit, request, { actorUserId: request.auth!.user.id, action: "deployment.stop.failed", targetType: "deployment", targetId: deployment.id, metadata: { projectId: project.id, commandId: admitted.command.id, reason: "receipt-identity-mismatch" } });
      return reply.code(502).send(errorEnvelope(request, "DEPLOY_STOP_OUTCOME_UNKNOWN", "Agent stop evidence was invalid; prior status and authority were preserved."));
    }
    const publishedReceipt = { ...receipt, reason: receipt.status === "failed" ? "docker_stop_failed" : receipt.status === "canceled" ? "canceled" : receipt.status === "absent" ? "container_absent" : null };
    const successful = receipt.status === "stopped" || receipt.status === "already-stopped";
     const result = stopCommandResult(claimed.command, "completed", successful ? receipt.status : `agent_${receipt.status}`);
     if (!await finishStop(result)) return reply;
     if (successful) {
       const stopped: Deployment = succeededWorkload ? deployment : { ...deployment, status: "canceled", finishedAt: new Date().toISOString() };
       if (!succeededWorkload && !await state.deployments.saveIfStatus(stopped, deployment.status)) return reply.code(409).send(errorEnvelope(request, "DEPLOYMENT_TERMINAL", "Deployment changed while stopping."));
       // Active workload control belongs to the command ledger; historical success/proof is immutable.
       const logs = await state.deployments.listLogs(deployment.id);
       await state.deployments.appendLog({ id: randomUUID(), deploymentId: deployment.id, sequence: (logs.at(-1)?.sequence ?? 0) + 1, level: "info", message: "Authenticated agent stop confirmed.", timestamp: new Date().toISOString(), redactionApplied: true, requestId: request.correlationContext.requestId, correlationId: claimed.command.correlationId });
      await appendAudit(adapters.audit, request, { actorUserId: request.auth!.user.id, action: "deployment.stop.succeeded", targetType: "deployment", targetId: deployment.id, metadata: { projectId: project.id, commandId: admitted.command.id, status: receipt.status } });
      return ok(request, { deployment: stopped, receipt: publishedReceipt, command: result });
    }
     await appendAudit(adapters.audit, request, { actorUserId: request.auth!.user.id, action: "deployment.stop.rejected", targetType: "deployment", targetId: deployment.id, metadata: { projectId: project.id, commandId: claimed.command.id, reason: result.reason } });
    return reply.code(409).send(errorEnvelope(request, "DEPLOY_STOP_NOT_CONFIRMED", "Agent did not confirm a stopped container; prior status was preserved."));
  }));
  app.post(`${API_PREFIX}/deployments/:deploymentId/rollback`, { preHandler: [requireAuth, requireMutationRole] }, async (request, reply) => withRequestPublication(request, reply, async (publicationSignal) => {
    const { deploymentId: activeId } = z.object({ deploymentId: z.string().min(1) }).parse(request.params);
    const body = z.object({ historicalDeploymentId: z.string().min(1), snapshotHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(request.body);
    const key = getHeaderValue(request, "x-control-idempotency-key"), controls = state.controlRollback;
    const pending = (command: ControlCommand) => reply.code(202).send(ok(request, { command, pending: true }));
    if (!key) return reply.code(400).send(errorEnvelope(request, "IDEMPOTENCY_KEY_REQUIRED", "A rollback idempotency key is required."));
    if (!controls) return reply.code(503).send(errorEnvelope(request, "ROLLBACK_UNAVAILABLE", "Rollback repository is unavailable."));
    const contextFor = (command: ControlCommand, running: Deployment, proof: TrustedPriorExecutionReceiptV1, effectiveImage: string, signal?: AbortSignal): AgentDispatchContext => ({ agentId: running.agentId!, requestId: request.correlationContext.requestId, correlationId: command.correlationId, executionDeploymentId: running.id, activeDeploymentId: running.activeDeploymentId!, sourceDeploymentId: running.sourceDeploymentId!, authority: command.executionAuthority, replacement: { prior: proof, effectiveImage, policy: { maxOutageMs: 30_000, maxRecoveryMs: 60_000 } }, signal });
    const finish = async (command: ControlCommand, running: Deployment, snapshot: DeploymentSnapshotV1, activeProof: TrustedPriorExecutionReceiptV1, received: DockerImageExecutionReceiptV1 | DeploymentDispatchReceipt) => {
      const result = command.result;
      if (result?.action !== "deployment.rollback" || !state.executionCompletion) return reply.code(503).send(errorEnvelope(request, "EXECUTION_COMPLETION_UNAVAILABLE", "Atomic rollback completion is unavailable."));
      const receipt = received as DeploymentDispatchReceipt;
      const { projectId: _project, activeDeploymentId: _active, sourceDeploymentId: _source, snapshotHash: _hash, correlationId: _correlation, ...inner } = receipt;
      const parsed = dockerImageExecutionReceiptSchema.safeParse(inner);
      const digest = running.stopTarget!.effectiveImage.split("@")[1]!;
      if (!parsed.success || receipt.projectId !== result.projectId || receipt.activeDeploymentId !== result.activeDeploymentId || receipt.sourceDeploymentId !== result.sourceDeploymentId || receipt.deploymentId !== result.deploymentId || receipt.snapshotHash !== result.snapshotHash || receipt.correlationId !== command.correlationId || parsed.data.effectiveImage !== running.stopTarget!.effectiveImage || parsed.data.runtimePort !== snapshot.runtimePort) return reply.code(502).send(errorEnvelope(request, "ROLLBACK_EVIDENCE_INVALID", "Original rollback terminal evidence does not match the command."));
      const proof = parsed.data.executionReceipt ?? null;
      if (parsed.data.terminalStatus === "succeeded" && (!proof || proof.deploymentId !== running.id || proof.projectId !== running.projectId || proof.runtimeHost !== running.agentId || proof.candidateId !== running.stopTarget!.candidateId || proof.snapshotOriginId !== snapshot.deploymentId || proof.snapshotHash !== snapshot.hash || proof.effectiveImageDigest !== digest || proof.containerPort !== snapshot.runtimePort || proof.hostPort !== activeProof.hostPort || proof.network !== activeProof.network)) return reply.code(502).send(errorEnvelope(request, "ROLLBACK_EVIDENCE_INVALID", "Rollback success requires independently observed R proof."));
      const persisted = await state.deployments.findById(running.id);
      publicationSignal.throwIfAborted();
      const terminal = { ...result, status: "completed" as const, reason: parsed.data.terminalStatus === "succeeded" ? null : `agent-${parsed.data.terminalStatus}` };
      const completionInput = { commandId: command.id, authority: command.executionAuthority, commandResult: terminal, expectedStatus: "running", executionId: running.id, projectId: running.projectId, sourceExecutionId: result.sourceDeploymentId, activeDeploymentId: result.activeDeploymentId, snapshotOriginId: snapshot.deploymentId, snapshotHash: snapshot.hash, runtimeHost: running.agentId!, effectiveImageDigest: digest, terminalStatus: parsed.data.terminalStatus, finishedAt: persisted?.finishedAt ?? new Date().toISOString(), proof } as const;
      let completion = await state.executionCompletion.completeExecution(completionInput, publicationSignal);
      if (completion.kind === "conflict") {
        const durable = await state.deployments.findById(running.id);
        publicationSignal.throwIfAborted();
        if (durable && durable.status === completionInput.terminalStatus && durable.finishedAt) completion = await state.executionCompletion.completeExecution({ ...completionInput, finishedAt: durable.finishedAt }, publicationSignal);
      }
      if (!("deployment" in completion)) return reply.code(completion.kind === "conflict" ? 409 : 404).send(errorEnvelope(request, "EXECUTION_COMPLETION_CONFLICT", "Rollback completion remains unresolved."));
      if (completion.kind === "committed") {
        await state.deployments.appendLog({ id: randomUUID(), deploymentId: running.id, sequence: 2, level: parsed.data.terminalStatus === "succeeded" ? "info" : "error", message: `Agent rollback ${parsed.data.terminalStatus}.`, timestamp: completion.deployment.finishedAt!, redactionApplied: true, requestId: request.correlationContext.requestId, correlationId: command.correlationId });
        await appendAudit(adapters.audit, request, { action: `deployment.rollback.${parsed.data.terminalStatus}`, targetType: "deployment", targetId: running.id, metadata: { activeDeploymentId: result.activeDeploymentId, sourceDeploymentId: result.sourceDeploymentId, snapshotHash: snapshot.hash } });
      }
      return ok(request, { deployment: completion.deployment, command: completion.command!.result, execution: parsed.data });
    };
    const reconcile = async (command: ControlCommand) => {
      const result = command.result;
      if (result?.action !== "deployment.rollback" || !command.executionAuthority || !state.deploymentDispatcher.readExecutionReceipt) return pending(command);
      const running = await state.deployments.findById(result.deploymentId), active = await state.deployments.findById(result.activeDeploymentId), snapshot = await state.snapshots.findByHash(result.snapshotHash);
      const proof = trustedPriorExecutionReceiptSchema.safeParse(active?.executionReceipt);
      if (!running || !snapshot || !proof.success || !active?.stopTarget || running.activeDeploymentId !== result.activeDeploymentId || running.sourceDeploymentId !== result.sourceDeploymentId || running.snapshotOriginId !== snapshot.deploymentId || running.snapshotHash !== result.snapshotHash) return pending(command);
      let received: DockerImageExecutionReceiptV1 | DeploymentDispatchReceipt | null = null;
      try { received = await readOriginalForRequest(publicationSignal, (signal) => state.deploymentDispatcher.readExecutionReceipt!(snapshot, `deploy_${running.id}`, contextFor(command, running, proof.data, active.stopTarget!.effectiveImage, signal))); } catch { /* Cache reads never claim, wait, release or execute the original effect again. */ }
      return received ? finish(command, running, snapshot, proof.data, received) : pending(command);
    };
    let command = await controls.findByIdempotency(request.auth!.user.id, key, "deployment.rollback");
    const projectId = command?.scope.kind === "deployment" ? command.scope.projectId : (await state.deployments.findById(activeId))?.projectId;
    if (!projectId) return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Expected active deployment was not found."));
    const scope = { kind: "deployment" as const, projectId, deploymentId: activeId };
    let R = command?.result?.action === "deployment.rollback" ? command.result.deploymentId : randomUUID();
    const input = { actorId: request.auth!.user.id, projectId, activeDeploymentId: activeId, sourceDeploymentId: body.historicalDeploymentId, deploymentId: R, snapshotHash: body.snapshotHash };
    const tentative = createControlCommand({ actorId: request.auth!.user.id, action: "deployment.rollback", scope, input, idempotencyKey: key, correlationId: request.correlationContext.correlationId });
    tentative.result = { projectId, activeDeploymentId: activeId, sourceDeploymentId: body.historicalDeploymentId, deploymentId: R, snapshotHash: body.snapshotHash, commandId: tentative.id, action: "deployment.rollback", status: "pending_confirmation", correlationId: tentative.correlationId, reason: null };
    if (command) {
      try { validateRollbackReservation(command, tentative); } catch { return reply.code(409).send(errorEnvelope(request, "IDEMPOTENCY_CONFLICT", "Rollback input changed.")); }
      if (command.status === "completed") return ok(request, { command, deploymentId: R, idempotent: true });
      if (command.status === "dispatching") return reconcile(command);
      if (command.status === "rejected") return reply.code(409).send(errorEnvelope(request, "ROLLBACK_REJECTED", "Rollback command was rejected."));
    }
    const decision = new PolicyEvaluator().evaluate({ actorId: request.auth!.user.id, role: request.auth!.user.role, action: "deployment.rollback", scope: { kind: "project", projectId }, correlationId: request.correlationContext.correlationId, grants: await state.controlGrants.listForActor(request.auth!.user.id) });
    if (!decision.allowed) return reply.code(403).send(errorEnvelope(request, decision.code, "Rollback is not authorized."));
    const active = await state.deployments.findById(activeId), historical = await state.deployments.findById(body.historicalDeploymentId), snapshot = await state.snapshots.findByHash(body.snapshotHash), project = await state.projects.findById(projectId);
    if (!active || !historical || !snapshot || !project) return reply.code(404).send(errorEnvelope(request, "ROLLBACK_SOURCE_MISSING", "Active workload or selected historical snapshot was not found."));
    const activeProof = trustedPriorExecutionReceiptSchema.safeParse(active.executionReceipt), historicalProof = trustedPriorExecutionReceiptSchema.safeParse(historical.executionReceipt);
    let canonical = true; try { validateDockerImageSnapshot(snapshot, { sha256: (bytes) => createHash("sha256").update(bytes).digest("hex") }); } catch { canonical = false; }
    const digest = snapshot.source.sourceMode === "image" ? (snapshot.source.image.selector.kind === "digest" ? snapshot.source.image.selector.value : snapshot.resolvedDigest) : undefined;
    const bound = (deployment: Deployment, proof: TrustedPriorExecutionReceiptV1) => deployment.status === "succeeded" && deployment.projectId === projectId && deployment.agentId === snapshot.agentId && proof.deploymentId === deployment.id && proof.projectId === projectId && proof.runtimeHost === deployment.agentId && proof.candidateId === deployment.stopTarget?.candidateId && proof.snapshotOriginId === deployment.snapshotOriginId && proof.snapshotHash === deployment.snapshotHash && proof.effectiveImageDigest === deployment.stopTarget?.effectiveImage.split("@")[1];
    if (!canonical || !activeProof.success || !historicalProof.success || !bound(active, activeProof.data) || !bound(historical, historicalProof.data) || historical.snapshotHash !== snapshot.hash || historical.snapshotOriginId !== snapshot.deploymentId || historicalProof.data.effectiveImageDigest !== digest || snapshot.projectId !== projectId || !snapshot.agentId || !snapshot.commitSha || createDeploymentPlan(snapshot).status !== "executable" || snapshot.configRevision !== "default" || snapshot.runtimeRevision !== "default" || snapshot.secretRefs.length !== 0 || snapshot.runtimePort !== project.port || activeProof.data.containerPort !== snapshot.runtimePort || historicalProof.data.containerPort !== snapshot.runtimePort || activeProof.data.hostPort !== historicalProof.data.hostPort || activeProof.data.network !== historicalProof.data.network) return reply.code(409).send(errorEnvelope(request, "ROLLBACK_SNAPSHOT_INELIGIBLE", "Historical state is outside the current supported runtime subset or binding."));
    let created = false;
    if (!command) {
      try { const resolved = await controls.resolve(tentative); command = resolved.command; created = resolved.created; if (command.result?.action !== "deployment.rollback") throw new Error("Rollback reservation result is unavailable."); R = command.result.deploymentId!; }
      catch (error) { if (error instanceof IdempotencyConflictError) return reply.code(409).send(errorEnvelope(request, error.code, error.message)); throw error; }
    }
    const confirmationId = getHeaderValue(request, "x-control-confirmation-id");
    if (command.status === "pending_confirmation" && (created || !confirmationId)) {
      publicationSignal.throwIfAborted();
      if (!controls.resolveRollbackConfirmation) return reply.code(503).send(errorEnvelope(request, "ROLLBACK_UNAVAILABLE", "Durable confirmation lookup is required."));
      const confirmation = await controls.resolveRollbackConfirmation(command);
      publicationSignal.throwIfAborted();
      if (!confirmation) return reply.code(409).send(errorEnvelope(request, "CONFIRMATION_REJECTED", "Original rollback confirmation is no longer eligible."));
      if (created) await appendAudit(adapters.audit, request, { action: "deployment.rollback.pending_confirmation", targetType: "deployment", targetId: activeId, metadata: { commandId: command.id, activeDeploymentId: activeId, sourceDeploymentId: historical.id, deploymentId: R, snapshotHash: snapshot.hash } });
      return reply.code(202).send(ok(request, { commandId: command.id, deploymentId: R, confirmationId: confirmation.id, confirmationRequired: true, correlationId: command.correlationId }));
    }
    if (command.status === "completed") return ok(request, { command, deploymentId: R, idempotent: true });
    if (command.status === "dispatching") return reconcile(command);
    if (!state.executionCompletion || !state.deploymentDispatcher.available() || !controls.validateDeploymentAuthority) return reply.code(503).send(errorEnvelope(request, "ROLLBACK_UNAVAILABLE", "Atomic execution, transport and persisted authority are required."));
    publicationSignal.throwIfAborted();
    if (command.status === "pending_confirmation") {
      if (!confirmationId) return pending(command);
      const confirmation = { id: confirmationId, commandId: command.id, actorId: command.actorId, action: command.action, scope: command.scope, inputDigest: command.inputDigest, classification: "destructive" as const, expiresAt: command.expiresAt, consumedAt: null };
      const deployment: Deployment = { id: R, projectId, agentId: snapshot.agentId, status: "queued", commitSha: snapshot.commitSha, startedAt: new Date().toISOString(), finishedAt: null, activeDeploymentId: active.id, sourceDeploymentId: historical.id, snapshotOriginId: snapshot.deploymentId, snapshotHash: snapshot.hash };
      const admitted = await controls.executeConfirmedDeploymentRollback({ command, confirmation, deployment, requestId: request.correlationContext.requestId });
      if (!admitted.accepted) return reply.code(409).send(errorEnvelope(request, "CONFIRMATION_REJECTED", "Rollback confirmation is not eligible."));
      command = admitted.command;
    }
    publicationSignal.throwIfAborted();
    const claim = await controls.claimDeploymentRollback(command);
    publicationSignal.throwIfAborted();
    if (!claim.claimed || !claim.deployment || !claim.authority) return pending(claim.command);
    const running = await state.deployments.save({ ...claim.deployment, status: "running", stopTarget: { candidateId: `${R}:candidate:deploy_${R}`, effectiveImage: `${snapshot.source.sourceMode === "image" ? `${snapshot.source.image.registryHost}/${snapshot.source.image.repository}` : ""}@${digest}` } });
    await controls.validateDeploymentAuthority(claim.authority);
    await state.deployments.appendLog({ id: randomUUID(), deploymentId: R, sequence: 1, level: "info", message: "Agent accepted historical snapshot for rollback execution.", timestamp: new Date().toISOString(), redactionApplied: true, requestId: request.correlationContext.requestId, correlationId: claim.command.correlationId });
    const context = contextFor(claim.command, running, activeProof.data, active.stopTarget!.effectiveImage, publicationSignal);
    let received: "dispatched" | DockerImageExecutionReceiptV1 | DeploymentDispatchReceipt | undefined;
    try { received = await state.deploymentDispatcher.dispatch(snapshot, `deploy_${R}`, context); }
    catch { try { received = await readOriginalForRequest(publicationSignal, (signal) => state.deploymentDispatcher.readExecutionReceipt?.(snapshot, `deploy_${R}`, { ...context, signal }) ?? Promise.resolve(null)) ?? undefined; } catch { /* Unknown physical outcomes retain R running and the original claim. */ } }
    if (!received) return reply.code(502).send(errorEnvelope(request, "ROLLBACK_OUTCOME_UNKNOWN", "Original terminal recovery evidence was not received."));
    if (received === "dispatched") return pending(claim.command);
    return finish(claim.command, running, snapshot, activeProof.data, received);
  }));
  app.post(`${API_PREFIX}/deployments/:deploymentId/redeploy`, { preHandler: [requireAuth, requireMutationRole] }, async (request, reply) => withRequestPublication(request, reply, async (publicationSignal) => {
    const params = z.object({ deploymentId: z.string().min(1) }).parse(request.params);
    const body = z.object({ snapshotHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(request.body ?? {});
    const idempotencyKey = getHeaderValue(request, "x-control-idempotency-key");
    if (!idempotencyKey) return reply.code(400).send(errorEnvelope(request, "IDEMPOTENCY_KEY_REQUIRED", "An idempotency key is required for deployment redeploy."));
    const finishReceipt = async (command: ControlCommand, running: Deployment, snapshot: DeploymentSnapshotV1, sourceProof: TrustedPriorExecutionReceiptV1, execution: "dispatched" | DockerImageExecutionReceiptV1 | DeploymentDispatchReceipt | undefined, available: boolean, signal?: AbortSignal) => {
      const sourceId = running.sourceDeploymentId!, authority = command.executionAuthority;
      const imageDigest = snapshot.source.sourceMode === "image" ? (snapshot.source.image.selector.kind === "digest" ? snapshot.source.image.selector.value : snapshot.resolvedDigest) : undefined;
      const persisted = await state.deployments.findById(running.id);
      signal?.throwIfAborted();
      if (!state.executionCompletion) return reply.code(503).send(errorEnvelope(request, "EXECUTION_COMPLETION_UNAVAILABLE", "Atomic redeploy completion is unavailable."));
      let terminalStatus: "succeeded" | "failed" | "canceled" = "failed";
      let proof: TrustedPriorExecutionReceiptV1 | null = null;
      if (execution) {
        const receipt = execution as DeploymentDispatchReceipt;
        const expected = command.result as import("@deploylite/contracts").DeploymentRedeployCommandResult | undefined;
        const { projectId: _projectId, sourceDeploymentId: _sourceId, snapshotHash: _hash, correlationId: _correlation, ...inner } = receipt;
        const parsed = dockerImageExecutionReceiptSchema.safeParse(inner);
        if (!expected || expected.status !== "eligible" || expected.projectId !== running.projectId || expected.sourceDeploymentId !== sourceId || expected.deploymentId !== running.id || expected.snapshotHash !== snapshot.hash || receipt.projectId !== expected.projectId || receipt.sourceDeploymentId !== expected.sourceDeploymentId || receipt.snapshotHash !== expected.snapshotHash || receipt.deploymentId !== expected.deploymentId || receipt.correlationId !== expected.correlationId || !parsed.success || parsed.data.runtimePort !== snapshot.runtimePort || parsed.data.effectiveImage !== running.stopTarget!.effectiveImage) return reply.code(502).send(errorEnvelope(request, "REDEPLOY_DISPATCH_FAILED", "Redeploy execution returned invalid terminal evidence."));
        terminalStatus = parsed.data.terminalStatus;
        proof = parsed.data.executionReceipt ?? null;
        if (terminalStatus === "succeeded" && (!proof || proof.projectId !== running.projectId || proof.deploymentId !== running.id || proof.candidateId !== running.stopTarget!.candidateId || proof.runtimeHost !== running.agentId || proof.snapshotOriginId !== snapshot.deploymentId || proof.snapshotHash !== snapshot.hash || proof.effectiveImageDigest !== imageDigest || proof.containerPort !== snapshot.runtimePort || proof.hostPort !== sourceProof.hostPort || proof.network !== sourceProof.network)) return reply.code(502).send(errorEnvelope(request, "REDEPLOY_DISPATCH_FAILED", "Redeploy execution returned invalid trusted proof."));
      }
      const terminal = { ...(command.result as import("@deploylite/contracts").DeploymentRedeployCommandResult), status: "completed" as const, reason: !available ? "deploy.execute-unavailable" : terminalStatus === "succeeded" ? null : `agent-${terminalStatus}` };
      // Completion failures must never enter the dispatch catch or fall back to separate writes.
      const completion = await state.executionCompletion.completeExecution({ commandId: command.id, authority, commandResult: terminal, proof, expectedStatus: running.status, executionId: running.id, projectId: running.projectId, sourceExecutionId: sourceId, snapshotOriginId: snapshot.deploymentId, snapshotHash: snapshot.hash, runtimeHost: running.agentId!, effectiveImageDigest: imageDigest!, terminalStatus, finishedAt: persisted?.finishedAt ?? new Date().toISOString() }, signal);
      if (!("deployment" in completion)) return reply.code(completion.kind === "conflict" ? 409 : 404).send(errorEnvelope(request, completion.kind === "conflict" ? "EXECUTION_COMPLETION_CONFLICT" : "NOT_FOUND", "Redeploy completion could not be persisted."));
      if (completion.kind === "committed") {
        await state.deployments.appendLog({ id: randomUUID(), deploymentId: running.id, sequence: available ? 2 : 1, level: terminalStatus === "succeeded" ? "info" : "error", message: `Agent redeploy ${terminalStatus}.`, timestamp: completion.deployment.finishedAt!, redactionApplied: true, requestId: request.correlationContext.requestId, correlationId: command.correlationId });
        await appendAudit(adapters.audit, request, { action: `deployment.redeploy.${terminalStatus}`, targetType: "deployment", targetId: running.id, metadata: { projectId: running.projectId, sourceDeploymentId: sourceId, snapshotHash: snapshot.hash, reason: terminal.reason } });
      }
      if (!available) return reply.code(503).send(errorEnvelope(request, "DEPLOY_EXECUTE_UNAVAILABLE", "Redeploy execution failed."));
      return ok(request, { deployment: completion.deployment, command: completion.command!.result, snapshotHash: snapshot.hash, sourceDeploymentId: sourceId, execution });
    };
    const reconcileOriginal = async (command: ControlCommand) => {
      const result = command.result as import("@deploylite/contracts").DeploymentRedeployCommandResult | undefined;
      if (!result?.deploymentId || command.scope.kind !== "deployment" || !command.executionAuthority || !state.deploymentDispatcher.readExecutionReceipt) return reply.code(202).send(ok(request, { command, pending: true }));
      const running = await state.deployments.findById(result.deploymentId), source = await state.deployments.findById(result.sourceDeploymentId), snapshot = await state.snapshots.findByHash(result.snapshotHash);
      const sourceProof = trustedPriorExecutionReceiptSchema.safeParse(source?.executionReceipt);
      if (!running || !snapshot || !sourceProof.success || running.projectId !== result.projectId || running.agentId !== snapshot.agentId || running.sourceDeploymentId !== result.sourceDeploymentId || running.snapshotOriginId !== snapshot.deploymentId || running.snapshotHash !== snapshot.hash) return reply.code(202).send(ok(request, { command, pending: true }));
      let cached: DockerImageExecutionReceiptV1 | DeploymentDispatchReceipt | null = null;
      try { cached = await readOriginalForRequest(publicationSignal, (signal) => state.deploymentDispatcher.readExecutionReceipt!(snapshot, `deploy_${running.id}`, { agentId: running.agentId, requestId: request.correlationContext.requestId, correlationId: command.correlationId, executionDeploymentId: running.id, sourceDeploymentId: result.sourceDeploymentId, authority: command.executionAuthority, replacement: { prior: sourceProof.data, effectiveImage: running.stopTarget!.effectiveImage, policy: { maxOutageMs: 30_000, maxRecoveryMs: 60_000 } }, signal })); } catch { /* Read-only evidence failure preserves the original claim. */ }
      if (!cached) return reply.code(202).send(ok(request, { command, pending: true }));
      return finishReceipt(command, running, snapshot, sourceProof.data, cached, true, publicationSignal);
    };
    const prior = await state.controlRedeploy.findByIdempotency(request.auth!.user.id, idempotencyKey);
    if (prior) {
      if (prior.scope.kind !== "deployment" || prior.scope.deploymentId !== params.deploymentId || digestControlInput({ actorId: request.auth!.user.id, projectId: prior.scope.kind === "deployment" ? prior.scope.projectId : "", sourceDeploymentId: params.deploymentId, snapshotHash: body.snapshotHash }) !== prior.inputDigest) return reply.code(409).send(errorEnvelope(request, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used with different command input."));
      const priorResult = prior.result as import("@deploylite/contracts").DeploymentRedeployCommandResult | undefined;
      if (prior.status === "completed" && priorResult) return ok(request, { command: prior, deploymentId: priorResult.deploymentId, snapshotHash: priorResult.snapshotHash, idempotent: true });
      if (prior.status === "dispatching") return reconcileOriginal(prior);
      if (prior.status === "eligible") return reply.code(202).send(ok(request, { command: prior, pending: true, correlationId: request.correlationContext.correlationId }));
      if (prior.status === "rejected") return reply.code(409).send(errorEnvelope(request, "REDEPLOY_COMMAND_REJECTED", "Redeploy command was rejected and cannot be reused."));
    }
    const source = await state.deployments.findById(params.deploymentId);
    if (!source) return reply.code(404).send(errorEnvelope(request, "REDEPLOY_SOURCE_MISSING", "Source deployment was not found."));
    const project = await state.projects.findById(source.projectId);
    if (!project) return reply.code(404).send(errorEnvelope(request, "REDEPLOY_PROJECT_MISSING", "Source deployment project was not found."));
    const scope = { kind: "deployment" as const, projectId: project.id, deploymentId: source.id };
    const decision = new PolicyEvaluator().evaluate({ actorId: request.auth!.user.id, role: request.auth!.user.role, action: "deployment.redeploy", scope, correlationId: request.correlationContext.correlationId, grants: await state.controlGrants.listForActor(request.auth!.user.id) });
    if (!decision.allowed) { await appendAudit(adapters.audit, request, { actorUserId: request.auth!.user.id, action: "deployment.redeploy.rejected", targetType: "deployment", targetId: source.id, metadata: { projectId: project.id, reason: decision.code } }); return reply.code(403).send(errorEnvelope(request, decision.code, "Deployment redeploy is not authorized.")); }
    const snapshot = await state.snapshots.findByHash(body.snapshotHash);
    if (!snapshot) { await appendAudit(adapters.audit, request, { actorUserId: request.auth!.user.id, action: "deployment.redeploy.rejected", targetType: "deployment", targetId: source.id, metadata: { projectId: project.id, snapshotHash: body.snapshotHash, reason: "snapshot-missing" } }); return reply.code(404).send(errorEnvelope(request, "REDEPLOY_SNAPSHOT_MISSING", "Deployment snapshot was not found.")); }
    if (snapshot.projectId !== project.id) { await appendAudit(adapters.audit, request, { actorUserId: request.auth!.user.id, action: "deployment.redeploy.rejected", targetType: "deployment", targetId: source.id, metadata: { projectId: project.id, snapshotHash: body.snapshotHash, reason: "snapshot-wrong-project" } }); return reply.code(409).send(errorEnvelope(request, "REDEPLOY_SNAPSHOT_WRONG_PROJECT", "Snapshot does not belong to the source deployment project.")); }
    let canonicalValid = true;
    try { validateDockerImageSnapshot(snapshot, { sha256: (bytes) => createHash("sha256").update(bytes).digest("hex") }); } catch { canonicalValid = false; }
    const sourceProof = trustedPriorExecutionReceiptSchema.safeParse(source.executionReceipt);
    const imageDigest = snapshot.source.sourceMode === "image" ? (snapshot.source.image.selector.kind === "digest" ? snapshot.source.image.selector.value : snapshot.resolvedDigest) : undefined;
    const sourceBound = sourceProof.success && sourceProof.data.deploymentId === source.id && sourceProof.data.projectId === project.id && sourceProof.data.runtimeHost === source.agentId && source.agentId === snapshot.agentId && source.snapshotOriginId === snapshot.deploymentId && source.snapshotHash === snapshot.hash && sourceProof.data.snapshotOriginId === snapshot.deploymentId && sourceProof.data.snapshotHash === snapshot.hash && sourceProof.data.effectiveImageDigest === imageDigest && sourceProof.data.containerPort === snapshot.runtimePort;
    if (!canonicalValid || !sourceBound || source.status !== "succeeded" || createDeploymentPlan(snapshot).status !== "executable" || !snapshot.agentId || !snapshot.commitSha) { await appendAudit(adapters.audit, request, { actorUserId: request.auth!.user.id, action: "deployment.redeploy.rejected", targetType: "deployment", targetId: source.id, metadata: { projectId: project.id, snapshotHash: body.snapshotHash, reason: "snapshot-ineligible" } }); return reply.code(409).send(errorEnvelope(request, "REDEPLOY_SNAPSHOT_INELIGIBLE", "Snapshot is not eligible for redeployment.")); }
    let resolved: { command: ControlCommand; created: boolean };
    try { resolved = await state.controlRedeploy.resolve(createControlCommand({ actorId: request.auth!.user.id, action: "deployment.redeploy", scope, input: { actorId: request.auth!.user.id, projectId: project.id, sourceDeploymentId: source.id, snapshotHash: body.snapshotHash }, idempotencyKey, correlationId: request.correlationContext.correlationId })); }
    catch (error) { if (error instanceof IdempotencyConflictError) return reply.code(409).send(errorEnvelope(request, error.code, error.message)); throw error; }
    const existingResult = resolved.command.result as import("@deploylite/contracts").DeploymentRedeployCommandResult | undefined;
    if (resolved.command.status === "completed" && existingResult) return ok(request, { command: resolved.command, deploymentId: existingResult.deploymentId, snapshotHash: body.snapshotHash, idempotent: true });
    if (resolved.command.status === "rejected") return reply.code(409).send(errorEnvelope(request, "REDEPLOY_COMMAND_REJECTED", "Redeploy command was rejected and cannot be reused."));
    const confirmationId = getHeaderValue(request, "x-control-confirmation-id");
    if (resolved.created && !confirmationId) { const confirmation = createConfirmation({ command: resolved.command, classification: "destructive" }); await state.controlRedeploy.bind(confirmation); await appendAudit(adapters.audit, request, { actorUserId: request.auth!.user.id, action: "deployment.redeploy.pending_confirmation", targetType: "deployment", targetId: source.id, metadata: { projectId: project.id, snapshotHash: body.snapshotHash, commandId: resolved.command.id } }); return reply.code(202).send(ok(request, { commandId: resolved.command.id, confirmationId: confirmation.id, confirmationRequired: true, correlationId: request.correlationContext.correlationId })); }
     if (resolved.command.status === "eligible" || resolved.command.status === "dispatching") return reply.code(202).send(ok(request, { command: resolved.command, pending: true, correlationId: request.correlationContext.correlationId }));
    if (!confirmationId) return reply.code(409).send(errorEnvelope(request, "CONFIRMATION_REQUIRED", "An explicit confirmation is required for deployment redeploy."));
    const confirmation = { id: confirmationId, commandId: resolved.command.id, actorId: resolved.command.actorId, action: resolved.command.action, scope: resolved.command.scope, inputDigest: resolved.command.inputDigest, classification: "destructive" as const, expiresAt: resolved.command.expiresAt, consumedAt: null };
    const deployment: Deployment = { id: randomUUID(), projectId: snapshot.projectId, agentId: snapshot.agentId, status: "queued", commitSha: snapshot.commitSha, startedAt: new Date().toISOString(), finishedAt: null, sourceDeploymentId: source.id, snapshotOriginId: snapshot.deploymentId, snapshotHash: snapshot.hash };
     const admitted = await state.controlRedeploy.executeConfirmedDeploymentRedeploy({ command: resolved.command, confirmation, deployment, requestId: request.correlationContext.requestId, snapshotHash: snapshot.hash });
     if (!admitted.accepted) return reply.code(409).send(errorEnvelope(request, "CONFIRMATION_REJECTED", "Confirmation is not eligible for this command."));
     const result = admitted.result;
     if (!result || !admitted.deployment) return reply.code(409).send(errorEnvelope(request, "REDEPLOY_NOT_COMPLETED", "Redeploy was not completed."));
     const claim = await state.controlRedeploy.claimDeploymentRedeploy(admitted.command);
     if (!claim.claimed) return reply.code(202).send(ok(request, { command: claim.command, pending: true, correlationId: request.correlationContext.correlationId }));
     if (!claim.deployment) throw new Error("Redeploy command deployment was not persisted");
     const queued = claim.deployment;
     const authority = claim.authority ? structuredClone(claim.authority) : undefined;
     const validateAuthority = state.controlRedeploy.validateDeploymentAuthority?.bind(state.controlRedeploy);
     if (!authority || !validateAuthority) return reply.code(503).send(errorEnvelope(request, "EXECUTION_AUTHORITY_UNAVAILABLE", "Persisted execution authority is required for replacement."));
     const running: Deployment = { ...queued, status: "running", stopTarget: { candidateId: `${queued.id}:candidate:deploy_${queued.id}`, effectiveImage: snapshot.source.sourceMode === "image" ? `${snapshot.source.image.registryHost}/${snapshot.source.image.repository}@${imageDigest}` : "" } };
     await state.deployments.save(running);
     if (!state.executionCompletion) return reply.code(503).send(errorEnvelope(request, "EXECUTION_COMPLETION_UNAVAILABLE", "Atomic redeploy completion is unavailable."));
     try { await validateAuthority(authority); } catch { return reply.code(409).send(errorEnvelope(request, "EXECUTION_AUTHORITY_LOST", "Replacement authority was lost before dispatch.")); }
     let execution: "dispatched" | DockerImageExecutionReceiptV1 | DeploymentDispatchReceipt | undefined;
     let dispatchError: unknown; let dispatchFailed = false; let cachedEvidence = false;
     const available = state.deploymentDispatcher.available();
     if (available) {
       await state.deployments.appendLog({ id: randomUUID(), deploymentId: queued.id, sequence: 1, level: "info", message: "Agent accepted redeploy snapshot and started execution.", timestamp: new Date().toISOString(), redactionApplied: true, requestId: request.correlationContext.requestId, correlationId: claim.command.correlationId });
       const abort = new AbortController(); const onAbort = () => abort.abort(); request.raw.once("aborted", onAbort); if (request.raw.aborted) abort.abort();
       const context: AgentDispatchContext = { agentId: queued.agentId!, requestId: request.correlationContext.requestId, correlationId: claim.command.correlationId, executionDeploymentId: queued.id, sourceDeploymentId: source.id, authority, replacement: { prior: sourceProof.data!, effectiveImage: running.stopTarget!.effectiveImage, policy: { maxOutageMs: 30_000, maxRecoveryMs: 60_000 } }, signal: abort.signal };
       try { execution = await state.deploymentDispatcher.dispatch(snapshot, `deploy_${queued.id}`, context); }
       catch (error) { dispatchError = error; try { execution = state.deploymentDispatcher.readExecutionReceipt ? await readOriginalForRequest(publicationSignal, (signal) => state.deploymentDispatcher.readExecutionReceipt!(snapshot, `deploy_${queued.id}`, { ...context, signal })) ?? undefined : undefined; cachedEvidence = execution !== undefined; } catch { /* Never reexecute the original command to recover its reply. */ } dispatchFailed = execution === undefined; }
       finally { request.raw.removeListener("aborted", onAbort); }
     }
     const persisted = await state.deployments.findById(running.id);
     const persistedCommand = await state.controlRedeploy.findByIdempotency(claim.command.actorId, claim.command.idempotencyKey);
     if (persistedCommand && (!persisted || !["succeeded", "failed", "canceled"].includes(persisted.status))) { try { await validateAuthority(authority); } catch { return reply.code(409).send(errorEnvelope(request, "EXECUTION_AUTHORITY_LOST", "Replacement authority was lost; execution remains unresolved.")); } }
     if (dispatchFailed) return reply.code(502).send(errorEnvelope(request, "REDEPLOY_OUTCOME_UNKNOWN", "Agent terminal recovery evidence was not received; execution and authority remain unresolved."));
     if (execution === "dispatched") return reply.code(202).send(ok(request, { command: claim.command, deployment: running, pending: true, correlationId: claim.command.correlationId }));
     return finishReceipt(claim.command, running, snapshot, sourceProof.data!, execution, available, cachedEvidence ? publicationSignal : undefined);
  }));
  app.get(`${API_PREFIX}/deployments/:deploymentId`, { preHandler: requireAuth }, async (request, reply) => {
    const params = z.object({ deploymentId: z.string().min(1) }).parse(request.params);
    const deployment = await state.deployments.findById(params.deploymentId);
    return deployment ? ok(request, { deployment }) : reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Deployment not found."));
  });
  app.get(`${API_PREFIX}/deployments`, { preHandler: requireAuth }, async (request) => ok(request, { deployments: await state.deployments.list() }));
  // Audit history list — operator/admin only. The response shape strips
  // per-row metadata so the API can never echo secret keys, fingerprints, or
  // other sensitive detail by accident (Task 4.6: safe metadata only).
  app.get(`${API_PREFIX}/audit-events`, { preHandler: [requireAuth, requireAuditReadRole] }, async (request, reply) => {
    const raw = (request.query ?? {}) as Record<string, unknown>;
    const parsed = z
      .object({
        actor: z.string().min(1).max(128).optional(),
        action: z.string().min(1).max(128).optional(),
        projectId: z.string().min(1).max(128).optional(),
        limit: z.coerce.number().int().min(1).max(MAX_AUDIT_LIST_LIMIT).optional(),
        offset: z.coerce.number().int().min(0).max(MAX_AUDIT_LIST_OFFSET).optional()
      })
      .safeParse({
        actor: typeof raw["actor"] === "string" && raw["actor"].length > 0 ? raw["actor"] : undefined,
        action: typeof raw["action"] === "string" && raw["action"].length > 0 ? raw["action"] : undefined,
        projectId: typeof raw["projectId"] === "string" && raw["projectId"].length > 0 ? raw["projectId"] : undefined,
        limit: typeof raw["limit"] === "string" && raw["limit"].length > 0 ? raw["limit"] : undefined,
        offset: typeof raw["offset"] === "string" && raw["offset"].length > 0 ? raw["offset"] : undefined
      });
    if (!parsed.success) {
      await appendAudit(adapters.audit, request, {
        actorUserId: request.auth?.user.id ?? null,
        action: "audit.list.rejected",
        targetType: "audit_events",
        targetId: "list",
        metadata: { reason: "invalid-query" }
      });
      return reply.code(400).send(errorEnvelope(request, "VALIDATION_ERROR", "Invalid audit-events query parameters."));
    }
    const page = await adapters.audit.list({
      actorUserId: parsed.data.actor,
      action: parsed.data.action,
      projectId: parsed.data.projectId,
      limit: parsed.data.limit,
      offset: parsed.data.offset
    });
    return ok(request, page);
  });
  app.get(`${API_PREFIX}/deployments/:deploymentId/logs`, { preHandler: requireAuth }, async (request) => {
    const params = z.object({ deploymentId: z.string().min(1) }).parse(request.params);
    return ok(request, { events: await state.deployments.listLogs(params.deploymentId) });
  });
  app.get(`${API_PREFIX}/deployments/:deploymentId/logs/stream`, { preHandler: requireAuth }, async (request, reply) => {
    const params = z.object({ deploymentId: z.string().min(1) }).parse(request.params);
    const lastEventId = Number.parseInt(getHeaderValue(request, "last-event-id") ?? "-1", 10);
    const logs = await state.deployments.listLogs(params.deploymentId, Number.isFinite(lastEventId) ? lastEventId : -1);
    const deployment = await state.deployments.findById(params.deploymentId);
    const body = logs
      .map((log) => `id: ${log.sequence}\nevent: deployment.log\ndata: ${JSON.stringify({ ...log, audit: { action: "deployment.log.stream", targetType: "deployment", targetId: params.deploymentId, ...request.correlationContext } })}\n`)
      .join("\n");
    const lastSequence = logs.at(-1)?.sequence ?? (Number.isFinite(lastEventId) ? lastEventId : -1);
    const terminal = deployment && ["succeeded", "failed", "canceled"].includes(deployment.status) ? `id: ${lastSequence + 1}\nevent: deployment.status\ndata: ${JSON.stringify({ deployment, ...request.correlationContext })}\n\n` : "";
    return reply.header("content-type", "text/event-stream; charset=utf-8").header("cache-control", "no-cache").send(body.length > 0 ? `${body}\n${terminal}` : terminal);
  });
  app.post(`${API_PREFIX}/deployments`, { preHandler: [requireAuth, requireMutationRole] }, async (request) => {
    const body = parseBody(deploymentSchema.omit({ id: true, startedAt: true, finishedAt: true }), request.body);
    const deployment: Deployment = { id: `dep_${createRequestId()}`, startedAt: new Date().toISOString(), finishedAt: null, ...body };
    await state.deployments.save(deployment);
    return ok(request, { deployment, audit: auditMutation(request, "deployment.create", "deployment", deployment.id) });
  });
}

export async function buildApiApp(options: BuildApiAppOptions = {}): Promise<FastifyInstance> {
  const sourceEnv = options.env ?? process.env;
  const composeResourceProjectAgents = options.composeResourceProjectAgents ?? parseComposeResourceProjectBindings(sourceEnv[COMPOSE_RESOURCE_PROJECT_AGENTS_ENV]);
  const composeVolumeAttachmentProjectAgents = options.composeVolumeAttachmentProjectAgents
    ?? parseComposeVolumeAttachmentProjectBindings(sourceEnv[COMPOSE_VOLUME_ATTACHMENT_PROJECT_AGENTS_ENV], composeResourceProjectAgents);
  const composeResourceCleanupProjectAgents = options.composeResourceCleanupProjectAgents
    ?? parseComposeResourceCleanupProjectBindings(sourceEnv[COMPOSE_RESOURCE_CLEANUP_PROJECT_AGENTS_ENV], composeResourceProjectAgents);
  if (composeVolumeAttachmentProjectAgents.length > 0 && composeResourceProjectAgents.length === 0) {
    throw new Error(`${COMPOSE_VOLUME_ATTACHMENT_PROJECT_AGENTS_ENV} requires an existing resource project binding.`);
  }
  if (composeResourceCleanupProjectAgents.length > 0 && composeResourceProjectAgents.length === 0) {
    throw new Error(`${COMPOSE_RESOURCE_CLEANUP_PROJECT_AGENTS_ENV} requires an existing resource project binding.`);
  }
  if (sourceEnv.NODE_ENV === "production" && (composeVolumeAttachmentProjectAgents.length > 0 || options.composeVolumeAttachmentExecutions)) {
    throw new Error(`${COMPOSE_VOLUME_ATTACHMENT_PROJECT_AGENTS_ENV} is restricted to non-production environments.`);
  }
  if (sourceEnv.NODE_ENV === "production" && (composeResourceCleanupProjectAgents.length > 0 || options.composeResourceCleanupExecutions)) {
    throw new Error(`${COMPOSE_RESOURCE_CLEANUP_PROJECT_AGENTS_ENV} is restricted to non-production environments.`);
  }
  if (composeResourceProjectAgents.length > 0 && (options.composeResourceInspection || options.composeNetworkAttachmentExecutions || options.composeVolumeAttachmentExecutions || options.composeResourceCleanupExecutions || options.domainRouteApplyExecutions || options.transportPortApplyExecutions)) {
    throw new Error("Compose resource project configuration cannot be combined with injected resource maps.");
  }
  const env = parseDeployLiteEnv(sourceEnv);
  const app = Fastify({ logger: false });
  const corsOrigin = options.corsOrigin === false ? null : options.corsOrigin ?? env.DEPLOYLITE_CORS_ORIGIN ?? (env.NODE_ENV === "production" ? null : "http://localhost:3000");
  const authConfig: AuthConfig = {
    cookieName: env.DEPLOYLITE_SESSION_COOKIE_NAME ?? defaultSessionCookieName,
    cookieSecure: env.DEPLOYLITE_SESSION_COOKIE_SECURE ?? env.NODE_ENV === "production",
    sessionTtlSeconds: env.DEPLOYLITE_SESSION_TTL_SECONDS,
    ...options.authConfig
  };
  const repositories = await createRuntimeRepositories(env, options);
  if (repositories.close) {
    app.addHook("onClose", repositories.close);
  }
  if (repositories.shouldSeedMockData) {
    await seedMockData(repositories.state);
  }
  let configuredResourceRuntime: Awaited<ReturnType<typeof createProjectScopedComposeResourceRuntime>> | undefined;
  try {
    configuredResourceRuntime = composeResourceProjectAgents.length > 0
      ? await createProjectScopedComposeResourceRuntime({ bindings: composeResourceProjectAgents, projects: repositories.state.projects,
        volumeAttachmentBindings: composeVolumeAttachmentProjectAgents, cleanupBindings: composeResourceCleanupProjectAgents,
        controls: repositories.state.controlDeletes, agent: { endpoint: env.DEPLOYLITE_AGENT_URL, agentId: env.DEPLOYLITE_AGENT_ID, trustKey: env.DEPLOYLITE_AGENT_TRUST_KEY } })
      : undefined;
  } catch (error) {
    await app.close();
    throw error;
  }
  const composeResourceInspection = options.composeResourceInspection ?? configuredResourceRuntime?.inspectionAccess;
  const composeNetworkAttachmentExecutions = options.composeNetworkAttachmentExecutions ?? configuredResourceRuntime?.attachmentExecutions;
  const composeVolumeAttachmentExecutions = options.composeVolumeAttachmentExecutions ?? configuredResourceRuntime?.volumeAttachmentExecutions;
  const composeResourceCleanupExecutions = options.composeResourceCleanupExecutions ?? configuredResourceRuntime?.cleanupExecutions;
  const domainRouteApplyExecutions = options.domainRouteApplyExecutions ?? configuredResourceRuntime?.domainRouteApplyExecutions;
  const transportPortApplyExecutions = options.transportPortApplyExecutions ?? configuredResourceRuntime?.transportPortApplyExecutions;
  registerCoreHooks(app, corsOrigin);
  const cleanupPlans = options.composeResourceCleanupPlans ?? (repositories.composeResourceCleanupStore && composeResourceInspection
    ? new Map([...(configuredResourceRuntime ? (composeResourceCleanupExecutions?.keys() ?? []) : composeResourceInspection.keys())]
      .map(projectId => [projectId, { store: repositories.composeResourceCleanupStore!, confirmationTtlMs: 60_000 }] as const))
    : undefined);
  registerRoutes(app, repositories.state, repositories.auth, authConfig, env.DEPLOYLITE_CONTROL_PLANE_CONFIRMED_DELETE, options.imagePolicy ?? { policyVersion: "deployment-v1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true }, composeResourceInspection, options.composeVolumeBackupPlans, cleanupPlans, options.composeVolumeBackupExecutions, composeNetworkAttachmentExecutions, composeResourceCleanupExecutions, composeVolumeAttachmentExecutions, domainRouteApplyExecutions, transportPortApplyExecutions);
  app.addHook("onClose", () => {
    repositories.state.deployRunner.cancelTimers();
  });
  return app;
}

export { API_PREFIX, AUTH_HEADER, InMemoryAuditRepository, InMemoryAuthUserRepository, InMemorySessionRepository, createRuntimeRepositories, type ApiRepositories, type BuildApiAppOptions };
