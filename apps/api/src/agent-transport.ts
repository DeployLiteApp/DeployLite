import { sealAgentSecretEnvelope, signAgentTransport, validateAgentTransportKey } from "@deploylite/config";
import { COMPOSE_RESOURCE_CLEANUP_CAPABILITY, COMPOSE_RESOURCE_CLEANUP_PATH, COMPOSE_RESOURCE_CLEANUP_RECEIPT_PATH,
  composeResourceCleanupAgentCommandSchema, composeResourceCleanupCachedReceiptSchema, composeResourceCleanupExecutionReceiptSchema,
  composeResourceCleanupReceiptQuerySchema, type ComposeResourceCleanupExecutionReceiptV1 } from "@deploylite/contracts";
import { agentCachedReceiptSchema, agentReceiptQuerySchema, type AgentReceiptQuery, agentCapabilityHandshakeSchema, agentExecutionReceiptSchema, composeNetworkAttachmentAgentCommandSchema, composeNetworkAttachmentCachedReceiptSchema, composeNetworkAttachmentReceiptQuerySchema, composeNetworkAttachmentReceiptSchema, COMPOSE_NETWORK_ATTACHMENT_CAPABILITY, COMPOSE_NETWORK_ATTACHMENT_PATH, composeVolumeAttachmentAgentCommandSchema, composeVolumeAttachmentCachedReceiptSchema, composeVolumeAttachmentReceiptQuerySchema, composeVolumeAttachmentReceiptSchema, COMPOSE_VOLUME_ATTACHMENT_CAPABILITY, COMPOSE_VOLUME_ATTACHMENT_PATH, COMPOSE_VOLUME_ATTACHMENT_RECEIPT_PATH, composeVolumeBackupAgentCommandSchema, composeVolumeBackupCachedReceiptSchema, composeVolumeBackupReceiptQuerySchema, composeVolumeBackupReceiptSchema, COMPOSE_VOLUME_BACKUP_CAPABILITY, COMPOSE_VOLUME_BACKUP_PATH, COMPOSE_VOLUME_BACKUP_RECEIPT_PATH, deploymentStopAgentReceiptSchema, dockerImageExecutionReceiptSchema, promotionPolicySchema, type AgentExecutionCommand, type AgentReplacementV1, type ComposeNetworkAttachmentReceiptV1, type ComposeVolumeAttachmentReceiptV1, type ComposeVolumeAttachmentExecutionRequestV1, type ComposeVolumeBackupAgentCommandV1, type ComposeVolumeBackupReceiptV1, type DeploymentExecutionAuthorityV1, type DeploymentSnapshotV1, type LeaseV1, type ProjectControlAuthorityV1, TransportCanceledError, TransportError, TransportTimeoutError } from "@deploylite/contracts";
import { awaitAbortable, type DockerImageExecutionReceiptV1, type PreparedComposeAttachmentCommand, type ControlCommand } from "@deploylite/domain";
import type { PreparedComposeResourceCleanupCommand } from "./compose-resource-cleanup-route.js";

export type AgentTransportOptions = Readonly<{ endpoint: string; trustKey: string; agentId: string; allowInsecureInternal?: boolean; fetch?: typeof globalThis.fetch; timeoutMs?: number; now?: () => number }>;
export type AgentDispatchContext = Readonly<{ requestId: string; correlationId: string; agentId: string; signal?: AbortSignal; executionDeploymentId?: string; activeDeploymentId?: string; sourceDeploymentId?: string; authority?: DeploymentExecutionAuthorityV1; replacement?: AgentReplacementV1 }>;
export type DeploymentDispatchReceipt = DockerImageExecutionReceiptV1 & Readonly<{ projectId: string; activeDeploymentId?: string; sourceDeploymentId: string; snapshotHash: string; correlationId: string }>;
export type AgentStopDispatchInput = Readonly<{ projectId: string; deploymentId: string; candidateId: string; effectiveImage: string; containerId?: string; commandId: string }>;
export type PreparedComposeVolumeAttachmentCommand = Readonly<{ command: ControlCommand; request: ComposeVolumeAttachmentExecutionRequestV1; agentId: string; environment: Readonly<Record<string, string>> }>;
export type PreparedComposeVolumeBackupCommand = Omit<ComposeVolumeBackupAgentCommandV1, "authority" | "lease" | "requiredCapabilities" | "timeoutMs" | "cancellationRequested">;

// Only this local transport can prove that no POST was attempted.
const preDispatchRejections = new WeakSet<object>();
export function isAgentPreDispatchRejection(error: unknown): boolean { return typeof error === "object" && error !== null && preDispatchRejections.has(error); }

function beforeDispatch<T extends Error>(error: T): T { preDispatchRejections.add(error); return error; }

