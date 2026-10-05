import type { DockerActiveIdentityObservation, DockerImageCandidateV1, DockerImageTransport, ProvenDockerImageExecutionReceiptV1 } from "@deploylite/domain";
import { z } from "zod";
import { buildDockerActiveIdentityInspectArgv, buildDockerImageIdentityInspectArgv, buildDockerInspectArgv, buildDockerOwnedStopLookupArgv, buildDockerOwnershipInspectArgv, buildDockerRemoveArgv, buildDockerRenameArgv, buildDockerRestoreInspectArgv, buildDockerRunArgv, buildDockerStartArgv, buildDockerStopArgv, buildDockerStopOwnershipInspectArgv } from "./docker-cli-argv.js";
import type { DockerProcessExit } from "./docker-process-runner.js";

export class DockerCliTransportFailure extends Error { constructor(readonly operation: string, readonly exit?: DockerProcessExit) { super(`docker ${operation} failed`); this.name = "DockerCliTransportFailure"; } }
export class DockerCliTransportCanceled extends Error { constructor(readonly operation: string) { super(`docker ${operation} canceled`); this.name = "DockerCliTransportCanceled"; } }
export type DockerCliRunner = Readonly<{ run(argv: readonly string[], signal: AbortSignal): Promise<DockerProcessExit> }>;
export type DockerCliImageTransportOptions = Readonly<{ runner: DockerCliRunner; owner: string; hostPort: number; containerPort: number; allowedNetworks: readonly string[]; networkName?: string }>;
const names = (candidate: DockerImageCandidateV1) => { const suffix = candidate.candidateId.slice(`${candidate.deploymentId}:candidate:`.length); return { candidate: `deploylite-candidate-${candidate.deploymentId}-${suffix}`, active: `deploylite-active-${candidate.deploymentId}` }; };
const signal = (input: AbortSignal | undefined) => input ?? new AbortController().signal;

export type { DockerActiveIdentityObservation } from "@deploylite/domain";

const objectIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
const imageIdSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const bindingsSchema = z.record(z.array(z.object({
  HostIp: z.literal("127.0.0.1"), HostPort: z.string().regex(/^[1-9][0-9]{0,4}$/)
}).strict()).length(1));
const activeIdentitySchema = z.object({
  id: objectIdSchema, name: z.string(), imageId: imageIdSchema,
  owner: z.string(), projectId: z.string(), deploymentId: z.string(), candidateId: z.string(), effectiveImage: z.string(),
  running: z.literal(true), health: z.literal("healthy"),
  hostBindings: bindingsSchema, portBindings: bindingsSchema, networkMode: z.string(),
  networks: z.record(z.object({ networkId: objectIdSchema, endpointId: objectIdSchema }).strict())
}).strict();

