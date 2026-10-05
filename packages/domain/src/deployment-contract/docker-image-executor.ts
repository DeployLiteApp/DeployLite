import {
  createStageAck, createTerminalAck, createTerminalIntent, ProtocolValidationError,
  trustedPriorExecutionReceiptSchema, type CanonicalHasher, type TrustedPriorExecutionReceiptV1, type DeploymentSnapshotV1, type LeaseV1, type TerminalStatusV1
} from "@deploylite/contracts";
import { InMemoryProtocolTransport } from "./protocol-memory.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[1-9][0-9]{0,4})?$/;
const REPOSITORY = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
const NETWORK = /^[a-z0-9][a-z0-9_.-]{0,62}$/;

export interface DockerImageCandidateV1 { readonly candidateId: string; readonly projectId?: string; readonly deploymentId: string; readonly effectiveImage: string; readonly runtimePort: number; readonly networkName?: string; }
export interface DockerImageExecutionReceiptV1 {
  readonly deploymentId: string; readonly candidateId?: string; readonly effectiveImage: string; readonly runtimePort: number;
  readonly runtimeConfig?: { readonly hostPort: number; readonly containerPort: number; readonly networkName?: string };
  readonly health: "passed" | "failed"; readonly terminalStatus: TerminalStatusV1;
  readonly rollback: { readonly target: string | null; readonly result: "not-required" | "restored" | "not-available" };
  readonly proven: boolean;
  readonly executionReceipt?: TrustedPriorExecutionReceiptV1;
}
export type ProvenDockerImageExecutionReceiptV1 = DockerImageExecutionReceiptV1 & { readonly health: "passed"; readonly terminalStatus: "succeeded"; readonly proven: true };
export type PriorDockerImageExecutionReceiptV1 = ProvenDockerImageExecutionReceiptV1 & { readonly projectId: string; readonly runtimeConfig?: { readonly hostPort: number; readonly containerPort: number; readonly networkName?: string } };
export type DockerActiveIdentityObservation = Readonly<{
  container: string; containerId: string; imageId: string;
  owner: string; projectId: string; deploymentId: string; candidateId: string; effectiveImage: string;
  running: true; health: "healthy"; hostPort: number; containerPort: number; network: string | null;
}>;
export interface DockerImageTransport {
  startCandidate(candidate: DockerImageCandidateV1, signal: AbortSignal): Promise<void>;
  checkHealth(candidate: DockerImageCandidateV1, signal: AbortSignal): Promise<boolean>;
  // Legacy transports may omit observations; absence is never trusted runtime proof.
  promoteCandidate(candidate: DockerImageCandidateV1, signal: AbortSignal): Promise<DockerActiveIdentityObservation | void>;
  promoteCandidate(candidate: DockerImageCandidateV1, prior: PriorDockerImageExecutionReceiptV1 | undefined, signal: AbortSignal): Promise<DockerActiveIdentityObservation | void>;
  restorePrior(receipt: PriorDockerImageExecutionReceiptV1, signal: AbortSignal): Promise<void>;
  discardCandidate(candidate: DockerImageCandidateV1, signal: AbortSignal): Promise<void>;
}
export interface DockerImageExecutionInputV1 { readonly snapshot: DeploymentSnapshotV1; readonly commandId: string; readonly lease: LeaseV1; readonly executionDeploymentId?: string; readonly networkName?: string; readonly runtimeConfig?: { readonly hostPort: number; readonly containerPort: number; readonly networkName?: string }; readonly priorProvenReceipt?: PriorDockerImageExecutionReceiptV1; readonly signal?: AbortSignal; }
export interface DockerImageExecutorOptions { readonly protocol: InMemoryProtocolTransport; readonly transport: DockerImageTransport; readonly trustedHosts: readonly string[]; readonly allowedNetworks?: readonly string[]; readonly runtimeHost?: string; readonly snapshotHasher?: CanonicalHasher; }

