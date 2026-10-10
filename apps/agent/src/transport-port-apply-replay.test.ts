import { signAgentTransport } from "@deploylite/config";
import { TRANSPORT_PORT_APPLY_CAPABILITY, TRANSPORT_PORT_TRANSFER_CAPABILITY, transportPortApplyAgentCommandSchema, transportPortApplyReceiptSchema,
  trustedPriorExecutionReceiptSchema, type TransportPortIntentV1 } from "@deploylite/contracts";
import { claimProjectUpdateAuthority, createControlCommand } from "@deploylite/domain";
import { describe, expect, it, vi } from "vitest";
import { AuthenticatedAgentCommandReceiver } from "./agent-transport.js";

const projectId = "project-1", deploymentId = "deployment-1", agentId = "agent-1", trustKey = "transport_port_test_trust_key_123";
const route: TransportPortIntentV1 = { schemaVersion: 1, projectId, deploymentId, protocol: "udp", publishedPort: 19132, targetPort: 19132 };
const effectiveImage = `registry.example.com/team/app@sha256:${"b".repeat(64)}`;
const executionReceipt = trustedPriorExecutionReceiptSchema.parse({ schemaVersion: 1, candidateId: `${deploymentId}:candidate:command-1`, deploymentId, projectId,
  snapshotOriginId: deploymentId, snapshotHash: "a".repeat(64), effectiveImageDigest: `sha256:${"b".repeat(64)}`, runtimeHost: agentId,
  container: `deploylite-active-${deploymentId}`, containerId: "c".repeat(64), hostPort: 43000, containerPort: 3000, network: null });

