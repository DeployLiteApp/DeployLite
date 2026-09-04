import { createHash, timingSafeEqual } from "node:crypto";
import { validateAgentTransportKey, verifyAgentTransport } from "@deploylite/config";
import { agentExecutionCommandSchema, CapabilityError, createDeploymentCommand, dockerImageExecutionReceiptSchema, LeaseExpiredError, protocolPayloadFingerprint, type AgentExecutionCommand, type LeaseV1 } from "@deploylite/contracts";
import { type DockerImageExecutionReceiptV1 } from "@deploylite/domain";

export type AgentCommandDispatcher = { dispatch(snapshot: any, commandId: string, signal?: AbortSignal, lease?: LeaseV1): Promise<DockerImageExecutionReceiptV1> };
export type AgentReplayClaim = { claimed: boolean; receipt?: DockerImageExecutionReceiptV1 };
export type AgentReplayStore = { readonly durable?: boolean; claim(commandId: string, fingerprint: string, lease: LeaseV1): Promise<AgentReplayClaim>; wait(commandId: string): Promise<DockerImageExecutionReceiptV1>; complete(commandId: string, value: { fingerprint: string; receipt: DockerImageExecutionReceiptV1 }): Promise<void>; release(commandId: string): Promise<void> };
export type AgentCommandReceiverOptions = Readonly<{ agentId: string; trustKey: string; capabilities: readonly string[]; dispatcher: AgentCommandDispatcher; replayStore: AgentReplayStore; now?: () => number }>;

export class AuthenticatedAgentCommandReceiver {
  readonly #options: AgentCommandReceiverOptions;
  constructor(options: AgentCommandReceiverOptions) { validateAgentTransportKey(options.trustKey); this.#options = options; }
  hasDurableReplayStore(): boolean { return this.#options.replayStore.durable === true; }
  async receive(body: unknown, signature: string | undefined, signal?: AbortSignal) {
    const text = JSON.stringify(body); if (!verifyAgentTransport(text, signature, this.#options.trustKey)) throw new Error("agent authentication failed");
    const command = agentExecutionCommandSchema.parse(body); const canonicalJson = command.snapshot.canonicalJson; if (typeof canonicalJson !== "string") throw new Error("agent snapshot evidence rejected"); const bytes = new TextEncoder().encode(canonicalJson); const hash = createHash("sha256").update(bytes).digest("hex"); if (command.agentId !== this.#options.agentId || command.projectId !== command.snapshot.projectId || command.deploymentId !== command.snapshot.deploymentId || command.deploymentId !== command.lease.deploymentId || command.snapshotHash !== command.snapshot.hash || command.snapshot.hash !== hash || new TextDecoder().decode(bytes) !== canonicalJson) throw new Error("agent command scope rejected");
    if (command.requiredCapabilities.length !== 1 || command.requiredCapabilities[0] !== "deploy.execute") throw new CapabilityError(command.requiredCapabilities[0] ?? "deploy.execute");
    for (const capability of command.requiredCapabilities) if (!this.#options.capabilities.includes(capability)) throw new CapabilityError(capability);
    if ((this.#options.now ?? Date.now)() >= command.lease.expiresAt) throw new LeaseExpiredError();
    const fingerprint = protocolPayloadFingerprint(command.snapshot); createDeploymentCommand({ schemaVersion: 1, commandId: command.commandId, deploymentId: command.deploymentId, requiredCapabilities: command.requiredCapabilities, payload: { snapshotHash: command.snapshotHash }, lease: command.lease }); const claim = await this.#options.replayStore.claim(command.commandId, fingerprint, command.lease);
    if (!claim.claimed) return this.#wrap(command, claim.receipt ?? await this.#options.replayStore.wait(command.commandId));
    const snapshot = { ...command.snapshot, canonicalBytes: bytes };
    const cancellation = new AbortController(); const cancel = () => cancellation.abort(); signal?.addEventListener("abort", cancel, { once: true }); if (command.cancellationRequested) cancellation.abort();
    let receipt: DockerImageExecutionReceiptV1; try { receipt = await this.#options.dispatcher.dispatch(snapshot, command.commandId, cancellation.signal, command.lease); } catch (error) { await this.#options.replayStore.release(command.commandId); throw error; } finally { signal?.removeEventListener("abort", cancel); }
    try { const validated = this.#validatedReceipt(command, receipt); await this.#options.replayStore.complete(command.commandId, { fingerprint, receipt: validated }); return this.#wrap(command, validated); } catch (error) { await this.#options.replayStore.release(command.commandId); throw error; }
  }
  #validatedReceipt(command: AgentExecutionCommand, receipt: DockerImageExecutionReceiptV1) { const validated = dockerImageExecutionReceiptSchema.parse(receipt); if (validated.deploymentId !== command.deploymentId) throw new Error("agent receipt deployment scope rejected"); return validated; }
  #wrap(command: AgentExecutionCommand, receipt: DockerImageExecutionReceiptV1) { const validated = this.#validatedReceipt(command, receipt); return { schemaVersion: 1 as const, commandId: command.commandId, deploymentId: command.deploymentId, terminalStatus: validated.terminalStatus, health: validated.health, redacted: true as const, receipt: validated }; }
}

export function createAgentExecutionHandler(receiver: AuthenticatedAgentCommandReceiver) {
  return (body: unknown, headers: Record<string, string | undefined>, signal?: AbortSignal) => receiver.receive(body, headers["x-deploylite-signature"], signal);
}
