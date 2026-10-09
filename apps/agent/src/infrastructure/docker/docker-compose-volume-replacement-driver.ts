import { createHash } from "node:crypto";
import { COMPOSE_REPLACEMENT_CANDIDATE_INSPECT_FORMAT, COMPOSE_REPLACEMENT_HEALTHCHECK_FORMAT,
  COMPOSE_REPLACEMENT_HEALTH_FORMAT, COMPOSE_REPLACEMENT_NETWORK_FORMAT } from "./docker-compose-resource-argv.js";
import type { DockerCliRunner } from "./docker-cli-image-transport.js";
import type { ComposeVolumeAttachmentAgentCommandV1, ComposePreviewV1 } from "@deploylite/contracts";
import type { ComposeVolumeReplacementCandidateV1, ComposeVolumeReplacementDriver } from "./docker-compose-volume-attachment.js";

type Options = Readonly<{ runner: DockerCliRunner; owner: string; now?: () => number; sleep?: (ms: number, signal: AbortSignal) => Promise<void> }>;
function fail(): never { throw new Error("Compose volume replacement Docker operation failed"); }
function parse(text: string): unknown { try { return JSON.parse(text); } catch { return fail(); } }
function candidateName(commandId: string): string { return `dl-${createHash("sha256").update(commandId).digest("hex").slice(0, 32)}-vol-candidate`; }

