import { createHash, timingSafeEqual } from "node:crypto";
import { signAgentTransport, validateAgentTransportKey, verifyAgentTransport } from "@deploylite/config";
import { agentReceiptQuerySchema, agentCachedReceiptSchema, type AgentReceiptQuery, agentExecutionCommandSchema, CapabilityError, composeNetworkAttachmentAgentCommandSchema, composeNetworkAttachmentCachedReceiptSchema, composeNetworkAttachmentReceiptQuerySchema, composeNetworkAttachmentReceiptSchema, composeResourceAttachmentCommandSchema, composeResourceInspectionAgentCommandSchema, composeResourceInspectionAgentResponseSchema, composeResourceObservationSchema, COMPOSE_NETWORK_ATTACHMENT_CAPABILITY, COMPOSE_NETWORK_ATTACHMENT_RECEIPT_PATH, COMPOSE_RESOURCE_INSPECTION_CAPABILITY, COMPOSE_RESOURCE_INSPECTION_PATH, composeVolumeBackupAgentCommandSchema, composeVolumeBackupCachedReceiptSchema, composeVolumeBackupReceiptQuerySchema, composeVolumeBackupReceiptSchema, COMPOSE_VOLUME_BACKUP_CAPABILITY, COMPOSE_VOLUME_BACKUP_RECEIPT_PATH, createDeploymentCommand, deploymentStopAgentCommandSchema, deploymentStopAgentReceiptSchema, dockerImageExecutionReceiptSchema, FenceError, LeaseExpiredError, protocolPayloadFingerprint, TransportCanceledError, TransportTimeoutError, type AgentExecutionCommand, type ComposeNetworkAttachmentAgentCommandV1, type ComposeNetworkAttachmentReceiptV1, type ComposeVolumeBackupAgentCommandV1, type ComposeVolumeBackupReceiptQueryV1, type ComposeVolumeBackupReceiptV1, type DeploymentSnapshotV1, type DeploymentStopAgentCommand, type DeploymentStopAgentReceipt, type LeaseV1, type ProjectControlAuthorityV1, type PromotionPolicy, type DeploymentExecutionAuthorityV1 } from "@deploylite/contracts";
import { awaitAbortable, composeResourceAttachmentExecutionDigest, composeVolumeBackupExecutionDigest, digestComposeResourceObservation, validateDockerImageSnapshot, type ComposeResourceInspector, type DockerImageExecutionReceiptV1, type DeploymentAuthorityValidation, type PriorDockerImageExecutionReceiptV1 } from "@deploylite/domain";
import type { ComposeVolumeBackupAuthority } from "./infrastructure/docker/docker-compose-volume-backup.js";

export type RuntimeExecutionAuthority = { assertValid(): Promise<void>; readonly expiresAt?: number };
export type AgentDispatchOptions = { activeDeploymentId?: string; sourceDeploymentId?: string; executionDeploymentId?: string; runtimeHost?: string; priorProvenReceipt?: PriorDockerImageExecutionReceiptV1; promotionPolicy?: PromotionPolicy; authority?: RuntimeExecutionAuthority; preparationTimeoutMs?: number };
export type AgentCommandDispatcher = { readonly promotionPolicy?: PromotionPolicy; readonly runtimeConfig?: { readonly hostPort: number; readonly containerPort: number; readonly networkName?: string }; dispatch(snapshot: any, commandId: string, signal?: AbortSignal, lease?: LeaseV1, options?: AgentDispatchOptions): Promise<DockerImageExecutionReceiptV1> };
export type AgentStopDispatcher = { stop(input: { projectId: string; deploymentId: string; candidateId: string; effectiveImage: string; containerId?: string }, signal?: AbortSignal, lease?: LeaseV1, authority?: RuntimeExecutionAuthority, timeoutMs?: number): Promise<"stopped" | "already-stopped" | "absent" | "failed" | "canceled"> };
export type AgentReplayReceipt = Record<string, unknown>;
export type AgentReplayClaim = { claimed: boolean; claimToken?: string; receipt?: AgentReplayReceipt };
type ReplayLease = Readonly<{ leaseId: string; fence: number; expiresAt: number }>;
type FenceLease = ReplayLease & Readonly<{ deploymentId?: string; projectId?: string }>;
export type AgentReplayStore = { readonly durable?: boolean; lookup?(commandId: string, fingerprint: string): Promise<AgentReplayReceipt | null>; claim(commandId: string, fingerprint: string, lease: ReplayLease): Promise<AgentReplayClaim>; wait(commandId: string): Promise<AgentReplayReceipt>; complete(commandId: string, value: { fingerprint: string; claimToken: string; receipt: AgentReplayReceipt }): Promise<void>; release(commandId: string, claimToken?: string): Promise<void> };
export type AgentNetworkAttachmentExecutor = { execute(command: ComposeNetworkAttachmentAgentCommandV1, authority: RuntimeExecutionAuthority, signal: AbortSignal): Promise<ComposeNetworkAttachmentReceiptV1> };
export type AgentVolumeBackupExecutor = { execute(command: ComposeVolumeBackupAgentCommandV1, authority: ComposeVolumeBackupAuthority, signal: AbortSignal): Promise<ComposeVolumeBackupReceiptV1> };
export type AgentCommandReceiverOptions = Readonly<{ agentId: string; trustKey: string; capabilities: readonly string[]; dispatcher: AgentCommandDispatcher; stopDispatcher?: AgentStopDispatcher; networkAttachment?: AgentNetworkAttachmentExecutor; volumeBackup?: AgentVolumeBackupExecutor; resourceInspector?: ComposeResourceInspector; replayStore: AgentReplayStore; authorityValidator?: DeploymentAuthorityValidation; now?: () => number }>;

