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

function matchesNetwork(actual: string, expected: string | null): boolean {
  return expected === null ? actual === "default" || actual === "bridge" : actual === expected;
}

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
    if (command.portTransfer) return this.executeTransfer(command, authority, signal);
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
      && matchesNetwork(value.networkMode, proof.network));
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
        || !matchesNetwork(applied.networkMode, proof.network) || applied.health !== "healthy" || observedBindings(applied.hostBindings)?.join("|") !== desired.join("|")) {
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

  /** Replaces both trusted same-agent deployments before committing a cross-deployment port handoff. */
  private async executeTransfer(command: TransportPortApplyAgentCommandV1, authority: RuntimeExecutionAuthority,
    signal: AbortSignal): Promise<TransportPortApplyReceiptV1> {
    const transfer = command.portTransfer!, targetProof = command.executionReceipt, sourceProof = transfer.sourceExecutionReceipt;
    const route = command.route, hostIp = this.options.hostIp ?? "0.0.0.0";
    const failed = (failureReason: NonNullable<TransportPortApplyReceiptV1["failureReason"]>) => transportPortApplyReceiptSchema.parse({
      schemaVersion: 1, action: "transport.port.apply", agentId: this.options.agentId, commandId: command.commandId, projectId: command.projectId,
      protocol: route.protocol, publishedPort: route.publishedPort, targetPort: route.targetPort, deploymentId: route.deploymentId,
      operation: command.operation, rollbackRevisionId: command.rollbackRevisionId, inputDigest: command.inputDigest,
      correlationId: command.context.correlationId, containerId: null, state: "failed", observedAt: Math.max(0, (this.options.now ?? Date.now)()),
      failureReason, redacted: true
    });
    if (sourceProof.deploymentId !== transfer.sourceDeploymentId || sourceProof.projectId !== command.projectId
      || sourceProof.runtimeHost !== this.options.agentId || sourceProof.container !== `deploylite-active-${transfer.sourceDeploymentId}`
      || sourceProof.effectiveImageDigest !== transfer.sourceEffectiveImage.split("@")[1]
      || sourceProof.network !== null && !this.options.allowedNetworks?.includes(sourceProof.network)
      || transfer.sourceContainerId === command.currentContainerId || transfer.sourceBindings.some(binding => binding.protocol === route.protocol && binding.publishedPort === route.publishedPort)
      || !transfer.sourcePreviousBindings.some(binding => binding.protocol === route.protocol && binding.publishedPort === route.publishedPort)) return failed("target-unavailable");
    const suffix = command.commandId.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 32);
    const targetActive = targetProof.container, sourceActive = sourceProof.container;
    const targetProbe = `deploylite-port-xfer-target-${suffix}`, sourceProbe = `deploylite-port-xfer-source-${suffix}`;
    const targetParked = `deploylite-port-prior-target-${suffix}`, sourceParked = `deploylite-port-prior-source-${suffix}`;
    type Service = { deploymentId: string; active: string; parked: string; probe: string; containerId: string; candidateId: string;
      effectiveImage: string; network: string | null; hostPort: number; containerPort: number; before: readonly TransportPortBindingV1[];
      after: readonly TransportPortBindingV1[]; original: z.infer<typeof inspectSchema> | null; wasRunning: boolean; stopAttempted: boolean;
      parkedState: boolean; parkAttempted: boolean; replacementId?: string };
    const target: Service = { deploymentId: route.deploymentId, active: targetActive, parked: targetParked, probe: targetProbe,
      containerId: command.currentContainerId, candidateId: targetProof.candidateId, effectiveImage: command.effectiveImage, network: targetProof.network,
      hostPort: targetProof.hostPort, containerPort: targetProof.containerPort, before: command.previousBindings, after: command.bindings,
      original: null, wasRunning: false, stopAttempted: false, parkedState: false, parkAttempted: false };
    const source: Service = { deploymentId: transfer.sourceDeploymentId, active: sourceActive, parked: sourceParked, probe: sourceProbe,
      containerId: transfer.sourceContainerId, candidateId: sourceProof.candidateId, effectiveImage: transfer.sourceEffectiveImage, network: sourceProof.network,
      hostPort: sourceProof.hostPort, containerPort: sourceProof.containerPort, before: transfer.sourcePreviousBindings, after: transfer.sourceBindings,
      original: null, wasRunning: false, stopAttempted: false, parkedState: false, parkAttempted: false };
    const services = [target, source];
    const desired = (service: Service) => expectedBindings(service.hostPort, service.containerPort, service.after, hostIp);
    const previous = (service: Service) => expectedBindings(service.hostPort, service.containerPort, service.before, hostIp);
    const matches = (value: z.infer<typeof inspectSchema> | null, service: Service, name = service.active) => Boolean(value
      && value.name === `/${name}` && value.id === service.containerId && value.owner === this.options.owner && value.projectId === command.projectId
      && value.deploymentId === service.deploymentId && value.candidateId === service.candidateId && value.effectiveImage === service.effectiveImage
      && matchesNetwork(value.networkMode, service.network));
    const inspect = async (name: string, inspectSignal: AbortSignal = signal): Promise<z.infer<typeof inspectSchema> | null> => {
      try {
        const result = await this.run(buildDockerTransportPortInspectArgv(name), inspectSignal, authority, false);
        return result.exitCode === 0 ? safeState(JSON.parse(result.stdout)) : null;
      } catch { if (inspectSignal.aborted) throw new DockerTransportPortExecutorError("canceled"); return null; }
    };
    const candidate = (service: Service) => ({ candidateId: service.candidateId, projectId: command.projectId, deploymentId: service.deploymentId,
      effectiveImage: service.effectiveImage, runtimePort: service.containerPort, ...(service.network ? { networkName: service.network } : {}) });
    const runInput = (service: Service, containerName: string, temporary: boolean) => ({ candidate: candidate(service), projectId: command.projectId,
      containerName, hostPort: service.hostPort, containerPort: service.containerPort, owner: this.options.owner,
      allowedNetworks: this.options.allowedNetworks ?? [], ...(service.network ? { networkName: service.network } : {}),
      bindings: service.after, hostIp, temporary });
    const removeProbe = async (service: Service, cleanupSignal: AbortSignal) => {
      const value = await inspect(service.probe, cleanupSignal);
      if (!value) return;
      const expected = { ...service, containerId: value.id };
      if (!matches(value, expected, service.probe) || observedBindings(value.hostBindings) === null) return;
      await this.run(buildDockerRemoveArgv(service.probe), cleanupSignal, authority, true);
    };
    let replacementTargetId: string | null = null, replacementSourceId: string | null = null;
    try {
      if (signal.aborted) return failed("canceled");
      await awaitAbortable(() => authority.assertValid(), signal);
      for (const service of services) {
        service.original = await inspect(service.active);
        if (!matches(service.original, service) || !service.original) return failed("target-unavailable");
        const actual = observedBindings(service.original.hostBindings);
        if (!actual || actual.join("|") !== previous(service).join("|") || !service.original.running || service.original.health !== "healthy") {
          return failed("target-unavailable");
        }
        service.wasRunning = service.original.running;
      }
      for (const service of services) {
        await this.run(buildDockerTransportPortRunArgv(runInput(service, service.probe, true)), signal, authority, true);
        await this.waitHealthy(service.probe, signal, authority);
      }
      for (const service of services) {
        const unchanged = await inspect(service.active);
        if (!matches(unchanged, service) || !unchanged || observedBindings(unchanged.hostBindings)?.join("|") !== previous(service).join("|")) {
          throw new DockerTransportPortExecutorError("target-unavailable");
        }
      }
      const probeCleanup = new AbortController();
      for (const service of services) await removeProbe(service, probeCleanup.signal);
      for (const service of services) {
        service.stopAttempted = true;
        await this.run(buildDockerStopArgv(service.containerId), signal, authority, true);
      }
      for (const service of services) {
        service.parkAttempted = true;
        await this.run(buildDockerRenameArgv(service.active, service.parked), signal, authority, true);
        service.parkedState = true;
        service.parkAttempted = false;
      }
      const targetCreated = await this.run(buildDockerTransportPortRunArgv(runInput(target, target.active, false)), signal, authority, true);
      replacementTargetId = targetCreated.stdout.trim(); target.replacementId = replacementTargetId;
      if (!/^[a-f0-9]{64}$/.test(replacementTargetId)) throw new DockerTransportPortExecutorError("restart-failed");
      const sourceCreated = await this.run(buildDockerTransportPortRunArgv(runInput(source, source.active, false)), signal, authority, true);
      replacementSourceId = sourceCreated.stdout.trim(); source.replacementId = replacementSourceId;
      if (!/^[a-f0-9]{64}$/.test(replacementSourceId)) throw new DockerTransportPortExecutorError("restart-failed");
      for (const service of services) {
        await this.waitHealthy(service.active, signal, authority);
        const applied = await inspect(service.active);
        if (!applied || applied.id !== service.replacementId || applied.owner !== this.options.owner || applied.projectId !== command.projectId
          || applied.deploymentId !== service.deploymentId || applied.candidateId !== service.candidateId || applied.effectiveImage !== service.effectiveImage
          || !applied.running || !matchesNetwork(applied.networkMode, service.network) || applied.health !== "healthy"
          || observedBindings(applied.hostBindings)?.join("|") !== desired(service).join("|")) throw new DockerTransportPortExecutorError("restart-failed");
      }
      const retainedPriorContainerIds: string[] = [];
      for (const service of services) {
        const parkedOriginal = await inspect(service.parked);
        if (!matches(parkedOriginal, service, service.parked) || parkedOriginal!.id !== service.containerId) throw new DockerTransportPortExecutorError("target-unavailable");
      }
      for (const service of services) {
        try {
          await this.run(buildDockerRemoveArgv(service.parked), signal, authority, true);
          service.parkedState = false;
        } catch {
          const retained = await inspect(service.parked);
          if (matches(retained, service, service.parked) && retained!.id === service.containerId) retainedPriorContainerIds.push(retained!.id);
        }
      }
      return transportPortApplyReceiptSchema.parse({ schemaVersion: 1, action: "transport.port.apply", agentId: this.options.agentId,
        commandId: command.commandId, projectId: command.projectId, protocol: route.protocol, publishedPort: route.publishedPort,
        targetPort: route.targetPort, deploymentId: route.deploymentId, operation: command.operation, rollbackRevisionId: command.rollbackRevisionId,
        inputDigest: command.inputDigest, correlationId: command.context.correlationId, containerId: replacementTargetId, state: "updated",
        observedAt: Math.max(0, (this.options.now ?? Date.now)()), failureReason: null, redacted: true,
        portTransfer: { sourceDeploymentId: source.deploymentId, sourceContainerId: replacementSourceId!, retainedPriorContainerIds } });
    } catch (error) {
      const recovery = new AbortController(), recoveryTimer = setTimeout(() => recovery.abort(), 20_000);
      let recoveryFailed = false;
      for (const service of services) {
        try { await removeProbe(service, recovery.signal); } catch { recoveryFailed = true; }
      }
      for (const service of [...services].reverse()) {
        try {
          if (service.parkAttempted && !service.parkedState) {
            const parked = await inspect(service.parked, recovery.signal);
            if (matches(parked, service, service.parked) && parked!.id === service.containerId) service.parkedState = true;
          }
          if (service.parkedState) {
            const active = await inspect(service.active, recovery.signal);
            if (active) {
              const ownedReplacement = active.id !== service.containerId && active.owner === this.options.owner && active.projectId === command.projectId
                && active.deploymentId === service.deploymentId && active.candidateId === service.candidateId && active.effectiveImage === service.effectiveImage
                && matchesNetwork(active.networkMode, service.network) && observedBindings(active.hostBindings)?.join("|") === desired(service).join("|");
              if (!ownedReplacement || service.replacementId !== undefined && active.id !== service.replacementId) throw new DockerTransportPortExecutorError("restart-failed");
              if (active.running) await this.run(buildDockerStopArgv(active.id), recovery.signal, authority, true);
              await this.run(buildDockerRemoveArgv(service.active), recovery.signal, authority, true);
            }
            await this.run(buildDockerRenameArgv(service.parked, service.active), recovery.signal, authority, true);
            service.parkedState = false;
          }
        } catch { recoveryFailed = true; }
      }
      // Release both replacement binding sets before starting either original.
      for (const service of [...services].reverse()) {
        try {
          if (service.stopAttempted && service.wasRunning) {
            const restored = await inspect(service.active, recovery.signal);
            if (!matches(restored, service) || !restored) throw new DockerTransportPortExecutorError("restart-failed");
            if (!restored.running) await this.run(buildDockerStartArgv(service.active), recovery.signal, authority, true);
            await this.waitHealthy(service.active, recovery.signal, authority);
            const verified = await inspect(service.active, recovery.signal);
            if (!matches(verified, service) || !verified?.running || verified.health !== "healthy"
              || observedBindings(verified.hostBindings)?.join("|") !== previous(service).join("|")) throw new DockerTransportPortExecutorError("restart-failed");
          }
        } catch { recoveryFailed = true; }
      }
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
