import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TransportCanceledError, type Deployment, type DeploymentSnapshotV1 } from "@deploylite/contracts";
import { parseDeployLiteEnv } from "@deploylite/config";
import { AuthenticatedAgentCommandReceiver, DigestDeploymentDispatcher } from "@deploylite/agent";
import { InMemoryProtocolTransport, type ExecutionCompletionInput, type ExecutionCompletionOutcome } from "@deploylite/domain";
import { createPromotionDockerRunner } from "./testing/promotion-docker-runner.js";
import { AuthenticatedAgentDeploymentTransport } from "./agent-transport.js";
import { buildApiApp, createInMemoryExecutionRepositories, createRuntimeRepositories, InMemoryAuthUserRepository, type DeploymentDispatcher } from "./app.js";

const digest = `sha256:${"b".repeat(64)}`;
const image = `registry.example.com/team/lineage@${digest}`;
const apps: Awaited<ReturnType<typeof buildApiApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); vi.restoreAllMocks(); });

function observedAgent(controls: ReturnType<typeof createInMemoryExecutionRepositories>["controls"]) {
  const docker = createPromotionDockerRunner(), calls = docker.calls, bodies: any[] = [], receipts = new Map<string, any>(), settled = new Map<string, any>();
  const dispatcher = new DigestDeploymentDispatcher({ hostPort: 43000, temporaryHostPort: 43001, containerPort: 3000, owner: "configured-owner", trustedHosts: ["registry.example.com"], promotionPolicy: { maxOutageMs: 30_000, maxRecoveryMs: 60_000 }, protocol: new InMemoryProtocolTransport({ clock: { now: Date.now }, leasePolicy: { ttlMs: 30000 }, retryPolicy: { maxAttempts: 1, deadlineMs: 0, backoffMs: () => 0 }, capabilities: ["deploy.execute"] }), runner: docker.runner });
  const receiver = new AuthenticatedAgentCommandReceiver({ agentId: "agent_mock_1", trustKey: "transport_test_key_123", capabilities: ["deploy.execute"], dispatcher, authorityValidator: controls, replayStore: { claim: async (id, fingerprint) => { const prior = settled.get(id); if (prior) { if (prior.fingerprint !== fingerprint) throw new Error("replay conflict"); return { claimed: false, receipt: prior.receipt }; } return { claimed: true, claimToken: "claim" }; }, wait: async (id) => settled.get(id).receipt, complete: async (id, value) => { settled.set(id, structuredClone(value)); }, release: async () => {} } });
  const transport = new AuthenticatedAgentDeploymentTransport({ endpoint: "https://agent.test", agentId: "agent_mock_1", trustKey: "transport_test_key_123", fetch: async (url, init) => {
    const signature = String((init?.headers as Record<string, string>)["x-deploylite-signature"]);
    if (String(url).endsWith("/capabilities")) { expect(receiver.verifyRequest("GET /capabilities", signature)).toBe(true); return new Response(JSON.stringify({ schemaVersion: 1, agentId: receiver.agentId, capabilities: receiver.capabilities, protocolVersions: [1, 2] }), { headers: { "x-deploylite-request-signature": signature } }); }
    const body = JSON.parse(String(init?.body)); bodies.push(body); const receipt = await receiver.receive(body, signature); receipts.set(body.deploymentId, receipt); return new Response(JSON.stringify(receipt));
  } });
  return { transport, calls, bodies, receipts };
}

