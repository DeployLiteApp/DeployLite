import Fastify, { type preHandlerAsyncHookHandler } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { transportPortApplyReceiptSchema, trustedPriorExecutionReceiptSchema, type TransportPortApplyReceiptV1 } from "@deploylite/contracts";
import { claimProjectUpdateAuthority, createControlCommand, validateProjectUpdateAuthority,
  type ControlCommand, type TransportPortApplyCompletionInput } from "@deploylite/domain";
import { registerTransportPortApplyRoutes, type TransportPortApplyExecutionAccess } from "./transport-port-apply-route.js";
import type { TransportPortApplyAgentTransport } from "./transport-port-apply-transport.js";

const projectId = "project-1", deploymentId = "deployment-1", agentId = "agent-1", protocol = "tcp" as const, publishedPort = 25565;
const effectiveImage = `registry.example.com/team/app@sha256:${"b".repeat(64)}`;
const proof = trustedPriorExecutionReceiptSchema.parse({ schemaVersion: 1, candidateId: `${deploymentId}:candidate:command-1`, deploymentId, projectId,
  snapshotOriginId: deploymentId, snapshotHash: "a".repeat(64), effectiveImageDigest: `sha256:${"b".repeat(64)}`, runtimeHost: agentId,
  container: `deploylite-active-${deploymentId}`, containerId: "c".repeat(64), hostPort: 43000, containerPort: 3000, network: null });
const deployment = { id: deploymentId, projectId, agentId, status: "succeeded", commitSha: "abcdef1", startedAt: "2026-10-09T00:00:00.000Z",
  finishedAt: "2026-10-09T00:01:00.000Z", snapshotHash: proof.snapshotHash, snapshotOriginId: deploymentId,
  stopTarget: { candidateId: proof.candidateId, effectiveImage }, executionReceipt: proof };
const sourceDeploymentId = "deployment-prior", sourceEffectiveImage = `registry.example.com/team/prior@sha256:${"d".repeat(64)}`;
const sourceProof = trustedPriorExecutionReceiptSchema.parse({ schemaVersion: 1, candidateId: `${sourceDeploymentId}:candidate:source-command`, deploymentId: sourceDeploymentId, projectId,
  snapshotOriginId: sourceDeploymentId, snapshotHash: "e".repeat(64), effectiveImageDigest: `sha256:${"d".repeat(64)}`, runtimeHost: agentId,
  container: `deploylite-active-${sourceDeploymentId}`, containerId: "f".repeat(64), hostPort: 43001, containerPort: 3000, network: null });
const sourceDeployment = { ...deployment, id: sourceDeploymentId, snapshotHash: sourceProof.snapshotHash, snapshotOriginId: sourceDeploymentId,
  stopTarget: { candidateId: sourceProof.candidateId, effectiveImage: sourceEffectiveImage }, executionReceipt: sourceProof };
const project = { id: projectId, name: "fixture", repoUrl: "https://github.com/example/app", defaultBranch: "main", buildCommand: null,
  runCommand: null, port: null, description: null, imageTag: null };
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.restoreAllMocks(); });

