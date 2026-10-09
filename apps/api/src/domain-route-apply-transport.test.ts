import { DOMAIN_ROUTE_APPLY_CAPABILITY, DOMAIN_ROUTE_APPLY_PATH, domainRouteApplyReceiptSchema,
  trustedPriorExecutionReceiptSchema, type DomainRouteIntentV1 } from "@deploylite/contracts";
import { claimProjectUpdateAuthority, createControlCommand, domainRouteNetworkName, type PreparedDomainRouteApplyCommand } from "@deploylite/domain";
import { describe, expect, it, vi } from "vitest";
import { AuthenticatedAgentDeploymentTransport } from "./agent-transport.js";

const projectId = "project-1", deploymentId = "deployment-1", agentId = "agent-1", trustKey = "route_transport_test_key_123";
const route: DomainRouteIntentV1 = { schemaVersion: 1, projectId, deploymentId, domain: "app.example.test" };
const effectiveImage = `registry.example.com/team/app@sha256:${"b".repeat(64)}`;
const executionReceipt = trustedPriorExecutionReceiptSchema.parse({
  schemaVersion: 1, candidateId: `${deploymentId}:candidate:command-1`, deploymentId, projectId, snapshotOriginId: deploymentId,
  snapshotHash: "a".repeat(64), effectiveImageDigest: `sha256:${"b".repeat(64)}`, runtimeHost: agentId,
  container: `deploylite-active-${deploymentId}`, containerId: "c".repeat(64), hostPort: 43000, containerPort: 3000, network: "bridge"
});

describe("authenticated Traefik route apply transport", () => {
  it("negotiates the apply capability and binds the terminal receipt to the project command", async () => {
    const control = { ...createControlCommand({ actorId: "actor-1", action: "project.update", scope: { kind: "project", projectId },
      input: { route, executionReceipt, effectiveImage }, idempotencyKey: "route-key-1", correlationId: "correlation-1",
      expiresAt: new Date(Date.now() + 30_000) }), status: "eligible" as const };
    const authority = claimProjectUpdateAuthority([control], control)!;
    const prepared: PreparedDomainRouteApplyCommand = { command: control, route, executionReceipt, effectiveImage, agentId };
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = new AuthenticatedAgentDeploymentTransport({
      endpoint: "https://agent.test", trustKey, agentId, fetch: async (url, init) => {
        const target = String(url); calls.push({ url: target, init });
        if (target.endsWith("/capabilities")) return new Response(JSON.stringify({
          schemaVersion: 1, agentId, capabilities: [DOMAIN_ROUTE_APPLY_CAPABILITY], protocolVersions: [1, 2]
        }), { status: 200, headers: { "x-deploylite-request-signature": String((init?.headers as Record<string, string>)["x-deploylite-signature"]) } });
        const command = JSON.parse(String(init?.body)) as { commandId: string; inputDigest: string; context: { correlationId: string } };
        return new Response(JSON.stringify(domainRouteApplyReceiptSchema.parse({
          schemaVersion: 1, action: "domain.route.apply", agentId, commandId: command.commandId, projectId, domain: route.domain,
          deploymentId, inputDigest: command.inputDigest, correlationId: command.context.correlationId,
          networkName: domainRouteNetworkName(projectId), networkId: "d".repeat(64), targetContainerId: executionReceipt.containerId,
          traefikContainerId: "e".repeat(64), fileName: `domain-route-${"f".repeat(24)}.yml`,
          contentDigest: "1".repeat(64), state: "created", observedAt: Date.now(), failureReason: null, redacted: true
        })), { status: 200 });
      }
    });

    const terminal = await transport.dispatchDomainRouteApply(prepared, authority, { requestId: "request-1", correlationId: control.correlationId });
    expect(terminal).toMatchObject({ state: "created", commandId: control.id, projectId, deploymentId });
    expect(calls.map(call => call.url)).toEqual(["https://agent.test/capabilities", `https://agent.test${DOMAIN_ROUTE_APPLY_PATH}`]);
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({
      action: "domain.route.apply", projectId, commandId: control.id, route, authority, requiredCapabilities: [DOMAIN_ROUTE_APPLY_CAPABILITY]
    });
  });
});
