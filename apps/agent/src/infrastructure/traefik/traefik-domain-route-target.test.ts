import { trustedPriorExecutionReceiptSchema, type DomainRouteIntentV1 } from "@deploylite/contracts";
import { domainRouteNetworkName } from "@deploylite/domain";
import { describe, expect, it, vi } from "vitest";
import { inspectDomainRouteTarget } from "./traefik-domain-route-target.js";

const route: DomainRouteIntentV1 = { schemaVersion: 1, projectId: "project-1", deploymentId: "dep_0123456789abcdef", domain: "app.example.test" };
const network = domainRouteNetworkName(route.projectId);
const effectiveImage = `registry.example.com/team/app@sha256:${"b".repeat(64)}`;
const receipt = trustedPriorExecutionReceiptSchema.parse({
  schemaVersion: 1, candidateId: `${route.deploymentId}:candidate:deploy_0123456789abcdef`,
  deploymentId: route.deploymentId, projectId: route.projectId, snapshotOriginId: route.deploymentId,
  snapshotHash: "a".repeat(64), effectiveImageDigest: `sha256:${"b".repeat(64)}`, runtimeHost: "agent-1",
  container: `deploylite-active-${route.deploymentId}`, containerId: "c".repeat(64), hostPort: 43000,
  containerPort: 3000, network
});
const observation = {
  id: "c".repeat(64), name: `/${receipt.container}`, imageId: `sha256:${"d".repeat(64)}`,
  owner: "deploylite-agent", projectId: route.projectId, deploymentId: route.deploymentId,
  candidateId: receipt.candidateId, effectiveImage, running: true, health: "healthy",
  hostBindings: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "43000" }] },
  portBindings: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "43000" }] },
  networkMode: network,
  networks: { [network]: { networkId: "e".repeat(64), endpointId: "f".repeat(64) } }
};

const fixture = (patchedReceipt: unknown = receipt, patchedObservation: unknown = observation) => {
  const run = vi.fn(async (argv: readonly string[]) => ({
    exitCode: 0, signal: null,
    stdout: JSON.stringify(argv[1] === "image" ? `sha256:${"d".repeat(64)}` : patchedObservation),
    stderr: ""
  }));
  return { run, input: { route, receipt: patchedReceipt, agentId: "agent-1", effectiveImage, runner: { run } } };
};

describe("live domain route target inspection", () => {
  it("accepts only the exact healthy receipt-bound active container and project network", async () => {
    const f = fixture();
    const verified = await inspectDomainRouteTarget(f.input);
    expect(verified).toMatchObject({
      projectId: route.projectId, deploymentId: route.deploymentId, agentId: "agent-1",
      networkName: network, container: receipt.container, containerId: receipt.containerId,
      containerPort: 3000, health: "healthy", dynamicConfig: { fileName: expect.stringMatching(/^domain-route-[a-f0-9]{24}\.yml$/) }
    });
    expect(f.run.mock.calls.map(([argv]) => argv[1])).toEqual(["container", "image"]);
  });

  it("rejects an unhealthy or replaced container without returning runner diagnostics", async () => {
    const unhealthy = fixture(receipt, { ...observation, health: "unhealthy" });
    await expect(inspectDomainRouteTarget(unhealthy.input)).rejects.toThrow("Domain route target is unavailable.");
    const replaced = fixture({ ...receipt, containerId: "1".repeat(64) });
    await expect(inspectDomainRouteTarget(replaced.input)).rejects.toThrow("Domain route target is unavailable.");
  });

  it("allows legacy bridge-only receipts during preflight and rejects an image mismatch before inspection", async () => {
    const legacy = fixture({ ...receipt, network: null }, { ...observation, networkMode: "default",
      networks: { bridge: { networkId: "e".repeat(64), endpointId: "f".repeat(64) } } });
    await expect(inspectDomainRouteTarget({ ...legacy.input, requireRouteNetwork: false })).resolves.toMatchObject({
      networkName: network, containerId: receipt.containerId
    });
    const wrongImage = fixture(receipt);
    await expect(inspectDomainRouteTarget({ ...wrongImage.input, effectiveImage: `registry.example.com/team/other@sha256:${"c".repeat(64)}` }))
      .rejects.toThrow("Domain route target is unavailable.");
    expect(wrongImage.run).not.toHaveBeenCalled();
  });
});
