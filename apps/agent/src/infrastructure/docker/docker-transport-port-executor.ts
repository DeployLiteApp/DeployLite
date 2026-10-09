import { transportPortApplyReceiptSchema, type TransportPortApplyAgentCommandV1, type TransportPortApplyReceiptV1 } from "@deploylite/contracts";
import type { TransportPortBindingV1 } from "@deploylite/contracts";
import type { RuntimeExecutionAuthority } from "../../agent-transport.js";
import { buildDockerRemoveArgv, buildDockerRenameArgv, buildDockerStartArgv, buildDockerStopArgv,
  buildDockerTransportPortInspectArgv, buildDockerTransportPortRunArgv } from "./docker-cli-argv.js";
import type { DockerCliRunner } from "./docker-cli-image-transport.js";
import type { DockerProcessExit } from "./docker-process-runner.js";
import { awaitAbortable } from "@deploylite/domain";
import { z } from "zod";

const inspectSchema = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), name: z.string(), state: z.enum(["running", "exited", "created"]),
  running: z.boolean(), health: z.string().nullable(), owner: z.string(), projectId: z.string(), deploymentId: z.string(), candidateId: z.string(),
  effectiveImage: z.string(), hostBindings: z.record(z.array(z.object({ HostIp: z.string(), HostPort: z.string() }).strict()).nullable()),
  networkMode: z.string() }).strict();

export class DockerTransportPortExecutorError extends Error {
  constructor(readonly code: "authority" | "target-unavailable" | "port-conflict" | "docker-unavailable" | "restart-failed" | "canceled") {
    super("Docker transport port apply failed safely."); this.name = "DockerTransportPortExecutorError";
  }
}

export type DockerTransportPortExecutorOptions = Readonly<{ runner: DockerCliRunner; agentId: string; owner: string; hostIp?: "0.0.0.0" | "127.0.0.1"; allowedNetworks?: readonly string[]; now?: () => number }>;

