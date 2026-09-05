import { createHash, timingSafeEqual } from "node:crypto";
import { validateAgentTransportKey, verifyAgentTransport } from "@deploylite/config";
import { agentExecutionCommandSchema, CapabilityError, createDeploymentCommand, deploymentStopAgentCommandSchema, deploymentStopAgentReceiptSchema, dockerImageExecutionReceiptSchema, FenceError, LeaseExpiredError, protocolPayloadFingerprint, TransportCanceledError, type AgentExecutionCommand, type DeploymentStopAgentCommand, type DeploymentStopAgentReceipt, type LeaseV1 } from "@deploylite/contracts";
import { type DockerImageExecutionReceiptV1 } from "@deploylite/domain";

export type AgentCommandDispatcher = { dispatch(snapshot: any, commandId: string, signal?: AbortSignal, lease?: LeaseV1, options?: { executionDeploymentId?: string }): Promise<DockerImageExecutionReceiptV1> };
export type AgentStopDispatcher = { stop(input: { projectId: string; deploymentId: string; candidateId: string; effectiveImage: string }, signal?: AbortSignal, lease?: LeaseV1): Promise<"stopped" | "already-stopped" | "absent" | "failed" | "canceled"> };
export type AgentReplayReceipt = Record<string, unknown>;
export type AgentReplayClaim = { claimed: boolean; claimToken?: string; receipt?: AgentReplayReceipt };
export type AgentReplayStore = { readonly durable?: boolean; claim(commandId: string, fingerprint: string, lease: LeaseV1): Promise<AgentReplayClaim>; wait(commandId: string): Promise<AgentReplayReceipt>; complete(commandId: string, value: { fingerprint: string; claimToken: string; receipt: AgentReplayReceipt }): Promise<void>; release(commandId: string): Promise<void> };
export type AgentCommandReceiverOptions = Readonly<{ agentId: string; trustKey: string; capabilities: readonly string[]; dispatcher: AgentCommandDispatcher; stopDispatcher?: AgentStopDispatcher; replayStore: AgentReplayStore; now?: () => number }>;

