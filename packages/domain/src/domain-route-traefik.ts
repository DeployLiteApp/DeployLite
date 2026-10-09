import { createHash } from "node:crypto";
import { domainRouteIntentSchema, trustedPriorExecutionReceiptSchema } from "@deploylite/contracts";
import { stringify } from "yaml";

/** Stable, project-isolated Docker network name; a route writer must join Traefik only to this project network. */
export function domainRouteNetworkName(projectId: string): string {
  if (typeof projectId !== "string" || projectId.length === 0 || projectId.length > 256) throw new DomainRouteRuntimeError("route-invalid");
  return `deploylite-project-${createHash("sha256").update(projectId).digest("hex").slice(0, 24)}`;
}

export type DomainRouteDynamicConfig = Readonly<{
  fileName: string;
  content: string;
}>;

export class DomainRouteRuntimeError extends Error {
  constructor(readonly code: "route-invalid" | "receipt-invalid" | "target-mismatch" | "network-unavailable") {
    super("The domain route runtime configuration cannot be rendered safely.");
    this.name = "DomainRouteRuntimeError";
  }
}

const identityPattern = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
const containerPattern = /^[a-z0-9][a-z0-9_.-]{0,127}$/;

/**
 * Renders one file-provider route from a versioned intent and trusted execution
 * receipt. This pure helper does not inspect runtime state or write the file;
 * callers must establish that the receipt target is still healthy first.
 */
export function renderDomainRouteDynamicConfig(input: Readonly<{ route: unknown; receipt: unknown; agentId: string }>): DomainRouteDynamicConfig {
  const route = domainRouteIntentSchema.safeParse(input.route);
  const rawDomain = typeof input.route === "object" && input.route !== null && "domain" in input.route
    ? (input.route as { domain?: unknown }).domain : undefined;
  if (!route.success || typeof rawDomain !== "string" || rawDomain !== route.data.domain) {
    throw new DomainRouteRuntimeError("route-invalid");
  }
  const receipt = trustedPriorExecutionReceiptSchema.safeParse(input.receipt);
  if (!receipt.success) throw new DomainRouteRuntimeError("receipt-invalid");
  if (!identityPattern.test(input.agentId) || receipt.data.runtimeHost !== input.agentId
    || receipt.data.projectId !== route.data.projectId || receipt.data.deploymentId !== route.data.deploymentId
    || !containerPattern.test(`deploylite-active-${route.data.deploymentId}`)
    || receipt.data.container !== `deploylite-active-${route.data.deploymentId}`) {
    throw new DomainRouteRuntimeError("target-mismatch");
  }
  const suffix = createHash("sha256").update(route.data.domain).digest("hex").slice(0, 24);
  const router = `domain-route-${suffix}`;
  const service = `domain-service-${suffix}`;
  const content = stringify({
    http: {
      routers: {
        [router]: {
          rule: `Host(\`${route.data.domain}\`)`,
          entryPoints: ["websecure"],
          service,
          tls: { certResolver: "le" }
        }
      },
      services: {
        [service]: {
          loadBalancer: {
            servers: [{ url: `http://${receipt.data.container}:${receipt.data.containerPort}` }]
          }
        }
      }
    }
  }, { lineWidth: 0 });
  return Object.freeze({ fileName: `domain-route-${suffix}.yml`, content });
}
