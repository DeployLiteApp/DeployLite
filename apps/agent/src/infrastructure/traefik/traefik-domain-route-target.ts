import {
  domainRouteIntentSchema,
  trustedPriorExecutionReceiptSchema
} from "@deploylite/contracts";
import {
  domainRouteNetworkName,
  renderDomainRouteDynamicConfig,
  type DomainRouteDynamicConfig
} from "@deploylite/domain";
import { z } from "zod";
import { type DockerCliRunner } from "../docker/docker-cli-image-transport.js";
import { buildDockerActiveIdentityInspectArgv, buildDockerImageIdentityInspectArgv } from "./traefik-domain-route-argv.js";

export type DomainRouteTargetInspection = Readonly<{
  projectId: string;
  deploymentId: string;
  agentId: string;
  networkName: string;
  container: string;
  containerId: string;
  containerPort: number;
  health: "healthy";
  observedAt: number;
  dynamicConfig: DomainRouteDynamicConfig;
}>;

export class DomainRouteTargetInspectionError extends Error {
  constructor(readonly code: "target-unavailable" | "canceled") {
    super("Domain route target is unavailable.");
    this.name = "DomainRouteTargetInspectionError";
  }
}

/**
 * Rechecks the live Docker object against its trusted receipt immediately
 * before route application. The CLI adapter emits only selected identity,
 * health, port and network fields; it never dumps container environment.
 */
export async function inspectDomainRouteTarget(input: Readonly<{
  route: unknown;
  receipt: unknown;
  agentId: string;
  effectiveImage: string;
  runner: DockerCliRunner;
  requireRouteNetwork?: boolean;
  signal?: AbortSignal;
  now?: () => number;
}>): Promise<DomainRouteTargetInspection> {
  const route = domainRouteIntentSchema.safeParse(input.route);
  const receipt = trustedPriorExecutionReceiptSchema.safeParse(input.receipt);
  if (!route.success || !receipt.success || typeof input.route !== "object" || input.route === null
    || !("domain" in input.route) || (input.route as { domain?: unknown }).domain !== route.data.domain
    || receipt.data.effectiveImageDigest !== input.effectiveImage.split("@")[1]) {
    throw new DomainRouteTargetInspectionError("target-unavailable");
  }

  let dynamicConfig: DomainRouteDynamicConfig;
  try {
    dynamicConfig = renderDomainRouteDynamicConfig({ route: route.data, receipt: receipt.data, agentId: input.agentId });
  } catch {
    console.log("debug render failed");
    throw new DomainRouteTargetInspectionError("target-unavailable");
  }

  const networkName = domainRouteNetworkName(route.data.projectId);
  try {
    const signal = input.signal ?? new AbortController().signal;
    const candidate = { candidateId: receipt.data.candidateId, projectId: route.data.projectId, deploymentId: route.data.deploymentId,
      effectiveImage: input.effectiveImage, runtimePort: receipt.data.containerPort, networkName };
    const activeArgv = buildDockerActiveIdentityInspectArgv({ owner: "deploylite-agent", hostPort: receipt.data.hostPort,
      containerPort: receipt.data.containerPort, allowedNetworks: [networkName], networkName, candidate, projectId: route.data.projectId,
      containerName: `deploylite-active-${route.data.deploymentId}` });
    const [activeResult, imageResult] = await Promise.all([
      input.runner.run(activeArgv, signal),
      input.runner.run(buildDockerImageIdentityInspectArgv(input.effectiveImage), signal)
    ]);
    if (signal.aborted || activeResult.exitCode !== 0 || imageResult.exitCode !== 0 || activeResult.signal !== null || imageResult.signal !== null) throw new Error("target inspect failed");
    const hostBindingSchema = z.record(z.array(z.object({ HostIp: z.string(), HostPort: z.string() }).passthrough()));
    const identitySchema = z.object({
      id: z.string().regex(/^[a-f0-9]{64}$/), name: z.string(), imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      owner: z.string(), projectId: z.string(), deploymentId: z.string(), candidateId: z.string(), effectiveImage: z.string(),
      running: z.boolean(), health: z.string().nullable(), hostBindings: hostBindingSchema, portBindings: hostBindingSchema,
      networkMode: z.string(), networks: z.record(z.object({ networkId: z.string(), endpointId: z.string() }).passthrough())
    }).passthrough();
    const live = identitySchema.parse(JSON.parse(activeResult.stdout));
    const imageId = z.string().regex(/^sha256:[a-f0-9]{64}$/).parse(JSON.parse(imageResult.stdout));
    const portKey = `${receipt.data.containerPort}/tcp`;
    const hostPortBindings = live.hostBindings[portKey] ?? [];
    const containerPortBindings = live.portBindings[portKey] ?? [];
    const networkNames = Object.keys(live.networks);
    const permittedNetworks = new Set([networkName, receipt.data.network ?? "bridge"]);
    const hasRouteNetwork = networkNames.includes(networkName);
    if (live.name !== `/deploylite-active-${route.data.deploymentId}` || live.id !== receipt.data.containerId
      || live.owner !== "deploylite-agent" || live.projectId !== route.data.projectId || live.deploymentId !== route.data.deploymentId
      || live.candidateId !== receipt.data.candidateId || live.effectiveImage !== input.effectiveImage || live.imageId !== imageId
      || live.running !== true || live.health !== "healthy" || (receipt.data.network === null ? !["default", "bridge"].includes(live.networkMode) : live.networkMode !== receipt.data.network)
      || networkNames.some(name => !permittedNetworks.has(name)) || (input.requireRouteNetwork !== false && !hasRouteNetwork)
      || networkNames.length < 1 || (input.requireRouteNetwork === false && networkNames.length === 0)
      || hostPortBindings.length !== 1 || hostPortBindings[0]?.HostIp !== "127.0.0.1" || hostPortBindings[0]?.HostPort !== String(receipt.data.hostPort)
      || containerPortBindings.length !== 1 || containerPortBindings[0]?.HostPort !== String(receipt.data.hostPort)) {
      throw new Error("target identity mismatch");
    }
    const observedAt = (input.now ?? Date.now)();
    if (!Number.isSafeInteger(observedAt) || observedAt < 0) throw new Error("inspection clock invalid");
    return Object.freeze({
      projectId: route.data.projectId,
      deploymentId: route.data.deploymentId,
      agentId: input.agentId,
      networkName,
      container: live.name.slice(1),
      containerId: live.id,
      containerPort: receipt.data.containerPort,
      health: "healthy",
      observedAt,
      dynamicConfig
    });
  } catch {
    if (input.signal?.aborted) throw new DomainRouteTargetInspectionError("canceled");
    throw new DomainRouteTargetInspectionError("target-unavailable");
  }
}