function fail(message: string): never { throw new ProtocolValidationError(message); }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  return value;
}
export function validateDockerImageSnapshot(snapshot: DeploymentSnapshotV1, hasher?: CanonicalHasher): void {
  if (!snapshot || snapshot.schemaVersion !== 1 || !/^[0-9a-f]{64}$/.test(snapshot.hash) || typeof snapshot.canonicalJson !== "string" || !(snapshot.canonicalBytes instanceof Uint8Array)) fail("deployment snapshot is invalid");
  let parsed: unknown;
  try { parsed = JSON.parse(snapshot.canonicalJson); } catch { fail("deployment snapshot canonical evidence is invalid"); }
  const { canonicalJson, canonicalBytes, hash, ...projection } = snapshot;
  if (JSON.stringify(canonical(parsed)) !== canonicalJson || new TextDecoder().decode(canonicalBytes) !== canonicalJson || JSON.stringify(canonical(projection)) !== canonicalJson) fail("deployment snapshot canonical projection is tampered");
  if (hasher && hasher.sha256(canonicalBytes) !== hash) fail("deployment snapshot canonical hash is tampered");
}
function effectiveImage(snapshot: DeploymentSnapshotV1, trustedHosts: ReadonlySet<string>): string {
  validateDockerImageSnapshot(snapshot);
  if (snapshot.source.sourceMode !== "image" || snapshot.source.schemaVersion !== 1) fail("docker image execution requires an image snapshot");
  const image = snapshot.source.image;
  if (image.declaredIntentOnly !== true || image.policyVersion !== snapshot.policyVersion || !HOST.test(image.registryHost) || !REPOSITORY.test(image.repository) || !trustedHosts.has(image.registryHost)) fail("image snapshot is not trusted");
  const base = `${image.registryHost}/${image.repository}`; const selector = image.selector;
  if (!selector || (selector.kind !== "tag" && selector.kind !== "digest") || typeof selector.value !== "string") fail("image snapshot selector is invalid");
  if (selector.kind === "digest" && (!DIGEST.test(selector.value) || image.reference !== `${base}@${selector.value}`)) fail("image snapshot digest selector is invalid");
  if (selector.kind === "tag" && (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(selector.value) || image.reference !== `${base}:${selector.value}`)) fail("image snapshot tag selector is invalid");
  const digest = selector.kind === "digest" ? selector.value : snapshot.resolvedDigest;
  if (!digest || !DIGEST.test(digest)) fail("image must be digest-pinned");
  if (selector.kind === "digest" && snapshot.resolvedDigest !== undefined && snapshot.resolvedDigest !== selector.value) fail("snapshot digest selector conflicts with resolved digest");
  return `${base}@${digest}`;
}
function assertReceipt(receipt: PriorDockerImageExecutionReceiptV1 | undefined): void { if (receipt && (receipt.proven !== true || receipt.health !== "passed" || receipt.terminalStatus !== "succeeded" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(receipt.projectId) || !receipt.candidateId?.startsWith(`${receipt.deploymentId}:candidate:`) || !DIGEST.test(receipt.effectiveImage.split("@")[1] ?? ""))) fail("rollback receipt is not proven"); }
function boundedPort(snapshot: DeploymentSnapshotV1): number { const port = snapshot.runtimePort; if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) fail("docker image execution requires a bounded runtime port"); return port; }

