import { signAgentTransport } from "@deploylite/config";
import { DOMAIN_ROUTE_APPLY_CAPABILITY, domainRouteApplyAgentCommandSchema, domainRouteApplyReceiptSchema,
  trustedPriorExecutionReceiptSchema, type DomainRouteIntentV1 } from "@deploylite/contracts";
import { claimProjectUpdateAuthority, createControlCommand, domainRouteNetworkName } from "@deploylite/domain";
import { describe, expect, it, vi } from "vitest";
import { AuthenticatedAgentCommandReceiver } from "./agent-transport.js";

const projectId = "project-1", deploymentId = "dep_0123456789abcdef", agentId = "agent-1", trustKey = "domain_route_test_trust_key_123";
const route: DomainRouteIntentV1 = { schemaVersion: 1, projectId, deploymentId, domain: "app.example.test" };
const effectiveImage = `registry.example.com/team/app@sha256:${"b".repeat(64)}`;
const priorReceipt = trustedPriorExecutionReceiptSchema.parse({
  schemaVersion: 1, candidateId: `${deploymentId}:candidate:deploy_0123456789abcdef`, deploymentId, projectId,
  snapshotOriginId: deploymentId, snapshotHash: "a".repeat(64), effectiveImageDigest: `sha256:${"b".repeat(64)}`,
  runtimeHost: agentId, container: `deploylite-active-${deploymentId}`, containerId: "c".repeat(64),
  hostPort: 43000, containerPort: 3000, network: "bridge"
});

describe("durable agent replay for Traefik route apply", () => {
  it("returns the same cached receipt after a retry without repeating runtime effects", async () => {
    const now = Date.now(), control = { ...createControlCommand({ actorId: "actor-1", action: "project.update", scope: { kind: "project", projectId },
      input: { route, executionReceipt: priorReceipt, effectiveImage }, idempotencyKey: "route-apply-1", correlationId: "correlation-1",
      expiresAt: new Date(now + 30_000) }), status: "eligible" as const };
    const authority = claimProjectUpdateAuthority([control], control, now)!;
    const command = domainRouteApplyAgentCommandSchema.parse({
      schemaVersion: 1, action: "domain.route.apply", agentId, commandId: control.id, projectId, idempotencyKey: control.idempotencyKey,
      inputDigest: control.inputDigest, route, executionReceipt: priorReceipt, effectiveImage,
      requiredCapabilities: [DOMAIN_ROUTE_APPLY_CAPABILITY], authority, lease: authority.projectLease,
      context: { requestId: "request-1", correlationId: control.correlationId }, timeoutMs: 30_000, cancellationRequested: false
    });
    const networkName = domainRouteNetworkName(projectId);
    const runtimeReceipt = domainRouteApplyReceiptSchema.parse({
      schemaVersion: 1, action: "domain.route.apply", agentId, commandId: command.commandId, projectId,
      domain: route.domain, deploymentId, inputDigest: command.inputDigest, correlationId: command.context.correlationId,
      networkName, networkId: "d".repeat(64), targetContainerId: priorReceipt.containerId, traefikContainerId: "e".repeat(64),
      fileName: `domain-route-${"f".repeat(24)}.yml`, contentDigest: "1".repeat(64), state: "created",
      observedAt: now, failureReason: null, redacted: true
    });
    const replay = new Map<string, { fingerprint: string; receipt: Record<string, unknown> }>();
    const replayStore = {
      durable: true,
      lookup: vi.fn(async (id: string, fingerprint: string) => {
        const current = replay.get(id);
        if (!current) return null;
        if (current.fingerprint !== fingerprint) throw new Error("replay fingerprint conflict");
        return structuredClone(current.receipt);
      }),
      claim: vi.fn(async () => ({ claimed: true, claimToken: "claim-1" })),
      wait: vi.fn(async () => { throw new Error("unexpected replay wait"); }),
      complete: vi.fn(async (id: string, input: { fingerprint: string; claimToken: string; receipt: Record<string, unknown> }) => {
        replay.set(id, { fingerprint: input.fingerprint, receipt: structuredClone(input.receipt) });
      }),
      release: vi.fn(async () => {})
    };
    const executor = { execute: vi.fn(async () => runtimeReceipt) };
    const receiver = new AuthenticatedAgentCommandReceiver({
      agentId, trustKey, capabilities: [DOMAIN_ROUTE_APPLY_CAPABILITY], dispatcher: { dispatch: async () => { throw new Error("unused"); } },
      domainRouteApply: executor, replayStore: replayStore as never,
      authorityValidator: { validateDeploymentAuthority: vi.fn(async () => {}),
        validateProjectUpdateAuthority: vi.fn(async () => {}) }
    });
    const signature = signAgentTransport(JSON.stringify(command), trustKey);

    const first = await receiver.receive(command, signature);
    const replayed = await receiver.receive(command, signature);
    expect(first).toEqual(runtimeReceipt);
    expect(replayed).toEqual(runtimeReceipt);
    expect(executor.execute).toHaveBeenCalledOnce();
    expect(replayStore.claim).toHaveBeenCalledOnce();
    expect(replayStore.complete).toHaveBeenCalledOnce();
    expect(replayStore.lookup).toHaveBeenCalledTimes(2);
  });
});
