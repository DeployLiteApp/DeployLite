import {
  domainRouteIntentSchema,
  trustedPriorExecutionReceiptSchema
} from "@deploylite/contracts";
import {
  domainRouteNetworkName,
  renderDomainRouteDynamicConfig,
  type DomainRouteDynamicConfig
} from "@deploylite/domain";
import { DockerCliImageTransport, type DockerCliRunner } from "../docker/docker-cli-image-transport.js";

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
    throw new DomainRouteTargetInspectionError("target-unavailable");
  }

  const networkName = domainRouteNetworkName(route.data.projectId);
  const candidate = {
    candidateId: receipt.data.candidateId,
    projectId: route.data.projectId,
    deploymentId: route.data.deploymentId,
    effectiveImage: input.effectiveImage,
    runtimePort: receipt.data.containerPort,
    networkName
  };
  const transport = new DockerCliImageTransport({
    runner: input.runner,
    owner: "deploylite-agent",
    hostPort: receipt.data.hostPort,
    containerPort: receipt.data.containerPort,
    allowedNetworks: [networkName],
    networkName
  });

  try {
    const observation = await transport.observeActiveIdentity(candidate, input.signal ?? new AbortController().signal);
    if (observation.container !== receipt.data.container || observation.containerId !== receipt.data.containerId
      || observation.projectId !== route.data.projectId || observation.deploymentId !== route.data.deploymentId
      || observation.candidateId !== receipt.data.candidateId || observation.effectiveImage !== input.effectiveImage
      || observation.hostPort !== receipt.data.hostPort || observation.containerPort !== receipt.data.containerPort
      || observation.network !== networkName || observation.health !== "healthy" || observation.running !== true) {
      throw new Error("target identity mismatch");
    }
    const observedAt = (input.now ?? Date.now)();
    if (!Number.isSafeInteger(observedAt) || observedAt < 0) throw new Error("inspection clock invalid");
    return Object.freeze({
      projectId: route.data.projectId,
      deploymentId: route.data.deploymentId,
      agentId: input.agentId,
      networkName,
      container: observation.container,
      containerId: observation.containerId,
      containerPort: observation.containerPort,
      health: "healthy",
      observedAt,
      dynamicConfig
    });
  } catch {
    if (input.signal?.aborted) throw new DomainRouteTargetInspectionError("canceled");
    throw new DomainRouteTargetInspectionError("target-unavailable");
  }
}