export class AuthenticatedAgentCommandReceiver {
  readonly #options: AgentCommandReceiverOptions;
  readonly #fences = new Map<string, FenceLease>();
  constructor(options: AgentCommandReceiverOptions) {
    validateAgentTransportKey(options.trustKey);
    const capabilities = options.capabilities.filter(capability => capability !== COMPOSE_RESOURCE_INSPECTION_CAPABILITY || Boolean(options.resourceInspector));
    this.#options = { ...options, capabilities };
  }
  hasDurableReplayStore(): boolean { return this.#options.replayStore.durable === true; }
  get agentId(): string { return this.#options.agentId; }
  get capabilities(): readonly string[] { return this.#options.capabilities; }
  verifyRequest(payload: string, signature: string | undefined): boolean { return verifyAgentTransport(payload, signature, this.#options.trustKey); }
  signResponse(payload: string): string { return signAgentTransport(payload, this.#options.trustKey); }
  async readReceipt(body: unknown, signature: string | undefined, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new TransportCanceledError();
    const started = Date.now();
    if (!this.verifyRequest(`POST /deployments/receipt\n${JSON.stringify(body)}`, signature)) throw new Error("agent authentication failed");
    const query = agentReceiptQuerySchema.parse(structuredClone(body));
    const runtime = this.#options.dispatcher.runtimeConfig ? structuredClone(this.#options.dispatcher.runtimeConfig) : undefined;
    if (query.agentId !== this.#options.agentId) throw new Error("agent cache scope rejected");
    if (query.action === "deploy.execute") {
      const canonicalJson = query.snapshot.canonicalJson;
      if (typeof canonicalJson !== "string") throw new Error("agent snapshot evidence rejected");
      const snapshot = { ...query.snapshot, canonicalBytes: new TextEncoder().encode(canonicalJson) } as unknown as DeploymentSnapshotV1;
      validateDockerImageSnapshot(snapshot, { sha256: (value) => createHash("sha256").update(value).digest("hex") });
      if (query.projectId !== snapshot.projectId || (snapshot.agentId && snapshot.agentId !== this.#options.agentId) || query.snapshotHash !== snapshot.hash || (query.sourceDeploymentId === null ? query.deploymentId !== snapshot.deploymentId || query.authority !== null || query.replacement !== null : query.sourceDeploymentId === query.deploymentId) || (runtime && snapshot.runtimePort !== runtime.containerPort)) throw new Error("agent cache scope rejected");
    }
    const fingerprint = this.receiptFingerprint(query, runtime);
    const controller = new AbortController(), cancel = () => controller.abort(new TransportCanceledError());
    signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel();
    const remaining = query.timeoutMs - (Date.now() - started);
    const timer = setTimeout(() => controller.abort(new TransportTimeoutError()), Math.max(0, remaining));
    try {
    if (remaining <= 0) throw new TransportTimeoutError();
      const cached = await awaitAbortable(async () => await this.#options.replayStore.lookup?.(query.commandId, fingerprint) ?? null, controller.signal);
      if (Date.now() >= started + query.timeoutMs) throw new TransportTimeoutError();
      let receipt: unknown = null;
      if (cached && query.action === "deploy.execute") {
        const command = { schemaVersion: query.sourceDeploymentId === null ? 1 as const : 2 as const, commandId: query.commandId, projectId: query.projectId, deploymentId: query.deploymentId, ...(query.sourceDeploymentId === null ? {} : { sourceDeploymentId: query.sourceDeploymentId }), snapshot: query.snapshot, snapshotHash: query.snapshotHash, context: { correlationId: query.correlationId } };
        const inner = this.#validatedReceipt(command, dockerImageExecutionReceiptSchema.parse(cached), runtime);
        receipt = query.sourceDeploymentId === null ? { schemaVersion: 1, commandId: query.commandId, deploymentId: query.deploymentId, terminalStatus: inner.terminalStatus, health: inner.health, redacted: true, receipt: inner } : { ...(query.activeDeploymentId ? { activeDeploymentId: query.activeDeploymentId } : {}), schemaVersion: 2, commandId: query.commandId, deploymentId: query.deploymentId, sourceDeploymentId: query.sourceDeploymentId, snapshotHash: query.snapshotHash, correlationId: query.correlationId, terminalStatus: inner.terminalStatus, health: inner.health, redacted: true, receipt: inner };
      } else if (cached) {
        const stopped = deploymentStopAgentReceiptSchema.parse(cached);
        if (query.action !== "deployment.stop" || stopped.agentId !== query.agentId || stopped.commandId !== query.commandId || stopped.projectId !== query.projectId || stopped.deploymentId !== query.deploymentId || stopped.candidateId !== query.candidateId || stopped.effectiveImage !== query.effectiveImage || (stopped.containerId ?? null) !== query.containerId || stopped.correlationId !== query.correlationId) throw new Error("agent cached Stop scope rejected");
        receipt = stopped;
      }
      return agentCachedReceiptSchema.parse({ schemaVersion: 1, action: query.action, agentId: this.#options.agentId, commandId: query.commandId, correlationId: query.correlationId, receipt });
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
  }
  async readComposeNetworkAttachmentReceipt(body: unknown, signature: string | undefined, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new TransportCanceledError();
    const text = JSON.stringify(body);
    if (!this.verifyRequest(`POST ${COMPOSE_NETWORK_ATTACHMENT_RECEIPT_PATH}\n${text}`, signature)) throw new Error("agent authentication failed");
    const query = composeNetworkAttachmentReceiptQuerySchema.parse(structuredClone(body));
    if (query.agentId !== this.#options.agentId || !this.#options.capabilities.includes(COMPOSE_NETWORK_ATTACHMENT_CAPABILITY)) throw new Error("agent cache scope rejected");
    const fingerprint = this.networkAttachmentFingerprint(query);
    const receipt = await this.lookupReplay(query.commandId, fingerprint, query.timeoutMs, signal);
    const parsed = receipt === null ? null : composeNetworkAttachmentReceiptSchema.parse(receipt);
    if (parsed && !this.matchesNetworkReceipt(query, parsed)) throw new Error("agent cached network receipt scope rejected");
    return composeNetworkAttachmentCachedReceiptSchema.parse({ schemaVersion: 1, action: "compose.network.attachment", agentId: this.#options.agentId,
      commandId: query.commandId, correlationId: query.context.correlationId, receipt: parsed });
  }
  async readComposeVolumeBackupReceipt(body: unknown, signature: string | undefined, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new TransportCanceledError();
    const text = JSON.stringify(body);
    if (!this.verifyRequest(`POST ${COMPOSE_VOLUME_BACKUP_RECEIPT_PATH}\n${text}`, signature)) throw new Error("agent authentication failed");
    const query = composeVolumeBackupReceiptQuerySchema.parse(structuredClone(body));
    if (query.agentId !== this.#options.agentId || !this.#options.capabilities.includes(COMPOSE_VOLUME_BACKUP_CAPABILITY)) throw new Error("agent cache scope rejected");
    const fingerprint = this.volumeBackupFingerprint(query);
    const cached = await this.lookupReplay(query.commandId, fingerprint, query.timeoutMs, signal);
    const parsed = cached === null ? null : composeVolumeBackupReceiptSchema.parse(cached);
    if (parsed && !this.matchesVolumeBackupReceipt(query, parsed)) throw new Error("agent cached volume backup receipt scope rejected");
    return composeVolumeBackupCachedReceiptSchema.parse({ schemaVersion: 1, action: "compose.volume.backup", agentId: this.#options.agentId,
      commandId: query.commandId, correlationId: query.context.correlationId,
      receipt: parsed ? this.replayedVolumeBackupReceipt(parsed) : null });
  }
  async inspectComposeResource(body: unknown, signature: string | undefined, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new TransportCanceledError();
    const text = JSON.stringify(body);
    if (!this.verifyRequest(`POST ${COMPOSE_RESOURCE_INSPECTION_PATH}\n${text}`, signature)) throw new Error("agent authentication failed");
    const command = composeResourceInspectionAgentCommandSchema.parse(structuredClone(body));
    const inspector = this.#options.resourceInspector;
    if (command.agentId !== this.#options.agentId || !inspector || !this.#options.capabilities.includes(COMPOSE_RESOURCE_INSPECTION_CAPABILITY))
      throw new CapabilityError(COMPOSE_RESOURCE_INSPECTION_CAPABILITY);
    const start = (this.#options.now ?? Date.now)();
    if (!Number.isSafeInteger(start) || start < 0) throw new TransportTimeoutError();
    const controller = new AbortController();
    const cancel = () => controller.abort(new TransportCanceledError());
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(() => controller.abort(new TransportTimeoutError()), command.timeoutMs);
    try {
      const observation = composeResourceObservationSchema.parse(await awaitAbortable(() => inspector.inspect(
        { preview: structuredClone(command.preview), kind: command.kind, key: command.key }, controller.signal, command.context), controller.signal));
      const resource = command.kind === "network" ? command.preview.networks.find(value => value.key === command.key) : command.preview.volumes.find(value => value.key === command.key);
      if (!resource || observation.agentId !== this.#options.agentId || observation.projectId !== command.projectId
        || observation.kind !== command.kind || observation.key !== command.key || observation.runtimeName !== resource.runtimeName
        || observation.configDigest !== command.expectedConfigDigest || digestComposeResourceObservation(observation) !== observation.stateDigest)
        throw new Error("agent inspection scope rejected");
      if ((this.#options.now ?? Date.now)() >= start + command.timeoutMs) throw new TransportTimeoutError();
      return composeResourceInspectionAgentResponseSchema.parse({ schemaVersion: 1, action: "compose.resource.inspect", agentId: this.#options.agentId,
        projectId: command.projectId, configDigest: command.expectedConfigDigest, kind: command.kind, key: command.key,
        context: command.context, observation });
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
  }
  private receiptFingerprint(query: AgentReceiptQuery, runtime?: AgentCommandDispatcher["runtimeConfig"]): string {
    return protocolPayloadFingerprint(query.action === "deploy.execute" ? { ...(query.activeDeploymentId ? { activeDeploymentId: query.activeDeploymentId } : {}), snapshot: query.snapshot, agentId: this.#options.agentId, deploymentId: query.deploymentId, sourceDeploymentId: query.sourceDeploymentId, correlationId: query.correlationId, runtimeConfig: runtime ?? null, authority: query.authority, replacement: query.replacement } : { action: query.action, agentId: query.agentId, projectId: query.projectId, deploymentId: query.deploymentId, candidateId: query.candidateId, effectiveImage: query.effectiveImage, containerId: query.containerId, correlationId: query.correlationId, authority: query.authority });
  }
  async receive(body: unknown, signature: string | undefined, signal?: AbortSignal): Promise<any> {
    if (signal?.aborted) throw new TransportCanceledError();
    const text = JSON.stringify(body); if (!verifyAgentTransport(text, signature, this.#options.trustKey)) throw new Error("agent authentication failed");
    if (typeof body === "object" && body !== null && (body as { action?: string }).action === "compose.volume.backup") return this.receiveComposeVolumeBackup(body, signal);
    if (typeof body === "object" && body !== null && (body as { action?: string }).action === "compose.network.attachment") return this.receiveComposeNetworkAttachment(body, signal);
    if (typeof body === "object" && body !== null && (body as { action?: string }).action === "deployment.stop") return this.receiveStop(body, signal);
    const command = agentExecutionCommandSchema.parse(structuredClone(body));
    const canonicalJson = command.snapshot.canonicalJson;
    if (typeof canonicalJson !== "string") throw new Error("agent snapshot evidence rejected");
    const bytes = new TextEncoder().encode(canonicalJson);
    const snapshot = structuredClone({ ...command.snapshot, canonicalBytes: bytes }) as unknown as DeploymentSnapshotV1;
    validateDockerImageSnapshot(snapshot, { sha256: (value) => createHash("sha256").update(value).digest("hex") });
    const runtime = this.#options.dispatcher.runtimeConfig ? structuredClone(this.#options.dispatcher.runtimeConfig) : undefined;
    if (command.agentId !== this.#options.agentId || (snapshot.agentId && snapshot.agentId !== this.#options.agentId) || command.projectId !== snapshot.projectId || (command.schemaVersion === 1 && command.deploymentId !== snapshot.deploymentId) || (command.schemaVersion === 2 && command.sourceDeploymentId === command.deploymentId) || command.deploymentId !== command.lease.deploymentId || command.snapshotHash !== snapshot.hash || (runtime && runtime.containerPort !== snapshot.runtimePort)) throw new Error("agent command scope rejected");
    const options = command.schemaVersion === 1 && this.#options.authorityValidator ? { authority: this.initialAuthority(command) } : this.replacementOptions(command, runtime, snapshot);
    if (command.requiredCapabilities.length !== 1 || command.requiredCapabilities[0] !== "deploy.execute") throw new CapabilityError(command.requiredCapabilities[0] ?? "deploy.execute");
    for (const capability of command.requiredCapabilities) if (!this.#options.capabilities.includes(capability)) throw new CapabilityError(capability);
    if ((this.#options.now ?? Date.now)() >= command.lease.expiresAt) throw new LeaseExpiredError();
    this.validateFence(command.lease); const fingerprint = protocolPayloadFingerprint({ ...(command.schemaVersion === 2 && command.activeDeploymentId ? { activeDeploymentId: command.activeDeploymentId } : {}), snapshot: command.snapshot, agentId: this.#options.agentId, deploymentId: command.deploymentId, sourceDeploymentId: command.schemaVersion === 2 ? command.sourceDeploymentId : null, correlationId: command.context.correlationId, runtimeConfig: runtime ?? null, authority: command.schemaVersion === 2 ? command.authority ?? null : null, replacement: command.schemaVersion === 2 ? command.replacement ?? null : null }); createDeploymentCommand({ schemaVersion: 1, commandId: command.commandId, deploymentId: command.deploymentId, requiredCapabilities: command.requiredCapabilities, payload: { snapshotHash: command.snapshotHash }, lease: command.lease });
    const admission = this.admission(command.timeoutMs, command.lease, signal);
    let claim: AgentReplayClaim | undefined;
    try {
      claim = await this.claimReplay(command.commandId, fingerprint, command.lease, admission.signal);
      if (!claim.claimed) return this.#wrap(command, dockerImageExecutionReceiptSchema.parse(claim.receipt ?? await awaitAbortable(() => this.#options.replayStore.wait(command.commandId), admission.signal)), runtime);
      await awaitAbortable(async () => options.authority?.assertValid(), admission.signal);
      admission.finishPreparation();
      if (command.cancellationRequested) admission.cancel();
      // The dispatcher owns preparation/cutover/recovery. Do not race its independent recovery against caller cancellation.
      const receipt = await this.#options.dispatcher.dispatch(snapshot, command.commandId, admission.signal, command.lease, { executionDeploymentId: command.deploymentId, runtimeHost: this.#options.agentId, ...options, preparationTimeoutMs: admission.remaining() });
      const validated = this.#validatedReceipt(command, receipt, runtime);
      if (!claim.claimToken) throw new Error("agent replay claim token missing");
      await this.#options.replayStore.complete(command.commandId, { fingerprint, claimToken: claim.claimToken, receipt: validated as unknown as AgentReplayReceipt });
      return this.#wrap(command, validated, runtime);
    } catch (error) { if (claim?.claimed && claim.claimToken) this.releaseReplay(command.commandId, claim.claimToken); throw error; }
    finally { admission.dispose(); }

  }
  private async receiveStop(body: unknown, signal?: AbortSignal): Promise<DeploymentStopAgentReceipt> {
    const command = deploymentStopAgentCommandSchema.parse(structuredClone(body)); if (!this.#options.stopDispatcher) throw new CapabilityError("deployment.stop");
    const authority = this.runtimeAuthority(command.authority, command.projectId, command.deploymentId, command.lease, "deployment.stop");
    if (command.agentId !== this.#options.agentId || command.lease.deploymentId !== command.deploymentId) throw new Error("agent command scope rejected");
    if (!this.#options.capabilities.includes("deployment.stop")) throw new CapabilityError("deployment.stop"); if ((this.#options.now?.() ?? Date.now()) >= command.lease.expiresAt) throw new LeaseExpiredError();
    if (signal?.aborted) throw new TransportCanceledError(); this.validateFence(command.lease); const fingerprint = protocolPayloadFingerprint({ action: command.action, agentId: command.agentId, projectId: command.projectId, deploymentId: command.deploymentId, candidateId: command.candidateId, effectiveImage: command.effectiveImage, containerId: command.containerId ?? null, correlationId: command.context.correlationId, authority: command.authority ?? null });
    const admission = this.admission(command.timeoutMs, command.lease, signal); let claim: AgentReplayClaim | undefined;
    try {
      claim = await this.claimReplay(command.commandId, fingerprint, command.lease, admission.signal);
      if (!claim.claimed) return deploymentStopAgentReceiptSchema.parse(claim.receipt ?? await awaitAbortable(() => this.#options.replayStore.wait(command.commandId), admission.signal));
      await awaitAbortable(async () => authority?.assertValid(), admission.signal); admission.finishPreparation();
      if (command.cancellationRequested) admission.cancel();
      const status = await this.#options.stopDispatcher.stop({ projectId: command.projectId, deploymentId: command.deploymentId, candidateId: command.candidateId, effectiveImage: command.effectiveImage, ...(command.containerId ? { containerId: command.containerId } : {}) }, admission.signal, command.lease, authority, admission.remaining());
      const receipt = deploymentStopAgentReceiptSchema.parse({ schemaVersion: 1, action: command.action, agentId: command.agentId, commandId: command.commandId, projectId: command.projectId, deploymentId: command.deploymentId, candidateId: command.candidateId, effectiveImage: command.effectiveImage, ...(command.containerId ? { containerId: command.containerId } : {}), status, redacted: true, correlationId: command.context.correlationId, reason: status === "failed" ? "docker_stop_failed" : status === "canceled" ? "canceled" : null });
      if (!claim.claimToken) throw new Error("agent replay claim token missing");
      await this.#options.replayStore.complete(command.commandId, { fingerprint, claimToken: claim.claimToken, receipt }); return receipt;
    } catch (error) { if (claim?.claimed && claim.claimToken) this.releaseReplay(command.commandId, claim.claimToken); throw error; }
    finally { admission.dispose(); }

  }
  private async receiveComposeNetworkAttachment(body: unknown, signal?: AbortSignal): Promise<ComposeNetworkAttachmentReceiptV1> {
    const command = composeNetworkAttachmentAgentCommandSchema.parse(structuredClone(body));
    if (!this.#options.networkAttachment || !this.#options.capabilities.includes(COMPOSE_NETWORK_ATTACHMENT_CAPABILITY)
      || command.requiredCapabilities.length !== 1 || command.requiredCapabilities[0] !== COMPOSE_NETWORK_ATTACHMENT_CAPABILITY) throw new CapabilityError(COMPOSE_NETWORK_ATTACHMENT_CAPABILITY);
    if (command.agentId !== this.#options.agentId || command.lease.projectId !== command.projectId
      || command.authority.projectId !== command.projectId || command.authority.commandId !== command.commandId
      || command.authority.inputDigest !== command.inputDigest || protocolPayloadFingerprint(command.lease) !== protocolPayloadFingerprint(command.authority.projectLease)) throw new FenceError("Project update authority scope rejected");
    const request = composeResourceAttachmentCommandSchema.parse({ schemaVersion: 1, action: "project.update", scope: { kind: "project", projectId: command.projectId },
      operation: command.operation, idempotencyKey: command.idempotencyKey, correlationId: command.context.correlationId, projectId: command.projectId,
      kind: "network", key: command.key, runtimeName: command.runtimeName, service: command.service, attachmentAction: command.attachmentAction,
      configDigest: command.configDigest, stateDigest: command.stateDigest, containerId: command.containerId, alreadySatisfied: command.alreadySatisfied });
    if (composeResourceAttachmentExecutionDigest(request) !== command.inputDigest) throw new FenceError("Project update input digest mismatch");
    const fingerprint = this.networkAttachmentFingerprint(command);
    const cached = await this.lookupReplay(command.commandId, fingerprint, command.timeoutMs, signal);
    if (cached) {
      const receipt = composeNetworkAttachmentReceiptSchema.parse(cached);
      if (!this.matchesNetworkReceipt(command, receipt)) throw new FenceError("Cached project update receipt scope rejected");
      return receipt;
    }
    const now = this.#options.now ?? Date.now;
    if (now() >= command.lease.expiresAt) throw new LeaseExpiredError();
    this.validateFence(command.lease, command.projectId);
    const validator = this.#options.authorityValidator?.validateProjectUpdateAuthority?.bind(this.#options.authorityValidator);
    if (!validator) throw new FenceError("Persisted project update authority reader required");
    const authority: RuntimeExecutionAuthority = { expiresAt: command.lease.expiresAt, assertValid: async () => {
      await validator(structuredClone(command.authority), now());
      if (now() >= command.lease.expiresAt) throw new LeaseExpiredError();
      this.validateFence(command.lease, command.projectId);
    } };
    if (signal?.aborted) throw new TransportCanceledError();
    const admission = this.admission(command.timeoutMs, command.lease, signal);
    let claim: AgentReplayClaim | undefined;
    try {
      claim = await this.claimReplay(command.commandId, fingerprint, command.lease, admission.signal);
      if (!claim.claimed) {
        const receipt = composeNetworkAttachmentReceiptSchema.parse(claim.receipt ?? await awaitAbortable(() => this.#options.replayStore.wait(command.commandId), admission.signal));
        if (!this.matchesNetworkReceipt(command, receipt)) throw new FenceError("Replayed project update receipt scope rejected");
        return receipt;
      }
      await awaitAbortable(() => authority.assertValid(), admission.signal);
      if (admission.signal.aborted) throw admission.signal.reason;
      const receipt = composeNetworkAttachmentReceiptSchema.parse(await this.#options.networkAttachment.execute(command, authority, admission.signal));
      if (!this.matchesNetworkReceipt(command, receipt)) throw new FenceError("Project update receipt scope rejected");
      if (!claim.claimToken) throw new Error("agent replay claim token missing");
      await this.#options.replayStore.complete(command.commandId, { fingerprint, claimToken: claim.claimToken, receipt });
      return receipt;
    } catch (error) { if (claim?.claimed && claim.claimToken) this.releaseReplay(command.commandId, claim.claimToken); throw error; }
    finally { admission.dispose(); }
  }
  private async receiveComposeVolumeBackup(body: unknown, signal?: AbortSignal): Promise<ComposeVolumeBackupReceiptV1> {
    const command = composeVolumeBackupAgentCommandSchema.parse(structuredClone(body));
    if (!this.#options.volumeBackup || !this.#options.capabilities.includes(COMPOSE_VOLUME_BACKUP_CAPABILITY)
      || command.requiredCapabilities.length !== 1 || command.requiredCapabilities[0] !== COMPOSE_VOLUME_BACKUP_CAPABILITY) throw new CapabilityError(COMPOSE_VOLUME_BACKUP_CAPABILITY);
    if (command.agentId !== this.#options.agentId || command.lease.projectId !== command.projectId
      || command.authority.projectId !== command.projectId || command.authority.commandId !== command.commandId
      || command.authority.inputDigest !== command.inputDigest || protocolPayloadFingerprint(command.lease) !== protocolPayloadFingerprint(command.authority.projectLease)
      || command.inputDigest !== composeVolumeBackupExecutionDigest(command)) throw new FenceError("Project update authority scope rejected");
    const fingerprint = this.volumeBackupFingerprint(command);
    const cached = await this.lookupReplay(command.commandId, fingerprint, command.timeoutMs, signal);
    if (cached) {
      const receipt = composeVolumeBackupReceiptSchema.parse(cached);
      if (!this.matchesVolumeBackupReceipt(command, receipt)) throw new FenceError("Cached project update receipt scope rejected");
      return this.replayedVolumeBackupReceipt(receipt);
    }
    const now = this.#options.now ?? Date.now;
    if (now() >= command.lease.expiresAt) throw new LeaseExpiredError();
    this.validateFence(command.lease, command.projectId);
    const validator = this.#options.authorityValidator?.validateProjectUpdateAuthority?.bind(this.#options.authorityValidator);
    if (!validator) throw new FenceError("Persisted project update authority reader required");
    const authority: ComposeVolumeBackupAuthority = { projectId: command.projectId, commandId: command.commandId,
      inputDigest: command.inputDigest, expiresAt: command.lease.expiresAt, assertValid: async () => {
        await validator(structuredClone(command.authority), now());
        if (now() >= command.lease.expiresAt) throw new LeaseExpiredError();
        this.validateFence(command.lease, command.projectId);
      } };
    if (signal?.aborted) throw new TransportCanceledError();
    const admission = this.admission(command.timeoutMs, command.lease, signal); let claim: AgentReplayClaim | undefined;
    try {
      claim = await this.claimReplay(command.commandId, fingerprint, command.lease, admission.signal);
      if (!claim.claimed) {
        const receipt = composeVolumeBackupReceiptSchema.parse(claim.receipt ?? await awaitAbortable(() => this.#options.replayStore.wait(command.commandId), admission.signal));
        if (!this.matchesVolumeBackupReceipt(command, receipt)) throw new FenceError("Replayed project update receipt scope rejected");
        return this.replayedVolumeBackupReceipt(receipt);
      }
      await awaitAbortable(() => authority.assertValid(), admission.signal);
      if (admission.signal.aborted) throw admission.signal.reason;
      const receipt = composeVolumeBackupReceiptSchema.parse(await this.#options.volumeBackup.execute(command, authority, admission.signal));
      if (!this.matchesVolumeBackupReceipt(command, receipt)) throw new FenceError("Project update receipt scope rejected");
      if (!claim.claimToken) throw new Error("agent replay claim token missing");
      await this.#options.replayStore.complete(command.commandId, { fingerprint, claimToken: claim.claimToken, receipt });
      return receipt;
    } catch (error) { if (claim?.claimed && claim.claimToken) this.releaseReplay(command.commandId, claim.claimToken); throw error; }
    finally { admission.dispose(); }
  }
  private networkAttachmentFingerprint(value: ComposeNetworkAttachmentAgentCommandV1 | import("@deploylite/contracts").ComposeNetworkAttachmentReceiptQueryV1): string {
    return protocolPayloadFingerprint({ action: value.action, agentId: value.agentId, commandId: value.commandId, projectId: value.projectId,
      operation: value.operation, idempotencyKey: value.idempotencyKey, inputDigest: value.inputDigest, canonicalDocument: value.canonicalDocument,
      configDigest: value.configDigest, stateDigest: value.stateDigest, key: value.key, runtimeName: value.runtimeName, service: value.service,
      attachmentAction: value.attachmentAction, containerId: value.containerId, alreadySatisfied: value.alreadySatisfied,
      correlationId: value.context.correlationId, authority: value.authority, lease: value.lease });
  }
  private volumeBackupFingerprint(value: ComposeVolumeBackupAgentCommandV1 | ComposeVolumeBackupReceiptQueryV1): string {
    return protocolPayloadFingerprint({ action: value.action, agentId: value.agentId, commandId: value.commandId, projectId: value.projectId,
      operation: value.operation, idempotencyKey: value.idempotencyKey, inputDigest: value.inputDigest, canonicalDocument: value.canonicalDocument,
      plan: value.plan, correlationId: value.context.correlationId, authority: value.authority, lease: value.lease });
  }
  private async lookupReplay(commandId: string, fingerprint: string, timeoutMs: number, parent?: AbortSignal): Promise<AgentReplayReceipt | null> {
    const controller = new AbortController(), cancel = () => controller.abort(new TransportCanceledError());
    parent?.addEventListener("abort", cancel, { once: true }); if (parent?.aborted) cancel();
    const timer = setTimeout(() => controller.abort(new TransportTimeoutError()), timeoutMs);
    try { return await awaitAbortable(async () => await this.#options.replayStore.lookup?.(commandId, fingerprint) ?? null, controller.signal); }
    finally { clearTimeout(timer); parent?.removeEventListener("abort", cancel); }
  }
  private matchesNetworkReceipt(command: ComposeNetworkAttachmentAgentCommandV1 | import("@deploylite/contracts").ComposeNetworkAttachmentReceiptQueryV1, receipt: ComposeNetworkAttachmentReceiptV1): boolean {
    return receipt.agentId === command.agentId && receipt.commandId === command.commandId && receipt.projectId === command.projectId
      && receipt.inputDigest === command.inputDigest && receipt.correlationId === command.context.correlationId && receipt.key === command.key
      && receipt.runtimeName === command.runtimeName && receipt.service === command.service && receipt.attachmentAction === command.attachmentAction
      && receipt.containerId === command.containerId;
  }
  private matchesVolumeBackupReceipt(command: ComposeVolumeBackupAgentCommandV1 | ComposeVolumeBackupReceiptQueryV1, receipt: ComposeVolumeBackupReceiptV1): boolean {
    return receipt.agentId === command.agentId && receipt.commandId === command.commandId && receipt.projectId === command.projectId
      && receipt.inputDigest === command.inputDigest && receipt.correlationId === command.context.correlationId
      && receipt.volumeKey === command.plan.volumeKey && receipt.destinationId === command.plan.destinationId;
  }
  private replayedVolumeBackupReceipt(receipt: ComposeVolumeBackupReceiptV1): ComposeVolumeBackupReceiptV1 {
    return composeVolumeBackupReceiptSchema.parse({ ...receipt, status: "already-created", idempotent: true });
  }
  private admission(timeoutMs: number, lease: ReplayLease, parent?: AbortSignal) {
    const controller = new AbortController(), cancel = () => controller.abort(new TransportCanceledError());
    const limit = Math.min(timeoutMs, lease.expiresAt - (this.#options.now ?? Date.now)()), deadline = Date.now() + limit;
    parent?.addEventListener("abort", cancel, { once: true }); if (parent?.aborted) cancel();
    const timer = setTimeout(() => controller.abort(new TransportTimeoutError()), Math.max(0, limit));
    return { signal: controller.signal, cancel, remaining: () => Math.max(0, deadline - Date.now()), finishPreparation: () => { if (controller.signal.aborted) throw controller.signal.reason; if (Date.now() >= deadline) { controller.abort(new TransportTimeoutError()); throw controller.signal.reason; } clearTimeout(timer); }, dispose: () => { clearTimeout(timer); parent?.removeEventListener("abort", cancel); } };
  }
  private releaseReplay(commandId: string, claimToken: string): void {
    // Cleanup must not hold an already canceled/deadline-bound admission open.
    // The durable token CAS fences a late delete; failure retains the claim until its lease expires.
    try { void this.#options.replayStore.release(commandId, claimToken).catch(() => {}); }
    catch { /* Preserve the original admission/dispatch error and the unresolved durable claim. */ }
  }
  private async claimReplay(commandId: string, fingerprint: string, lease: ReplayLease, signal: AbortSignal) {
    return awaitAbortable(async () => {
      const claim = await this.#options.replayStore.claim(commandId, fingerprint, lease);
      if (signal.aborted) { if (claim.claimed && claim.claimToken) this.releaseReplay(commandId, claim.claimToken); throw signal.reason; }
      return claim;
    }, signal);
  }
  private initialAuthority(command: Extract<AgentExecutionCommand, { schemaVersion: 1 }>): RuntimeExecutionAuthority {
    const validate = this.#options.authorityValidator?.validateInitialExecution?.bind(this.#options.authorityValidator);
    if (!validate) throw new FenceError("Persisted INITIAL authority reader required");
    return { expiresAt: command.lease.expiresAt, assertValid: async () => {
      await validate(command.projectId, command.deploymentId, { snapshotOriginId: command.deploymentId, snapshotHash: command.snapshotHash, runtimeHost: this.#options.agentId });
      if ((this.#options.now ?? Date.now)() >= command.lease.expiresAt) throw new LeaseExpiredError();
      this.validateFence(command.lease);
    } };
  }
  private runtimeAuthority(value: DeploymentExecutionAuthorityV1 | undefined, projectId: string, executionId: string, lease: LeaseV1, action: DeploymentExecutionAuthorityV1["action"], sourceId?: string): RuntimeExecutionAuthority | undefined {
    if (!value) { if (this.#options.authorityValidator) throw new FenceError("Persisted execution authority required"); return undefined; }
    const validator = this.#options.authorityValidator;
    if (!validator || value.projectId !== projectId || value.action !== action || value.projectLease.deploymentId !== projectId || protocolPayloadFingerprint(value.executionLease) !== protocolPayloadFingerprint(lease) || ((action === "deployment.redeploy" || action === "deployment.rollback") ? value.sourceLease?.deploymentId !== sourceId : value.sourceLease !== undefined)) throw new FenceError("Signed execution authority scope rejected");
    const captured = structuredClone(value);
    return { expiresAt: Math.min(captured.projectLease.expiresAt, captured.executionLease.expiresAt, captured.sourceLease?.expiresAt ?? Infinity), assertValid: async () => { await validator.validateDeploymentAuthority(structuredClone(captured), (this.#options.now ?? Date.now)()); if ((this.#options.now ?? Date.now)() >= Math.min(captured.projectLease.expiresAt, captured.executionLease.expiresAt, captured.sourceLease?.expiresAt ?? Infinity)) throw new LeaseExpiredError(); } };
  }
  private replacementOptions(command: AgentExecutionCommand, runtime: AgentCommandDispatcher["runtimeConfig"], snapshot: DeploymentSnapshotV1): AgentDispatchOptions {
    if (command.schemaVersion === 1) return {};
    const rollback = command.authority?.action === "deployment.rollback";
    if (rollback && (snapshot.configRevision !== "default" || snapshot.runtimeRevision !== "default" || snapshot.secretRefs.length !== 0)) throw new Error("Historical runtime state is not materialized by this receiver");
    const authority = this.runtimeAuthority(command.authority, command.projectId, command.deploymentId, command.lease, rollback ? "deployment.rollback" : "deployment.redeploy", rollback ? command.activeDeploymentId : command.sourceDeploymentId);
    const replacement = command.replacement;
    if (!replacement) { if (authority) throw new Error("Observed previous execution required"); return {}; }
    const prior = replacement.prior, source = command.snapshot.source as DeploymentSnapshotV1["source"];
    const digest = source.sourceMode === "image" ? source.image.selector.kind === "digest" ? source.image.selector.value : command.snapshot.resolvedDigest : undefined;
    const effectiveImage = source.sourceMode === "image" ? `${source.image.registryHost}/${source.image.repository}@${digest}` : undefined;
    if (!authority || !runtime || !this.#options.dispatcher.promotionPolicy || protocolPayloadFingerprint(replacement.policy) !== protocolPayloadFingerprint(this.#options.dispatcher.promotionPolicy) || (!rollback && replacement.effectiveImage !== effectiveImage) || prior.projectId !== command.projectId || prior.deploymentId !== (rollback ? command.activeDeploymentId : command.sourceDeploymentId) || (!rollback && (prior.snapshotOriginId !== command.snapshot.deploymentId || prior.snapshotHash !== command.snapshotHash)) || prior.effectiveImageDigest !== (rollback ? replacement.effectiveImage.split("@")[1] : digest) || prior.runtimeHost !== this.#options.agentId || prior.hostPort !== runtime.hostPort || prior.containerPort !== runtime.containerPort || prior.containerPort !== command.snapshot.runtimePort || prior.network !== (runtime.networkName ?? null)) throw new Error("Previous execution binding rejected");
    const priorProvenReceipt: PriorDockerImageExecutionReceiptV1 = { deploymentId: prior.deploymentId, projectId: prior.projectId, candidateId: prior.candidateId, effectiveImage: replacement.effectiveImage, runtimePort: prior.containerPort, runtimeConfig: { hostPort: prior.hostPort, containerPort: prior.containerPort, ...(prior.network ? { networkName: prior.network } : {}) }, terminalStatus: "succeeded", health: "passed", proven: true, rollback: { target: null, result: "not-required" }, executionReceipt: prior };
    return { authority, priorProvenReceipt, promotionPolicy: replacement.policy, ...(rollback ? { activeDeploymentId: command.activeDeploymentId, sourceDeploymentId: command.sourceDeploymentId } : {}) };
  }
  private validateFence(lease: FenceLease, projectScope?: string): void { const scope = projectScope ?? lease.deploymentId ?? lease.projectId; if (!scope) throw new FenceError(); const current = this.#fences.get(scope); if (current && (lease.fence < current.fence || (lease.fence === current.fence && current.leaseId !== lease.leaseId))) throw new FenceError(); if (!current || lease.fence > current.fence) this.#fences.set(scope, lease); }
  #validatedReceipt(command: Pick<AgentExecutionCommand, "commandId" | "projectId" | "deploymentId" | "snapshot" | "snapshotHash">, receipt: DockerImageExecutionReceiptV1, runtime?: AgentCommandDispatcher["runtimeConfig"]) {
    const validated = dockerImageExecutionReceiptSchema.parse(receipt);
    if (validated.deploymentId !== command.deploymentId) throw new Error("agent receipt deployment scope rejected");
    const proof = validated.executionReceipt;
    if (proof) {
      const source = command.snapshot.source as DeploymentSnapshotV1["source"];
      const digest = source.sourceMode === "image" ? source.image.selector.kind === "digest" ? source.image.selector.value : command.snapshot.resolvedDigest : undefined;
      if (!runtime || proof.projectId !== command.projectId || proof.runtimeHost !== this.#options.agentId || proof.snapshotOriginId !== command.snapshot.deploymentId || proof.snapshotHash !== command.snapshotHash || proof.effectiveImageDigest !== digest || proof.candidateId !== `${command.deploymentId}:candidate:${command.commandId}` || proof.containerPort !== command.snapshot.runtimePort || proof.hostPort !== runtime.hostPort || proof.containerPort !== runtime.containerPort || proof.network !== (runtime.networkName ?? null)) throw new Error("agent execution proof scope rejected");
    }
    return validated;
  }
  #wrap(command: AgentExecutionCommand, receipt: DockerImageExecutionReceiptV1, runtime?: AgentCommandDispatcher["runtimeConfig"]) { const validated = this.#validatedReceipt(command, receipt, runtime); return command.schemaVersion === 2 ? { ...(command.activeDeploymentId ? { activeDeploymentId: command.activeDeploymentId } : {}), schemaVersion: 2 as const, commandId: command.commandId, deploymentId: command.deploymentId, sourceDeploymentId: command.sourceDeploymentId, snapshotHash: command.snapshotHash, terminalStatus: validated.terminalStatus, health: validated.health, redacted: true as const, correlationId: command.context.correlationId, receipt: validated } : { schemaVersion: 1 as const, commandId: command.commandId, deploymentId: command.deploymentId, terminalStatus: validated.terminalStatus, health: validated.health, redacted: true as const, receipt: validated }; }
}

export function createAgentExecutionHandler(receiver: AuthenticatedAgentCommandReceiver) {
  return (body: unknown, headers: Record<string, string | undefined>, signal?: AbortSignal) => receiver.receive(body, headers["x-deploylite-signature"], signal);
}