function key(binding: Pick<TransportPortBindingV1, "protocol" | "publishedPort">): string { return `${binding.protocol}:${binding.publishedPort}`; }
function expectedBindings(hostPort: number, runtimePort: number, ports: readonly TransportPortBindingV1[], hostIp: "0.0.0.0" | "127.0.0.1") {
  const values: string[] = [`${hostPort}:127.0.0.1:${runtimePort}/tcp`];
  for (const binding of ports) values.push(`${binding.publishedPort}:${hostIp}:${binding.targetPort}/${binding.protocol}`);
  return values.sort();
}
function observedBindings(raw: z.infer<typeof inspectSchema>["hostBindings"]): string[] | null {
  const values: string[] = [];
  for (const [key, entries] of Object.entries(raw)) {
    if (entries === null) continue;
    const match = /^(\d+)\/(tcp|udp)$/.exec(key);
    if (!match || entries.length !== 1 || !/^[0-9]{1,5}$/.test(entries[0]?.HostPort ?? "")) return null;
    const ip = entries[0]!.HostIp;
    if (match[2] === "tcp" && ip === "127.0.0.1") values.push(`${entries[0]!.HostPort}:127.0.0.1:${match[1]}/tcp`);
    else if (ip === "" || ip === "0.0.0.0") values.push(`${entries[0]!.HostPort}:0.0.0.0:${match[1]}/${match[2]}`);
    else if (ip === "127.0.0.1") values.push(`${entries[0]!.HostPort}:127.0.0.1:${match[1]}/${match[2]}`);
    else return null;
  }
  return values.sort();
}
function safeState(value: unknown): z.infer<typeof inspectSchema> | null {
  const parsed = inspectSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Apply a published TCP/UDP binding by replacing only the image container named by the trusted receipt.
 * The app is first started on a loopback-assigned temporary port; cutover then parks the owned original
 * and restores that exact container if the new binding fails health or ownership verification.
 */
export class DockerTransportPortExecutor {
  constructor(private readonly options: DockerTransportPortExecutorOptions) {}

  async execute(command: TransportPortApplyAgentCommandV1, authority: RuntimeExecutionAuthority, signal: AbortSignal): Promise<TransportPortApplyReceiptV1> {
    const { route, executionReceipt: proof } = command;
    const failed = (failureReason: NonNullable<TransportPortApplyReceiptV1["failureReason"]>) => transportPortApplyReceiptSchema.parse({
      schemaVersion: 1, action: "transport.port.apply", agentId: this.options.agentId, commandId: command.commandId, projectId: command.projectId,
      protocol: route.protocol, publishedPort: route.publishedPort, targetPort: route.targetPort, deploymentId: route.deploymentId,
      operation: command.operation, rollbackRevisionId: command.rollbackRevisionId,
      inputDigest: command.inputDigest, correlationId: command.context.correlationId, containerId: null, state: "failed",
      observedAt: Math.max(0, (this.options.now ?? Date.now)()), failureReason, redacted: true
    });
    const candidate = { candidateId: proof.candidateId, projectId: proof.projectId, deploymentId: proof.deploymentId,
      effectiveImage: command.effectiveImage, runtimePort: proof.containerPort, ...(proof.network ? { networkName: proof.network } : {}) };
    if (proof.runtimeHost !== this.options.agentId || proof.projectId !== route.projectId || proof.deploymentId !== route.deploymentId
      || proof.container !== `deploylite-active-${route.deploymentId}` || proof.effectiveImageDigest !== command.effectiveImage.split("@")[1]
      || (proof.network !== null && !this.options.allowedNetworks?.includes(proof.network))) return failed("target-unavailable");

    const activeName = proof.container;
    const probeName = `deploylite-port-probe-${command.commandId.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 40)}`;
    const parkedName = `deploylite-port-prior-${command.commandId.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 40)}`;
    const inspect = async (name: string, inspectSignal: AbortSignal = signal): Promise<z.infer<typeof inspectSchema> | null> => {
      try {
        const result = await this.run(buildDockerTransportPortInspectArgv(name), inspectSignal, authority, false);
        if (result.exitCode !== 0) return null;
        return safeState(JSON.parse(result.stdout));
      } catch { if (signal.aborted) throw new DockerTransportPortExecutorError("canceled"); return null; }
    };
    const matchesOwned = (value: z.infer<typeof inspectSchema> | null, name: string) => Boolean(value && value.name === `/${name}`
      && value.id === command.currentContainerId && value.owner === this.options.owner && value.projectId === route.projectId
      && value.deploymentId === route.deploymentId && value.candidateId === proof.candidateId && value.effectiveImage === command.effectiveImage
      && value.networkMode === (proof.network ?? "default"));
    const desired = expectedBindings(proof.hostPort, proof.containerPort, command.bindings, this.options.hostIp ?? "0.0.0.0");
    const previous = expectedBindings(proof.hostPort, proof.containerPort, command.previousBindings, this.options.hostIp ?? "0.0.0.0");
    let parked = false, parkAttempted = false, originalStopped = false, originalStopAttempted = false, wasRunning = false, replacementId: string | null = null;
    let original: z.infer<typeof inspectSchema> | null = null;
    try {
      if (signal.aborted) return failed("canceled");
      await awaitAbortable(() => authority.assertValid(), signal);
      original = await inspect(activeName);
      if (!matchesOwned(original, activeName)) return failed("target-unavailable");
      const actual = observedBindings(original!.hostBindings);
      if (!actual) return failed("target-unavailable");
      if (actual.join("|") === desired.join("|") && original!.running) {
        if (original!.health !== "healthy") return failed("target-unavailable");
        return this.receipt(command, original!.id, "unchanged", null);
      }
      if (actual.join("|") !== previous.join("|") && actual.join("|") !== desired.join("|")) return failed("target-unavailable");
      wasRunning = original!.running;

      const runInput = { candidate, projectId: route.projectId, containerName: probeName, hostPort: proof.hostPort,
        containerPort: proof.containerPort, owner: this.options.owner, allowedNetworks: this.options.allowedNetworks ?? [],
        ...(proof.network ? { networkName: proof.network } : {}), bindings: [] as const, temporary: true };
      await this.run(buildDockerTransportPortRunArgv(runInput), signal, authority, true);
      await this.waitHealthy(probeName, signal, authority);
      const stillOwned = await inspect(activeName);
      if (!matchesOwned(stillOwned, activeName) || !stillOwned || observedBindings(stillOwned.hostBindings)?.join("|") !== previous.join("|")) {
        throw new DockerTransportPortExecutorError("target-unavailable");
      }
      if (signal.aborted) throw new DockerTransportPortExecutorError("canceled");
      await this.removeOwnedProbe(probeName, command, signal, authority);
      if (wasRunning) {
        originalStopAttempted = true;
        await this.run(buildDockerStopArgv(original!.id), signal, authority, true);
        originalStopped = true;
      }
      const beforeRename = await inspect(activeName);
      if (!matchesOwned(beforeRename, activeName) || beforeRename!.id !== original!.id) throw new DockerTransportPortExecutorError("target-unavailable");
      parkAttempted = true;
      await this.run(buildDockerRenameArgv(activeName, parkedName), signal, authority, true);
      parked = true;
      parkAttempted = false;
      originalStopped = false;
      const finalInput = { ...runInput, containerName: activeName, bindings: command.bindings, temporary: false,
        hostIp: this.options.hostIp ?? "0.0.0.0" };
      const created = await this.run(buildDockerTransportPortRunArgv(finalInput), signal, authority, true);
      replacementId = created.stdout.trim();
      if (!/^[a-f0-9]{64}$/.test(replacementId)) throw new DockerTransportPortExecutorError("restart-failed");
      await this.waitHealthy(activeName, signal, authority);
      const applied = await inspect(activeName);
      if (!applied || applied.owner !== this.options.owner || applied.projectId !== route.projectId || applied.deploymentId !== route.deploymentId
        || applied.candidateId !== proof.candidateId || applied.effectiveImage !== command.effectiveImage || !applied.running
        || applied.networkMode !== (proof.network ?? "default") || applied.health !== "healthy" || observedBindings(applied.hostBindings)?.join("|") !== desired.join("|")) {
        throw new DockerTransportPortExecutorError("restart-failed");
      }
      const parkedOriginal = await inspect(parkedName);
      if (!matchesOwned(parkedOriginal, parkedName) || parkedOriginal!.id !== original!.id) throw new DockerTransportPortExecutorError("target-unavailable");
      await this.run(buildDockerRemoveArgv(parkedName), signal, authority, true);
      parked = false;
      return this.receipt(command, applied.id, "updated", null);
    } catch (error) {
      const recovery = new AbortController(), recoveryTimer = setTimeout(() => recovery.abort(), 20_000);
      let recoveryFailed = false;
      try { await this.removeOwnedProbe(probeName, command, recovery.signal, authority); } catch { recoveryFailed = true; }
      try {
        if (parkAttempted && !parked) {
          const parkedOriginal = await inspect(parkedName, recovery.signal);
          if (matchesOwned(parkedOriginal, parkedName) && parkedOriginal!.id === original?.id) { parked = true; originalStopAttempted = false; }
        }
        if (parked) {
          const active = await inspect(activeName, recovery.signal);
          if (active) {
            const replacementOwned = active.id !== command.currentContainerId && active.owner === this.options.owner && active.projectId === route.projectId
              && active.deploymentId === route.deploymentId && active.candidateId === proof.candidateId && active.effectiveImage === command.effectiveImage
              && active.networkMode === (proof.network ?? "default") && observedBindings(active.hostBindings)?.join("|") === desired.join("|");
            if (!replacementOwned || (replacementId !== null && active.id !== replacementId)) {
              throw new DockerTransportPortExecutorError("restart-failed");
            }
            if (active.running) await this.run(buildDockerStopArgv(active.id), recovery.signal, authority, true);
            await this.run(buildDockerRemoveArgv(activeName), recovery.signal, authority, true);
          }
          await this.run(buildDockerRenameArgv(parkedName, activeName), recovery.signal, authority, true);
          parked = false;
          const restored = await inspect(activeName, recovery.signal);
          if (!matchesOwned(restored, activeName) || restored!.id !== original!.id) throw new DockerTransportPortExecutorError("restart-failed");
          if (wasRunning) {
            await this.run(buildDockerStartArgv(activeName), recovery.signal, authority, true);
            await this.waitHealthy(activeName, recovery.signal, authority);
          }
        } else if ((originalStopped || originalStopAttempted) && wasRunning) {
          const stopped = await inspect(activeName, recovery.signal);
          if (!matchesOwned(stopped, activeName) || stopped!.id !== original!.id) throw new DockerTransportPortExecutorError("restart-failed");
          if (!stopped!.running) await this.run(buildDockerStartArgv(activeName), recovery.signal, authority, true);
          await this.waitHealthy(activeName, recovery.signal, authority);
          originalStopped = false;
        }
      } catch { recoveryFailed = true; }
      clearTimeout(recoveryTimer);
      if (recoveryFailed) throw new DockerTransportPortExecutorError("restart-failed");
      if (error instanceof DockerTransportPortExecutorError) return failed(error.code === "authority" ? "docker-unavailable" : error.code);
      if (signal.aborted) return failed("canceled");
      return failed("docker-unavailable");
    }
  }

  private receipt(command: TransportPortApplyAgentCommandV1, containerId: string, state: "updated" | "unchanged", failureReason: null): TransportPortApplyReceiptV1 {
    return transportPortApplyReceiptSchema.parse({ schemaVersion: 1, action: "transport.port.apply", agentId: this.options.agentId,
      commandId: command.commandId, projectId: command.projectId, protocol: command.route.protocol, publishedPort: command.route.publishedPort,
      targetPort: command.route.targetPort, deploymentId: command.route.deploymentId, inputDigest: command.inputDigest,
      operation: command.operation, rollbackRevisionId: command.rollbackRevisionId,
      correlationId: command.context.correlationId, containerId, state, observedAt: Math.max(0, (this.options.now ?? Date.now)()), failureReason, redacted: true });
  }

  private async removeOwnedProbe(name: string, command: TransportPortApplyAgentCommandV1, signal: AbortSignal, authority: RuntimeExecutionAuthority): Promise<void> {
    const result = await this.run(buildDockerTransportPortInspectArgv(name), signal, authority, false);
    if (result.exitCode !== 0) return;
    const value = safeState(JSON.parse(result.stdout));
    if (!value || value.name !== `/${name}` || value.owner !== this.options.owner || value.projectId !== command.projectId
      || value.deploymentId !== command.route.deploymentId || value.candidateId !== command.executionReceipt.candidateId
      || value.effectiveImage !== command.effectiveImage || value.networkMode !== (command.executionReceipt.network ?? "default")) return;
    await this.run(buildDockerRemoveArgv(name), signal, authority, true);
  }

  private async waitHealthy(name: string, signal: AbortSignal, authority: RuntimeExecutionAuthority): Promise<void> {
    const until = (this.options.now ?? Date.now)() + 25_000;
    while (!signal.aborted && (this.options.now ?? Date.now)() < until) {
      try {
        const result = await awaitAbortable(() => this.options.runner.run(["docker", "inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", name], signal), signal);
        if (result.exitCode === 0 && result.stdout.trim() === "healthy") return;
      } catch { if (signal.aborted) throw new DockerTransportPortExecutorError("canceled"); }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(done, 100);
        const cancel = () => { clearTimeout(timer); signal.removeEventListener("abort", cancel); reject(new DockerTransportPortExecutorError("canceled")); };
        function done() { signal.removeEventListener("abort", cancel); resolve(); }
        signal.addEventListener("abort", cancel, { once: true });
      });
    }
    throw new DockerTransportPortExecutorError(signal.aborted ? "canceled" : "restart-failed");
  }

  private async run(argv: readonly string[], signal: AbortSignal, authority: RuntimeExecutionAuthority, mutate: boolean): Promise<DockerProcessExit> {
    if (signal.aborted) throw new DockerTransportPortExecutorError("canceled");
    if (mutate) await awaitAbortable(() => authority.assertValid(), signal);
    let result: DockerProcessExit;
    try { result = await awaitAbortable(() => this.options.runner.run(argv, signal), signal); }
    catch { throw new DockerTransportPortExecutorError(signal.aborted ? "canceled" : mutate ? "restart-failed" : "docker-unavailable"); }
    if (signal.aborted) throw new DockerTransportPortExecutorError("canceled");
    if (mutate && result.exitCode !== 0) {
      if (argv[1] === "run" && /port is already allocated|address already in use/i.test(result.stderr)) throw new DockerTransportPortExecutorError("port-conflict");
      throw new DockerTransportPortExecutorError("restart-failed");
    }
    return result;
  }
}
