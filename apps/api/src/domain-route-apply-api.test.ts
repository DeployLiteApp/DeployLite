import Fastify, { type preHandlerAsyncHookHandler } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { domainRouteApplyReceiptSchema, trustedPriorExecutionReceiptSchema, type DomainRouteApplyReceiptV1 } from "@deploylite/contracts";
import { claimProjectUpdateAuthority, validateProjectUpdateAuthority,
  type ControlCommand, type DomainRouteApplyCompletionInput, type DomainRoutePlanV1 } from "@deploylite/domain";
import { registerDomainRouteApplyRoute, type DomainRouteApplyAgentTransport } from "./domain-route-apply-route.js";

const projectId = "project-1", deploymentId = "deployment-1", agentId = "agent-1", domain = "app.example.test";
const effectiveImage = `registry.example.com/team/app@sha256:${"b".repeat(64)}`;
const trustedReceipt = trustedPriorExecutionReceiptSchema.parse({
  schemaVersion: 1, candidateId: `${deploymentId}:candidate:command-1`, deploymentId, projectId, snapshotOriginId: deploymentId,
  snapshotHash: "a".repeat(64), effectiveImageDigest: `sha256:${"b".repeat(64)}`, runtimeHost: agentId,
  container: `deploylite-active-${deploymentId}`, containerId: "c".repeat(64), hostPort: 43000, containerPort: 3000, network: "bridge"
});
const deployment = {
  id: deploymentId, projectId, agentId, status: "succeeded", commitSha: "abcdef1", startedAt: "2026-10-09T00:00:00.000Z",
  finishedAt: "2026-10-09T00:01:00.000Z", snapshotHash: trustedReceipt.snapshotHash, snapshotOriginId: deploymentId,
  stopTarget: { candidateId: trustedReceipt.candidateId, effectiveImage }, executionReceipt: trustedReceipt
};
const project = { id: projectId, name: "fixture", repoUrl: "https://github.com/example/app", defaultBranch: "main", buildCommand: null,
  runCommand: null, port: null, description: null, imageTag: null };

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.restoreAllMocks(); });