async function fixture(legacyInitial = false) {
  const runtime = await createRuntimeRepositories(parseDeployLiteEnv({ NODE_ENV: "test", DEPLOYLITE_BCRYPT_COST: "10" }));
  const admin = (await runtime.auth.users.findByEmail("admin@example.test"))!;
  const auth = { ...runtime.auth, users: new InMemoryAuthUserRepository([admin, { ...admin, id: "different-actor", email: "other@example.test", emailNormalized: "other@example.test" }]) };
  const memory = createInMemoryExecutionRepositories(runtime.state.projects, runtime.auth.audit), agent = observedAgent(memory.controls), snapshots = new Map<string, DeploymentSnapshotV1>();
  let grantsEnabled = true, available = true;
  let dispatch: DeploymentDispatcher["dispatch"] = async (...args) => { const result = await agent.transport.dispatch(...args); if (legacyInitial) { const { executionReceipt, ...legacy } = result; return legacy; } return result; };
  let fault: ((input: ExecutionCompletionInput) => Promise<ExecutionCompletionOutcome>) | undefined;
  const complete = vi.fn((input: ExecutionCompletionInput) => fault ? fault(input) : memory.completion.completeExecution(input));
  const save = vi.spyOn(memory.deployments, "save"), separate = vi.spyOn(memory.controls, "completeDeploymentRedeploy");
  const app = await buildApiApp({ env: { NODE_ENV: "test", DEPLOYLITE_BCRYPT_COST: "10" }, auth, state: { ...runtime.state, deployments: memory.deployments, controlDeletes: memory.controls, controlRedeploy: memory.controls, executionCompletion: { completeExecution: complete }, deploymentDispatcher: { available: () => available, dispatch: (...args) => dispatch(...args) }, snapshots: { saveSnapshot: async (value) => { snapshots.set(value.hash, structuredClone(value)); }, findByHash: async (hash) => structuredClone(snapshots.get(hash) ?? null) }, controlGrants: { listForActor: async (actorId) => grantsEnabled ? [{ id: "redeploy-grant", actorId, action: "deployment.redeploy", scope: { kind: "platform" } }] : [] } } }); apps.push(app);
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "admin@example.test", password: "deploylite-admin-password" } }); expect(login.statusCode).toBe(200); const cookie = login.headers["set-cookie"] as string;
  const initial = await app.inject({ method: "POST", url: "/api/v1/projects/project_mock_1/deployments", headers: { cookie, "x-deployment-idempotency-key": "initial-A" }, payload: { imageReference: image, agentId: "agent_mock_1", commitSha: "abcdef1" } }); expect(initial.statusCode, initial.body).toBe(200);
  const A = initial.json().data.deployment as Deployment; if (!legacyInitial) expect(A.executionReceipt).toMatchObject({ deploymentId: A.id, snapshotOriginId: A.id, containerId: createHash("sha256").update(`physical-${A.id}`).digest("hex") });
  complete.mockClear(); save.mockClear();
  const request = (sourceId: string, key: string, confirmationId?: string, hash = A.snapshotHash!) => app.inject({ method: "POST", url: `/api/v1/deployments/${sourceId}/redeploy`, headers: { cookie, "x-control-idempotency-key": key, ...(confirmationId ? { "x-control-confirmation-id": confirmationId } : {}) }, payload: { snapshotHash: hash } });
  const admit = async (sourceId = A.id, key = "redeploy-B") => { const pending = await request(sourceId, key); expect(pending.statusCode, pending.body).toBe(202); expect(pending.json().data.confirmationRequired).toBe(true); return () => request(sourceId, key, pending.json().data.confirmationId); };
  return { app, memory, runtime, agent, snapshots, A, cookie, complete, save, separate, request, admit, setDispatch: (value: typeof dispatch) => { dispatch = value; }, setFault: (value: typeof fault) => { fault = value; }, disableDependencies: async () => { grantsEnabled = false; available = false; snapshots.clear(); await runtime.state.projects.remove(A.projectId); } };
}