export class DockerCliImageTransport implements DockerImageTransport {
  constructor(private readonly options: DockerCliImageTransportOptions) {}
  // This observation does not authorize promotion or construct a trusted execution receipt.
  async observeActiveIdentity(candidate: DockerImageCandidateV1, abort: AbortSignal): Promise<DockerActiveIdentityObservation> {
    try {
      if (abort.aborted) throw new DockerCliTransportCanceled("observe");
      const request = { ...candidate };
      const options = { ...this.options, allowedNetworks: [...this.options.allowedNetworks] };
      if (request.runtimePort !== options.containerPort || request.networkName !== options.networkName) throw new DockerCliTransportFailure("observe");
      const activeName = names(request).active;
      const containerArgv = buildDockerActiveIdentityInspectArgv({ ...options, candidate: request, projectId: request.projectId, containerName: activeName });
      const imageArgv = buildDockerImageIdentityInspectArgv(request.effectiveImage);
      const inspect = async (argv: readonly string[]): Promise<unknown> => {
        if (abort.aborted) throw new DockerCliTransportCanceled("observe");
        const result = await options.runner.run(argv, abort);
        if (abort.aborted) throw new DockerCliTransportCanceled("observe");
        if (result.exitCode !== 0 || result.signal !== null) throw new DockerCliTransportFailure("observe");
        return JSON.parse(result.stdout);
      };
      const inspected = activeIdentitySchema.parse(await inspect(containerArgv));
      if (inspected.name !== `/${activeName}` || inspected.owner !== options.owner || inspected.projectId !== request.projectId || inspected.deploymentId !== request.deploymentId || inspected.candidateId !== request.candidateId || inspected.effectiveImage !== request.effectiveImage) throw new DockerCliTransportFailure("observe");
      const validBindings = (bindings: z.infer<typeof bindingsSchema>) => {
        const entries = Object.entries(bindings);
        return entries.length === 1 && entries[0]?.[0] === `${options.containerPort}/tcp` && entries[0]?.[1][0]?.HostPort === String(options.hostPort);
      };
      if (!validBindings(inspected.hostBindings) || !validBindings(inspected.portBindings)) throw new DockerCliTransportFailure("observe");
      const networkNames = Object.keys(inspected.networks);
      // Null denotes an inspected default-mode bridge attachment, never absent inspection.
      if (inspected.networkMode !== (options.networkName ?? "default") || networkNames.length !== 1 || networkNames[0] !== (options.networkName ?? "bridge")) throw new DockerCliTransportFailure("observe");
      if (inspected.imageId !== imageIdSchema.parse(await inspect(imageArgv))) throw new DockerCliTransportFailure("observe");
      const port = Object.keys(inspected.portBindings)[0]!;
      return Object.freeze({
        container: inspected.name.slice(1), containerId: inspected.id, imageId: inspected.imageId,
        owner: inspected.owner, projectId: inspected.projectId, deploymentId: inspected.deploymentId,
        candidateId: inspected.candidateId, effectiveImage: inspected.effectiveImage,
        running: inspected.running, health: inspected.health,
        hostPort: Number(inspected.portBindings[port]![0]!.HostPort), containerPort: Number(port.split("/")[0]),
        network: options.networkName === undefined ? null : networkNames[0]!
      });
    } catch {
      if (abort.aborted) throw new DockerCliTransportCanceled("observe");
      // Keep runner output and parser diagnostics out of the public error.
      throw new DockerCliTransportFailure("observe");
    }
  }
  async startCandidate(candidate: DockerImageCandidateV1, abort: AbortSignal): Promise<void> { await this.run("start", buildDockerRunArgv({ candidate, projectId: candidate.projectId, containerName: names(candidate).candidate, hostPort: this.options.hostPort, containerPort: this.options.containerPort, owner: this.options.owner, allowedNetworks: this.options.allowedNetworks, networkName: this.options.networkName }), abort); }
  async checkHealth(candidate: DockerImageCandidateV1, abort: AbortSignal): Promise<boolean> { try { const result = await this.options.runner.run(buildDockerInspectArgv(names(candidate).candidate), signal(abort)); return result.exitCode === 0 && result.stdout.trim() === "healthy"; } catch (error) { if (abort.aborted) throw new DockerCliTransportCanceled("health"); return false; } }
  async promoteCandidate(candidate: DockerImageCandidateV1, priorOrSignal: AbortSignal | import("@deploylite/domain").PriorDockerImageExecutionReceiptV1 | undefined, signalOrSource?: AbortSignal | string, suppliedSignal?: AbortSignal): Promise<DockerActiveIdentityObservation> {
    const abort = suppliedSignal ?? (signalOrSource instanceof AbortSignal ? signalOrSource : priorOrSignal instanceof AbortSignal ? priorOrSignal : undefined);
    if (!abort) throw new DockerCliTransportFailure("promote");
    const request = { ...candidate };
    const resource = names(request);
    await this.verifyOwnership(resource.candidate, request.deploymentId, request.candidateId, request.effectiveImage, abort);
    await this.run("promote", buildDockerRenameArgv(resource.candidate, resource.active), abort);
    return this.observeActiveIdentity(request, abort);
  }
  async restorePrior(receipt: ProvenDockerImageExecutionReceiptV1 & { projectId?: string; runtimeConfig?: { hostPort: number; containerPort: number; networkName?: string } }, abort: AbortSignal): Promise<void> { if (!receipt.candidateId || !receipt.projectId || !receipt.runtimeConfig || receipt.runtimeConfig.hostPort !== this.options.hostPort || receipt.runtimeConfig.containerPort !== this.options.containerPort || receipt.runtimeConfig.networkName !== this.options.networkName) throw new DockerCliTransportFailure("restore"); const candidate = { candidateId: receipt.candidateId, projectId: receipt.projectId, deploymentId: receipt.deploymentId, effectiveImage: receipt.effectiveImage, runtimePort: receipt.runtimeConfig.containerPort, networkName: receipt.runtimeConfig.networkName }; const resource = names(candidate); const inspected = await this.options.runner.run(buildDockerRestoreInspectArgv(resource.active), signal(abort)); if (inspected.exitCode !== 0) throw new DockerCliTransportFailure("restore", inspected); const [owner, project, deployment, candidateId, image, state, health] = inspected.stdout.trim().split("|"); if (owner !== this.options.owner || project !== receipt.projectId || deployment !== receipt.deploymentId || candidateId !== receipt.candidateId || image !== receipt.effectiveImage || (state !== "running" && state !== "exited" && state !== "created")) throw new DockerCliTransportFailure("restore", inspected); if (state === "running") { if (health !== "healthy") throw new DockerCliTransportFailure("restore", inspected); return; } await this.run("restore", buildDockerStartArgv(resource.active), abort); const healthy = await this.options.runner.run(buildDockerInspectArgv(resource.active), signal(abort)); if (healthy.exitCode !== 0 || healthy.stdout.trim() !== "healthy") throw new DockerCliTransportFailure("restore", healthy); }
  async discardCandidate(candidate: DockerImageCandidateV1, abort: AbortSignal): Promise<void> { const resource = names(candidate); await this.verifyOwnership(resource.candidate, candidate.deploymentId, candidate.candidateId, candidate.effectiveImage, abort); await this.run("discard", buildDockerRemoveArgv(resource.candidate), abort); }
  async stopOwned(input: { projectId: string; deploymentId: string; candidateId: string; effectiveImage: string }, abort: AbortSignal): Promise<"stopped" | "already-stopped" | "absent" | "failed" | "canceled"> { try { const result = await this.options.runner.run(buildDockerOwnedStopLookupArgv({ ...input, owner: this.options.owner }), signal(abort)); if (result.exitCode !== 0) throw new DockerCliTransportFailure("lookup", result); const records = result.stdout.trim() ? result.stdout.trim().split("\n").map((line) => line.split("|")) : []; if (records.length === 0) return "absent"; if (records.length !== 1 || !records[0]?.[0]) throw new DockerCliTransportFailure("ownership", result); const [containerId] = records[0]; const inspected = await this.options.runner.run(buildDockerStopOwnershipInspectArgv(containerId!), signal(abort)); const [owner, project, deployment, candidate, image, state] = inspected.stdout.trim().split("|"); if (inspected.exitCode !== 0 || owner !== this.options.owner || project !== input.projectId || deployment !== input.deploymentId || candidate !== input.candidateId || image !== input.effectiveImage) throw new DockerCliTransportFailure("ownership", inspected); if (state !== "running") return "already-stopped"; await this.run("stop", buildDockerStopArgv(containerId!), abort); return "stopped"; } catch (error) { return abort.aborted ? "canceled" : "failed"; } }
  private async verifyOwnership(name: string, deploymentId: string, candidateId: string, effectiveImage: string, abort: AbortSignal, allowMissing = false): Promise<void> { try { const result = await this.options.runner.run(buildDockerOwnershipInspectArgv(name), signal(abort)); if (result.exitCode !== 0) { if (allowMissing && /no such object/i.test(result.stderr)) return; throw new DockerCliTransportFailure("ownership", result); } const [owner, deployment, candidate, image] = result.stdout.trim().split("|"); if (owner !== this.options.owner || deployment !== deploymentId || candidate !== candidateId || image !== effectiveImage) throw new DockerCliTransportFailure("ownership", result); } catch (error) { if (abort.aborted) throw new DockerCliTransportCanceled("ownership"); if (error instanceof DockerCliTransportFailure) throw error; throw new DockerCliTransportFailure("ownership"); } }
  private async run(operation: string, argv: readonly string[], abort: AbortSignal): Promise<void> { try { const result = await this.options.runner.run(argv, signal(abort)); if (result.exitCode !== 0) throw new DockerCliTransportFailure(operation, result); } catch (error) { if (abort.aborted) throw new DockerCliTransportCanceled(operation); if (error instanceof DockerCliTransportFailure) throw error; throw new DockerCliTransportFailure(operation); } }
}