function fixture(currentClaims: unknown[] = [], authorized = true, rollbackTarget: unknown = null,
  options: Readonly<{ extraDeployment?: typeof sourceDeployment; runtimeStates?: readonly { projectId: string; deploymentId: string; containerId: string; bindings: unknown[] }[] }> = {}) {
  const commandById = new Map<string, ControlCommand>(), commandIdByKey = new Map<string, string>();
  const reservations = new Map<string, any>(), revisions = new Map<string, unknown>(), auditEvents: unknown[] = [];
  const controls = {
    findProjectUpdateByIdempotency: vi.fn(async (actor: string, _project: string, key: string) => {
      const id = commandIdByKey.get(`${actor}:${key}`); return id ? structuredClone(commandById.get(id)!) : null;
    }),
    resolve: vi.fn(async (command: ControlCommand) => {
      const key = `${command.actorId}:${command.idempotencyKey}`, prior = commandIdByKey.get(key);
      if (prior) { const existing = commandById.get(prior)!; if (existing.inputDigest !== command.inputDigest) throw new Error("idempotency conflict"); return { command: structuredClone(existing), created: false }; }
      commandById.set(command.id, structuredClone(command)); commandIdByKey.set(key, command.id); return { command: structuredClone(command), created: true };
    }),
    claimProjectUpdate: vi.fn(async (command: ControlCommand) => {
      const current = commandById.get(command.id)!, authority = claimProjectUpdateAuthority([...commandById.values()], current, Date.now());
      if (!authority) return { command: structuredClone(current), claimed: false };
      const claimed = { ...current, status: "dispatching" as const, projectExecutionAuthority: authority }; commandById.set(claimed.id, claimed);
      return { command: structuredClone(claimed), claimed: true, authority };
    }),
    validateProjectUpdateAuthority: vi.fn(async (authority: import("@deploylite/contracts").ProjectControlAuthorityV1) =>
      validateProjectUpdateAuthority([...commandById.values()], authority, Date.now()))
  };
  let savedClaims = structuredClone(currentClaims);
  const runtimeStates = new Map((options.runtimeStates ?? []).map(value => [value.deploymentId, structuredClone(value)]));
  const claims = { available: () => true, listClaims: vi.fn(async () => structuredClone(savedClaims)) };
  const store = {
    available: () => true,
    findRollbackTarget: vi.fn(async () => rollbackTarget as never),
    findTransportPortRevisionByCommand: vi.fn(async (id: string) => (revisions.get(id) ?? null) as never),
    findTransportPortRuntimeState: vi.fn(async (_projectId: string, targetDeploymentId: string) => structuredClone(runtimeStates.get(targetDeploymentId) ?? null)),
    findTransportPortReservation: vi.fn(async (id: string) => reservations.get(id) ?? null),
    reserveTransportPortApply: vi.fn(async (input: any) => { reservations.set(input.command.id, structuredClone(input)); }),
    releaseTransportPortApply: vi.fn(async (id: string) => { reservations.delete(id); }),
    completeTransportPortApply: vi.fn(async (input: TransportPortApplyCompletionInput) => {
      auditEvents.push(structuredClone(input.audit)); reservations.delete(input.command.id);
      const completed = { ...input.command, status: "completed" as const, result: structuredClone(input.receipt) };
      commandById.set(completed.id, completed);
      if (input.receipt.state !== "failed") {
        runtimeStates.set(input.route.deploymentId, { projectId, deploymentId: input.route.deploymentId, containerId: input.receipt.containerId!, bindings: structuredClone(input.bindings) });
        savedClaims = savedClaims.filter((claim: any) => !(claim.protocol === input.route.protocol && claim.publishedPort === input.route.publishedPort));
        savedClaims.push({ schemaVersion: 1, projectId, deploymentId: input.route.deploymentId, protocol: input.route.protocol, publishedPort: input.route.publishedPort, targetPort: input.route.targetPort });
        if (input.portTransfer) runtimeStates.set(input.portTransfer.sourceDeploymentId, { projectId, deploymentId: input.portTransfer.sourceDeploymentId,
          containerId: input.receipt.portTransfer!.sourceContainerId, bindings: structuredClone(input.portTransfer.sourceBindings) });
      }
      if (input.receipt.state !== "failed" && input.plan.action !== "no-op") revisions.set(input.command.id, {
        schemaVersion: 1, id: "revision-created", projectId, protocol, publishedPort, deploymentId: input.route.deploymentId,
        targetPort: input.route.targetPort, revisionNumber: 1, operation: input.operation, rollbackRevisionId: input.rollbackRevisionId,
        commandId: input.command.id, correlationId: input.command.correlationId, createdAt: "2026-10-09T00:02:00.000Z",
        evidence: { state: input.receipt.state, observedAt: input.receipt.observedAt, redacted: true }
      });
      return structuredClone(completed);
    })
  };
  const dispatch = vi.fn(async (prepared: any): Promise<TransportPortApplyReceiptV1> => transportPortApplyReceiptSchema.parse({
    schemaVersion: 1, action: "transport.port.apply", agentId, commandId: prepared.command.id, projectId,
    protocol: prepared.route.protocol, publishedPort: prepared.route.publishedPort, targetPort: prepared.route.targetPort,
    deploymentId: prepared.route.deploymentId, operation: prepared.operation, rollbackRevisionId: prepared.rollbackRevisionId,
    inputDigest: prepared.command.inputDigest, correlationId: prepared.command.correlationId, containerId: "d".repeat(64),
    ...(prepared.portTransfer ? { portTransfer: { sourceDeploymentId: prepared.portTransfer.sourceDeploymentId,
      sourceContainerId: "e".repeat(64), retainedPriorContainerIds: [] } } : {}),
    state: "updated", observedAt: Date.now(), failureReason: null, redacted: true
  }));
  const transport: TransportPortApplyAgentTransport = { available: () => true, dispatchTransportPortApply: dispatch,
    readTransportPortApplyReceipt: vi.fn(async () => null) };
  const audit = { append: vi.fn(async (event: unknown) => { auditEvents.push(structuredClone(event)); return event as never; }) };
  const requireAuth: preHandlerAsyncHookHandler = async request => {
    const raw = request as unknown as { auth: unknown; correlationContext: unknown };
    raw.auth = { user: { id: "actor-1", role: "operator" } }; raw.correlationContext = { requestId: "request-1", correlationId: "correlation-1" };
  };
  const app = Fastify() as any;
  registerTransportPortApplyRoutes(app, { prefix: "/api/v1", projects: { findById: vi.fn(async () => project) } as never,
    deployments: { findById: vi.fn(async (id: string) => id === options.extraDeployment?.id ? options.extraDeployment : deployment) } as never, claims: claims as never, applyStore: store as never,
    executions: new Map([[projectId, { controls: controls as never, transport, commandTtlMs: 30_000, agentId } satisfies TransportPortApplyExecutionAccess]]),
    grants: { listForActor: vi.fn(async (actorId: string) => authorized ? [{ id: "grant-1", actorId, action: "project.update", scope: { kind: "project", projectId } }] : []) } as never,
    audit: audit as never, requireAuth, requireRole: (async () => {}) as preHandlerAsyncHookHandler,
    ok: (_request: unknown, data: unknown) => ({ data, error: null }), error: (_request: unknown, code: string, message: string) => ({ data: null, error: { code, message } }) } as never);
  apps.push(app);
  const post = (key = "apply-1", targetPort = 25565, port = publishedPort) => app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/transport-ports/apply`,
    headers: { "x-control-idempotency-key": key }, payload: { deploymentId, protocol, publishedPort: port, targetPort } });
  const rollback = (key = "rollback-1") => app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/transport-ports/rollback`,
    headers: { "x-control-idempotency-key": key }, payload: { protocol, publishedPort } });
  return { app, post, rollback, dispatch, controls, claims, store, auditEvents };
}

