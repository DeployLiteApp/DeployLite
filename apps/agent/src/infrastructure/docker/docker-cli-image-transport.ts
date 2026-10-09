import { awaitAbortable } from "@deploylite/domain";
import type { DockerActiveIdentityObservation, DockerImageCandidateV1, DockerImageTransport, ProvenDockerImageExecutionReceiptV1, DockerPromotionContext, PriorDockerImageExecutionReceiptV1, RuntimeExecutionAuthority } from "@deploylite/domain";
import { promotionPolicySchema, trustedPriorExecutionReceiptSchema } from "@deploylite/contracts";
import { z } from "zod";
import { buildDockerLifecycleInspectArgv, buildDockerActiveIdentityInspectArgv, buildDockerImageIdentityInspectArgv, buildDockerInspectArgv, buildDockerOwnedStopLookupArgv, buildDockerOwnershipInspectArgv, buildDockerRemoveArgv, buildDockerRenameArgv, buildDockerRestoreInspectArgv, buildDockerRunArgv, buildDockerStartArgv, buildDockerStopArgv, buildDockerStopOwnershipInspectArgv } from "./docker-cli-argv.js";
import { DockerProcessError, type DockerProcessExit } from "./docker-process-runner.js";

export class DockerCliTransportFailure extends Error { constructor(readonly operation: string, readonly exit?: DockerProcessExit) { super(`docker ${operation} failed`); this.name = "DockerCliTransportFailure"; } }
export class DockerCliTransportCanceled extends Error { constructor(readonly operation: string) { super(`docker ${operation} canceled`); this.name = "DockerCliTransportCanceled"; } }
export type DockerCliRunner = Readonly<{ run(argv: readonly string[], signal: AbortSignal, environment?: Readonly<Record<string, string>>): Promise<DockerProcessExit> }>;
export type DockerCliImageTransportOptions = Readonly<{ runner: DockerCliRunner; owner: string; hostPort: number; containerPort: number; temporaryHostPort?: number; allowedNetworks: readonly string[]; networkName?: string }>;
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
    return this.observeIdentity(candidate, abort, names(candidate).active, this.options.hostPort);
  }
  private async observeIdentity(candidate: DockerImageCandidateV1, abort: AbortSignal, activeName: string, hostPort: number): Promise<DockerActiveIdentityObservation> {
    try {
      if (abort.aborted) throw new DockerCliTransportCanceled("observe");
      const request = { ...candidate };
      const options = { ...this.options, hostPort, allowedNetworks: [...this.options.allowedNetworks] };
      if (request.runtimePort !== options.containerPort || request.networkName !== options.networkName) throw new DockerCliTransportFailure("observe");
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
  async startCandidate(candidate: DockerImageCandidateV1, abort: AbortSignal, supplied?: DockerPromotionContext, initialAuthority?: RuntimeExecutionAuthority): Promise<void> {
    const request = { ...candidate }, context = supplied ? this.captureContext(supplied) : undefined;
    if (context) { await this.assertAuthority(context, abort); const current = await this.observeActiveIdentity(this.priorCandidate(context.prior), abort); this.assertPriorIdentity(current, context); }
    const port = context ? this.options.temporaryHostPort! : this.options.hostPort;
    await this.mutate("start", this.runArgv(request, names(request).candidate, port), abort, context ?? (initialAuthority ? { authority: initialAuthority } : undefined));
  }
  async checkHealth(candidate: DockerImageCandidateV1, abort: AbortSignal): Promise<boolean> {
    try { await this.waitHealthy(names(candidate).candidate, abort); return true; }
    catch { if (abort.aborted) throw new DockerCliTransportCanceled("health"); return false; }
  }
  async promoteCandidate(candidate: DockerImageCandidateV1, priorOrSignal: AbortSignal | PriorDockerImageExecutionReceiptV1 | undefined, signalOrSource?: AbortSignal | string, suppliedSignal?: AbortSignal | DockerPromotionContext, suppliedContext?: DockerPromotionContext | RuntimeExecutionAuthority): Promise<DockerActiveIdentityObservation> {
    const abort = suppliedSignal instanceof AbortSignal ? suppliedSignal : signalOrSource instanceof AbortSignal ? signalOrSource : priorOrSignal instanceof AbortSignal ? priorOrSignal : undefined;
    const initialAuthority = suppliedContext && "assertValid" in suppliedContext ? suppliedContext : undefined;
    const supplied = (suppliedContext && "assertValid" in suppliedContext ? undefined : suppliedContext) ?? (suppliedSignal && !(suppliedSignal instanceof AbortSignal) ? suppliedSignal : undefined);
    if (!abort) throw new DockerCliTransportFailure("promote");
    const request = { ...candidate }, resource = names(request);
    const prior = priorOrSignal && !(priorOrSignal instanceof AbortSignal) ? priorOrSignal : undefined;
    if (prior && !supplied) throw new DockerCliTransportFailure("authority");
    if (supplied) {
      const context = this.captureContext(supplied);
      if (context.prior.projectId !== request.projectId || context.prior.deploymentId === request.deploymentId) throw new DockerCliTransportFailure("scope");
      await this.assertAuthority(context, abort);
      await this.observeIdentity(request, abort, resource.candidate, this.options.temporaryHostPort!);
      const current = await this.observeActiveIdentity(this.priorCandidate(context.prior), abort);
      this.assertPriorIdentity(current, context);
      if (context.authority.expiresAt !== undefined && context.authority.expiresAt - Date.now() < context.policy.maxOutageMs + context.policy.maxRecoveryMs) throw new DockerCliTransportFailure("authority-budget");
      context.completePreparation?.();
      return this.within(context.policy.maxOutageMs, context.promotionSignal ?? abort, async (bounded) => {
        await this.mutate("cutover-stop", buildDockerStopArgv(current.containerId), bounded, context);
        await this.removeOwned(resource.candidate, request, bounded, context);
        await this.mutate("cutover-run", this.runArgv(request, resource.active, this.options.hostPort), bounded, context);
        await this.waitHealthy(resource.active, bounded);
        return this.observeActiveIdentity(request, bounded);
      });
    }
    await this.verifyOwnership(resource.candidate, request.deploymentId, request.candidateId, request.effectiveImage, abort);
    await this.mutate("promote", buildDockerRenameArgv(resource.candidate, resource.active), abort, initialAuthority ? { authority: initialAuthority } : undefined);
    return this.observeActiveIdentity(request, abort);
  }
  async restorePrior(receipt: ProvenDockerImageExecutionReceiptV1 & { projectId?: string; runtimeConfig?: { hostPort: number; containerPort: number; networkName?: string } }, abort: AbortSignal, supplied?: DockerPromotionContext): Promise<void> { if (supplied) return this.recoverPrior(this.captureContext(supplied), abort); if (!receipt.candidateId || !receipt.projectId || !receipt.runtimeConfig || receipt.runtimeConfig.hostPort !== this.options.hostPort || receipt.runtimeConfig.containerPort !== this.options.containerPort || receipt.runtimeConfig.networkName !== this.options.networkName) throw new DockerCliTransportFailure("restore"); const candidate = { candidateId: receipt.candidateId, projectId: receipt.projectId, deploymentId: receipt.deploymentId, effectiveImage: receipt.effectiveImage, runtimePort: receipt.runtimeConfig.containerPort, networkName: receipt.runtimeConfig.networkName }; const resource = names(candidate); const inspected = await awaitAbortable(() => this.options.runner.run(buildDockerRestoreInspectArgv(resource.active), signal(abort)), abort); if (inspected.exitCode !== 0) throw new DockerCliTransportFailure("restore", inspected); const [owner, project, deployment, candidateId, image, state, health] = inspected.stdout.trim().split("|"); if (owner !== this.options.owner || project !== receipt.projectId || deployment !== receipt.deploymentId || candidateId !== receipt.candidateId || image !== receipt.effectiveImage || (state !== "running" && state !== "exited" && state !== "created")) throw new DockerCliTransportFailure("restore", inspected); if (state === "running") { if (health !== "healthy") throw new DockerCliTransportFailure("restore", inspected); return; } await this.run("restore", buildDockerStartArgv(resource.active), abort); const healthy = await awaitAbortable(() => this.options.runner.run(buildDockerInspectArgv(resource.active), signal(abort)), abort); if (healthy.exitCode !== 0 || healthy.stdout.trim() !== "healthy") throw new DockerCliTransportFailure("restore", healthy); }
  async discardCandidate(candidate: DockerImageCandidateV1, abort: AbortSignal, supplied?: DockerPromotionContext): Promise<void> { if (supplied) { const context = this.captureContext(supplied); await this.assertAuthority(context, abort); await this.removeOwned(names(candidate).candidate, candidate, abort, context, true); return; } const resource = names(candidate); await this.verifyOwnership(resource.candidate, candidate.deploymentId, candidate.candidateId, candidate.effectiveImage, abort); await this.run("discard", buildDockerRemoveArgv(resource.candidate), abort); }
  async stopOwned(input: { projectId: string; deploymentId: string; candidateId: string; effectiveImage: string; containerId?: string }, abort: AbortSignal, authority?: RuntimeExecutionAuthority): Promise<"stopped" | "already-stopped" | "absent" | "failed" | "canceled"> { try { if (!authority || abort.aborted) throw new DockerCliTransportFailure("authority"); await awaitAbortable(() => authority.assertValid(), abort); const result = await awaitAbortable(() => this.options.runner.run(buildDockerOwnedStopLookupArgv({ ...input, owner: this.options.owner }), signal(abort)), abort); if (result.exitCode !== 0) throw new DockerCliTransportFailure("lookup", result); const records = result.stdout.trim() ? result.stdout.trim().split("\n").map((line) => line.split("|")) : []; if (records.length === 0) return "absent"; if (records.length !== 1 || !records[0]?.[0]) throw new DockerCliTransportFailure("ownership", result); const [containerId] = records[0]; if (input.containerId !== undefined && containerId !== input.containerId) throw new DockerCliTransportFailure("physical-identity"); const inspected = await awaitAbortable(() => this.options.runner.run(buildDockerStopOwnershipInspectArgv(containerId!), signal(abort)), abort); const [owner, project, deployment, candidate, image, state] = inspected.stdout.trim().split("|"); if (inspected.exitCode !== 0 || owner !== this.options.owner || project !== input.projectId || deployment !== input.deploymentId || candidate !== input.candidateId || image !== input.effectiveImage) throw new DockerCliTransportFailure("ownership", inspected); if (state !== "running") return "already-stopped"; await awaitAbortable(() => authority.assertValid(), abort); if (abort.aborted) throw new DockerCliTransportCanceled("stop"); await this.run("stop", buildDockerStopArgv(containerId!), abort); return "stopped"; } catch (error) { return abort.aborted ? "canceled" : "failed"; } }
  private captureContext(input: DockerPromotionContext): DockerPromotionContext {
    if (!input.authority || typeof input.authority.assertValid !== "function") throw new DockerCliTransportFailure("authority");
    const policy = promotionPolicySchema.parse(input.policy), prior = structuredClone(input.prior);
    const proof = trustedPriorExecutionReceiptSchema.parse(prior.executionReceipt);
    const port = this.options.temporaryHostPort;
    if (!Number.isInteger(port) || port! < 1024 || port! > 65535 || port === this.options.hostPort || proof.projectId !== prior.projectId || proof.deploymentId !== prior.deploymentId || proof.candidateId !== prior.candidateId || proof.effectiveImageDigest !== prior.effectiveImage.split("@")[1] || proof.container !== names(this.priorCandidate(prior)).active || proof.hostPort !== this.options.hostPort || proof.containerPort !== this.options.containerPort || proof.network !== (this.options.networkName ?? null)) throw new DockerCliTransportFailure("replacement");
    return { prior, policy, completePreparation: input.completePreparation, promotionSignal: input.promotionSignal, authority: { assertValid: input.authority.assertValid.bind(input.authority), expiresAt: input.authority.expiresAt }, ...(input.candidate ? { candidate: { ...input.candidate } } : {}) };
  }
  private assertPriorIdentity(current: DockerActiveIdentityObservation, context: DockerPromotionContext): void {
    if (current.containerId !== context.prior.executionReceipt?.containerId) throw new DockerCliTransportFailure("physical-identity");
  }
  private priorCandidate(prior: PriorDockerImageExecutionReceiptV1): DockerImageCandidateV1 {
    if (!prior.candidateId || !prior.runtimeConfig || prior.runtimeConfig.hostPort !== this.options.hostPort || prior.runtimeConfig.containerPort !== this.options.containerPort || prior.runtimeConfig.networkName !== this.options.networkName) throw new DockerCliTransportFailure("restore");
    return { candidateId: prior.candidateId, projectId: prior.projectId, deploymentId: prior.deploymentId, effectiveImage: prior.effectiveImage, runtimePort: prior.runtimePort, ...(prior.runtimeConfig.networkName ? { networkName: prior.runtimeConfig.networkName } : {}) };
  }
  private runArgv(candidate: DockerImageCandidateV1, name: string, hostPort: number) {
    return buildDockerRunArgv({ ...this.options, candidate, projectId: candidate.projectId, containerName: name, hostPort });
  }
  private async assertAuthority(context: Pick<DockerPromotionContext, "authority">, abort: AbortSignal): Promise<void> {
    if (abort.aborted) throw new DockerCliTransportCanceled("authority");
    await awaitAbortable(() => context.authority.assertValid(), abort);
    if (abort.aborted) throw new DockerCliTransportCanceled("authority");
  }
  private async mutate(operation: string, argv: readonly string[], abort: AbortSignal, context?: Pick<DockerPromotionContext, "authority">): Promise<void> {
    if (context) await this.assertAuthority(context, abort);
    await this.run(operation, argv, abort);
  }
  private async lifecycle(name: string, candidate: DockerImageCandidateV1, abort: AbortSignal, missing = false) {
    if (abort.aborted) throw new DockerCliTransportCanceled("ownership");
    const absent = (result: DockerProcessExit) => result.exitCode === 1 && result.signal === null && result.stdout.trim() === "" &&
      ["", "Error: ", "Error response from daemon: "].some((prefix) => ["container", "object"].some((kind) =>
        result.stderr.trim() === `${prefix}No such ${kind}: ${name}`));
    let result: DockerProcessExit;
    try { result = await awaitAbortable(() => this.options.runner.run(buildDockerLifecycleInspectArgv(name), abort), abort); }
    catch (error) {
      if (abort.aborted) throw new DockerCliTransportCanceled("ownership");
      if (missing && error instanceof DockerProcessError && error.kind === "failed" && error.result && absent(error.result)) return undefined;
      throw error;
    }
    if (abort.aborted) throw new DockerCliTransportCanceled("ownership");
    if (result.exitCode !== 0) { if (missing && absent(result)) return undefined; throw new DockerCliTransportFailure("ownership"); }
    const value = z.object({ id: objectIdSchema, name: z.string(), owner: z.string(), project: z.string(), deployment: z.string(), candidate: z.string(), image: z.string(), state: z.enum(["running", "exited", "created"]) }).strict().parse(JSON.parse(result.stdout));
    if (value.name !== `/${name}` || value.owner !== this.options.owner || value.project !== candidate.projectId || value.deployment !== candidate.deploymentId || value.candidate !== candidate.candidateId || value.image !== candidate.effectiveImage) throw new DockerCliTransportFailure("ownership");
    return value;
  }
  private async removeOwned(name: string, candidate: DockerImageCandidateV1, abort: AbortSignal, context: DockerPromotionContext, missing = false): Promise<void> {
    await this.assertAuthority(context, abort);
    const value = await this.lifecycle(name, candidate, abort, missing);
    if (value) await this.mutate("remove", buildDockerRemoveArgv(value.id), abort, context);
  }
  private async recoverPrior(context: DockerPromotionContext, abort: AbortSignal): Promise<void> {
    return this.within(context.policy.maxRecoveryMs, abort, async (bounded) => {
      await this.assertAuthority(context, bounded);
      const prior = this.priorCandidate(context.prior), name = names(prior).active;
      const current = await this.lifecycle(name, prior, bounded, true);
      if (current && current.id !== context.prior.executionReceipt?.containerId) throw new DockerCliTransportFailure("physical-identity");
      if (current?.state === "running") { await this.observeActiveIdentity(prior, bounded); return; }
      if (context.candidate) await this.removeOwned(names(context.candidate).active, context.candidate, bounded, context, true);
      if (current) await this.mutate("restore", buildDockerStartArgv(current.id), bounded, context);
      else await this.mutate("restore", this.runArgv(prior, name, this.options.hostPort), bounded, context);
      await this.waitHealthy(name, bounded);
      // Re-created physical IDs are observed independently; historical success proof is immutable.
      await this.observeActiveIdentity(prior, bounded);
    });
  }
  private async waitHealthy(name: string, abort: AbortSignal): Promise<void> {
    while (!abort.aborted) {
      const result = await awaitAbortable(() => this.options.runner.run(buildDockerInspectArgv(name), abort), abort);
      if (abort.aborted) break;
      if (result.exitCode === 0 && result.signal === null && result.stdout.trim() === "healthy") return;
      await new Promise<void>((resolve, reject) => { const timer = setTimeout(done, 100); const cancel = () => { clearTimeout(timer); abort.removeEventListener("abort", cancel); reject(new DockerCliTransportCanceled("health")); }; function done() { abort.removeEventListener("abort", cancel); resolve(); } abort.addEventListener("abort", cancel, { once: true }); });
    }
    throw new DockerCliTransportCanceled("health");
  }
  private async within<T>(limit: number, parent: AbortSignal, operation: (abort: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController(), cancel = () => controller.abort();
    parent.addEventListener("abort", cancel, { once: true }); if (parent.aborted) cancel();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([operation(controller.signal), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new DockerCliTransportFailure("deadline")); }, limit); })]); }
    finally { if (timer) clearTimeout(timer); parent.removeEventListener("abort", cancel); }
  }
  private async verifyOwnership(name: string, deploymentId: string, candidateId: string, effectiveImage: string, abort: AbortSignal, allowMissing = false): Promise<void> { try { const result = await awaitAbortable(() => this.options.runner.run(buildDockerOwnershipInspectArgv(name), signal(abort)), abort); if (result.exitCode !== 0) { if (allowMissing && /no such object/i.test(result.stderr)) return; throw new DockerCliTransportFailure("ownership", result); } const [owner, deployment, candidate, image] = result.stdout.trim().split("|"); if (owner !== this.options.owner || deployment !== deploymentId || candidate !== candidateId || image !== effectiveImage) throw new DockerCliTransportFailure("ownership", result); } catch (error) { if (abort.aborted) throw new DockerCliTransportCanceled("ownership"); if (error instanceof DockerCliTransportFailure) throw error; throw new DockerCliTransportFailure("ownership"); } }
  private async run(operation: string, argv: readonly string[], abort: AbortSignal): Promise<void> { try { if (abort.aborted) throw new DockerCliTransportCanceled(operation); const result = await awaitAbortable(() => this.options.runner.run(argv, signal(abort)), abort); if (abort.aborted) throw new DockerCliTransportCanceled(operation); if (result.exitCode !== 0) throw new DockerCliTransportFailure(operation, result); } catch (error) { if (abort.aborted) throw new DockerCliTransportCanceled(operation); if (error instanceof DockerCliTransportFailure) throw error; throw new DockerCliTransportFailure(operation); } }
}
export { createDockerComposeResourceInspector } from "./docker-compose-resource-inspector.js";
