import {
  createStageAck, createTerminalAck, createTerminalIntent, ProtocolValidationError,
  type DeploymentSnapshotV1, type LeaseV1, type TerminalStatusV1
} from "@deploylite/contracts";
import { InMemoryProtocolTransport } from "./protocol-memory.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[1-9][0-9]{0,4})?$/;
const REPOSITORY = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
const NETWORK = /^[a-z0-9][a-z0-9_.-]{0,62}$/;

export interface DockerImageCandidateV1 { readonly candidateId: string; readonly projectId?: string; readonly deploymentId: string; readonly effectiveImage: string; readonly runtimePort: number; readonly networkName?: string; }
export interface DockerImageExecutionReceiptV1 {
  readonly deploymentId: string; readonly candidateId?: string; readonly effectiveImage: string; readonly runtimePort: number;
  readonly health: "passed" | "failed"; readonly terminalStatus: TerminalStatusV1;
  readonly rollback: { readonly target: string | null; readonly result: "not-required" | "restored" | "not-available" };
  readonly proven: boolean;
}
export type ProvenDockerImageExecutionReceiptV1 = DockerImageExecutionReceiptV1 & { readonly health: "passed"; readonly terminalStatus: "succeeded"; readonly proven: true };
export interface DockerImageTransport {
  startCandidate(candidate: DockerImageCandidateV1, signal: AbortSignal): Promise<void>;
  checkHealth(candidate: DockerImageCandidateV1, signal: AbortSignal): Promise<boolean>;
  promoteCandidate(candidate: DockerImageCandidateV1, signal: AbortSignal): Promise<void>;
  restorePrior(receipt: ProvenDockerImageExecutionReceiptV1, signal: AbortSignal): Promise<void>;
  discardCandidate(candidate: DockerImageCandidateV1, signal: AbortSignal): Promise<void>;
}
export interface DockerImageExecutionInputV1 { readonly snapshot: DeploymentSnapshotV1; readonly commandId: string; readonly lease: LeaseV1; readonly executionDeploymentId?: string; readonly networkName?: string; readonly priorProvenReceipt?: ProvenDockerImageExecutionReceiptV1; readonly signal?: AbortSignal; }
export interface DockerImageExecutorOptions { readonly protocol: InMemoryProtocolTransport; readonly transport: DockerImageTransport; readonly trustedHosts: readonly string[]; readonly allowedNetworks?: readonly string[]; }

function fail(message: string): never { throw new ProtocolValidationError(message); }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  return value;
}
function validateSnapshot(snapshot: DeploymentSnapshotV1): void {
  if (!snapshot || snapshot.schemaVersion !== 1 || !/^[0-9a-f]{64}$/.test(snapshot.hash) || typeof snapshot.canonicalJson !== "string" || !(snapshot.canonicalBytes instanceof Uint8Array)) fail("deployment snapshot is invalid");
  let parsed: unknown;
  try { parsed = JSON.parse(snapshot.canonicalJson); } catch { fail("deployment snapshot canonical evidence is invalid"); }
  if (JSON.stringify(canonical(parsed)) !== snapshot.canonicalJson || new TextDecoder().decode(snapshot.canonicalBytes) !== snapshot.canonicalJson) fail("deployment snapshot canonical evidence is tampered");
}
function effectiveImage(snapshot: DeploymentSnapshotV1, trustedHosts: ReadonlySet<string>): string {
  validateSnapshot(snapshot);
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
function assertReceipt(receipt: ProvenDockerImageExecutionReceiptV1 | undefined): void { if (receipt && (receipt.proven !== true || receipt.health !== "passed" || receipt.terminalStatus !== "succeeded" || !DIGEST.test(receipt.effectiveImage.split("@")[1] ?? ""))) fail("rollback receipt is not proven"); }
function boundedPort(snapshot: DeploymentSnapshotV1): number { const port = snapshot.runtimePort; if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) fail("docker image execution requires a bounded runtime port"); return port; }