function fixture(claims: unknown[] = [], authorized = true, rollbackTarget: unknown = {
  schemaVersion: 1, id: "revision-a", projectId, domain, deploymentId, revisionNumber: 1, operation: "baseline",
  rollbackRevisionId: null, commandId: null, correlationId: null, createdAt: "2026-10-08T00:00:00.000Z",
  evidence: { state: "baseline", contentDigest: null, observedAt: null, redacted: true }
}, runtimeState: unknown = null) {
  const commandById = new Map<string, ControlCommand>();
  const commandIdByKey = new Map<string, string>();
  const reservations = new Map<string, { commandId: string; route: unknown; plan: DomainRoutePlanV1; operation: "apply" | "rollback"; rollbackRevisionId: string | null }>();
  const revisionsByCommand = new Map<string, unknown>();
  const auditEvents: unknown[] = [];
  const keyOf = (actorId: string, key: string) => `${actorId}:${projectId}:${key}`;
  const controls = {
    resolve: vi.fn(async (command: ControlCommand) => {
      const key = keyOf(command.actorId, command.idempotencyKey), currentId = commandIdByKey.get(key);
      if (currentId) {
        const current = commandById.get(currentId)!;
        if (current.inputDigest !== command.inputDigest) throw new Error("idempotency conflict");
        return { command: structuredClone(current), created: false };
      }
      commandById.set(command.id, structuredClone(command)); commandIdByKey.set(key, command.id);
      return { command: structuredClone(command), created: true };
    }),
    complete: vi.fn(async (command: ControlCommand) => command),
    findProjectUpdateByIdempotency: vi.fn(async (actorId: string, _scopeProject: string, key: string) => {
      const id = commandIdByKey.get(keyOf(actorId, key));
      return id ? structuredClone(commandById.get(id)!) : null;
    }),
    claimProjectUpdate: vi.fn(async (command: ControlCommand) => {
      const current = commandById.get(command.id)!;
      const authority = claimProjectUpdateAuthority([...commandById.values()], current, Date.now());
      return { command: structuredClone(current), claimed: Boolean(authority), ...(authority ? { authority: structuredClone(authority) } : {}) };
    }),
    validateProjectUpdateAuthority: vi.fn(async (authority: import("@deploylite/contracts").ProjectControlAuthorityV1) =>
      validateProjectUpdateAuthority([...commandById.values()], authority, Date.now())),
    completeProjectUpdate: vi.fn(async (command: ControlCommand) => command)
  };
  const claimsReader = { available: () => true, listClaims: vi.fn(async () => structuredClone(claims)) };
  const store = {
    available: () => true,
    findRollbackTarget: vi.fn(async () => rollbackTarget as never),
    findDomainRouteRevisionByCommand: vi.fn(async (commandId: string) => (revisionsByCommand.get(commandId) ?? null) as never),
    findDomainRouteReservation: vi.fn(async (commandId: string) => {
      const row = [...reservations.values()].find(item => item.commandId === commandId);
      return row ? { commandId, route: structuredClone(row.route) as never, plan: structuredClone(row.plan), operation: row.operation, rollbackRevisionId: row.rollbackRevisionId } : null;
    }),
    reserveDomainRouteApply: vi.fn(async ({ command, route, plan, operation, rollbackRevisionId }: { command: ControlCommand; route: unknown; plan: DomainRoutePlanV1; operation: "apply" | "rollback"; rollbackRevisionId: string | null }) => {
      const previous = reservations.get(domain);
      if (previous && previous.commandId !== command.id) throw new Error("domain conflict");
      reservations.set(domain, { commandId: command.id, route: structuredClone(route), plan: structuredClone(plan), operation, rollbackRevisionId });
    }),
    releaseDomainRouteApply: vi.fn(async (commandId: string) => {
      if (reservations.get(domain)?.commandId === commandId) reservations.delete(domain);
    }),
    completeDomainRouteApply: vi.fn(async (input: DomainRouteApplyCompletionInput) => {
      expect(reservations.get(domain)?.commandId).toBe(input.command.id);
      auditEvents.push(structuredClone(input.audit));
      const completed = { ...input.command, status: "completed" as const, result: structuredClone(input.receipt) };
      commandById.set(completed.id, structuredClone(completed));
      if (input.operation === "rollback" && input.receipt.state !== "failed") revisionsByCommand.set(input.command.id, {
        schemaVersion: 1, id: "revision-restored", projectId, domain, deploymentId: input.route.deploymentId, revisionNumber: 2,
        operation: "rollback", rollbackRevisionId: input.rollbackRevisionId, commandId: input.command.id,
        correlationId: input.command.correlationId, createdAt: "2026-10-09T00:02:00.000Z",
        evidence: { state: input.receipt.state, contentDigest: input.receipt.contentDigest, observedAt: input.receipt.observedAt, redacted: true }
      });
      return structuredClone(completed);
    })
  };
  const dispatch = vi.fn(async (prepared: { command: ControlCommand; route: { projectId: string; deploymentId: string; domain: string } }): Promise<DomainRouteApplyReceiptV1> =>
    domainRouteApplyReceiptSchema.parse({
      schemaVersion: 1, action: "domain.route.apply", agentId, commandId: prepared.command.id, projectId: prepared.route.projectId,
      domain: prepared.route.domain, deploymentId: prepared.route.deploymentId, inputDigest: prepared.command.inputDigest,
      correlationId: prepared.command.correlationId, networkName: `deploylite-project-${"d".repeat(24)}`, networkId: "e".repeat(64),
      targetContainerId: trustedReceipt.containerId, traefikContainerId: "f".repeat(64),
      fileName: `domain-route-${"1".repeat(24)}.yml`, contentDigest: "2".repeat(64), state: "created", observedAt: Date.now(),
      failureReason: null, redacted: true
    }));
  const transport: DomainRouteApplyAgentTransport = { available: () => true, dispatchDomainRouteApply: dispatch,
    readDomainRouteApplyReceipt: vi.fn(async () => null) };
  const audit = { append: vi.fn(async (event: unknown) => { auditEvents.push(structuredClone(event)); return event as never; }) };
  const requireAuth: preHandlerAsyncHookHandler = async request => {
    const raw = request as unknown as { auth: unknown; correlationContext: unknown };
    raw.auth = { user: { id: "actor-1", role: "operator" } };
    raw.correlationContext = { requestId: "request-1", correlationId: "correlation-1" };
  };
  const app = Fastify() as any;
  registerDomainRouteApplyRoute(app, { prefix: "/api/v1", projects: { findById: vi.fn(async () => project) } as never,
    deployments: { findById: vi.fn(async () => deployment) } as never, claims: claimsReader as never, applyStore: store as never, transportRuntime: { available: () => true, findTransportPortRuntimeState: async () => runtimeState } as never,
    executions: new Map([[projectId, { controls: controls as never, transport, commandTtlMs: 30_000, agentId }]]),
    grants: { listForActor: vi.fn(async (actorId: string) => authorized ? [{ id: "grant-1", actorId, action: "project.update", scope: { kind: "project", projectId } }] : []) } as never,
    audit: audit as never, requireAuth, requireRole: (async () => {}) as preHandlerAsyncHookHandler,
    ok: (_request: unknown, data: unknown) => ({ data, error: null }),
    error: (_request: unknown, code: string, message: string) => ({ data: null, error: { code, message } }) } as never);
  apps.push(app);
  const post = (key = "apply-1") => app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/domains/apply`,
    headers: { "x-control-idempotency-key": key }, payload: { domain, deploymentId } });
  const postRollback = (key = "rollback-1") => app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/domains/rollback`,
    headers: { "x-control-idempotency-key": key }, payload: { domain } });
  return { app, post, postRollback, dispatch, controls, claimsReader, store, reservations, commandById, auditEvents };
}