export class AuthenticatedAgentDeploymentTransport {
  readonly #options: AgentTransportOptions; readonly #fetch: typeof globalThis.fetch;
  constructor(options: AgentTransportOptions) { this.#options = options; this.#fetch = options.fetch ?? globalThis.fetch; }
  available(): boolean { let url: URL; try { url = new URL(this.#options.endpoint); validateAgentTransportKey(this.#options.trustKey); } catch { return false; } const internal = url.hostname === "localhost" || url.hostname === "agent" || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname); if (url.username || url.password || url.hash || !["https:", ...(this.#options.allowInsecureInternal && internal ? ["http:"] : [])].includes(url.protocol)) return false; return Boolean(this.#options.agentId.trim()); }
  async dispatch(snapshot: DeploymentSnapshotV1, commandId: string, context?: AgentDispatchContext): Promise<DockerImageExecutionReceiptV1 | DeploymentDispatchReceipt> {
    snapshot = structuredClone(snapshot);
    context = context ? { ...context, authority: context.authority ? structuredClone(context.authority) : undefined, replacement: context.replacement ? structuredClone(context.replacement) : undefined } : undefined;
    if (!this.available()) throw beforeDispatch(new TransportError("agent transport is not configured"));
    if (context?.agentId && context.agentId !== this.#options.agentId) throw beforeDispatch(new TransportError("agent transport identity mismatch"));
    const now = this.#options.now ?? Date.now; const timeoutMs = this.#options.timeoutMs ?? 30_000;
    const responseTimeoutMs = timeoutMs + (context?.replacement ? promotionPolicySchema.parse(context.replacement.policy).maxOutageMs + context.replacement.policy.maxRecoveryMs : 0);
    if (context?.signal?.aborted) throw beforeDispatch(new TransportCanceledError());
      const lease: LeaseV1 = context?.authority?.executionLease ?? { leaseId: `${snapshot.deploymentId}:transport:1`, deploymentId: snapshot.deploymentId, fence: 1, expiresAt: now() + timeoutMs };
    const executionDeploymentId = context?.executionDeploymentId ?? snapshot.deploymentId; const sourceDeploymentId = context?.sourceDeploymentId ?? snapshot.deploymentId; const v2 = context?.executionDeploymentId !== undefined;
    return this.operate(responseTimeoutMs, context?.signal, async (signal, dispatched) => {
    if (v2) { const handshakeRequestSignature = signAgentTransport("GET /capabilities", this.#options.trustKey); const handshakeResponse = await awaitAbortable(() => this.#fetch(`${this.#options.endpoint.replace(/\/$/, "")}/capabilities`, { headers: { "x-deploylite-signature": handshakeRequestSignature }, signal }), signal); const responseBinding = handshakeResponse.headers.get("x-deploylite-request-signature"); // This echo binds the response to the signed request target; it does not authenticate the response body.
      if (!handshakeResponse.ok || responseBinding !== handshakeRequestSignature) throw new TransportError("capability_unavailable"); const handshake = agentCapabilityHandshakeSchema.parse(await awaitAbortable(() => handshakeResponse.json(), signal)); if (handshake.agentId !== this.#options.agentId || !handshake.capabilities.includes("deploy.execute") || !handshake.protocolVersions.includes(2)) throw new TransportError("capability_unavailable"); }
    const body: AgentExecutionCommand = v2 ? { schemaVersion: 2, agentId: context?.agentId ?? this.#options.agentId, commandId, deploymentId: executionDeploymentId, ...(context?.activeDeploymentId ? { activeDeploymentId: context.activeDeploymentId } : {}), sourceDeploymentId, ...(context?.authority ? { authority: context.authority } : {}), ...(context?.replacement ? { replacement: context.replacement } : {}), projectId: snapshot.projectId, snapshot: { ...snapshot, canonicalBytes: undefined } as unknown as Record<string, unknown>, snapshotHash: snapshot.hash, requiredCapabilities: ["deploy.execute"], lease: { ...lease, deploymentId: executionDeploymentId }, context: { requestId: context?.requestId ?? commandId, correlationId: context?.correlationId ?? commandId }, timeoutMs, cancellationRequested: false } : { schemaVersion: 1, agentId: context?.agentId ?? this.#options.agentId, commandId, deploymentId: executionDeploymentId, projectId: snapshot.projectId, snapshot: { ...snapshot, canonicalBytes: undefined } as unknown as Record<string, unknown>, snapshotHash: snapshot.hash, requiredCapabilities: ["deploy.execute"], lease, context: { requestId: context?.requestId ?? commandId, correlationId: context?.correlationId ?? commandId }, timeoutMs, cancellationRequested: false };
    const payload = JSON.stringify(body);
    dispatched();
    const response = await awaitAbortable(() => this.#fetch(`${this.#options.endpoint.replace(/\/$/, "")}/deployments/execute`, { method: "POST", headers: { "content-type": "application/json", "x-deploylite-signature": signAgentTransport(payload, this.#options.trustKey) }, body: payload, signal }), signal);
    if (!response.ok) throw new TransportError(`agent transport returned HTTP ${response.status}`);
    const result = agentExecutionReceiptSchema.parse(await awaitAbortable(() => response.json(), signal));
    if (result.commandId !== commandId || result.deploymentId !== executionDeploymentId || result.receipt.deploymentId !== executionDeploymentId) throw new TransportError("agent receipt identity mismatch");
    const receipt = dockerImageExecutionReceiptSchema.parse(result.receipt) as DockerImageExecutionReceiptV1;
    if (v2) { if (result.schemaVersion !== 2 || (result.activeDeploymentId ?? null) !== (context?.activeDeploymentId ?? null) || result.sourceDeploymentId !== sourceDeploymentId || result.snapshotHash !== snapshot.hash || result.correlationId !== (context?.correlationId ?? commandId)) throw new TransportError("agent receipt identity mismatch"); return { ...receipt, ...(context?.activeDeploymentId ? { activeDeploymentId: context.activeDeploymentId } : {}), projectId: snapshot.projectId, sourceDeploymentId, snapshotHash: snapshot.hash, correlationId: result.correlationId }; }
    if (result.schemaVersion !== 1) throw new TransportError("agent receipt identity mismatch"); return receipt;
    });
  }

  async dispatchComposeNetworkAttachment(prepared: PreparedComposeAttachmentCommand, authority: ProjectControlAuthorityV1, context: Pick<AgentDispatchContext, "requestId" | "correlationId" | "signal">): Promise<ComposeNetworkAttachmentReceiptV1> {
    if (!this.available()) throw beforeDispatch(new TransportError("agent transport is not configured"));
    if (prepared.agentId !== this.#options.agentId || authority.projectId !== prepared.request.projectId
      || authority.commandId !== prepared.command.id || authority.inputDigest !== prepared.command.inputDigest
      || prepared.request.correlationId !== context.correlationId) throw beforeDispatch(new TransportError("project update authority scope rejected"));
    const timeoutMs = this.#options.timeoutMs ?? 30_000;
    const body = composeNetworkAttachmentAgentCommandSchema.parse({ schemaVersion: 1, action: "compose.network.attachment", agentId: this.#options.agentId,
      commandId: prepared.command.id, projectId: prepared.request.projectId, operation: prepared.request.operation,
      idempotencyKey: prepared.request.idempotencyKey, inputDigest: prepared.command.inputDigest, canonicalDocument: prepared.canonicalDocument,
      configDigest: prepared.request.configDigest, stateDigest: prepared.request.stateDigest, key: prepared.request.key,
      runtimeName: prepared.request.runtimeName, service: prepared.request.service, attachmentAction: prepared.request.attachmentAction,
      containerId: prepared.request.containerId, alreadySatisfied: prepared.request.alreadySatisfied,
      requiredCapabilities: [COMPOSE_NETWORK_ATTACHMENT_CAPABILITY], authority, lease: authority.projectLease,
      context: { requestId: context.requestId, correlationId: context.correlationId }, timeoutMs, cancellationRequested: false });
    return this.operate(timeoutMs, context.signal, async (signal, sent) => {
      const handshakeSignature = signAgentTransport("GET /capabilities", this.#options.trustKey);
      const handshakeResponse = await awaitAbortable(() => this.#fetch(`${this.#options.endpoint.replace(/\/$/, "")}/capabilities`, { headers: { "x-deploylite-signature": handshakeSignature }, signal }), signal);
      const binding = handshakeResponse.headers.get("x-deploylite-request-signature");
      if (!handshakeResponse.ok || binding !== handshakeSignature) throw new TransportError("capability_unavailable");
      const handshake = agentCapabilityHandshakeSchema.parse(await awaitAbortable(() => handshakeResponse.json(), signal));
      if (handshake.agentId !== this.#options.agentId || !handshake.capabilities.includes(COMPOSE_NETWORK_ATTACHMENT_CAPABILITY)) throw new TransportError("capability_unavailable");
      const payload = JSON.stringify(body); sent();
      const response = await awaitAbortable(() => this.#fetch(`${this.#options.endpoint.replace(/\/$/, "")}${COMPOSE_NETWORK_ATTACHMENT_PATH}`, { method: "POST", headers: { "content-type": "application/json", "x-deploylite-signature": signAgentTransport(payload, this.#options.trustKey) }, body: payload, signal }), signal);
      if (!response.ok) throw new TransportError(`agent transport returned HTTP ${response.status}`);
      const receipt = composeNetworkAttachmentReceiptSchema.parse(await awaitAbortable(() => response.json(), signal));
      if (receipt.agentId !== body.agentId || receipt.commandId !== body.commandId || receipt.projectId !== body.projectId
        || receipt.inputDigest !== body.inputDigest || receipt.correlationId !== body.context.correlationId || receipt.key !== body.key
        || receipt.runtimeName !== body.runtimeName || receipt.service !== body.service || receipt.attachmentAction !== body.attachmentAction
        || receipt.containerId !== body.containerId) throw new TransportError("agent network receipt identity mismatch");
      return receipt;
    });
  }

  async readComposeNetworkAttachmentReceipt(prepared: PreparedComposeAttachmentCommand, authority: ProjectControlAuthorityV1, context: Pick<AgentDispatchContext, "requestId" | "correlationId" | "signal">): Promise<ComposeNetworkAttachmentReceiptV1 | null> {
    if (!this.available()) throw new TransportError("agent transport is not configured");
    if (prepared.agentId !== this.#options.agentId || authority.projectId !== prepared.request.projectId
      || authority.commandId !== prepared.command.id || authority.inputDigest !== prepared.command.inputDigest
      || prepared.request.correlationId !== context.correlationId) throw new TransportError("project update authority scope rejected");
    const command = composeNetworkAttachmentAgentCommandSchema.parse({ schemaVersion: 1, action: "compose.network.attachment", agentId: this.#options.agentId,
      commandId: prepared.command.id, projectId: prepared.request.projectId, operation: prepared.request.operation,
      idempotencyKey: prepared.request.idempotencyKey, inputDigest: prepared.command.inputDigest, canonicalDocument: prepared.canonicalDocument,
      configDigest: prepared.request.configDigest, stateDigest: prepared.request.stateDigest, key: prepared.request.key,
      runtimeName: prepared.request.runtimeName, service: prepared.request.service, attachmentAction: prepared.request.attachmentAction,
      containerId: prepared.request.containerId, alreadySatisfied: prepared.request.alreadySatisfied,
      requiredCapabilities: [COMPOSE_NETWORK_ATTACHMENT_CAPABILITY], authority, lease: authority.projectLease,
      context: { requestId: context.requestId, correlationId: context.correlationId }, timeoutMs: this.#options.timeoutMs ?? 30_000, cancellationRequested: false });
    const query = composeNetworkAttachmentReceiptQuerySchema.parse(Object.fromEntries(Object.entries(command).filter(([field]) => field !== "cancellationRequested")));
    const payload = JSON.stringify(query);
    const result = await this.operate(query.timeoutMs, context.signal, async (signal, sent) => {
      sent();
      const response = await awaitAbortable(() => this.#fetch(`${this.#options.endpoint.replace(/\/$/, "")}/compose/networks/receipt`, { method: "POST", headers: { "content-type": "application/json", "x-deploylite-signature": signAgentTransport(`POST /compose/networks/receipt\n${payload}`, this.#options.trustKey) }, body: payload, signal }), signal);
      if (!response.ok) throw new TransportError(`agent cache returned HTTP ${response.status}`);
      return composeNetworkAttachmentCachedReceiptSchema.parse(await awaitAbortable(() => response.json(), signal));
    });
    if (result.agentId !== this.#options.agentId || result.commandId !== query.commandId || result.correlationId !== query.context.correlationId) throw new TransportError("agent cached network receipt identity mismatch");
    const receipt = result.receipt;
    if (receipt && (receipt.agentId !== query.agentId || receipt.commandId !== query.commandId || receipt.projectId !== query.projectId
      || receipt.inputDigest !== query.inputDigest || receipt.correlationId !== query.context.correlationId || receipt.key !== query.key
      || receipt.runtimeName !== query.runtimeName || receipt.service !== query.service || receipt.attachmentAction !== query.attachmentAction
      || receipt.containerId !== query.containerId)) throw new TransportError("agent cached network receipt scope rejected");
    return receipt;
  }

  async dispatchComposeResourceCleanup(command: PreparedComposeResourceCleanupCommand, signal?: AbortSignal): Promise<ComposeResourceCleanupExecutionReceiptV1> {
    if (!this.available()) throw beforeDispatch(new TransportError("agent transport is not configured"));
    if (command.agentId !== this.#options.agentId || (this.#options.now?.() ?? Date.now()) >= command.expiresAt)
      throw beforeDispatch(new TransportError("resource cleanup command scope rejected"));
    const timeoutMs = Math.min(this.#options.timeoutMs ?? 30_000, Math.max(1, command.expiresAt - (this.#options.now?.() ?? Date.now())));
    const body = composeResourceCleanupAgentCommandSchema.parse({ ...command, requiredCapabilities: [COMPOSE_RESOURCE_CLEANUP_CAPABILITY], timeoutMs, cancellationRequested: false });
    const payload = JSON.stringify(body);
    return this.operate(timeoutMs, signal, async (requestSignal, sent) => {
      const handshakeSignature = signAgentTransport("GET /capabilities", this.#options.trustKey);
      const handshakeResponse = await awaitAbortable(() => this.#fetch(`${this.#options.endpoint.replace(/\/$/, "")}/capabilities`, { headers: { "x-deploylite-signature": handshakeSignature }, signal: requestSignal }), requestSignal);
      const binding = handshakeResponse.headers.get("x-deploylite-request-signature");
      if (!handshakeResponse.ok || binding !== handshakeSignature) throw new TransportError("capability_unavailable");
      const handshake = agentCapabilityHandshakeSchema.parse(await awaitAbortable(() => handshakeResponse.json(), requestSignal));
      if (handshake.agentId !== this.#options.agentId || !handshake.capabilities.includes(COMPOSE_RESOURCE_CLEANUP_CAPABILITY)) throw new TransportError("capability_unavailable");
      sent();
      const response = await awaitAbortable(() => this.#fetch(`${this.#options.endpoint.replace(/\/$/, "")}${COMPOSE_RESOURCE_CLEANUP_PATH}`, {
        method: "POST", headers: { "content-type": "application/json", "x-deploylite-signature": signAgentTransport(payload, this.#options.trustKey) }, body: payload, signal: requestSignal
      }), requestSignal);
      if (!response.ok) throw new TransportError(`agent transport returned HTTP ${response.status}`);
      const receipt = composeResourceCleanupExecutionReceiptSchema.parse(await awaitAbortable(() => response.json(), requestSignal));
      if (receipt.agentId !== command.agentId || receipt.commandId !== command.commandId || receipt.cleanupCommandId !== command.cleanupCommandId
        || receipt.confirmationId !== command.confirmationId || receipt.projectId !== command.projectId || receipt.inputDigest !== command.inputDigest
        || receipt.cleanupInputDigest !== command.cleanupInputDigest || receipt.correlationId !== command.context.correlationId
        || receipt.kind !== command.kind || receipt.key !== command.key || receipt.runtimeName !== command.runtimeName
        || receipt.configDigest !== command.configDigest || receipt.stateDigest !== command.stateDigest) throw new TransportError("agent cleanup receipt identity mismatch");
      return receipt;
    });
  }

  async readComposeResourceCleanupReceipt(command: PreparedComposeResourceCleanupCommand, signal?: AbortSignal): Promise<ComposeResourceCleanupExecutionReceiptV1 | null> {
    if (!this.available() || command.agentId !== this.#options.agentId) throw new TransportError("agent transport is not configured");
    const timeoutMs = this.#options.timeoutMs ?? 30_000;
    const query = composeResourceCleanupReceiptQuerySchema.parse({ ...command, requiredCapabilities: [COMPOSE_RESOURCE_CLEANUP_CAPABILITY], timeoutMs });
    const payload = JSON.stringify(query);
    const result = await this.operate(timeoutMs, signal, async (requestSignal, sent) => {
      sent();
      const response = await awaitAbortable(() => this.#fetch(`${this.#options.endpoint.replace(/\/$/, "")}${COMPOSE_RESOURCE_CLEANUP_RECEIPT_PATH}`, {
        method: "POST", headers: { "content-type": "application/json", "x-deploylite-signature": signAgentTransport(`POST ${COMPOSE_RESOURCE_CLEANUP_RECEIPT_PATH}\n${payload}`, this.#options.trustKey) },
        body: payload, signal: requestSignal
      }), requestSignal);
      if (!response.ok) throw new TransportError(`agent cache returned HTTP ${response.status}`);
      return composeResourceCleanupCachedReceiptSchema.parse(await awaitAbortable(() => response.json(), requestSignal));
    });
    if (result.agentId !== command.agentId || result.commandId !== command.commandId || result.correlationId !== command.context.correlationId)
      throw new TransportError("agent cached cleanup identity mismatch");
    const receipt = result.receipt;
    if (receipt && (receipt.agentId !== command.agentId || receipt.commandId !== command.commandId || receipt.cleanupCommandId !== command.cleanupCommandId
      || receipt.confirmationId !== command.confirmationId || receipt.projectId !== command.projectId || receipt.inputDigest !== command.inputDigest
      || receipt.cleanupInputDigest !== command.cleanupInputDigest || receipt.correlationId !== command.context.correlationId
      || receipt.kind !== command.kind || receipt.key !== command.key || receipt.runtimeName !== command.runtimeName
      || receipt.configDigest !== command.configDigest || receipt.stateDigest !== command.stateDigest)) throw new TransportError("agent cached cleanup scope rejected");
    return receipt;
  }

  async dispatchComposeVolumeAttachment(prepared: PreparedComposeVolumeAttachmentCommand, authority: ProjectControlAuthorityV1, context: Pick<AgentDispatchContext, "requestId" | "correlationId" | "signal">): Promise<ComposeVolumeAttachmentReceiptV1> {
    if (!this.available()) throw beforeDispatch(new TransportError("agent transport is not configured"));
    if (prepared.agentId !== this.#options.agentId || authority.projectId !== prepared.request.projectId
      || authority.commandId !== prepared.command.id || authority.inputDigest !== prepared.command.inputDigest
      || prepared.request.correlationId !== context.correlationId) throw beforeDispatch(new TransportError("project update authority scope rejected"));
    const timeoutMs = this.#options.timeoutMs ?? 30_000;
    const binding = { agentId: this.#options.agentId, commandId: prepared.command.id, inputDigest: prepared.command.inputDigest, projectId: prepared.request.projectId };
    const { action: _action, scope: _scope, correlationId: _correlationId, ...intent } = prepared.request;
    const body = composeVolumeAttachmentAgentCommandSchema.parse({ ...intent, schemaVersion: 1, action: "compose.volume.attachment",
      agentId: this.#options.agentId, commandId: prepared.command.id, inputDigest: prepared.command.inputDigest,
      sealedEnvironment: sealAgentSecretEnvelope(prepared.environment, this.#options.trustKey, binding),
      requiredCapabilities: [COMPOSE_VOLUME_ATTACHMENT_CAPABILITY], authority, lease: authority.projectLease,
      context: { requestId: context.requestId, correlationId: context.correlationId }, timeoutMs, cancellationRequested: false });
    const payload = JSON.stringify(body);
    return this.operate(timeoutMs, context.signal, async (signal, sent) => {
      const handshakeSignature = signAgentTransport("GET /capabilities", this.#options.trustKey);
      const handshakeResponse = await awaitAbortable(() => this.#fetch(`${this.#options.endpoint.replace(/\/$/, "")}/capabilities`, { headers: { "x-deploylite-signature": handshakeSignature }, signal }), signal);
      if (!handshakeResponse.ok || handshakeResponse.headers.get("x-deploylite-request-signature") !== handshakeSignature) throw new TransportError("capability_unavailable");
      const handshake = agentCapabilityHandshakeSchema.parse(await awaitAbortable(() => handshakeResponse.json(), signal));
      if (handshake.agentId !== this.#options.agentId || !handshake.capabilities.includes(COMPOSE_VOLUME_ATTACHMENT_CAPABILITY)) throw new TransportError("capability_unavailable");
      sent();
      const response = await awaitAbortable(() => this.#fetch(`${this.#options.endpoint.replace(/\/$/, "")}${COMPOSE_VOLUME_ATTACHMENT_PATH}`, { method: "POST", headers: { "content-type": "application/json", "x-deploylite-signature": signAgentTransport(payload, this.#options.trustKey) }, body: payload, signal }), signal);
      if (!response.ok) throw new TransportError(`agent transport returned HTTP ${response.status}`);
      const receipt = composeVolumeAttachmentReceiptSchema.parse(await awaitAbortable(() => response.json(), signal));
      if (receipt.agentId !== body.agentId || receipt.commandId !== body.commandId || receipt.projectId !== body.projectId || receipt.inputDigest !== body.inputDigest
        || receipt.correlationId !== body.context.correlationId || receipt.key !== body.key || receipt.runtimeName !== body.runtimeName
        || receipt.service !== body.service || receipt.attachmentAction !== body.attachmentAction || receipt.priorContainerId !== body.containerId) throw new TransportError("agent volume attachment receipt identity mismatch");
      return receipt;
    });
  }

  async readComposeVolumeAttachmentReceipt(prepared: PreparedComposeVolumeAttachmentCommand, authority: ProjectControlAuthorityV1, context: Pick<AgentDispatchContext, "requestId" | "correlationId" | "signal">): Promise<ComposeVolumeAttachmentReceiptV1 | null> {
    if (!this.available()) throw new TransportError("agent transport is not configured");
    if (prepared.agentId !== this.#options.agentId || authority.projectId !== prepared.request.projectId
      || authority.commandId !== prepared.command.id || authority.inputDigest !== prepared.command.inputDigest
      || prepared.request.correlationId !== context.correlationId) throw new TransportError("project update authority scope rejected");
    const binding = { agentId: this.#options.agentId, commandId: prepared.command.id, inputDigest: prepared.command.inputDigest, projectId: prepared.request.projectId };
    const { action: _action, scope: _scope, correlationId: _correlationId, ...intent } = prepared.request;
    const body = composeVolumeAttachmentAgentCommandSchema.parse({ ...intent, schemaVersion: 1, action: "compose.volume.attachment",
      agentId: this.#options.agentId, commandId: prepared.command.id, inputDigest: prepared.command.inputDigest,
      sealedEnvironment: sealAgentSecretEnvelope(prepared.environment, this.#options.trustKey, binding),
      requiredCapabilities: [COMPOSE_VOLUME_ATTACHMENT_CAPABILITY], authority, lease: authority.projectLease,
      context: { requestId: context.requestId, correlationId: context.correlationId }, timeoutMs: this.#options.timeoutMs ?? 30_000, cancellationRequested: false });
    const query = composeVolumeAttachmentReceiptQuerySchema.parse(Object.fromEntries(Object.entries(body).filter(([key]) => key !== "sealedEnvironment" && key !== "cancellationRequested")));
    const payload = JSON.stringify(query);
    const result = await this.operate(query.timeoutMs, context.signal, async (signal, sent) => {
      sent();
      const response = await awaitAbortable(() => this.#fetch(`${this.#options.endpoint.replace(/\/$/, "")}${COMPOSE_VOLUME_ATTACHMENT_RECEIPT_PATH}`, { method: "POST", headers: { "content-type": "application/json", "x-deploylite-signature": signAgentTransport(`POST ${COMPOSE_VOLUME_ATTACHMENT_RECEIPT_PATH}\n${payload}`, this.#options.trustKey) }, body: payload, signal }), signal);
      if (!response.ok) throw new TransportError(`agent cache returned HTTP ${response.status}`);
      return composeVolumeAttachmentCachedReceiptSchema.parse(await awaitAbortable(() => response.json(), signal));
    });
    if (result.agentId !== this.#options.agentId || result.commandId !== query.commandId || result.correlationId !== query.context.correlationId) throw new TransportError("agent cached volume attachment identity mismatch");
    const receipt = result.receipt;
    if (receipt && (receipt.agentId !== query.agentId || receipt.commandId !== query.commandId || receipt.projectId !== query.projectId
      || receipt.inputDigest !== query.inputDigest || receipt.correlationId !== query.context.correlationId || receipt.key !== query.key
      || receipt.runtimeName !== query.runtimeName || receipt.service !== query.service || receipt.attachmentAction !== query.attachmentAction || receipt.priorContainerId !== query.containerId)) throw new TransportError("agent cached volume attachment scope rejected");
    return receipt;
  }

  async dispatchComposeVolumeBackup(prepared: PreparedComposeVolumeBackupCommand, authority: ProjectControlAuthorityV1, context: Pick<AgentDispatchContext, "requestId" | "correlationId" | "signal">): Promise<ComposeVolumeBackupReceiptV1> {
    if (!this.available()) throw beforeDispatch(new TransportError("agent transport is not configured"));
    if (prepared.agentId !== this.#options.agentId || authority.projectId !== prepared.projectId
      || authority.commandId !== prepared.commandId || authority.inputDigest !== prepared.inputDigest
      || prepared.context.correlationId !== context.correlationId) throw beforeDispatch(new TransportError("project update authority scope rejected"));
    const timeoutMs = Math.min(60_000, this.#options.timeoutMs ?? 30_000, prepared.plan.limits.maxDurationMs);
    const body = composeVolumeBackupAgentCommandSchema.parse({ ...prepared, requiredCapabilities: [COMPOSE_VOLUME_BACKUP_CAPABILITY],
      authority, lease: authority.projectLease, context: { requestId: context.requestId, correlationId: context.correlationId }, timeoutMs, cancellationRequested: false });
    return this.operate(timeoutMs, context.signal, async (signal, sent) => {
      const handshakeSignature = signAgentTransport("GET /capabilities", this.#options.trustKey);
      const handshakeResponse = await awaitAbortable(() => this.#fetch(`${this.#options.endpoint.replace(/\/$/, "")}/capabilities`, { headers: { "x-deploylite-signature": handshakeSignature }, signal }), signal);
      const binding = handshakeResponse.headers.get("x-deploylite-request-signature");
      if (!handshakeResponse.ok || binding !== handshakeSignature) throw new TransportError("capability_unavailable");
      const handshake = agentCapabilityHandshakeSchema.parse(await awaitAbortable(() => handshakeResponse.json(), signal));
      if (handshake.agentId !== this.#options.agentId || !handshake.capabilities.includes(COMPOSE_VOLUME_BACKUP_CAPABILITY)) throw new TransportError("capability_unavailable");
      const payload = JSON.stringify(body); sent();
      const response = await awaitAbortable(() => this.#fetch(`${this.#options.endpoint.replace(/\/$/, "")}${COMPOSE_VOLUME_BACKUP_PATH}`, { method: "POST", headers: { "content-type": "application/json", "x-deploylite-signature": signAgentTransport(payload, this.#options.trustKey) }, body: payload, signal }), signal);
      if (!response.ok) throw new TransportError(`agent transport returned HTTP ${response.status}`);
      const receipt = composeVolumeBackupReceiptSchema.parse(await awaitAbortable(() => response.json(), signal));
      if (!this.matchesVolumeBackupReceipt(body, receipt)) throw new TransportError("agent volume backup receipt identity mismatch");
      return receipt;
    });
  }

  async readComposeVolumeBackupReceipt(prepared: PreparedComposeVolumeBackupCommand, authority: ProjectControlAuthorityV1, context: Pick<AgentDispatchContext, "requestId" | "correlationId" | "signal">): Promise<ComposeVolumeBackupReceiptV1 | null> {
    if (!this.available()) throw new TransportError("agent transport is not configured");
    if (prepared.agentId !== this.#options.agentId || authority.projectId !== prepared.projectId
      || authority.commandId !== prepared.commandId || authority.inputDigest !== prepared.inputDigest
      || prepared.context.correlationId !== context.correlationId) throw new TransportError("project update authority scope rejected");
    const timeoutMs = Math.min(60_000, this.#options.timeoutMs ?? 30_000, prepared.plan.limits.maxDurationMs);
    const command = composeVolumeBackupAgentCommandSchema.parse({ ...prepared, requiredCapabilities: [COMPOSE_VOLUME_BACKUP_CAPABILITY], authority,
      lease: authority.projectLease, context: { requestId: context.requestId, correlationId: context.correlationId }, timeoutMs, cancellationRequested: false });
    const query = composeVolumeBackupReceiptQuerySchema.parse(Object.fromEntries(Object.entries(command).filter(([field]) => field !== "cancellationRequested")));
    const payload = JSON.stringify(query);
    const result = await this.operate(query.timeoutMs, context.signal, async (signal, sent) => {
      sent();
      const response = await awaitAbortable(() => this.#fetch(`${this.#options.endpoint.replace(/\/$/, "")}${COMPOSE_VOLUME_BACKUP_RECEIPT_PATH}`, { method: "POST", headers: { "content-type": "application/json", "x-deploylite-signature": signAgentTransport(`POST ${COMPOSE_VOLUME_BACKUP_RECEIPT_PATH}\n${payload}`, this.#options.trustKey) }, body: payload, signal }), signal);
      if (!response.ok) throw new TransportError(`agent cache returned HTTP ${response.status}`);
      return composeVolumeBackupCachedReceiptSchema.parse(await awaitAbortable(() => response.json(), signal));
    });
    if (result.agentId !== this.#options.agentId || result.commandId !== query.commandId || result.correlationId !== query.context.correlationId) throw new TransportError("agent cached volume backup receipt identity mismatch");
    if (result.receipt && !this.matchesVolumeBackupReceipt(query, result.receipt)) throw new TransportError("agent cached volume backup receipt scope rejected");
    return result.receipt;
  }

  private matchesVolumeBackupReceipt(command: Pick<ComposeVolumeBackupAgentCommandV1, "agentId" | "commandId" | "projectId" | "inputDigest" | "context" | "plan">, receipt: ComposeVolumeBackupReceiptV1): boolean {
    return receipt.agentId === command.agentId && receipt.commandId === command.commandId && receipt.projectId === command.projectId
      && receipt.inputDigest === command.inputDigest && receipt.correlationId === command.context.correlationId
      && receipt.volumeKey === command.plan.volumeKey && receipt.destinationId === command.plan.destinationId;
  }

  async readExecutionReceipt(snapshot: DeploymentSnapshotV1, commandId: string, context?: AgentDispatchContext): Promise<DockerImageExecutionReceiptV1 | DeploymentDispatchReceipt | null> {
    snapshot = structuredClone(snapshot); context = context ? { ...context, authority: context.authority ? structuredClone(context.authority) : undefined, replacement: context.replacement ? structuredClone(context.replacement) : undefined } : undefined;
    const query = agentReceiptQuerySchema.parse({ schemaVersion: 1, action: "deploy.execute", agentId: context?.agentId ?? this.#options.agentId, commandId, projectId: snapshot.projectId, deploymentId: context?.executionDeploymentId ?? snapshot.deploymentId, ...(context?.activeDeploymentId ? { activeDeploymentId: context.activeDeploymentId } : {}), sourceDeploymentId: context?.executionDeploymentId === undefined ? null : context.sourceDeploymentId ?? snapshot.deploymentId, snapshot: { ...snapshot, canonicalBytes: undefined }, snapshotHash: snapshot.hash, correlationId: context?.correlationId ?? commandId, authority: context?.authority ?? null, replacement: context?.replacement ?? null, timeoutMs: this.#options.timeoutMs ?? 30_000 });
    const result = await this.readCached(query, context?.signal);
    if (result.action !== "deploy.execute" || query.action !== "deploy.execute") throw new TransportError("agent cached receipt identity mismatch");
    if (!result.receipt) return null;
    const receipt = result.receipt;
    if (receipt.commandId !== query.commandId || receipt.deploymentId !== query.deploymentId || receipt.receipt.deploymentId !== query.deploymentId || (query.sourceDeploymentId === null ? receipt.schemaVersion !== 1 : receipt.schemaVersion !== 2 || (receipt.activeDeploymentId ?? null) !== (query.activeDeploymentId ?? null) || receipt.sourceDeploymentId !== query.sourceDeploymentId || receipt.snapshotHash !== query.snapshotHash || receipt.correlationId !== query.correlationId)) throw new TransportError("agent cached execution identity mismatch");
    return query.action === "deploy.execute" && query.sourceDeploymentId !== null ? { ...result.receipt.receipt, ...(query.activeDeploymentId ? { activeDeploymentId: query.activeDeploymentId } : {}), projectId: query.projectId, sourceDeploymentId: query.sourceDeploymentId, snapshotHash: query.snapshotHash, correlationId: query.correlationId } : result.receipt.receipt;
  }
  async readStopReceipt(input: AgentStopDispatchInput, context: AgentDispatchContext): Promise<ReturnType<typeof deploymentStopAgentReceiptSchema.parse> | null> {
    input = structuredClone(input); context = { ...context, authority: context.authority ? structuredClone(context.authority) : undefined };
    const query = agentReceiptQuerySchema.parse({ schemaVersion: 1, action: "deployment.stop", agentId: context.agentId, commandId: input.commandId, projectId: input.projectId, deploymentId: input.deploymentId, candidateId: input.candidateId, effectiveImage: input.effectiveImage, containerId: input.containerId ?? null, correlationId: context.correlationId, authority: context.authority ?? null, timeoutMs: this.#options.timeoutMs ?? 30_000 });
    const result = await this.readCached(query, context.signal);
    if (result.action !== "deployment.stop" || query.action !== "deployment.stop") throw new TransportError("agent cached receipt identity mismatch");
    const receipt = result.receipt;
    if (receipt && (receipt.agentId !== this.#options.agentId || receipt.commandId !== query.commandId || receipt.projectId !== query.projectId || receipt.deploymentId !== query.deploymentId || receipt.candidateId !== query.candidateId || receipt.effectiveImage !== query.effectiveImage || (receipt.containerId ?? null) !== query.containerId || receipt.correlationId !== query.correlationId)) throw new TransportError("agent cached Stop identity mismatch");
    return receipt;
  }
  private async readCached(query: AgentReceiptQuery, parent?: AbortSignal) {
    if (!this.available()) throw new TransportError("agent transport is not configured");
    if (query.agentId !== this.#options.agentId) throw new TransportError("agent transport identity mismatch");
    const payload = JSON.stringify(query);
    return this.operate(query.timeoutMs, parent, async (signal, sent) => {
      sent(); const response = await awaitAbortable(() => this.#fetch(`${this.#options.endpoint.replace(/\/$/, "")}/deployments/receipt`, { method: "POST", headers: { "content-type": "application/json", "x-deploylite-signature": signAgentTransport(`POST /deployments/receipt\n${payload}`, this.#options.trustKey) }, body: payload, signal }), signal);
      if (!response.ok) throw new TransportError(`agent cache returned HTTP ${response.status}`);
      const result = agentCachedReceiptSchema.parse(await awaitAbortable(() => response.json(), signal));
      if (result.action !== query.action || result.agentId !== this.#options.agentId || result.commandId !== query.commandId || result.correlationId !== query.correlationId) throw new TransportError("agent cached receipt identity mismatch");
      return result;
    });
  }

  async dispatchStop(input: AgentStopDispatchInput, context: AgentDispatchContext): Promise<ReturnType<typeof deploymentStopAgentReceiptSchema.parse>> {
    input = structuredClone(input); context = { ...context, authority: context.authority ? structuredClone(context.authority) : undefined };
    if (!this.available()) throw beforeDispatch(new TransportError("agent transport is not configured")); if (context.agentId !== this.#options.agentId) throw beforeDispatch(new TransportError("agent transport identity mismatch")); if (context.signal?.aborted) throw beforeDispatch(new TransportCanceledError());
    const now = this.#options.now ?? Date.now; const timeoutMs = this.#options.timeoutMs ?? 30_000; const body = { schemaVersion: 1 as const, action: "deployment.stop" as const, agentId: this.#options.agentId, commandId: input.commandId, projectId: input.projectId, deploymentId: input.deploymentId, candidateId: input.candidateId, effectiveImage: input.effectiveImage, ...(input.containerId ? { containerId: input.containerId } : {}), requiredCapabilities: ["deployment.stop" as const], lease: context.authority?.executionLease ?? { leaseId: `${input.deploymentId}:transport:stop:1`, deploymentId: input.deploymentId, fence: 1, expiresAt: now() + timeoutMs }, ...(context.authority ? { authority: context.authority } : {}), context: { requestId: context.requestId, correlationId: context.correlationId }, timeoutMs, cancellationRequested: false };
    return this.operate(timeoutMs, context.signal, async (signal, dispatched) => {
      const payload = JSON.stringify(body); dispatched();
      const response = await awaitAbortable(() => this.#fetch(`${this.#options.endpoint.replace(/\/$/, "")}/deployments/stop`, { method: "POST", headers: { "content-type": "application/json", "x-deploylite-signature": signAgentTransport(payload, this.#options.trustKey) }, body: payload, signal }), signal);
      if (!response.ok) throw new TransportError(`agent transport returned HTTP ${response.status}`);
      const result = deploymentStopAgentReceiptSchema.parse(await awaitAbortable(() => response.json(), signal));
      if (result.commandId !== input.commandId || result.agentId !== this.#options.agentId || result.projectId !== input.projectId || result.deploymentId !== input.deploymentId || result.correlationId !== context.correlationId || (input.containerId !== undefined && result.containerId !== input.containerId)) throw new TransportError("agent stop receipt identity mismatch");
      return result;
    });
  }
  private async operate<T>(timeoutMs: number, parent: AbortSignal | undefined, operation: (signal: AbortSignal, dispatched: () => void) => Promise<T>): Promise<T> {
    const controller = new AbortController(); let sent = false; const deadline = Date.now() + timeoutMs;
    const assertBudget = () => { if (Date.now() >= deadline && !controller.signal.aborted) controller.abort(new TransportTimeoutError()); if (controller.signal.aborted) throw controller.signal.reason; };
    const cancel = () => controller.abort(new TransportCanceledError());
    parent?.addEventListener("abort", cancel, { once: true }); if (parent?.aborted) cancel();
    const timer = setTimeout(() => controller.abort(new TransportTimeoutError()), timeoutMs);
    try { const result = await awaitAbortable(() => operation(controller.signal, () => { assertBudget(); sent = true; }), controller.signal); assertBudget(); return result; }
    catch (error) {
      const classified = error instanceof TransportError || error instanceof TransportTimeoutError || error instanceof TransportCanceledError ? error : new TransportError(error instanceof Error ? error.message : "agent transport failed");
      if (!sent) preDispatchRejections.add(classified); throw classified;
    } finally { clearTimeout(timer); parent?.removeEventListener("abort", cancel); }
  }
}