export function createDockerComposeVolumeReplacementDriver(supplied: Options): ComposeVolumeReplacementDriver {
  const options = { ...supplied };
  const run = async (argv: readonly string[], signal: AbortSignal, environment?: Readonly<Record<string, string>>) => {
    try {
      const result = await options.runner.run(argv, signal, environment);
      if (result.exitCode !== 0 || result.signal !== null) return fail();
      return result.stdout.trim();
    } catch { return fail(); }
  };
  const inspectCandidate = async (containerId: string, signal: AbortSignal): Promise<ComposeVolumeReplacementCandidateV1 & { name: string }> => {
    if (!/^[a-f0-9]{64}$/.test(containerId)) return fail();
    const result = parse(await run(["docker", "container", "inspect", "--format", COMPOSE_REPLACEMENT_CANDIDATE_INSPECT_FORMAT, containerId], signal)) as Record<string, unknown>;
    if (typeof result.id !== "string" || typeof result.name !== "string" || typeof result.owner !== "string" || typeof result.projectId !== "string"
      || typeof result.service !== "string" || typeof result.commandId !== "string" || typeof result.revisionId !== "string"
      || typeof result.configDigest !== "string" || typeof result.environmentDigest !== "string" || typeof result.image !== "string" || typeof result.running !== "boolean"
      || !Array.isArray(result.networks) || !Array.isArray(result.mounts)) return fail();
    const mounts = result.mounts.map((value) => {
      const item = value as Record<string, unknown>;
      if (typeof item.source !== "string" || typeof item.target !== "string" || typeof item.readOnly !== "boolean") return fail();
      return { source: item.source, target: item.target, readOnly: item.readOnly };
    });
    if (result.networks.some(value => typeof value !== "string")) return fail();
    return { containerId: result.id, name: result.name.replace(/^\//, ""), owner: result.owner, projectId: result.projectId, service: result.service,
      commandId: result.commandId, revisionId: result.revisionId, configDigest: result.configDigest, environmentDigest: result.environmentDigest,
      image: result.image, running: result.running, networks: result.networks as string[], mounts };
  };
  const networkState = async (containerId: string, signal: AbortSignal): Promise<Array<{ name: string; aliases: string[] }>> => {
    const value = parse(await run(["docker", "container", "inspect", "--format", COMPOSE_REPLACEMENT_NETWORK_FORMAT, containerId], signal)) as { networks?: unknown };
    if (!Array.isArray(value.networks)) return fail();
    return value.networks.map((raw) => {
      const item = raw as Record<string, unknown>;
      const aliases = item.aliases === null || item.aliases === undefined ? [] : item.aliases;
      if (typeof item.name !== "string" || !Array.isArray(aliases) || aliases.some(alias => typeof alias !== "string")) return fail();
      return { name: item.name, aliases: aliases as string[] };
    });
  };
  const networkAttached = async (containerId: string, network: string, signal: AbortSignal) => (await networkState(containerId, signal)).find(value => value.name === network) ?? null;
  const ensureNetwork = async (containerId: string, network: string, service: string, signal: AbortSignal) => {
    const attached = await networkAttached(containerId, network, signal);
    if (attached?.aliases.includes(service)) return;
    if (attached) await run(["docker", "network", "disconnect", network, containerId], signal);
    await run(["docker", "network", "connect", "--alias", service, network, containerId], signal);
  };
  const disconnectIfAttached = async (containerId: string, network: string, signal: AbortSignal) => {
    if (await networkAttached(containerId, network, signal)) await run(["docker", "network", "disconnect", network, containerId], signal);
  };
  return {
    async inspectContainer(containerId, signal) {
      if (!/^[a-f0-9]{64}$/.test(containerId)) return fail();
      const fields = (await run(["docker", "container", "inspect", "--format", COMPOSE_REPLACEMENT_HEALTHCHECK_FORMAT, containerId], signal)).split("|");
      if (fields.length !== 2 || !["yes", "no"].includes(fields[0]!) || !["healthy", "unhealthy", "starting", "none"].includes(fields[1]!)) return fail();
      const changes = await run(["docker", "container", "diff", containerId], signal);
      return { healthcheck: fields[0] === "yes", health: fields[1] === "none" ? null : fields[1]!, writableLayerClean: changes.length === 0 };
    },
    async findCandidate(name, signal) {
      if (!/^dl-[a-f0-9]{32}-vol-candidate$/.test(name)) return fail();
      const idsText = await run(["docker", "container", "ls", "--all", "--no-trunc", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"], signal);
      if (!idsText) return null;
      const ids = idsText.split(/\r?\n/).filter(Boolean);
      if (ids.length !== 1 || !/^[a-f0-9]{64}$/.test(ids[0]!)) return fail();
      const candidate = await inspectCandidate(ids[0]!, signal);
      // Treat a broad Docker name-filter hit as no candidate. We never adopt or remove
      // it; Docker will still reject creation if the exact deterministic name is occupied.
      if (candidate.name !== name) return null;
      const { name: _name, ...result } = candidate;
      return result;
    },
    async createCandidate(input, signal) {
      const { command, preview } = input;
      const service = preview.services.find(value => value.name === command.service);
      const networkName = service && preview.networks.find(value => value.key === service.networks[0])?.runtimeName;
      if (!service || !networkName || service.networks.length !== 1 || service.volumes.length > 1 || input.name !== candidateName(command.commandId)
        || !/^[A-Za-z0-9_-]{1,200}$/.test(command.projectId) || !/^[a-f0-9]{64}$/.test(command.secretDigest)) return fail();
      const args = ["docker", "run", "--detach", "--name", input.name,
        "--label", `com.deploylite.owner=${options.owner}`, "--label", `com.deploylite.project=${command.projectId}`,
        "--label", "com.deploylite.compose.managed=v1", "--label", `com.deploylite.compose.service=${command.service}`,
        "--label", `com.deploylite.compose.command=${command.commandId}`, "--label", `com.deploylite.compose.revision=${command.revisionId}`,
        "--label", `com.deploylite.compose.config-digest=${command.configDigest}`, "--label", `com.deploylite.compose.environment-digest=${command.secretDigest}`,
        "--cpus=0.5", "--memory=67108864", "--pids-limit=64", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
        "--restart", "no", "--network", networkName];
      for (const mount of service.volumes) args.push("--mount", `type=volume,source=${preview.volumes.find(value => value.key === mount.source)!.runtimeName},target=${mount.target}${mount.readOnly ? ",readonly" : ""}`);
      for (const name of Object.keys(input.environment).sort()) {
        if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(name)) return fail();
        args.push("--env", name);
      }
      args.push(service.image);
      const result = await options.runner.run(args, signal, input.environment);
      const containerId = result.stdout.trim();
      if (result.exitCode !== 0 || result.signal !== null || !/^[a-f0-9]{64}$/.test(containerId)) return fail();
      return containerId;
    },
    async waitUntilHealthy(containerId, timeoutMs, signal) {
      const start = (options.now ?? Date.now)(), deadline = start + timeoutMs;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(deadline) || timeoutMs < 1 || timeoutMs > 60_000) return fail();
      do {
        if (signal.aborted) throw signal.reason;
        const status = await run(["docker", "container", "inspect", "--format", COMPOSE_REPLACEMENT_HEALTH_FORMAT, containerId], signal);
        if (status === "healthy") return true;
        if (status === "unhealthy" || status === "none") return false;
        const remaining = deadline - (options.now ?? Date.now)();
        if (remaining <= 0) return false;
        await (options.sleep ?? ((ms, abort) => new Promise<void>((resolve, reject) => {
          const cancel = () => { clearTimeout(timer); abort.removeEventListener("abort", cancel); reject(abort.reason); };
          const timer = setTimeout(() => { abort.removeEventListener("abort", cancel); resolve(); }, ms);
          abort.addEventListener("abort", cancel, { once: true });
          if (abort.aborted) cancel();
        })))(Math.min(250, remaining), signal);
      } while ((options.now ?? Date.now)() < deadline);
      return false;
    },
    async cutover(input, signal) {
      if (!/^[a-f0-9]{64}$/.test(input.priorContainerId) || !/^[a-f0-9]{64}$/.test(input.candidateContainerId)) return fail();
      await disconnectIfAttached(input.priorContainerId, input.networkName, signal);
      await disconnectIfAttached(input.candidateContainerId, input.networkName, signal);
      await ensureNetwork(input.candidateContainerId, input.networkName, input.service, signal);
      const status = await run(["docker", "container", "inspect", "--format", "{{.State.Status}}", input.priorContainerId], signal);
      if (status === "running") await run(["docker", "container", "stop", "--time", "10", input.priorContainerId], signal);
    },
    async restorePrior(input, signal) {
      await disconnectIfAttached(input.candidateContainerId, input.networkName, signal);
      await ensureNetwork(input.priorContainerId, input.networkName, input.service, signal);
      const status = await run(["docker", "container", "inspect", "--format", "{{.State.Status}}", input.priorContainerId], signal);
      if (status !== "running") await run(["docker", "container", "start", input.priorContainerId], signal);
    },
    async removeCandidate(containerId, commandId, signal) {
      const candidate = await inspectCandidate(containerId, signal);
      if (candidate.owner !== options.owner || candidate.commandId !== commandId || candidate.name !== candidateName(commandId)) return fail();
      await run(["docker", "container", "rm", "--force", containerId], signal);
    }
  };
}