describe("project domain route apply API", () => {
  it("applies a trusted route through project.update and durably replays its terminal receipt", async () => {
    const f = fixture();
    const first = await f.post();
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().data).toMatchObject({ applied: true, idempotent: false, receipt: { state: "created" } });
    expect(f.controls.claimProjectUpdate).toHaveBeenCalledOnce();
    expect(f.store.reserveDomainRouteApply).toHaveBeenCalledOnce();
    expect(f.auditEvents).toContainEqual(expect.objectContaining({ action: "domain.route.applied", targetId: projectId }));

    const replay = await f.post();
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().data).toMatchObject({ applied: true, idempotent: true, receipt: { state: "created" } });
    expect(f.dispatch).toHaveBeenCalledOnce();
  });

  it("reconciles a no-op database claim through the agent so missing file-provider state can be repaired", async () => {
    const f = fixture([{ schemaVersion: 1, projectId, deploymentId, domain }]);
    const response = await f.post("repair-existing");
    expect(response.statusCode, response.body).toBe(200);
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(f.store.reserveDomainRouteApply).toHaveBeenCalledWith(expect.objectContaining({ plan: expect.objectContaining({ action: "no-op" }) }));
    expect(response.json().data.applied).toBe(true);
  });

  it("rejects unauthorized requests before reading claims or contacting the agent", async () => {
    const f = fixture([], false);
    const response = await f.post("denied-1");
    expect(response.statusCode).toBe(403);
    expect(f.claimsReader.listClaims).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("rolls back to the latest prior domain revision through project.update and replays correlated evidence", async () => {
    const f = fixture([{ schemaVersion: 1, projectId, deploymentId: "deployment-b", domain }]);
    const response = await f.postRollback();
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({
      operation: "rollback", rolledBack: true, rollbackRevisionId: "revision-a", routeRevisionId: "revision-restored",
      route: { projectId, deploymentId, domain }, receipt: { state: "created", correlationId: "correlation-1" }, idempotent: false
    });
    expect(f.store.reserveDomainRouteApply).toHaveBeenCalledWith(expect.objectContaining({
      operation: "rollback", rollbackRevisionId: "revision-a", plan: expect.objectContaining({ action: "retarget", previousDeploymentId: "deployment-b" })
    }));
    expect(f.auditEvents).toContainEqual(expect.objectContaining({ action: "domain.route.rolled_back", correlationId: "correlation-1" }));
    const replay = await f.postRollback();
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().data).toMatchObject({ operation: "rollback", rolledBack: true, rollbackRevisionId: "revision-a", idempotent: true });
    expect(f.dispatch).toHaveBeenCalledOnce();
  });

  it("fails closed when no prior route revision is available", async () => {
    const f = fixture([{ schemaVersion: 1, projectId, deploymentId: "deployment-b", domain }], true, null);
    const response = await f.postRollback();
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("DOMAIN_ROUTE_NO_ROLLBACK");
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("rejects an unauthorized rollback before reading revision state", async () => {
    const f = fixture([{ schemaVersion: 1, projectId, deploymentId: "deployment-b", domain }], false);
    const response = await f.postRollback();
    expect(response.statusCode).toBe(403);
    expect(f.store.findRollbackTarget).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  });
});

it("binds subsequent domain apply to the durable transport replacement identity", async () => {
 const current = "d".repeat(64), f = fixture([], true, undefined, {projectId, deploymentId, containerId: current, bindings: []});
 expect((await f.post()).statusCode).toBe(200);
 expect((f.dispatch.mock.calls[0]![0] as any).executionReceipt.containerId).toBe(current);
});

it.each([
 {projectId: "foreign", deploymentId, containerId: "d".repeat(64), bindings: []},
 {projectId, deploymentId: "foreign", containerId: "d".repeat(64), bindings: []},
 {projectId, deploymentId, containerId: "invalid", bindings: []}
])("rejects invalid durable replacement identity before dispatch", async state => {
 const f = fixture([], true, undefined, state);
 expect((await f.post()).statusCode).toBe(503); expect(f.dispatch).not.toHaveBeenCalled();
});