describe("project TCP/UDP port apply API", () => {
  it("applies a trusted port with project.update and durably replays its receipt", async () => {
    const f = fixture();
    const response = await f.post();
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({ applied: true, operation: "apply", idempotent: false,
      receipt: { state: "updated", protocol, publishedPort }, revision: { revisionNumber: 1, operation: "apply" } });
    expect(f.controls.claimProjectUpdate).toHaveBeenCalledOnce(); expect(f.store.reserveTransportPortApply).toHaveBeenCalledOnce();
    expect(f.auditEvents).toContainEqual(expect.objectContaining({ action: "transport.port.applied", targetId: projectId }));
    const replay = await f.post();
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().data).toMatchObject({ applied: true, operation: "apply", idempotent: true });
    expect(f.dispatch).toHaveBeenCalledOnce();
  });

  it("uses the persisted active container identity on the next port change", async () => {
    const f = fixture();
    expect((await f.post("first-apply", 25565)).statusCode).toBe(200);
    const second = await f.post("second-apply", 25566);
    expect(second.statusCode, second.body).toBe(200);
    expect(f.dispatch).toHaveBeenCalledTimes(2);
    expect(f.dispatch.mock.calls[1]?.[0]).toMatchObject({ currentContainerId: "d".repeat(64),
      previousBindings: [{ protocol, publishedPort, targetPort: 25565 }], bindings: [{ protocol, publishedPort, targetPort: 25566 }] });
  });

  it("rolls back to a saved revision using the same authorized adapter", async () => {
    const prior = { schemaVersion: 1, id: "revision-prior", projectId, protocol, publishedPort, deploymentId, targetPort: 25565,
      revisionNumber: 1, operation: "apply", rollbackRevisionId: null, commandId: "prior-command", correlationId: "prior-correlation",
      createdAt: "2026-10-08T00:00:00.000Z", evidence: { state: "updated", observedAt: 1, redacted: true } };
    const f = fixture([{ schemaVersion: 1, projectId, deploymentId, protocol, publishedPort, targetPort: 3000 }], true, prior);
    const response = await f.rollback();
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({ operation: "rollback", rolledBack: true, rollbackRevisionId: "revision-prior",
      route: { deploymentId, targetPort: 25565 }, receipt: { state: "updated", rollbackRevisionId: "revision-prior" } });
    expect(f.store.reserveTransportPortApply).toHaveBeenCalledWith(expect.objectContaining({ operation: "rollback", rollbackRevisionId: "revision-prior",
      plan: expect.objectContaining({ action: "retarget" }) }));
  });

  it("denies unauthorized apply before reading claims or dispatching", async () => {
    const f = fixture([], false);
    const response = await f.post("denied-1");
    expect(response.statusCode).toBe(403); expect(f.claims.listClaims).not.toHaveBeenCalled(); expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("rejects a TCP publication that collides with the deployment health port before dispatch", async () => {
    const f = fixture();
    const response = await f.post("health-port-conflict", 25565, proof.hostPort);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("TRANSPORT_PORT_CONFLICT");
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.auditEvents).toContainEqual(expect.objectContaining({ action: "transport.port.apply.rejected",
      metadata: expect.objectContaining({ reason: "runtime-health-port-conflict" }) }));
  });

  it("fails closed when rollback has no earlier saved revision", async () => {
    const f = fixture([], true, null);
    const response = await f.rollback();
    expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe("TRANSPORT_PORT_NO_ROLLBACK"); expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("transfers a claimed port between deployments only with trusted same-agent source state", async () => {
    const f = fixture([{ schemaVersion: 1, projectId, deploymentId: sourceDeploymentId, protocol, publishedPort, targetPort: 25565 }], true, null,
      { extraDeployment: sourceDeployment, runtimeStates: [{ projectId, deploymentId: sourceDeploymentId, containerId: "a".repeat(64),
        bindings: [{ protocol, publishedPort, targetPort: 25565 }] }] });
    const response = await f.post("cross-deployment-port", 25566);
    expect(response.statusCode, response.body).toBe(200);
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(f.dispatch.mock.calls[0]?.[0]).toMatchObject({ portTransfer: { sourceDeploymentId,
      sourceContainerId: "a".repeat(64), sourcePreviousBindings: [{ protocol, publishedPort, targetPort: 25565 }], sourceBindings: [] } });
    expect(f.store.reserveTransportPortApply).toHaveBeenCalledWith(expect.objectContaining({ portTransfer: expect.objectContaining({ sourceDeploymentId }) }));
  });

  it("fails closed when the source has no persisted active state or belongs to another agent", async () => {
    const claim = [{ schemaVersion: 1, projectId, deploymentId: sourceDeploymentId, protocol, publishedPort, targetPort: 25565 }];
    const missingState = fixture(claim, true, null, { extraDeployment: sourceDeployment });
    const missing = await missingState.post("transfer-missing-source-state", 25566);
    expect(missing.statusCode).toBe(409);
    expect(missing.json().error.code).toBe("TRANSPORT_PORT_SOURCE_STATE_STALE");
    expect(missingState.dispatch).not.toHaveBeenCalled();

    const foreignAgent = fixture(claim, true, null, { extraDeployment: { ...sourceDeployment, agentId: "agent-other" },
      runtimeStates: [{ projectId, deploymentId: sourceDeploymentId, containerId: "a".repeat(64), bindings: [{ protocol, publishedPort, targetPort: 25565 }] }] });
    const foreign = await foreignAgent.post("transfer-foreign-agent", 25566);
    expect(foreign.statusCode).toBe(409);
    expect(foreign.json().error.code).toBe("TRANSPORT_PORT_SOURCE_UNVERIFIED");
    expect(foreignAgent.dispatch).not.toHaveBeenCalled();
  });
});
