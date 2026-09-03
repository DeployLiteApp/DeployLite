import type { DeploymentSnapshotV1 } from "@deploylite/contracts";
import { DockerImageExecutor, type DockerImageExecutionReceiptV1, type DockerImageTransport } from "@deploylite/domain";
import { DockerCliImageTransport, type DockerCliRunner } from "./infrastructure/docker/docker-cli-image-transport.js";
import { InMemoryProtocolTransport } from "@deploylite/domain";

export type DigestDeploymentDispatcherOptions = Readonly<{
  protocol: InMemoryProtocolTransport;
  transport?: DockerImageTransport;
  runner?: DockerCliRunner;
  owner?: string;
  hostPort?: number;
  containerPort?: number;
  trustedHosts: readonly string[];
  allowedNetworks?: readonly string[];
  networkName?: string;
  timeoutMs?: number;
}>;

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
  readonly #timeoutMs: number;

  constructor(options: DigestDeploymentDispatcherOptions) {
    this.#protocol = options.protocol;
    this.#transport = options.transport ?? (options.runner ? new DockerCliImageTransport({ runner: options.runner, owner: options.owner ?? "deploylite-agent", hostPort: options.hostPort ?? 3000, containerPort: options.containerPort ?? 3000, allowedNetworks: options.allowedNetworks ?? [], networkName: options.networkName }) : undefined);
    this.#trustedHosts = options.trustedHosts;
    this.#allowedNetworks = options.allowedNetworks ?? [];
    this.#networkName = options.networkName;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs <= 0) throw new Error("dispatcher timeout must be positive");
  }

  available(): boolean {
    return this.#transport !== undefined && this.#protocol.hasCapability("deploy.execute");
  }

  async dispatch(snapshot: DeploymentSnapshotV1, commandId: string, parentSignal?: AbortSignal): Promise<DockerImageExecutionReceiptV1> {
    if (!this.available()) throw new Error("deploy.execute capability unavailable");
    const lease = this.#protocol.claimLease(snapshot.deploymentId);
    const scoped = scopedSignal(parentSignal, this.#timeoutMs);
    try {
      return await new DockerImageExecutor({ protocol: this.#protocol, transport: this.#transport!, trustedHosts: this.#trustedHosts, allowedNetworks: this.#allowedNetworks }).execute({ snapshot, commandId, lease, networkName: this.#networkName, signal: scoped.signal });
    } finally {
      scoped.dispose();
    }
  }
}