export class DockerImageExecutor {
  #protocol: InMemoryProtocolTransport; #transport: DockerImageTransport; #trustedHosts: ReadonlySet<string>; #allowedNetworks: ReadonlySet<string>;
  constructor(options: DockerImageExecutorOptions) { this.#protocol = options.protocol; this.#transport = options.transport; this.#trustedHosts = new Set(options.trustedHosts); this.#allowedNetworks = new Set(options.allowedNetworks ?? []); }
  async execute(input: DockerImageExecutionInputV1): Promise<DockerImageExecutionReceiptV1> {
    const image = effectiveImage(input.snapshot, this.#trustedHosts); const port = boundedPort(input.snapshot);
    if (input.networkName !== undefined && (!NETWORK.test(input.networkName) || !this.#allowedNetworks.has(input.networkName))) fail("docker network is not allowlisted");
    assertReceipt(input.priorProvenReceipt);
    const executionDeploymentId = input.executionDeploymentId ?? input.snapshot.deploymentId; if (input.lease.deploymentId !== executionDeploymentId) fail("execution deployment identity does not match lease");
    const command = this.#protocol.createCommand({ commandId: input.commandId, deploymentId: executionDeploymentId, requiredCapabilities: ["deploy.execute"], payload: { snapshotHash: input.snapshot.hash, effectiveImage: image, runtimePort: port, networkName: input.networkName ?? null, rollbackTarget: input.priorProvenReceipt?.effectiveImage ?? null }, lease: input.lease });
    return (await this.#protocol.deliverAsync(command, () => this.#run(input, image, port))).result;
  }
  #stage(input: DockerImageExecutionInputV1, stage: string, sequence: number): void { this.#protocol.recordStageAck(createStageAck({ schemaVersion: 1, deploymentId: input.executionDeploymentId ?? input.snapshot.deploymentId, commandId: input.commandId, lease: input.lease, stage, sequence })); }
  #terminal(input: DockerImageExecutionInputV1, receipt: DockerImageExecutionReceiptV1): DockerImageExecutionReceiptV1 { const terminal = { schemaVersion: 1 as const, deploymentId: input.executionDeploymentId ?? input.snapshot.deploymentId, commandId: input.commandId, lease: input.lease, status: receipt.terminalStatus }; this.#protocol.recordTerminalIntent(createTerminalIntent(terminal)); this.#protocol.recordTerminalAck(createTerminalAck(terminal)); return Object.freeze(receipt); }
  async #run(input: DockerImageExecutionInputV1, image: string, port: number): Promise<DockerImageExecutionReceiptV1> {
    const executionDeploymentId = input.executionDeploymentId ?? input.snapshot.deploymentId; const candidate = Object.freeze({ candidateId: `${executionDeploymentId}:candidate:${input.commandId}`, projectId: input.snapshot.projectId, deploymentId: executionDeploymentId, effectiveImage: image, runtimePort: port, ...(input.networkName ? { networkName: input.networkName } : {}) });
    if (input.signal?.aborted) { this.#stage(input, "execution-canceled", 1); return this.#terminal(input, { deploymentId: executionDeploymentId, effectiveImage: image, runtimePort: port, health: "failed", terminalStatus: "canceled", rollback: { target: null, result: "not-available" }, proven: false }); }
    let started = false; let healthy = false; let rollback: DockerImageExecutionReceiptV1["rollback"] = { target: null, result: "not-available" };
      try { await this.#transport.startCandidate(candidate, input.signal ?? new AbortController().signal); started = true; this.#stage(input, "candidate-started", 1); if (input.signal?.aborted) throw new Error("canceled"); healthy = await this.#transport.checkHealth(candidate, input.signal ?? new AbortController().signal); this.#stage(input, healthy ? "candidate-healthy" : "candidate-unhealthy", 2); if (healthy) { await this.#transport.promoteCandidate(candidate, input.signal ?? new AbortController().signal); this.#stage(input, "candidate-promoted", 3); return this.#terminal(input, { deploymentId: executionDeploymentId, candidateId: candidate.candidateId, effectiveImage: image, runtimePort: port, health: "passed", terminalStatus: "succeeded", rollback: { target: null, result: "not-required" }, proven: true }); } throw new Error("health check failed"); }
     catch { const prior = input.priorProvenReceipt; if (prior && started) { try { await this.#transport.restorePrior(prior, input.signal ?? new AbortController().signal); rollback = { target: prior.effectiveImage, result: "restored" }; } catch { rollback = { target: prior.effectiveImage, result: "not-available" }; } } if (started) { try { await this.#transport.discardCandidate(candidate, input.signal ?? new AbortController().signal); } catch { /* cleanup is best effort; terminal state remains durable */ } } const canceled = input.signal?.aborted; this.#stage(input, canceled ? "execution-canceled" : "candidate-failed", started ? 3 : 2); return this.#terminal(input, { deploymentId: executionDeploymentId, effectiveImage: image, runtimePort: port, health: healthy ? "passed" : "failed", terminalStatus: canceled ? "canceled" : "failed", rollback, proven: false }); }
  }
}

export function renderDockerImageCandidate(input: DockerImageExecutionInputV1, trustedHosts: readonly string[], allowedNetworks: readonly string[] = []): DockerImageCandidateV1 { const image = effectiveImage(input.snapshot, new Set(trustedHosts)); const port = boundedPort(input.snapshot); if (input.networkName !== undefined && (!NETWORK.test(input.networkName) || !allowedNetworks.includes(input.networkName))) fail("docker network is not allowlisted"); return Object.freeze({ candidateId: `${input.snapshot.deploymentId}:candidate:${input.commandId}`, projectId: input.snapshot.projectId, deploymentId: input.snapshot.deploymentId, effectiveImage: image, runtimePort: port, ...(input.networkName ? { networkName: input.networkName } : {}) }); }
