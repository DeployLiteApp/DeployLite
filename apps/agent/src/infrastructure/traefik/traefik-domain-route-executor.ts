import { DOMAIN_ROUTE_APPLY_CAPABILITY, domainRouteApplyAgentCommandSchema, domainRouteApplyReceiptSchema, protocolPayloadFingerprint,
  type DomainRouteApplyAgentCommandV1, type DomainRouteApplyReceiptV1 } from "@deploylite/contracts";
import { domainRouteNetworkName } from "@deploylite/domain";
import { z } from "zod";
import { DockerProcessError } from "../docker/docker-process-runner.js";
import type { DockerCliRunner } from "../docker/docker-cli-image-transport.js";
import { inspectDomainRouteTarget, DomainRouteTargetInspectionError } from "./traefik-domain-route-target.js";
import { TraefikDomainRouteFileStore, TraefikDomainRouteFileStoreError } from "./traefik-domain-route-file-store.js";
import { buildDomainRouteNetworkConnectArgv, buildDomainRouteNetworkCreateArgv, buildDomainRouteNetworkInspectArgv,
  buildDomainRouteTraefikInspectArgv, buildDomainRouteTraefikLookupArgv, buildDomainRouteContainerInspectArgv } from "./traefik-domain-route-argv.js";
import type { RuntimeExecutionAuthority } from "../../agent-transport.js";

export type DomainRouteAgentExecutor = Readonly<{
  execute(command: DomainRouteApplyAgentCommandV1, authority: RuntimeExecutionAuthority, signal: AbortSignal): Promise<DomainRouteApplyReceiptV1>;
}>;

export type TraefikDomainRouteExecutorOptions = Readonly<{
  runner: DockerCliRunner;
  fileStore: TraefikDomainRouteFileStore;
  agentId: string;
  now?: () => number;
}>;

export class TraefikDomainRouteExecutorError extends Error {
  constructor(readonly code: "authority-invalid" | "target-unavailable" | "network-conflict" | "traefik-unavailable" | "config-write-failed" | "canceled") {
    super("Traefik domain route apply failed safely.");
    this.name = "TraefikDomainRouteExecutorError";
  }
}

type NetworkView = Readonly<{
  id: string; name: string; driver: string; internal: boolean; owner: string | null; project: string | null; kind: string | null;
  containers: Readonly<Record<string, { Name: string }>>;
}>;
type TraefikView = Readonly<{ id: string; name: string; project: string; service: string; image: string; state: string }>;
type ContainerView = Readonly<{ id: string; name: string; owner: string | null; project: string | null; deployment: string | null; state: string }>;

const objectId = z.string().regex(/^[a-f0-9]{64}$/);
const networkViewSchema = z.object({ id: objectId, name: z.string(), driver: z.string(), internal: z.boolean(), owner: z.string().nullable(),
  project: z.string().nullable(), kind: z.string().nullable(), containers: z.record(z.object({ Name: z.string() }).passthrough()).nullable() }).strict();
const traefikViewSchema = z.object({ id: objectId, name: z.string(), project: z.string(), service: z.string(), image: z.string(), state: z.string() }).strict();
const containerViewSchema = z.object({ id: objectId, name: z.string(), owner: z.string().nullable(), project: z.string().nullable(), deployment: z.string().nullable(), state: z.string() }).strict();
const traefikImage = "traefik:v3.6.7@sha256:a9890c898f379c1905ee5b28342f6b408dc863f08db2dab20e46c267d1ff463a";

function normalizeNetwork(raw: unknown): NetworkView {
  const parsed = networkViewSchema.parse(raw);
  return Object.freeze({ ...parsed, containers: parsed.containers ?? {} });
}

function missingNetwork(error: unknown): boolean {
  if (!(error instanceof DockerProcessError) || error.kind !== "failed" || error.result?.exitCode !== 1 || error.result.signal !== null) return false;
  return /(?:No such network:|network [^\n]+ not found)/i.test(error.result.stderr.trim());
}

async function commandOutput(runner: DockerCliRunner, argv: readonly string[], signal: AbortSignal): Promise<string> {
  const result = await runner.run(argv, signal);
  if (signal.aborted || result.exitCode !== 0 || result.signal !== null) throw new Error("Docker route command failed");
  return result.stdout.trim();
}

function isTargetName(name: string, projectId: string): boolean {
  const normalized = name.startsWith("/") ? name.slice(1) : name;
  if (!normalized.startsWith("deploylite-active-")) return false;
  const deploymentId = normalized.slice("deploylite-active-".length);
  return /^[a-z0-9][a-z0-9_.-]{0,127}$/.test(deploymentId) && projectId.length > 0;
}