describe("repeated redeploy lineage and atomic command completion", () => {
  it("composes INITIAL A to B to C with distinct observed identities and one immutable origin/hash/config", async () => {
    const f = await fixture();
    const Bresponse = await (await f.admit())(); expect(Bresponse.statusCode, Bresponse.body).toBe(200); const B = Bresponse.json().data.deployment as Deployment;
    expect(f.complete).toHaveBeenCalledOnce(); expect(B).toMatchObject({ status: "succeeded", sourceDeploymentId: f.A.id, snapshotOriginId: f.A.id, snapshotHash: f.A.snapshotHash, executionReceipt: f.agent.receipts.get(B.id).receipt.executionReceipt });
    const Cresponse = await (await f.admit(B.id, "redeploy-C"))(); expect(Cresponse.statusCode, Cresponse.body).toBe(200); const C = Cresponse.json().data.deployment as Deployment;
    expect(C).toMatchObject({ status: "succeeded", sourceDeploymentId: B.id, snapshotOriginId: f.A.id, snapshotHash: f.A.snapshotHash, executionReceipt: { snapshotOriginId: f.A.id, snapshotHash: f.A.snapshotHash, effectiveImageDigest: digest, runtimeHost: "agent_mock_1", containerPort: 3000, hostPort: 43000, network: null } });
    expect(new Set([f.A, B, C].map((value) => value.executionReceipt!.containerId)).size).toBe(3);
    expect(f.agent.bodies.at(-1)).toMatchObject({ schemaVersion: 2, deploymentId: C.id, sourceDeploymentId: B.id, snapshot: { deploymentId: f.A.id, hash: f.A.snapshotHash, configRevision: "default", runtimeRevision: "default" } });
    expect(f.complete.mock.calls.at(-1)?.[0]).toMatchObject({ commandId: Cresponse.json().data.command.commandId, sourceExecutionId: B.id, snapshotOriginId: f.A.id, commandResult: { status: "completed", sourceDeploymentId: B.id, deploymentId: C.id }, proof: C.executionReceipt });
    const command = await f.memory.controls.findByIdempotency([...f.memory.completion.commands.values()][0]!.actorId, "redeploy-C"); expect(command).toMatchObject({ status: "completed", result: { deploymentId: C.id } });
    expect(f.separate).not.toHaveBeenCalled(); expect(f.save.mock.calls.some(([value]) => ["succeeded", "failed", "canceled"].includes(value.status))).toBe(false);
    const logs = await f.app.inject({ method: "GET", url: `/api/v1/deployments/${C.id}/logs/stream`, headers: { cookie: f.cookie } }); expect(logs.body).toContain('"status":"succeeded"'); expect(logs.body).toContain("Agent redeploy succeeded."); expect(logs.body.indexOf("event: deployment.log")).toBeLessThan(logs.body.indexOf("event: deployment.status"));
    const effectCount = f.agent.calls.length, completions = f.complete.mock.calls.length; await f.memory.deployments.remove(B.id); await f.disableDependencies();
    const replay = await f.request(B.id, "redeploy-C"); expect(replay.statusCode, replay.body).toBe(200); expect(replay.json().data.idempotent).toBe(true);
    expect((await f.request(B.id, "redeploy-C", undefined, "c".repeat(64))).statusCode).toBe(409); expect((await f.request(f.A.id, "redeploy-C")).statusCode).toBe(409);
    expect((await f.request(B.id, "different-key")).statusCode).toBe(404);
    const other = await f.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "other@example.test", password: "deploylite-admin-password" } }); expect(other.statusCode).toBe(200);
    const foreignReplay = await f.app.inject({ method: "POST", url: `/api/v1/deployments/${B.id}/redeploy`, headers: { cookie: other.headers["set-cookie"] as string, "x-control-idempotency-key": "redeploy-C" }, payload: { snapshotHash: f.A.snapshotHash } }); expect(foreignReplay.statusCode).toBe(404);
    expect(f.agent.calls).toHaveLength(effectCount); expect(f.complete).toHaveBeenCalledTimes(completions);
  });

  it.each([["conflict", 409], ["not-found", 404], ["storage", 500]] as const)("preserves running execution and dispatching command when atomic completion is %s", async (kind, status) => {
    const f = await fixture(); f.setFault(async () => { if (kind === "storage") throw new Error("storage fault"); return { kind }; });
    const response = await (await f.admit())(); expect(response.statusCode, response.body).toBe(status); expect(f.complete).toHaveBeenCalledOnce();
    const B = (await f.memory.deployments.list()).find((value) => value.sourceDeploymentId === f.A.id)!; expect(B).toMatchObject({ status: "running", finishedAt: null }); expect(B.executionReceipt).toBeUndefined();
    expect([...f.memory.completion.commands.values()][0]).toMatchObject({ status: "dispatching", result: { status: "eligible" } }); expect(f.separate).not.toHaveBeenCalled();
    expect(f.save.mock.calls.map(([value]) => value.status)).toEqual(["queued", "running"]);
    const logs = await f.app.inject({ method: "GET", url: `/api/v1/deployments/${B.id}/logs/stream`, headers: { cookie: f.cookie } }); expect(logs.body).not.toContain('"status":"succeeded"'); expect(logs.body).not.toContain("Agent redeploy succeeded.");
  });

  it.each(["failed", "canceled", "transport error"] as const)("handles %s without invented proof or separate command save", async (kind) => {
    const f = await fixture(); f.setDispatch(async (snapshot, commandId, context) => { if (kind === "transport error") throw new TransportCanceledError(); const received = await f.agent.transport.dispatch(snapshot, commandId, context); const { executionReceipt, ...terminal } = received; return { ...terminal, proven: false, terminalStatus: kind, health: "failed" }; });
    const response = await (await f.admit())(); expect(response.statusCode, response.body).toBe(kind === "transport error" ? 502 : 200);
    const B = (await f.memory.deployments.list()).find((value) => value.sourceDeploymentId === f.A.id)!;
    if (kind === "transport error") {
      // With active-port replacement, transport loss cannot establish terminal recovery.
      expect(f.complete).not.toHaveBeenCalled(); expect(B.status).toBe("running"); expect([...f.memory.completion.commands.values()][0]?.status).toBe("dispatching");
    } else {
      expect(f.complete).toHaveBeenCalledOnce(); expect(f.complete.mock.calls[0]?.[0]).toMatchObject({ proof: null, terminalStatus: kind, commandResult: { status: "completed" } });
      expect(B.status).toBe(kind); expect([...f.memory.completion.commands.values()][0]?.status).toBe("completed");
    }
    expect(B.executionReceipt).toBeUndefined(); expect(f.separate).not.toHaveBeenCalled();
  });

  it.each([["missing", null], ["origin", { snapshotOriginId: "immediate-B" }], ["host", { runtimeHost: "wrong-agent" }], ["digest", { effectiveImageDigest: `sha256:${"c".repeat(64)}` }], ["candidate", { candidateId: "wrong" }], ["configuration", { hostPort: 44000 }]] as const)("rejects %s proof before any terminal or command publication", async (_field, patch) => {
    const f = await fixture(); f.setDispatch(async (...args) => { const received = await f.agent.transport.dispatch(...args); return { ...received, executionReceipt: patch ? { ...received.executionReceipt!, ...patch } : undefined }; });
    const response = await (await f.admit())(); expect(response.statusCode, response.body).toBe(502); expect(f.complete).not.toHaveBeenCalled(); expect(f.separate).not.toHaveBeenCalled();
    const B = (await f.memory.deployments.list()).find((value) => value.sourceDeploymentId === f.A.id)!; expect(B).toMatchObject({ status: "running", finishedAt: null }); expect(B.executionReceipt).toBeUndefined();
  });

  it("leaves running intact when the actual shared ledger loses its command before completion", async () => {
    const f = await fixture(); f.setDispatch(async (...args) => { const received = await f.agent.transport.dispatch(...args); f.memory.completion.commands.clear(); return received; });
    const response = await (await f.admit())(); expect(response.statusCode).toBe(404); await expect(f.complete.mock.results[0]?.value).resolves.toEqual({ kind: "not-found" });
    const B = (await f.memory.deployments.list()).find((value) => value.sourceDeploymentId === f.A.id)!; expect(B).toMatchObject({ status: "running", finishedAt: null }); expect(B.executionReceipt).toBeUndefined(); expect(f.separate).not.toHaveBeenCalled();
  });

  it("keeps legacy success readable but ineligible for trusted redeploy", async () => {
    const f = await fixture(true); expect(f.A.status).toBe("succeeded"); expect(f.A.executionReceipt).toBeUndefined(); const effects = f.agent.calls.length;
    const response = await f.request(f.A.id, "legacy"); expect(response.statusCode).toBe(409); expect(f.agent.calls).toHaveLength(effects); expect(f.memory.completion.commands.size).toBe(0);
  });

  it.each([{ snapshotOriginId: "wrong-origin" }, { snapshotHash: "c".repeat(64) }, { agentId: "wrong-agent" }])("rejects immutable source binding corruption %j before command admission", async (patch) => {
    const f = await fixture(); const find = f.memory.deployments.findById.bind(f.memory.deployments); vi.spyOn(f.memory.deployments, "findById").mockImplementation(async (id) => id === f.A.id ? { ...f.A, ...patch } : find(id));
    const response = await f.request(f.A.id, "corrupt"); expect(response.statusCode).toBe(409); expect(f.memory.completion.commands.size).toBe(0); expect(f.complete).not.toHaveBeenCalled();
  });

  it("reconciles already committed equal completion with durable finishedAt and no duplicate effects", async () => {
    const f = await fixture(), finishedAt = "2026-10-04T16:00:00.000Z";
    f.setDispatch(async (...args) => { const received = await f.agent.transport.dispatch(...args); const command = [...f.memory.completion.commands.values()][0]!; const eligible = command.result as any;
      const committed = await f.memory.completion.completeExecution({ commandId: command.id, authority: command.executionAuthority, commandResult: { ...eligible, status: "completed" }, expectedStatus: "running", executionId: received.deploymentId, projectId: f.A.projectId, sourceExecutionId: f.A.id, snapshotOriginId: f.A.id, snapshotHash: f.A.snapshotHash!, runtimeHost: "agent_mock_1", effectiveImageDigest: digest, terminalStatus: "succeeded", finishedAt, proof: received.executionReceipt! }); expect(committed.kind).toBe("committed"); return received;
    });
    const response = await (await f.admit())(); expect(response.statusCode, response.body).toBe(200); expect(response.json().data.deployment.finishedAt).toBe(finishedAt); expect(f.complete.mock.calls[0]?.[0].finishedAt).toBe(finishedAt); await expect(f.complete.mock.results[0]?.value).resolves.toMatchObject({ kind: "replayed" }); expect(f.separate).not.toHaveBeenCalled();
  });
});


it("generates PostgreSQL-compatible UUID INITIAL/redeploy IDs and replays the same initial key without another execution", async () => {
  const f = await fixture(); const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  expect(f.A.id).toMatch(uuid);
  const calls = f.agent.calls.length;
  const replay = await f.app.inject({ method: "POST", url: "/api/v1/projects/project_mock_1/deployments", headers: { cookie: f.cookie, "x-deployment-idempotency-key": "initial-A" }, payload: { imageReference: image, agentId: "agent_mock_1", commitSha: "abcdef1" } });
  expect(replay.statusCode, replay.body).toBe(200); expect(replay.json().data.deployment.id).toBe(f.A.id); expect(f.agent.calls).toHaveLength(calls);
  const B = await (await f.admit())(); expect(B.statusCode, B.body).toBe(200); expect(B.json().data.deployment.id).toMatch(uuid);
  expect(B.json().data.deployment.snapshotOriginId).toBe(f.A.id);
  const logs = [...await f.memory.deployments.listLogs(f.A.id), ...await f.memory.deployments.listLogs(B.json().data.deployment.id)];
  expect(logs.length).toBeGreaterThan(0); expect(logs.every((event) => uuid.test(event.id))).toBe(true);
});