export class DockerImageExecutor {
  #protocol: InMemoryProtocolTransport; #transport: DockerImageTransport; #trustedHosts: ReadonlySet<string>; #allowedNetworks: ReadonlySet<string>; #runtimeHost?: string; #snapshotHasher?: CanonicalHasher;
  constructor(options: DockerImageExecutorOptions) { this.#protocol = options.protocol; this.#transport = options.transport; this.#trustedHosts = new Set(options.trustedHosts); this.#allowedNetworks = new Set(options.allowedNetworks ?? []); this.#runtimeHost = options.runtimeHost; this.#snapshotHasher = options.snapshotHasher; }
  async execute(input: DockerImageExecutionInputV1): Promise<DockerImageExecutionReceiptV1> {
    // Capture validated bindings before any adapter or protocol await can expose mutable callers.
    input = { ...input, snapshot: structuredClone(input.snapshot), lease: structuredClone(input.lease), runtimeConfig: input.runtimeConfig ? structuredClone(input.runtimeConfig) : undefined, priorProvenReceipt: input.priorProvenReceipt ? structuredClone(input.priorProvenReceipt) : undefined };
    validateDockerImageSnapshot(input.snapshot, this.#snapshotHasher);
    if (this.#runtimeHost && input.snapshot.agentId && input.snapshot.agentId !== this.#runtimeHost) fail("snapshot configured runtime host mismatch");
    const image = effectiveImage(input.snapshot, this.#trustedHosts); const port = boundedPort(input.snapshot);
    if (input.runtimeConfig && (input.runtimeConfig.containerPort !== port || input.runtimeConfig.networkName !== input.networkName)) fail("snapshot runtime configuration mismatch");
    if (input.runtimeConfig && (!Number.isInteger(input.runtimeConfig.hostPort) || input.runtimeConfig.hostPort < 1024 || input.runtimeConfig.hostPort > 65535 || !Number.isInteger(input.runtimeConfig.containerPort) || input.runtimeConfig.containerPort < 1 || input.runtimeConfig.containerPort > 65535 || (input.runtimeConfig.networkName !== undefined && (!NETWORK.test(input.runtimeConfig.networkName) || !this.#allowedNetworks.has(input.runtimeConfig.networkName))))) fail("runtime configuration is not trusted");
    if (input.networkName !== undefined && (!NETWORK.test(input.networkName) || !this.#allowedNetworks.has(input.networkName))) fail("docker network is not allowlisted");
    assertReceipt(input.priorProvenReceipt);
    const executionDeploymentId = input.executionDeploymentId ?? input.snapshot.deploymentId; if (input.lease.deploymentId !== executionDeploymentId) fail("execution deployment identity does not match lease");
    const command = this.#protocol.createCommand({ commandId: input.commandId, deploymentId: executionDeploymentId, requiredCapabilities: ["deploy.execute"], payload: { snapshotHash: input.snapshot.hash, runtimeHost: this.#runtimeHost ?? null, runtimeConfig: input.runtimeConfig ?? null, effectiveImage: image, runtimePort: port, networkName: input.networkName ?? null, rollbackTarget: input.priorProvenReceipt?.effectiveImage ?? null }, lease: input.lease });
    return (await this.#protocol.deliverAsync(command, () => this.#run(input, image, port))).result;
  }
  #stage(input: DockerImageExecutionInputV1, stage: string, sequence: number): void { this.#protocol.recordStageAck(createStageAck({ schemaVersion: 1, deploymentId: input.executionDeploymentId ?? input.snapshot.deploymentId, commandId: input.commandId, lease: input.lease, stage, sequence })); }
  #terminal(input: DockerImageExecutionInputV1, receipt: DockerImageExecutionReceiptV1): DockerImageExecutionReceiptV1 { const terminal = { schemaVersion: 1 as const, deploymentId: input.executionDeploymentId ?? input.snapshot.deploymentId, commandId: input.commandId, lease: input.lease, status: receipt.terminalStatus }; this.#protocol.recordTerminalIntent(createTerminalIntent(terminal)); this.#protocol.recordTerminalAck(createTerminalAck(terminal)); return Object.freeze(receipt); }
  #proof(input: DockerImageExecutionInputV1, candidate: DockerImageCandidateV1, observation: DockerActiveIdentityObservation): TrustedPriorExecutionReceiptV1 | undefined {
    const runtime = input.runtimeConfig;
    if (observation.projectId !== candidate.projectId || observation.deploymentId !== candidate.deploymentId || observation.candidateId !== candidate.candidateId || observation.effectiveImage !== candidate.effectiveImage || observation.running !== true || observation.health !== "healthy" || !observation.imageId || !observation.owner || observation.containerPort !== candidate.runtimePort || observation.network !== (candidate.networkName ?? null)) fail("active observation identity mismatch");
    if (runtime && (observation.hostPort !== runtime.hostPort || observation.containerPort !== runtime.containerPort || observation.network !== (runtime.networkName ?? null))) fail("active observation runtime mismatch");
    // Legacy callers without configured identity/hash verification never gain trusted proof.
    if (!this.#runtimeHost || !this.#snapshotHasher || !runtime) return undefined;
    return Object.freeze(trustedPriorExecutionReceiptSchema.parse({ schemaVersion: 1, candidateId: observation.candidateId, deploymentId: observation.deploymentId, projectId: observation.projectId, snapshotOriginId: input.snapshot.deploymentId, snapshotHash: input.snapshot.hash, effectiveImageDigest: candidate.effectiveImage.split("@")[1], runtimeHost: this.#runtimeHost, container: observation.container, containerId: observation.containerId, hostPort: observation.hostPort, containerPort: observation.containerPort, network: observation.network }));
  }
  async #run(input: DockerImageExecutionInputV1, image: string, port: number): Promise<DockerImageExecutionReceiptV1> {
    const executionDeploymentId = input.executionDeploymentId ?? input.snapshot.deploymentId; const candidate = Object.freeze({ candidateId: `${executionDeploymentId}:candidate:${input.commandId}`, projectId: input.snapshot.projectId, deploymentId: executionDeploymentId, effectiveImage: image, runtimePort: port, ...(input.networkName ? { networkName: input.networkName } : {}) });
    if (input.signal?.aborted) { this.#stage(input, "execution-canceled", 1); return this.#terminal(input, { deploymentId: executionDeploymentId, effectiveImage: image, runtimePort: port, health: "failed", terminalStatus: "canceled", rollback: { target: null, result: "not-available" }, proven: false }); }
    let started = false; let healthy = false; let rollback: DockerImageExecutionReceiptV1["rollback"] = { target: null, result: "not-available" };
    try {
      await this.#transport.startCandidate(candidate, input.signal ?? new AbortController().signal);
      started = true; this.#stage(input, "candidate-started", 1);
      if (input.signal?.aborted) throw new Error("canceled");
      healthy = await this.#transport.checkHealth(candidate, input.signal ?? new AbortController().signal);
      this.#stage(input, healthy ? "candidate-healthy" : "candidate-unhealthy", 2);
      if (!healthy) throw new Error("health check failed");
      const observation = await this.#transport.promoteCandidate(candidate, input.signal ?? new AbortController().signal);
      const proof = observation ? this.#proof(input, candidate, observation) : undefined;
      this.#stage(input, "candidate-promoted", 3);
      return this.#terminal(input, { deploymentId: executionDeploymentId, candidateId: candidate.candidateId, effectiveImage: image, runtimePort: port, ...(input.runtimeConfig ? { runtimeConfig: input.runtimeConfig } : {}), ...(proof ? { executionReceipt: proof } : {}), health: "passed", terminalStatus: "succeeded", rollback: { target: null, result: "not-required" }, proven: true });
    }
     catch { const prior = input.priorProvenReceipt; if (prior && started) { try { await this.#transport.restorePrior(prior, input.signal ?? new AbortController().signal); rollback = { target: prior.effectiveImage, result: "restored" }; } catch { rollback = { target: prior.effectiveImage, result: "not-available" }; } } if (started) { try { await this.#transport.discardCandidate(candidate, input.signal ?? new AbortController().signal); } catch { /* cleanup is best effort; terminal state remains durable */ } } const canceled = input.signal?.aborted; this.#stage(input, canceled ? "execution-canceled" : "candidate-failed", started ? 3 : 2); return this.#terminal(input, { deploymentId: executionDeploymentId, effectiveImage: image, runtimePort: port, health: healthy ? "passed" : "failed", terminalStatus: canceled ? "canceled" : "failed", rollback, proven: false }); }
  }
}

export function renderDockerImageCandidate(input: DockerImageExecutionInputV1, trustedHosts: readonly string[], allowedNetworks: readonly string[] = []): DockerImageCandidateV1 { const image = effectiveImage(input.snapshot, new Set(trustedHosts)); const port = boundedPort(input.snapshot); if (input.networkName !== undefined && (!NETWORK.test(input.networkName) || !allowedNetworks.includes(input.networkName))) fail("docker network is not allowlisted"); return Object.freeze({ candidateId: `${input.snapshot.deploymentId}:candidate:${input.commandId}`, projectId: input.snapshot.projectId, deploymentId: input.snapshot.deploymentId, effectiveImage: image, runtimePort: port, ...(input.networkName ? { networkName: input.networkName } : {}) }); }