describe("agent replay for Docker TCP/UDP apply", () => {
  it("binds a cross-deployment port transfer to a second trusted source receipt", async () => {
    const sourceDeploymentId = "deployment-source";
    const sourceEffectiveImage = `registry.example.com/team/source@sha256:${"d".repeat(64)}`;
    const sourceExecutionReceipt = trustedPriorExecutionReceiptSchema.parse({ schemaVersion: 1,
      candidateId: `${sourceDeploymentId}:candidate:source-command`, deploymentId: sourceDeploymentId, projectId,
      snapshotOriginId: sourceDeploymentId, snapshotHash: "e".repeat(64), effectiveImageDigest: `sha256:${"d".repeat(64)}`,
      runtimeHost: agentId, container: `deploylite-active-${sourceDeploymentId}`, containerId: "f".repeat(64),
      hostPort: 43001, containerPort: 3000, network: null });
    const portTransfer = { sourceDeploymentId, sourceContainerId: "a".repeat(64), sourceBindings: [],
      sourcePreviousBindings: [{ protocol: route.protocol, publishedPort: route.publishedPort, targetPort: route.targetPort }],
      sourceExecutionReceipt, sourceEffectiveImage };
    const input = { route, executionReceipt, effectiveImage, operation: "apply" as const, rollbackRevisionId: null, portTransfer };
    const now = Date.now(), control = { ...createControlCommand({ actorId: "actor-1", action: "project.update", scope: { kind: "project", projectId },
      input, idempotencyKey: "port-transfer-1", correlationId: "correlation-transfer-1", expiresAt: new Date(now + 30_000) }), status: "eligible" as const };
    const authority = claimProjectUpdateAuthority([control], control, now)!;
    const command = transportPortApplyAgentCommandSchema.safeParse({ schemaVersion: 1, action: "transport.port.apply", agentId,
      commandId: control.id, projectId, idempotencyKey: control.idempotencyKey, inputDigest: control.inputDigest,
      operation: "apply", rollbackRevisionId: null, route, currentContainerId: executionReceipt.containerId,
      bindings: [{ protocol: route.protocol, publishedPort: route.publishedPort, targetPort: route.targetPort }], previousBindings: [],
      executionReceipt, effectiveImage, portTransfer, requiredCapabilities: [TRANSPORT_PORT_APPLY_CAPABILITY, TRANSPORT_PORT_TRANSFER_CAPABILITY], authority,
      lease: authority.projectLease, context: { requestId: "request-transfer", correlationId: control.correlationId },
      timeoutMs: 30_000, cancellationRequested: false });
    expect(command.success).toBe(true);
    if (!command.success) return;
    expect(command.data.portTransfer?.sourceExecutionReceipt.deploymentId).toBe(sourceDeploymentId);
    expect(transportPortApplyAgentCommandSchema.safeParse({ ...command.data, portTransfer: { ...portTransfer,
      sourceExecutionReceipt: { ...sourceExecutionReceipt, projectId: "foreign-project" } } }).success).toBe(false);
    const executor = { execute: vi.fn() };
    const receiver = new AuthenticatedAgentCommandReceiver({ agentId, trustKey, capabilities: [TRANSPORT_PORT_APPLY_CAPABILITY],
      dispatcher: { dispatch: async () => { throw new Error("unused"); } }, transportPortApply: executor,
      replayStore: { claim: vi.fn(), wait: vi.fn(), complete: vi.fn(), release: vi.fn() } as never });
    const signature = signAgentTransport(JSON.stringify(command.data), trustKey);
    await expect(receiver.receive(command.data, signature)).rejects.toThrow(/capability/);
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("returns the durable terminal receipt on retry without repeating container replacement", async () => {
    const operation = "apply" as const, rollbackRevisionId = null;
    const input = { route, executionReceipt, effectiveImage, operation, rollbackRevisionId };
    const now = Date.now(), control = { ...createControlCommand({ actorId: "actor-1", action: "project.update", scope: { kind: "project", projectId },
      input, idempotencyKey: "port-apply-1", correlationId: "correlation-1", expiresAt: new Date(now + 30_000) }), status: "eligible" as const };
    const authority = claimProjectUpdateAuthority([control], control, now)!;
    const command = transportPortApplyAgentCommandSchema.parse({ schemaVersion: 1, action: "transport.port.apply", agentId,
      commandId: control.id, projectId, idempotencyKey: control.idempotencyKey, inputDigest: control.inputDigest,
      operation, rollbackRevisionId, route, currentContainerId: executionReceipt.containerId,
      bindings: [{ protocol: "udp", publishedPort: 19132, targetPort: 19132 }], previousBindings: [],
      executionReceipt, effectiveImage, requiredCapabilities: [TRANSPORT_PORT_APPLY_CAPABILITY], authority, lease: authority.projectLease,
      context: { requestId: "request-1", correlationId: control.correlationId }, timeoutMs: 30_000, cancellationRequested: false });
    const runtimeReceipt = transportPortApplyReceiptSchema.parse({ schemaVersion: 1, action: "transport.port.apply", agentId,
      commandId: command.commandId, projectId, protocol: route.protocol, publishedPort: route.publishedPort, targetPort: route.targetPort,
      deploymentId, operation, rollbackRevisionId, inputDigest: command.inputDigest, correlationId: command.context.correlationId,
      containerId: "d".repeat(64), state: "updated", observedAt: now, failureReason: null, redacted: true });
    const replay = new Map<string, { fingerprint: string; receipt: Record<string, unknown> }>();
    const replayStore = {
      durable: true,
      lookup: vi.fn(async (id: string, fingerprint: string) => {
        const current = replay.get(id); if (!current) return null;
        if (current.fingerprint !== fingerprint) throw new Error("replay fingerprint conflict");
        return structuredClone(current.receipt);
      }),
      claim: vi.fn(async () => ({ claimed: true, claimToken: "claim-1" })),
      wait: vi.fn(async () => { throw new Error("unexpected replay wait"); }),
      complete: vi.fn(async (id: string, value: { fingerprint: string; claimToken: string; receipt: Record<string, unknown> }) => {
        replay.set(id, { fingerprint: value.fingerprint, receipt: structuredClone(value.receipt) });
      }), release: vi.fn(async () => {})
    };
    const executor = { execute: vi.fn(async () => runtimeReceipt) };
    const receiver = new AuthenticatedAgentCommandReceiver({ agentId, trustKey, capabilities: [TRANSPORT_PORT_APPLY_CAPABILITY],
      dispatcher: { dispatch: async () => { throw new Error("unused"); } }, transportPortApply: executor,
      replayStore: replayStore as never, authorityValidator: { validateDeploymentAuthority: vi.fn(async () => {}),
        validateProjectUpdateAuthority: vi.fn(async () => {}) } });
    const signature = signAgentTransport(JSON.stringify(command), trustKey);
    const first = await receiver.receive(command, signature), second = await receiver.receive(command, signature);
    expect(first).toEqual(runtimeReceipt); expect(second).toEqual(runtimeReceipt);
    const staleContainer = { ...command, currentContainerId: "e".repeat(64) };
    await expect(receiver.receive(staleContainer, signAgentTransport(JSON.stringify(staleContainer), trustKey))).rejects.toThrow(/fingerprint conflict/);
    expect(executor.execute).toHaveBeenCalledOnce(); expect(replayStore.claim).toHaveBeenCalledOnce();
    expect(replayStore.complete).toHaveBeenCalledOnce(); expect(replayStore.lookup).toHaveBeenCalledTimes(3);
  });

  it("rejects a command whose stable control digest is detached from the route", async () => {
    const input = { route, executionReceipt, effectiveImage, operation: "apply" as const, rollbackRevisionId: null };
    const now = Date.now(), control = { ...createControlCommand({ actorId: "actor-1", action: "project.update", scope: { kind: "project", projectId },
      input, idempotencyKey: "port-apply-2", correlationId: "correlation-2", expiresAt: new Date(now + 30_000) }), status: "eligible" as const };
    const authority = claimProjectUpdateAuthority([control], control, now)!;
    const command = transportPortApplyAgentCommandSchema.parse({ schemaVersion: 1, action: "transport.port.apply", agentId,
      commandId: control.id, projectId, idempotencyKey: control.idempotencyKey, inputDigest: control.inputDigest,
      operation: "apply", rollbackRevisionId: null, route, currentContainerId: executionReceipt.containerId,
      bindings: [{ protocol: "udp", publishedPort: 19132, targetPort: 19132 }], previousBindings: [],
      executionReceipt, effectiveImage, requiredCapabilities: [TRANSPORT_PORT_APPLY_CAPABILITY], authority, lease: authority.projectLease,
      context: { requestId: "request-2", correlationId: control.correlationId }, timeoutMs: 30_000, cancellationRequested: false });
    const tampered = { ...command, executionReceipt: { ...command.executionReceipt, snapshotHash: "e".repeat(64) } };
    const receiver = new AuthenticatedAgentCommandReceiver({ agentId, trustKey, capabilities: [TRANSPORT_PORT_APPLY_CAPABILITY],
      dispatcher: { dispatch: async () => { throw new Error("unused"); } }, transportPortApply: { execute: vi.fn() },
      replayStore: { claim: vi.fn(), wait: vi.fn(), complete: vi.fn(), release: vi.fn() } as never,
      authorityValidator: { validateDeploymentAuthority: vi.fn(async () => {}), validateProjectUpdateAuthority: vi.fn(async () => {}) } });
    await expect(receiver.receive(tampered, signAgentTransport(JSON.stringify(tampered), trustKey))).rejects.toThrow(/digest rejected/);
  });
});
