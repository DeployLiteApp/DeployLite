import { signAgentTransport } from "@deploylite/config";
import { TRANSPORT_PORT_APPLY_CAPABILITY, TRANSPORT_PORT_TRANSFER_CAPABILITY, trustedPriorExecutionReceiptSchema,
  type TransportPortApplyReceiptV1 } from "@deploylite/contracts";
import { claimProjectUpdateAuthority, createControlCommand, type PreparedTransportPortApplyCommand } from "@deploylite/domain";
import { describe, expect, it, vi } from "vitest";
import { AuthenticatedAgentTransportPortApplyTransport } from "./transport-port-apply-transport.js";

const projectId = "project-1", targetDeploymentId = "deployment-target", sourceDeploymentId = "deployment-source", agentId = "agent-1";
const trustKey = "transport_port_transfer_adapter_trust_key";
const route = { schemaVersion: 1 as const, projectId, deploymentId: targetDeploymentId, protocol: "tcp" as const, publishedPort: 25565, targetPort: 8080 };
const effectiveImage = `registry.example.com/team/target@sha256:${"b".repeat(64)}`;
const sourceEffectiveImage = `registry.example.com/team/source@sha256:${"d".repeat(64)}`;
const executionReceipt = trustedPriorExecutionReceiptSchema.parse({ schemaVersion: 1, candidateId: `${targetDeploymentId}:candidate:target-command`,
  deploymentId: targetDeploymentId, projectId, snapshotOriginId: targetDeploymentId, snapshotHash: "a".repeat(64),
  effectiveImageDigest: `sha256:${"b".repeat(64)}`, runtimeHost: agentId, container: `deploylite-active-${targetDeploymentId}`,
  containerId: "c".repeat(64), hostPort: 43000, containerPort: 3000, network: null });
const sourceExecutionReceipt = trustedPriorExecutionReceiptSchema.parse({ schemaVersion: 1, candidateId: `${sourceDeploymentId}:candidate:source-command`,
  deploymentId: sourceDeploymentId, projectId, snapshotOriginId: sourceDeploymentId, snapshotHash: "e".repeat(64),
  effectiveImageDigest: `sha256:${"d".repeat(64)}`, runtimeHost: agentId, container: `deploylite-active-${sourceDeploymentId}`,
  containerId: "f".repeat(64), hostPort: 43001, containerPort: 3000, network: null });
const portTransfer = { sourceDeploymentId, sourceContainerId: "a".repeat(64), sourceBindings: [],
  sourcePreviousBindings: [{ protocol: route.protocol, publishedPort: route.publishedPort, targetPort: 25565 }],
  sourceExecutionReceipt, sourceEffectiveImage };

function prepared(): { value: PreparedTransportPortApplyCommand; authority: ReturnType<typeof claimProjectUpdateAuthority> & {} } {
  const operation = "apply" as const, rollbackRevisionId = null;
  const input = { route, executionReceipt, effectiveImage, operation, rollbackRevisionId, portTransfer };
  const now = Date.now(), command = { ...createControlCommand({ actorId: "actor-1", action: "project.update", scope: { kind: "project", projectId },
    input, idempotencyKey: "port-transfer-adapter", correlationId: "correlation-transfer-adapter", expiresAt: new Date(now + 30_000) }), status: "eligible" as const };
  const authority = claimProjectUpdateAuthority([command], command, now)!;
  return { value: { command, route, bindings: [{ protocol: route.protocol, publishedPort: route.publishedPort, targetPort: route.targetPort }],
    previousBindings: [], currentContainerId: executionReceipt.containerId, executionReceipt, effectiveImage, portTransfer, operation,
    rollbackRevisionId, agentId }, authority };
}

describe("authenticated transport-port adapter", () => {
  it("requires the negotiated transfer capability before sending a cross-deployment command", async () => {
    const { value, authority } = prepared(), fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const signature = (init?.headers as Record<string, string>)?.["x-deploylite-signature"];
      return new Response(JSON.stringify({ schemaVersion: 1, agentId, capabilities: [TRANSPORT_PORT_APPLY_CAPABILITY], protocolVersions: [1, 2] }),
        { headers: { "x-deploylite-request-signature": signature ?? "" } });
    });
    const adapter = new AuthenticatedAgentTransportPortApplyTransport({ endpoint: "https://agent.example.test", trustKey, agentId, fetch: fetcher as typeof fetch });
    await expect(adapter.dispatchTransportPortApply(value, authority, { requestId: "request-1", correlationId: value.command.correlationId }))
      .rejects.toThrow(/capability_unavailable/);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("sends the transfer capability and accepts a receipt proving both active containers", async () => {
    const { value, authority } = prepared();
    const receipt: TransportPortApplyReceiptV1 = { schemaVersion: 1, action: "transport.port.apply", agentId, commandId: value.command.id,
      projectId, protocol: route.protocol, publishedPort: route.publishedPort, targetPort: route.targetPort, deploymentId: targetDeploymentId,
      operation: "apply", rollbackRevisionId: null, inputDigest: value.command.inputDigest, correlationId: value.command.correlationId,
      containerId: "d".repeat(64), portTransfer: { sourceDeploymentId, sourceContainerId: "e".repeat(64), retainedPriorContainerIds: [] },
      state: "updated", observedAt: Date.now(), failureReason: null, redacted: true };
    const sent: unknown[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url), signature = (init?.headers as Record<string, string>)?.["x-deploylite-signature"];
      if (path.endsWith("/capabilities")) return new Response(JSON.stringify({ schemaVersion: 1, agentId,
        capabilities: [TRANSPORT_PORT_APPLY_CAPABILITY, TRANSPORT_PORT_TRANSFER_CAPABILITY], protocolVersions: [1, 2] }),
        { headers: { "x-deploylite-request-signature": signature ?? "" } });
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(receipt), { status: 200 });
    });
    const adapter = new AuthenticatedAgentTransportPortApplyTransport({ endpoint: "https://agent.example.test", trustKey, agentId, fetch: fetcher as typeof fetch });
    await expect(adapter.dispatchTransportPortApply(value, authority, { requestId: "request-2", correlationId: value.command.correlationId }))
      .resolves.toEqual(receipt);
    expect(sent).toMatchObject([{ requiredCapabilities: [TRANSPORT_PORT_APPLY_CAPABILITY, TRANSPORT_PORT_TRANSFER_CAPABILITY],
      portTransfer: { sourceDeploymentId, sourceContainerId: portTransfer.sourceContainerId } }]);
  });
});
