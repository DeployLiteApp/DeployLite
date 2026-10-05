import { createHash } from "node:crypto";
import { promotionPolicySchema, protocolPayloadFingerprint, type PromotionPolicy, type DeploymentSnapshotV1 } from "@deploylite/contracts";
import { awaitAbortable, DockerImageExecutor, type DockerImageExecutionReceiptV1, type DockerImageTransport, type RuntimeExecutionAuthority } from "@deploylite/domain";
import { DockerCliImageTransport, type DockerCliRunner } from "./infrastructure/docker/docker-cli-image-transport.js";
import type { AgentDispatchOptions } from "./agent-transport.js";
import { InMemoryProtocolTransport } from "@deploylite/domain";

export type DigestDeploymentDispatcherOptions = Readonly<{
  protocol: InMemoryProtocolTransport;
  transport?: DockerImageTransport;
  runner?: DockerCliRunner;
  owner?: string;
  hostPort?: number;
  temporaryHostPort?: number;
  promotionPolicy?: PromotionPolicy;
  containerPort?: number;
  trustedHosts: readonly string[];
  allowedNetworks?: readonly string[];
  networkName?: string;
  timeoutMs?: number;
}>;
export type OwnedStopInput = Readonly<{ projectId: string; deploymentId: string; candidateId: string; effectiveImage: string; containerId?: string }>;
export type OwnedStopTransport = { stopOwned(input: OwnedStopInput, signal: AbortSignal, authority?: RuntimeExecutionAuthority): Promise<"stopped" | "already-stopped" | "absent" | "failed" | "canceled"> };

function scopedSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  parent?.addEventListener("abort", abort, { once: true });
  if (parent?.aborted) abort();
  return { signal: controller.signal, dispose: () => { clearTimeout(timer); parent?.removeEventListener("abort", abort); } };
}

export class DigestDeploymentDispatcher {
  readonly #protocol: InMemoryProtocolTransport;
  readonly #transport: DockerImageTransport | undefined;
  readonly #trustedHosts: readonly string[];
  readonly #allowedNetworks: readonly string[];
  readonly #networkName: string | undefined;
  readonly #runtimeConfig: { hostPort: number; containerPort: number; networkName?: string };
  readonly #timeoutMs: number;
  readonly #promotionPolicy: PromotionPolicy | undefined;

  constructor(options: DigestDeploymentDispatcherOptions) {
    this.#protocol = options.protocol;
    this.#promotionPolicy = options.promotionPolicy ? promotionPolicySchema.parse(options.promotionPolicy) : undefined;
    this.#transport = options.transport ?? (options.runner ? new DockerCliImageTransport({ runner: options.runner, owner: options.owner ?? "deploylite-agent", hostPort: options.hostPort ?? 3000, containerPort: options.containerPort ?? 3000, temporaryHostPort: options.temporaryHostPort, allowedNetworks: options.allowedNetworks ?? [], networkName: options.networkName }) : undefined);
    this.#trustedHosts = options.trustedHosts;
    this.#allowedNetworks = options.allowedNetworks ?? [];
    this.#networkName = options.networkName;
    this.#runtimeConfig = { hostPort: options.hostPort ?? 3000, containerPort: options.containerPort ?? 3000, ...(options.networkName ? { networkName: options.networkName } : {}) };
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs <= 0) throw new Error("dispatcher timeout must be positive");
  }

  get promotionPolicy() { return this.#promotionPolicy ? structuredClone(this.#promotionPolicy) : undefined; }

  get runtimeConfig() { return structuredClone(this.#runtimeConfig); }

  available(): boolean {
    return this.#transport !== undefined && this.#protocol.hasCapability("deploy.execute");
  }

  async dispatch(snapshot: DeploymentSnapshotV1, commandId: string, parentSignal?: AbortSignal, suppliedLease?: { leaseId: string; deploymentId: string; fence: number; expiresAt: number }, options?: AgentDispatchOptions): Promise<DockerImageExecutionReceiptV1> {
    if (!this.available()) throw new Error("deploy.execute capability unavailable");
    if (options?.priorProvenReceipt && (!options.priorProvenReceipt || !options.authority || !this.#promotionPolicy || protocolPayloadFingerprint(this.#promotionPolicy) !== protocolPayloadFingerprint(options.promotionPolicy))) throw new Error("explicit replacement authority and policy required");
    const lease = suppliedLease ?? this.#protocol.claimLease(snapshot.deploymentId);
    const scoped = scopedSignal(parentSignal, Math.min(this.#timeoutMs, options?.preparationTimeoutMs ?? this.#timeoutMs));
    try {
      return await new DockerImageExecutor({ protocol: this.#protocol, transport: this.#transport!, trustedHosts: this.#trustedHosts, allowedNetworks: this.#allowedNetworks, runtimeHost: options?.runtimeHost, snapshotHasher: options?.runtimeHost ? { sha256: (bytes) => createHash("sha256").update(bytes).digest("hex") } : undefined }).execute({ snapshot, commandId, lease, executionDeploymentId: options?.executionDeploymentId, networkName: this.#networkName, runtimeConfig: this.#runtimeConfig, priorProvenReceipt: options?.priorProvenReceipt, promotionPolicy: options?.promotionPolicy, authority: options?.authority, signal: scoped.signal, promotionSignal: parentSignal ?? new AbortController().signal, completePreparation: scoped.dispose });
    } finally {
      scoped.dispose();
    }
  }

  async stop(input: OwnedStopInput, parentSignal?: AbortSignal, _lease?: unknown, authority?: RuntimeExecutionAuthority, timeoutMs?: number): Promise<"stopped" | "already-stopped" | "absent" | "failed" | "canceled"> {
    if (!authority) throw new Error("persisted stop authority required");
    if (!(this.#transport && "stopOwned" in this.#transport)) throw new Error("deployment.stop capability unavailable");
    const scoped = scopedSignal(parentSignal, Math.min(this.#timeoutMs, timeoutMs ?? this.#timeoutMs));
    try { await awaitAbortable(() => authority.assertValid(), scoped.signal); return await awaitAbortable(() => (this.#transport as DockerImageTransport & OwnedStopTransport).stopOwned(input, scoped.signal, authority), scoped.signal); } finally { scoped.dispose(); }
  }
}
