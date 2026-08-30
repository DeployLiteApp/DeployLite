import type { DockerImageCandidateV1, DockerImageTransport, ProvenDockerImageExecutionReceiptV1 } from "@deploylite/domain";
import { buildDockerInspectArgv, buildDockerRemoveArgv, buildDockerRenameArgv, buildDockerRunArgv } from "./docker-cli-argv.js";
import type { DockerProcessExit } from "./docker-process-runner.js";

export class DockerCliTransportFailure extends Error { constructor(readonly operation: string, readonly exit?: DockerProcessExit) { super(`docker ${operation} failed`); this.name = "DockerCliTransportFailure"; } }
export class DockerCliTransportCanceled extends Error { constructor(readonly operation: string) { super(`docker ${operation} canceled`); this.name = "DockerCliTransportCanceled"; } }
export type DockerCliRunner = Readonly<{ run(argv: readonly string[], signal: AbortSignal): Promise<DockerProcessExit> }>;
export type DockerCliImageTransportOptions = Readonly<{ runner: DockerCliRunner; owner: string; hostPort: number; containerPort: number; allowedNetworks: readonly string[]; networkName?: string }>;
const names = (candidate: DockerImageCandidateV1) => { const suffix = candidate.candidateId.slice(`${candidate.deploymentId}:candidate:`.length); return { candidate: `deploylite-candidate-${candidate.deploymentId}-${suffix}`, active: `deploylite-active-${candidate.deploymentId}` }; };
const signal = (input: AbortSignal | undefined) => input ?? new AbortController().signal;

export class DockerCliImageTransport implements DockerImageTransport {
  constructor(private readonly options: DockerCliImageTransportOptions) {}
  async startCandidate(candidate: DockerImageCandidateV1, abort: AbortSignal): Promise<void> { await this.run("start", buildDockerRunArgv({ candidate, containerName: names(candidate).candidate, hostPort: this.options.hostPort, containerPort: this.options.containerPort, owner: this.options.owner, allowedNetworks: this.options.allowedNetworks, networkName: this.options.networkName }), abort); }
  async checkHealth(candidate: DockerImageCandidateV1, abort: AbortSignal): Promise<boolean> { try { const result = await this.options.runner.run(buildDockerInspectArgv(names(candidate).candidate), signal(abort)); return result.exitCode === 0 && result.stdout.trim() === "healthy"; } catch (error) { if (abort.aborted) throw new DockerCliTransportCanceled("health"); return false; } }
  async promoteCandidate(candidate: DockerImageCandidateV1, abort: AbortSignal): Promise<void> { await this.run("promote", buildDockerRenameArgv(names(candidate).candidate, names(candidate).active), abort); }
  async restorePrior(receipt: ProvenDockerImageExecutionReceiptV1, abort: AbortSignal): Promise<void> { const candidate = { candidateId: `${receipt.deploymentId}:candidate:rollback`, deploymentId: receipt.deploymentId, effectiveImage: receipt.effectiveImage, runtimePort: receipt.runtimePort }; await this.run("restore", buildDockerRunArgv({ candidate, containerName: names(candidate).active, hostPort: this.options.hostPort, containerPort: this.options.containerPort, owner: this.options.owner, allowedNetworks: this.options.allowedNetworks, networkName: this.options.networkName }), abort); }
  async discardCandidate(candidate: DockerImageCandidateV1, abort: AbortSignal): Promise<void> { await this.run("discard", buildDockerRemoveArgv(names(candidate).candidate), abort); }
  private async run(operation: string, argv: readonly string[], abort: AbortSignal): Promise<void> { try { const result = await this.options.runner.run(argv, signal(abort)); if (result.exitCode !== 0) throw new DockerCliTransportFailure(operation, result); } catch (error) { if (abort.aborted) throw new DockerCliTransportCanceled(operation); if (error instanceof DockerCliTransportFailure) throw error; throw new DockerCliTransportFailure(operation); } }
}
