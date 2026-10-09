import { trustedPriorExecutionReceiptSchema, type DomainRouteIntentV1 } from "@deploylite/contracts";
import { parseDocument } from "yaml";
import { describe, expect, it } from "vitest";
import { DomainRouteRuntimeError, domainRouteNetworkName, renderDomainRouteDynamicConfig } from "./domain-route-traefik.js";

const route: DomainRouteIntentV1 = { schemaVersion: 1, projectId: "project-1", deploymentId: "dep_0123456789abcdef", domain: "app.example.test" };
const receipt = trustedPriorExecutionReceiptSchema.parse({
  schemaVersion: 1,
  candidateId: "dep_0123456789abcdef:candidate:deploy_0123456789abcdef",
  deploymentId: route.deploymentId,
  projectId: route.projectId,
  snapshotOriginId: route.deploymentId,
  snapshotHash: "a".repeat(64),
  effectiveImageDigest: `sha256:${"b".repeat(64)}`,
  runtimeHost: "agent-1",
  container: `deploylite-active-${route.deploymentId}`,
  containerId: "c".repeat(64),
  hostPort: 43000,
  containerPort: 3000,
  network: domainRouteNetworkName(route.projectId)
});

describe("Traefik domain route config", () => {
  it("derives a stable but project-isolated Docker network name", () => {
    const first = domainRouteNetworkName("project-1");
    expect(first).toMatch(/^deploylite-project-[a-f0-9]{24}$/);
    expect(domainRouteNetworkName("project-1")).toBe(first);
    expect(domainRouteNetworkName("project-2")).not.toBe(first);
  });

  it("renders a deterministic TLS host route to the receipt-bound container on the private route network", () => {
    const result = renderDomainRouteDynamicConfig({ route, receipt, agentId: "agent-1" });
    const doc = parseDocument(result.content).toJS() as any;
    const [routerName] = Object.keys(doc.http.routers);
    const [serviceName] = Object.keys(doc.http.services);
    expect(result.fileName).toMatch(/^domain-route-[a-f0-9]{24}\.yml$/);
    expect(doc.http.routers[routerName]).toEqual({
      rule: "Host(`app.example.test`)",
      entryPoints: ["websecure"],
      service: serviceName,
      tls: { certResolver: "le" }
    });
    expect(doc.http.services[serviceName].loadBalancer.servers).toEqual([
      { url: `http://${receipt.container}:${receipt.containerPort}` }
    ]);
    expect(renderDomainRouteDynamicConfig({ route, receipt, agentId: "agent-1" })).toEqual(result);
  });

  it.each([
    ["foreign project", { receipt: { ...receipt, projectId: "project-2" } }],
    ["foreign deployment", { receipt: { ...receipt, deploymentId: "dep_other" } }],
    ["foreign agent", { receipt: { ...receipt, runtimeHost: "agent-2" } }],
    ["foreign container name", { receipt: { ...receipt, container: "attacker" } }]
  ])("fails closed for %s", (_label, patch) => {
    expect(() => renderDomainRouteDynamicConfig({ route, receipt: { ...receipt, ...patch.receipt }, agentId: "agent-1" }))
      .toThrow(DomainRouteRuntimeError);
  });

  it("renders for an existing default or legacy network because apply joins a separate project route network", () => {
    const canonical = renderDomainRouteDynamicConfig({ route, receipt, agentId: "agent-1" });
    expect(renderDomainRouteDynamicConfig({ route, receipt: { ...receipt, network: null }, agentId: "agent-1" })).toEqual(canonical);
    expect(renderDomainRouteDynamicConfig({ route, receipt: { ...receipt, network: "deploylite-agent" }, agentId: "agent-1" })).toEqual(canonical);
  });

  it("rejects noncanonical host input after normalization rather than writing a different owner route", () => {
    expect(() => renderDomainRouteDynamicConfig({ route: { ...route, domain: " APP.EXAMPLE.TEST " }, receipt, agentId: "agent-1" }))
      .toThrow(DomainRouteRuntimeError);
  });
});