export class AuthenticatedAgentCommandReceiver {
  readonly #options: AgentCommandReceiverOptions;
  readonly #fences = new Map<string, LeaseV1>();
  constructor(options: AgentCommandReceiverOptions) { validateAgentTransportKey(options.trustKey); this.#options = options; }
  hasDurableReplayStore(): boolean { return this.#options.replayStore.durable === true; }
  get agentId(): string { return this.#options.agentId; }
  get capabilities(): readonly string[] { return this.#options.capabilities; }
  verifyRequest(payload: string, signature: string | undefined): boolean { return verifyAgentTransport(payload, signature, this.#options.trustKey); }
  async receive(body: unknown, signature: string | undefined, signal?: AbortSignal): Promise<any> {
    const text = JSON.stringify(body); if (!verifyAgentTransport(text, signature, this.#options.trustKey)) throw new Error("agent authentication failed");
    if (typeof body === "object" && body !== null && (body as { action?: string }).action === "deployment.stop") return this.receiveStop(body, signal);
    const command = agentExecutionCommandSchema.parse(body); const canonicalJson = command.snapshot.canonicalJson; if (typeof canonicalJson !== "string") throw new Error("agent snapshot evidence rejected"); const bytes = new TextEncoder().encode(canonicalJson); const hash = createHash("sha256").update(bytes).digest("hex"); if (command.agentId !== this.#options.agentId || command.projectId !== command.snapshot.projectId || (command.schemaVersion === 2 && command.sourceDeploymentId !== command.snapshot.deploymentId) || command.deploymentId !== command.lease.deploymentId || command.snapshotHash !== command.snapshot.hash || command.snapshot.hash !== hash || new TextDecoder().decode(bytes) !== canonicalJson) throw new Error("agent command scope rejected");
    if (command.requiredCapabilities.length !== 1 || command.requiredCapabilities[0] !== "deploy.execute") throw new CapabilityError(command.requiredCapabilities[0] ?? "deploy.execute");
    for (const capability of command.requiredCapabilities) if (!this.#options.capabilities.includes(capability)) throw new CapabilityError(capability);
    if ((this.#options.now ?? Date.now)() >= command.lease.expiresAt) throw new LeaseExpiredError();
    this.validateFence(command.lease); const fingerprint = protocolPayloadFingerprint(command.snapshot); createDeploymentCommand({ schemaVersion: 1, commandId: command.commandId, deploymentId: command.deploymentId, requiredCapabilities: command.requiredCapabilities, payload: { snapshotHash: command.snapshotHash }, lease: command.lease }); const claim = await this.#options.replayStore.claim(command.commandId, fingerprint, command.lease);
    if (!claim.claimed) return this.#wrap(command, dockerImageExecutionReceiptSchema.parse(claim.receipt ?? await this.#options.replayStore.wait(command.commandId)));
    const snapshot = { ...command.snapshot, canonicalBytes: bytes };
    const cancellation = new AbortController(); const cancel = () => cancellation.abort(); signal?.addEventListener("abort", cancel, { once: true }); if (command.cancellationRequested) cancellation.abort();
    let receipt: DockerImageExecutionReceiptV1; try { receipt = await this.#options.dispatcher.dispatch(snapshot, command.commandId, cancellation.signal, command.lease, { executionDeploymentId: command.deploymentId }); } catch (error) { await this.#options.replayStore.release(command.commandId); throw error; } finally { signal?.removeEventListener("abort", cancel); }
    try { const validated = this.#validatedReceipt(command, receipt); if (!claim.claimToken) throw new Error("agent replay claim token missing"); await this.#options.replayStore.complete(command.commandId, { fingerprint, claimToken: claim.claimToken, receipt: validated as unknown as AgentReplayReceipt }); return this.#wrap(command, validated); } catch (error) { await this.#options.replayStore.release(command.commandId); throw error; }
  }
  private async receiveStop(body: unknown, signal?: AbortSignal): Promise<DeploymentStopAgentReceipt> {
    const command = deploymentStopAgentCommandSchema.parse(body); if (!this.#options.stopDispatcher) throw new CapabilityError("deployment.stop");
    if (command.agentId !== this.#options.agentId || command.lease.deploymentId !== command.deploymentId) throw new Error("agent command scope rejected");
    if (!this.#options.capabilities.includes("deployment.stop")) throw new CapabilityError("deployment.stop"); if ((this.#options.now?.() ?? Date.now()) >= command.lease.expiresAt) throw new LeaseExpiredError();
    if (signal?.aborted) throw new TransportCanceledError(); this.validateFence(command.lease); const fingerprint = protocolPayloadFingerprint({ action: command.action, agentId: command.agentId, projectId: command.projectId, deploymentId: command.deploymentId, candidateId: command.candidateId, effectiveImage: command.effectiveImage, correlationId: command.context.correlationId }); const claim = await this.#options.replayStore.claim(command.commandId, fingerprint, command.lease); if (!claim.claimed) return deploymentStopAgentReceiptSchema.parse(claim.receipt ?? await this.#options.replayStore.wait(command.commandId));
    const cancellation = new AbortController(); const cancel = () => cancellation.abort(); signal?.addEventListener("abort", cancel, { once: true }); if (command.cancellationRequested) cancellation.abort();
    try { const status = await this.#options.stopDispatcher.stop({ projectId: command.projectId, deploymentId: command.deploymentId, candidateId: command.candidateId, effectiveImage: command.effectiveImage }, cancellation.signal, command.lease); const receipt = deploymentStopAgentReceiptSchema.parse({ schemaVersion: 1, action: command.action, agentId: command.agentId, commandId: command.commandId, projectId: command.projectId, deploymentId: command.deploymentId, candidateId: command.candidateId, effectiveImage: command.effectiveImage, status, redacted: true, correlationId: command.context.correlationId, reason: status === "failed" ? "docker_stop_failed" : status === "canceled" ? "canceled" : null }); if (!claim.claimToken) throw new Error("agent replay claim token missing"); await this.#options.replayStore.complete(command.commandId, { fingerprint, claimToken: claim.claimToken, receipt }); return receipt; } catch (error) { await this.#options.replayStore.release(command.commandId); throw error; } finally { signal?.removeEventListener("abort", cancel); }
  }
  private validateFence(lease: LeaseV1): void { const current = this.#fences.get(lease.deploymentId); if (current && (lease.fence < current.fence || (lease.fence === current.fence && current.leaseId !== lease.leaseId))) throw new FenceError(); if (!current || lease.fence > current.fence) this.#fences.set(lease.deploymentId, lease); }
  #validatedReceipt(command: AgentExecutionCommand, receipt: DockerImageExecutionReceiptV1) { const validated = dockerImageExecutionReceiptSchema.parse(receipt); if (validated.deploymentId !== command.deploymentId) throw new Error("agent receipt deployment scope rejected"); return validated; }
  #wrap(command: AgentExecutionCommand, receipt: DockerImageExecutionReceiptV1) { const validated = this.#validatedReceipt(command, receipt); return command.schemaVersion === 2 ? { schemaVersion: 2 as const, commandId: command.commandId, deploymentId: command.deploymentId, sourceDeploymentId: command.sourceDeploymentId, snapshotHash: command.snapshotHash, terminalStatus: validated.terminalStatus, health: validated.health, redacted: true as const, correlationId: command.context.correlationId, receipt: validated } : { schemaVersion: 1 as const, commandId: command.commandId, deploymentId: command.deploymentId, terminalStatus: validated.terminalStatus, health: validated.health, redacted: true as const, receipt: validated }; }
}

export function createAgentExecutionHandler(receiver: AuthenticatedAgentCommandReceiver) {
  return (body: unknown, headers: Record<string, string | undefined>, signal?: AbortSignal) => receiver.receive(body, headers["x-deploylite-signature"], signal);
}