async function assertAuthority(authority: RuntimeExecutionAuthority): Promise<void> {
  try { await authority.assertValid(); } catch { throw new TraefikDomainRouteExecutorError("authority-invalid"); }
}

export function createTraefikDomainRouteExecutor(options: TraefikDomainRouteExecutorOptions): DomainRouteAgentExecutor {
  const now = options.now ?? Date.now;
  const observeNetwork = async (name: string, signal: AbortSignal): Promise<NetworkView | null> => {
    try { return normalizeNetwork(JSON.parse(await commandOutput(options.runner, buildDomainRouteNetworkInspectArgv(name), signal))); }
    catch (error) { if (missingNetwork(error)) return null; throw error; }
  };
  const inspectTraefik = async (signal: AbortSignal): Promise<TraefikView> => {
    const ids = (await commandOutput(options.runner, buildDomainRouteTraefikLookupArgv(), signal)).split("\n").filter(Boolean);
    if (ids.length !== 1 || !/^[a-f0-9]{64}$/.test(ids[0]!)) throw new TraefikDomainRouteExecutorError("traefik-unavailable");
    const view = traefikViewSchema.parse(JSON.parse(await commandOutput(options.runner, buildDomainRouteTraefikInspectArgv(ids[0]!), signal)));
    if (view.id !== ids[0] || !/^\/deploylite-traefik-[1-9][0-9]*$/.test(view.name) || view.project !== "deploylite"
      || view.service !== "traefik" || view.image !== traefikImage || view.state !== "running") throw new TraefikDomainRouteExecutorError("traefik-unavailable");
    return view;
  };
  const inspectProjectContainer = async (containerId: string, projectId: string, signal: AbortSignal): Promise<ContainerView> => {
    const view = containerViewSchema.parse(JSON.parse(await commandOutput(options.runner, buildDomainRouteContainerInspectArgv(containerId), signal)));
    if (view.id !== containerId || view.owner !== "deploylite-agent" || view.project !== projectId || !isTargetName(view.name, projectId)
      || view.deployment !== view.name.replace(/^\/?deploylite-active-/, "") || !["running", "exited", "created"].includes(view.state)) {
      throw new TraefikDomainRouteExecutorError("network-conflict");
    }
    return view;
  };
  const validateNetwork = async (network: NetworkView, name: string, projectId: string, targetId: string, targetName: string, traefikId: string, traefikName: string,
    signal: AbortSignal): Promise<void> => {
    if (network.name !== name || network.driver !== "bridge" || network.internal || network.owner !== "deploylite"
      || network.project !== projectId || network.kind !== "domain-route") throw new TraefikDomainRouteExecutorError("network-conflict");
    for (const [id, endpoint] of Object.entries(network.containers)) {
      if (!objectId.safeParse(id).success) throw new TraefikDomainRouteExecutorError("network-conflict");
      const endpointName = endpoint.Name.startsWith("/") ? endpoint.Name.slice(1) : endpoint.Name;
      if (id === targetId) {
        if (endpointName !== targetName) throw new TraefikDomainRouteExecutorError("network-conflict");
        continue;
      }
      if (id === traefikId) {
        if (endpointName !== traefikName.replace(/^\//, "")) throw new TraefikDomainRouteExecutorError("network-conflict");
        continue;
      }
      if (!endpointName.startsWith("deploylite-active-")) throw new TraefikDomainRouteExecutorError("network-conflict");
      const owner = await inspectProjectContainer(id, projectId, signal);
      if (owner.name !== endpoint.Name) throw new TraefikDomainRouteExecutorError("network-conflict");
    }
  };
  const ensureConnected = async (networkName: string, containerId: string, signal: AbortSignal, authority: RuntimeExecutionAuthority): Promise<void> => {
    let current = await observeNetwork(networkName, signal);
    if (!current) throw new TraefikDomainRouteExecutorError("network-conflict");
    if (Object.hasOwn(current.containers, containerId)) return;
    await assertAuthority(authority);
    try {
      await commandOutput(options.runner, buildDomainRouteNetworkConnectArgv(networkName, containerId), signal);
    } catch {
      if (signal.aborted) throw new TraefikDomainRouteExecutorError("canceled");
      current = await observeNetwork(networkName, signal);
      if (!current || !Object.hasOwn(current.containers, containerId)) throw new TraefikDomainRouteExecutorError("network-conflict");
    }
  };

  return Object.freeze({
    async execute(raw: DomainRouteApplyAgentCommandV1, authority: RuntimeExecutionAuthority, signal: AbortSignal): Promise<DomainRouteApplyReceiptV1> {
      const command = domainRouteApplyAgentCommandSchema.parse(structuredClone(raw));
      if (command.agentId !== options.agentId || command.requiredCapabilities[0] !== DOMAIN_ROUTE_APPLY_CAPABILITY
        || command.authority.commandId !== command.commandId || command.authority.inputDigest !== command.inputDigest
        || command.authority.projectId !== command.projectId || protocolPayloadFingerprint(command.lease) !== protocolPayloadFingerprint(command.authority.projectLease)) {
        throw new TraefikDomainRouteExecutorError("authority-invalid");
      }
      const observedAt = () => {
        const value = now();
        if (!Number.isSafeInteger(value) || value < 0) throw new TraefikDomainRouteExecutorError("target-unavailable");
        return value;
      };
      const networkName = domainRouteNetworkName(command.projectId);
      let networkId: string | null = null, targetContainerId: string | null = command.executionReceipt.containerId, traefikContainerId: string | null = null;
      let fileName: string | null = null, contentDigest: string | null = null;
      const fail = (failureReason: Exclude<DomainRouteApplyReceiptV1["failureReason"], null>): DomainRouteApplyReceiptV1 => domainRouteApplyReceiptSchema.parse({
        schemaVersion: 1, action: "domain.route.apply", agentId: command.agentId, commandId: command.commandId, projectId: command.projectId,
        domain: command.route.domain, deploymentId: command.route.deploymentId, inputDigest: command.inputDigest, correlationId: command.context.correlationId,
        networkName, networkId, targetContainerId, traefikContainerId, fileName, contentDigest, state: "failed", observedAt: observedAt(), failureReason, redacted: true
      });
      try {
        await assertAuthority(authority);
        if (signal.aborted) return fail("canceled");
        let target;
        try {
          target = await inspectDomainRouteTarget({ route: command.route, receipt: command.executionReceipt, agentId: command.agentId,
            effectiveImage: command.effectiveImage, runner: options.runner, requireRouteNetwork: false, signal, now });
        } catch (error) {
          if (error instanceof DomainRouteTargetInspectionError && error.code === "canceled") return fail("canceled");
          return fail("target-unavailable");
        }
        const traefik = await inspectTraefik(signal);
        traefikContainerId = traefik.id;
        let network = await observeNetwork(networkName, signal);
        if (!network) {
          await assertAuthority(authority);
          try { await commandOutput(options.runner, buildDomainRouteNetworkCreateArgv(networkName, command.projectId), signal); }
          catch {
            network = await observeNetwork(networkName, signal);
            if (!network) return fail(signal.aborted ? "canceled" : "network-conflict");
          }
          network = await observeNetwork(networkName, signal);
        }
        if (!network) return fail("network-conflict");
        networkId = network.id;
        const targetName = `deploylite-active-${command.route.deploymentId}`;
        await validateNetwork(network, networkName, command.projectId, target.containerId, targetName, traefik.id, traefik.name, signal);
        await ensureConnected(networkName, target.containerId, signal, authority);
        await ensureConnected(networkName, traefik.id, signal, authority);
        network = await observeNetwork(networkName, signal);
        if (!network) return fail("network-conflict");
        networkId = network.id;
        await validateNetwork(network, networkName, command.projectId, target.containerId, targetName, traefik.id, traefik.name, signal);
        const verifiedTarget = await inspectDomainRouteTarget({ route: command.route, receipt: command.executionReceipt, agentId: command.agentId,
          effectiveImage: command.effectiveImage, runner: options.runner, requireRouteNetwork: true, signal, now });
        await assertAuthority(authority);
        const applied = await options.fileStore.apply({ route: command.route, receipt: command.executionReceipt, agentId: command.agentId });
        fileName = applied.fileName;
        contentDigest = applied.contentDigest;
        return domainRouteApplyReceiptSchema.parse({ schemaVersion: 1, action: "domain.route.apply", agentId: command.agentId,
          commandId: command.commandId, projectId: command.projectId, domain: command.route.domain, deploymentId: command.route.deploymentId,
          inputDigest: command.inputDigest, correlationId: command.context.correlationId, networkName: verifiedTarget.networkName,
          networkId, targetContainerId: verifiedTarget.containerId, traefikContainerId, fileName, contentDigest,
          state: applied.state, observedAt: verifiedTarget.observedAt, failureReason: null, redacted: true });
      } catch (error) {
        if (signal.aborted) return fail("canceled");
        if (error instanceof TraefikDomainRouteExecutorError) {
          if (error.code === "authority-invalid") throw error;
          return fail(error.code);
        }
        if (error instanceof TraefikDomainRouteFileStoreError) return fail("config-write-failed");
        if (error instanceof DomainRouteTargetInspectionError) return fail(error.code === "canceled" ? "canceled" : "target-unavailable");
        return fail("network-conflict");
      }
    }
  });
}
