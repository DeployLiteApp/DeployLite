import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeploymentSnapshot, createSourceIntent, deploymentRollbackCommandResultSchema, trustedPriorExecutionReceiptSchema, type CanonicalRole, type Deployment, type DeploymentSnapshotV1 } from "@deploylite/contracts";
import { parseDeployLiteEnv } from "@deploylite/config";
import { AuthenticatedAgentCommandReceiver, DigestDeploymentDispatcher } from "@deploylite/agent";
import { createControlCommand, InMemoryExecutionState, InMemoryProtocolTransport } from "@deploylite/domain";
import { buildApiApp, createInMemoryExecutionRepositories, createRuntimeRepositories } from "./app.js";
import { AuthenticatedAgentDeploymentTransport } from "./agent-transport.js";
import { createPromotionDockerRunner } from "./testing/promotion-docker-runner.js";
const imageA = `registry.example.com/team/app@sha256:${"a".repeat(64)}`, imageH = `registry.example.com/team/app@sha256:${"b".repeat(64)}`, policy = { maxOutageMs: 30_000, maxRecoveryMs: 60_000 };
const apps: Awaited<ReturnType<typeof buildApiApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); vi.restoreAllMocks(); });
async function fixture(options: { preparationTimeoutMs?: number; grantProject?: string; noGrants?: boolean } = {}) {
  const runtime = await createRuntimeRepositories(parseDeployLiteEnv({ NODE_ENV: "test", DEPLOYLITE_BCRYPT_COST: "10" })), memory = createInMemoryExecutionRepositories(runtime.state.projects, runtime.auth.audit), docker = createPromotionDockerRunner();
  const dispatcher = new DigestDeploymentDispatcher({ protocol: new InMemoryProtocolTransport({ clock: { now: Date.now }, leasePolicy: { ttlMs: 120_000 }, retryPolicy: { maxAttempts: 1, deadlineMs: 0, backoffMs: () => 0 }, capabilities: ["deploy.execute"] }), runner: docker.runner, owner: "configured-owner", hostPort: 43000, temporaryHostPort: 43001, containerPort: 3000, trustedHosts: ["registry.example.com"], promotionPolicy: policy, timeoutMs: options.preparationTimeoutMs });
  const records = new Map<string, any>(), bodies: any[] = []; let lose = false, cacheAvailable = true, currentRaw: any, cacheHook: (() => Promise<void>) | undefined;
  let role: CanonicalRole = "admin"; const findUser = runtime.auth.users.findById.bind(runtime.auth.users);
  runtime.auth.users.findById = async (id) => { const user = await findUser(id); return user ? { ...user, role } : null; };
  const replay = { claims: 0, lookups: 0, claim: async function(commandId: string, fingerprint: string) { this.claims++; const old = records.get(commandId); if (old) { if (old.fingerprint !== fingerprint) throw new Error("fingerprint conflict"); return { claimed: false, receipt: old.receipt }; } return { claimed: true, claimToken: "token" }; }, lookup: async function(commandId: string, fingerprint: string) { this.lookups++; const old = records.get(commandId); if (old && old.fingerprint !== fingerprint) throw new Error("fingerprint conflict"); return cacheAvailable ? old?.receipt ?? null : null; }, wait: async () => { throw new Error("unexpected wait"); }, complete: async (commandId: string, value: any) => { records.set(commandId, structuredClone(value)); }, release: async () => {} };
  const receiver = new AuthenticatedAgentCommandReceiver({ agentId: "agent_mock_1", trustKey: "transport_test_key_123", capabilities: ["deploy.execute", "deployment.stop"], dispatcher, stopDispatcher: dispatcher, replayStore: replay, authorityValidator: memory.controls });
  const transport = new AuthenticatedAgentDeploymentTransport({ endpoint: "https://agent.test", agentId: "agent_mock_1", trustKey: "transport_test_key_123", fetch: async (url, init) => {
    const signature = String((init?.headers as Record<string, string>)["x-deploylite-signature"]);
    if (String(url).endsWith("/capabilities")) return new Response(JSON.stringify({ schemaVersion: 1, agentId: receiver.agentId, capabilities: receiver.capabilities, protocolVersions: [1, 2] }), { headers: { "x-deploylite-request-signature": signature } });
    const body = JSON.parse(String(init?.body)); bodies.push(body);
    if (String(url).endsWith("/receipt")) { await cacheHook?.(); return new Response(JSON.stringify(await receiver.readReceipt(body, signature, init?.signal ?? undefined))); }
    const result = await receiver.receive(body, signature, init?.signal ?? undefined); if (lose && body.authority?.action === "deployment.rollback") throw new Error("lost rollback reply"); return new Response(JSON.stringify(result));
  } });
  const snapshots = new Map<string, DeploymentSnapshotV1>();
  const app = await buildApiApp({ env: { NODE_ENV: "test", DEPLOYLITE_BCRYPT_COST: "10" }, auth: runtime.auth, state: { ...runtime.state, deployments: memory.deployments, executionCompletion: memory.completion, controlDeletes: memory.controls, controlRedeploy: memory.controls, controlRollback: memory.controls, deploymentDispatcher: transport, deploymentStopDispatcher: transport, snapshots: { saveSnapshot: async (value) => { snapshots.set(value.hash, structuredClone(value)); }, findByHash: async (hash) => structuredClone(snapshots.get(hash) ?? null) }, controlGrants: { listForActor: async (actorId) => options.noGrants ? [] : ["deployment.rollback", "deployment.redeploy", "deployment.stop"].map((action) => ({ id: `${action}-grant`, actorId, action: action as "deployment.rollback" | "deployment.redeploy" | "deployment.stop", scope: options.grantProject ? { kind: "project" as const, projectId: options.grantProject } : { kind: "platform" as const } })) } } }); app.addHook("onRequest", async (request) => { currentRaw = request.raw; }); apps.push(app);
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "admin@example.test", password: "deploylite-admin-password" } }); expect(login.statusCode).toBe(200); const cookie = login.headers["set-cookie"] as string;
  const initial = await app.inject({ method: "POST", url: "/api/v1/projects/project_mock_1/deployments", headers: { cookie }, payload: { imageReference: imageA, agentId: "agent_mock_1", commitSha: "abcdef1" } }); expect(initial.statusCode, initial.body).toBe(200); const A = initial.json().data.deployment as Deployment; expect(A.executionReceipt).toBeDefined();
  const historicalSnapshot = createDeploymentSnapshot({ schemaVersion: 1, deploymentId: "00000000-0000-4000-8000-000000000005", projectId: A.projectId, agentId: A.agentId!, commitSha: "abcdef2", source: createSourceIntent({ sourceMode: "image", requestedReference: imageH }, { policyVersion: "p1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true }), configRevision: "default", runtimeRevision: "default", runtimePort: 3000, secretRefs: [], policyVersion: "p1" }, { sha256: (bytes) => createHash("sha256").update(bytes).digest("hex") });
  const historicalId = "00000000-0000-4000-8000-000000000004";
  const historicalProof = trustedPriorExecutionReceiptSchema.parse({ schemaVersion: 1, deploymentId: historicalId, projectId: A.projectId, candidateId: `${historicalId}:candidate:deploy_${historicalId}`, snapshotOriginId: historicalSnapshot.deploymentId, snapshotHash: historicalSnapshot.hash, effectiveImageDigest: imageH.split("@")[1], runtimeHost: A.agentId!, container: `deploylite-active-${historicalId}`, containerId: "7".repeat(64), hostPort: 43000, containerPort: 3000, network: null });
  const H: Deployment = { id: historicalId, projectId: A.projectId, agentId: A.agentId, status: "succeeded", commitSha: "abcdef2", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:01:00.000Z", sourceDeploymentId: historicalSnapshot.deploymentId, snapshotOriginId: historicalSnapshot.deploymentId, snapshotHash: historicalSnapshot.hash, executionReceipt: historicalProof, stopTarget: { candidateId: historicalProof.candidateId, effectiveImage: imageH } };
  await memory.deployments.save(H); snapshots.set(historicalSnapshot.hash, historicalSnapshot);
  const request = (key = "rollback", confirmation?: string, activeId = A.id, historicalId = H.id, snapshotHash = H.snapshotHash!, requestId = "original-correlation") => app.inject({ method: "POST", url: `/api/v1/deployments/${activeId}/rollback`, headers: { cookie, "x-request-id": requestId, "x-control-idempotency-key": key, ...(confirmation ? { "x-control-confirmation-id": confirmation } : {}) }, payload: { historicalDeploymentId: historicalId, snapshotHash } });
  return { app, cookie, A, H, snapshots, memory, docker, bodies, replay, transport, dispatcher, request, records, audit: runtime.auth.audit, projects: runtime.state.projects, complete: vi.spyOn(memory.completion, "completeExecution"), setCacheHook: (value: typeof cacheHook) => { cacheHook = value; }, abortCurrent: () => { currentRaw.emit("aborted"); }, setRole: (value: CanonicalRole) => { role = value; }, loseReply: (cache = true) => { lose = true; cacheAvailable = cache; }, enableCache: () => { cacheAvailable = true; } };
}
describe("rollback reserves stable R before confirmation", () => {
  it("returns one server UUID R with A/H/hash before any insertion, effect or confirmation binding change", async () => {
    const f = await fixture(), count = f.docker.calls.length;
    const pending = await f.request(); expect(pending.statusCode, pending.body).toBe(202);
    const command = [...f.memory.completion.commands.values()][0]!; expect(command).toBeDefined(); expect(command.status).toBe("pending_confirmation");
    expect(deploymentRollbackCommandResultSchema.safeParse(command.result).success).toBe(true);
    expect(command.result).toMatchObject({ activeDeploymentId: f.A.id, sourceDeploymentId: f.H.id, snapshotHash: f.H.snapshotHash, status: "pending_confirmation" });
    const R = command.result!.deploymentId!; expect(await f.memory.deployments.findById(R)).toBeNull(); expect(f.docker.calls).toHaveLength(count);
    const retry = await f.request(); expect(retry.statusCode).toBe(202); expect([...f.memory.completion.commands.values()]).toHaveLength(1); expect([...f.memory.completion.commands.values()][0]!.result!.deploymentId).toBe(R);
  });
});

describe("rollback vertical historical candidate and independent active recovery", () => {
  it("confirms exactly the reserved R, observes physical R/H, preserves A/H history and permits normal redeploy lineage from R", async () => {
    const f = await fixture(), before = structuredClone([f.A, f.H]);
    const pending = await f.request(); expect(pending.statusCode).toBe(202); const reserved = pending.json().data.deploymentId;
    const response = await f.request("rollback", pending.json().data.confirmationId); expect(response.statusCode, response.body).toBe(200);
    const R = response.json().data.deployment as Deployment;
    expect(R).toMatchObject({ id: reserved, activeDeploymentId: f.A.id, sourceDeploymentId: f.H.id, snapshotOriginId: f.H.snapshotOriginId, snapshotHash: f.H.snapshotHash, status: "succeeded", executionReceipt: { containerId: f.docker.containers.get(`deploylite-active-${reserved}`)!.id, effectiveImageDigest: imageH.split("@")[1] } });
    expect(f.bodies.find((body) => body.authority?.action === "deployment.rollback")).toMatchObject({ deploymentId: reserved, sourceDeploymentId: f.H.id, activeDeploymentId: f.A.id, authority: { sourceLease: { deploymentId: f.A.id } }, replacement: { prior: f.A.executionReceipt, effectiveImage: imageA } });
    expect(await Promise.all(before.map((value) => f.memory.deployments.findById(value.id)))).toEqual(before);
    expect(f.docker.containers.has(`deploylite-active-${f.H.id}`)).toBe(false);
    const redeploy = (confirmation?: string) => f.app.inject({ method: "POST", url: `/api/v1/deployments/${R.id}/redeploy`, headers: { cookie: f.cookie, "x-control-idempotency-key": "after-R", ...(confirmation ? { "x-control-confirmation-id": confirmation } : {}) }, payload: { snapshotHash: R.snapshotHash } });
    const next = await redeploy(); expect(next.statusCode, next.body).toBe(202); const repeated = await redeploy(next.json().data.confirmationId); expect(repeated.statusCode, repeated.body).toBe(200);
    expect(repeated.json().data.deployment).toMatchObject({ sourceDeploymentId: R.id, snapshotOriginId: f.H.snapshotOriginId, snapshotHash: f.H.snapshotHash });
  });
  it.each(["unhealthy", "partial-cutover"])("preserves/restores active A with its own image and physical identity for %s", async (fault) => {
    const f = await fixture({ preparationTimeoutMs: fault === "unhealthy" ? 20 : undefined }), before = structuredClone([f.A, f.H]); const pending = await f.request(); expect(pending.statusCode).toBe(202); const R = pending.json().data.deploymentId;
    const unhealthyWitness: { name: string; containerId: string; deploymentId: string }[] = [];
    f.docker.setHook(async (argv) => {
      if (fault === "unhealthy" && argv[1] === "inspect") {
        const value = f.docker.containers.get(String(argv.at(-1)));
        if (value && typeof value.labels["com.deploylite.deployment"] === "string" && value.labels["com.deploylite.deployment"] === R && value.hostPort === 43001) {
          unhealthyWitness.push({ name: value.name, containerId: value.id, deploymentId: value.labels["com.deploylite.deployment"]! });
          value.healthy = false;
        }
      }
      if (fault === "partial-cutover" && argv[1] === "run" && argv.includes(`deploylite-active-${R}`)) throw new Error("active-port promotion fault");
    });
    const response = await f.request("rollback", pending.json().data.confirmationId); expect(response.statusCode, response.body).toBe(200); expect(["failed", "canceled"]).toContain(response.json().data.deployment.status); expect(response.json().data.deployment.executionReceipt).toBeUndefined();
    expect(f.docker.containers.get(`deploylite-active-${f.A.id}`)).toMatchObject({ id: f.A.executionReceipt!.containerId, running: true, labels: { "com.deploylite.image": imageA } });
    if (fault === "unhealthy") {
      expect(unhealthyWitness.length).toBeGreaterThan(0);
      expect(unhealthyWitness.every((value) => value.deploymentId === R && value.containerId !== f.A.executionReceipt!.containerId)).toBe(true);
      expect(f.docker.calls.some((argv) => argv[1] === "stop")).toBe(false);
    }
    expect(await Promise.all(before.map((value) => f.memory.deployments.findById(value.id)))).toEqual(before);
  });
});


describe("rollback admission rejects unsupported historical state without reserving effects", () => {
  it.each(["missing-H", "project-H", "failed-H", "no-proof-H", "origin-H", "config-H", "runtime-H", "secret-H", "host-port-H", "container-port-H", "network-H", "agent-H"])("rejects %s before confirmation or candidate effects", async (variant) => {
    const f = await fixture(); const H = f.memory.completion.deployments.get(f.H.id)!, count = f.docker.calls.length;
    if (variant === "missing-H") f.memory.completion.deployments.delete(H.id);
    if (variant === "project-H") H.projectId = "another-project";
    if (variant === "failed-H") H.status = "failed";
    if (variant === "no-proof-H") delete H.executionReceipt;
    if (variant === "origin-H") H.snapshotOriginId = "another-origin";
    if (variant === "host-port-H") H.executionReceipt!.hostPort = 44000;
    if (variant === "container-port-H") H.executionReceipt!.containerPort = 8080;
    if (variant === "network-H") H.executionReceipt!.network = "another-network";
    if (variant === "agent-H") H.agentId = "another-agent";
    if (["config-H", "runtime-H", "secret-H"].includes(variant)) {
      const old = f.snapshots.get(H.snapshotHash!)!, { hash: _hash, canonicalJson: _json, canonicalBytes: _bytes, ...projection } = old;
      const next = createDeploymentSnapshot({ ...projection, ...(variant === "config-H" ? { configRevision: "unsupported-config" } : variant === "runtime-H" ? { runtimeRevision: "unsupported-runtime" } : { secretRefs: [{ secretRefId: "unavailable-history", version: 1 }] }) }, { sha256: (bytes) => createHash("sha256").update(bytes).digest("hex") });
      H.snapshotHash = next.hash; H.executionReceipt!.snapshotHash = next.hash; f.snapshots.set(next.hash, next);
    }
    const response = await f.request("unsupported", undefined, f.A.id, H.id, H.snapshotHash!);
    expect([404, 409]).toContain(response.statusCode); expect(f.docker.calls).toHaveLength(count); expect(f.memory.completion.commands.size).toBe(0);
  });
});


describe("rollback project authority and immutable admission", () => {
  it("admits an operator with the existing project-scoped rollback grant", async () => {
    const f = await fixture({ grantProject: "project_mock_1" }); f.setRole("operator"); const calls = f.docker.calls.length;
    const response = await f.request(); expect(response.statusCode, response.body).toBe(202);
    expect([...f.memory.completion.commands.values()][0]!.scope).toEqual({ kind: "deployment", projectId: f.A.projectId, deploymentId: f.A.id });
    expect(f.docker.calls).toHaveLength(calls);
  });
  it.each(["wrong-project", "no-grant", "read-only", "auditor"])("denies %s before reservation or effects", async (variant) => {
    const f = await fixture({ grantProject: variant === "wrong-project" ? "another-project" : "project_mock_1", noGrants: variant === "no-grant" });
    f.setRole(variant === "read-only" || variant === "auditor" ? variant : "operator"); const calls = f.docker.calls.length;
    expect((await f.request()).statusCode).toBe(403); expect(f.memory.completion.commands.size).toBe(0); expect(f.docker.calls).toHaveLength(calls);
  });
  it.each(["execution", "active", "source", "project", "hash", "origin", "agent", "status"])("rejects changed %s at shared-memory confirmation without consuming it", async (variant) => {
    const f = await fixture(), pending = await f.request(), R = pending.json().data.deploymentId;
    expect(pending.statusCode).toBe(202); const command = [...f.memory.completion.commands.values()][0]!;
    const confirmation = { id: pending.json().data.confirmationId, commandId: command.id, actorId: command.actorId, action: command.action, scope: command.scope, inputDigest: command.inputDigest, classification: "destructive" as const, expiresAt: command.expiresAt, consumedAt: null };
    const deployment: Deployment = { id: R, projectId: f.H.projectId, agentId: f.H.agentId, status: "queued", commitSha: f.H.commitSha, startedAt: new Date().toISOString(), finishedAt: null, activeDeploymentId: f.A.id, sourceDeploymentId: f.H.id, snapshotOriginId: f.H.snapshotOriginId, snapshotHash: f.H.snapshotHash };
    const changed = { ...deployment };
    if (variant === "execution") changed.id = "00000000-0000-4000-8000-000000000099";
    if (variant === "active") changed.activeDeploymentId = f.H.id;
    if (variant === "source") changed.sourceDeploymentId = f.A.id;
    if (variant === "project") changed.projectId = "another-project";
    if (variant === "hash") changed.snapshotHash = "f".repeat(64);
    if (variant === "origin") changed.snapshotOriginId = f.H.id;
    if (variant === "agent") changed.agentId = "another-agent";
    if (variant === "status") changed.status = "running";
    const outcome = await f.memory.controls.executeConfirmedDeploymentRollback({ command, confirmation, deployment: changed, requestId: "invalid-admission" }).then((value) => value.accepted, () => false);
    expect(outcome).toBe(false); expect(await f.memory.deployments.findById(R)).toBeNull(); expect(await f.memory.deployments.findById(changed.id)).toBeNull();
    expect([...f.memory.completion.commands.values()][0]!.status).toBe("pending_confirmation");
    expect((await f.memory.controls.executeConfirmedDeploymentRollback({ command, confirmation, deployment, requestId: "valid-admission" })).accepted).toBe(true);
  });
});


describe("rollback same-command cache, replay and terminal publication", () => {
  it("reconciles an immediate lost reply using original observed R without another claim or effect", async () => {
    const f = await fixture(); f.loseReply(); const pending = await f.request();
    const response = await f.request("rollback", pending.json().data.confirmationId); expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.deployment).toMatchObject({ id: pending.json().data.deploymentId, status: "succeeded", activeDeploymentId: f.A.id, sourceDeploymentId: f.H.id });
    expect(f.replay.claims).toBe(2); expect(f.replay.lookups).toBe(1); expect(f.complete).toHaveBeenCalledOnce();
  });
  it("retries cached evidence with original correlation then replays completed input before deleted dependencies", async () => {
    const f = await fixture(); f.loseReply(false); const pending = await f.request();
    expect((await f.request("rollback", pending.json().data.confirmationId)).statusCode).toBe(502);
    const command = [...f.memory.completion.commands.values()][0]!; expect(command.status).toBe("dispatching"); const effects = f.docker.calls.length, claims = f.replay.claims;
    f.enableCache(); const audit = vi.spyOn(f.audit, "append"), times: string[] = [], outcomes: string[] = [];
    let arrived = 0, release!: () => void; const barrier = new Promise<void>((resolve) => { release = resolve; });
    f.complete.mockImplementation(async (input, signal) => {
      times.push(input.finishedAt); if (++arrived === 1) vi.setSystemTime(Date.now() + 1); else if (arrived === 2) release();
      await barrier; const outcome = await InMemoryExecutionState.prototype.completeExecution.call(f.memory.completion, input, signal); outcomes.push(outcome.kind); return outcome;
    });
    vi.useFakeTimers({ toFake: ["Date"] }); let response!: Awaited<ReturnType<typeof f.request>>;
    try {
      const responses = await Promise.all([f.request("rollback", undefined, f.A.id, f.H.id, f.H.snapshotHash!, "fresh-retry-id"), f.request("rollback", undefined, f.A.id, f.H.id, f.H.snapshotHash!, "fresh-retry-id")]);
      expect(new Set(times.slice(0, 2)).size).toBe(2); expect(responses.map((value) => value.statusCode)).toEqual([200, 200]);
      response = responses[0]!; expect(response.statusCode, response.body).toBe(200); expect(responses[1]!.json().data.deployment).toEqual(response.json().data.deployment);
      expect(outcomes.filter((kind) => kind === "committed")).toHaveLength(1); expect(outcomes).toContain("replayed"); expect((await f.memory.deployments.listLogs(command.result!.deploymentId!)).filter((row) => row.message === "Agent rollback succeeded.")).toHaveLength(1); expect(audit.mock.calls.filter(([event]) => event.action === "deployment.rollback.succeeded" && event.targetId === command.result!.deploymentId)).toHaveLength(1);
    } finally { vi.useRealTimers(); }
    expect(f.bodies.at(-1)).toMatchObject({ activeDeploymentId: f.A.id, sourceDeploymentId: f.H.id, correlationId: command.correlationId });
    expect((await f.memory.deployments.listLogs(command.result!.deploymentId!)).find((row) => row.message === "Agent rollback succeeded.")).toMatchObject({ correlationId: command.correlationId, requestId: "fresh-retry-id" });
    const lookups = f.replay.lookups; await f.memory.deployments.remove(f.H.id); await f.memory.deployments.remove(f.A.id); f.snapshots.clear(); await f.projects.remove(f.A.projectId);
    expect((await f.request()).statusCode).toBe(200); expect(f.replay.lookups).toBe(lookups); expect(f.docker.calls).toHaveLength(effects); expect(f.replay.claims).toBe(claims);
    expect((await f.request("rollback", undefined, f.A.id, "changed-H")).statusCode).toBe(409);
  });
  it("reconciles original cached receipt after storage failure without a second effect or terminal timestamp", async () => {
    const f = await fixture(); f.complete.mockRejectedValueOnce(new Error("terminal storage unavailable")); const pending = await f.request();
    expect((await f.request("rollback", pending.json().data.confirmationId)).statusCode).toBe(500); const effects = f.docker.calls.length, claims = f.replay.claims;
    const response = await f.request(); expect(response.statusCode, response.body).toBe(200); const R = response.json().data.deployment as Deployment;
    expect(R.executionReceipt).toEqual(f.records.get(`deploy_${R.id}`)!.receipt.executionReceipt); expect(R.finishedAt).toBeTruthy();
    expect((await f.request()).statusCode).toBe(200); expect((await f.memory.deployments.findById(R.id))!.finishedAt).toBe(R.finishedAt); expect(f.docker.calls).toHaveLength(effects); expect(f.replay.claims).toBe(claims);
  });
  it.each(["immediate", "retry"])("keeps legal proofless cache success unresolved on %s without generic terminal publication", async (when) => {
    const f = await fixture(); f.loseReply(when === "immediate"); const pending = await f.request();
    if (when === "retry") { expect((await f.request("rollback", pending.json().data.confirmationId)).statusCode).toBe(502); f.enableCache(); }
    f.setCacheHook(async () => { delete f.records.get(`deploy_${pending.json().data.deploymentId}`)!.receipt.executionReceipt; });
    const response = await f.request("rollback", when === "immediate" ? pending.json().data.confirmationId : undefined);
    expect(response.statusCode, response.body).toBe(502); expect(f.complete).not.toHaveBeenCalled();
    expect(await f.memory.deployments.findById(pending.json().data.deploymentId)).toMatchObject({ status: "running", finishedAt: null });
    expect([...f.memory.completion.commands.values()][0]!.status).toBe("dispatching"); expect(f.replay.claims).toBe(2);
  });
  it("fences request abort after cache read before terminal handoff", async () => {
    const f = await fixture(); f.loseReply(false); const pending = await f.request(), R = pending.json().data.deploymentId;
    expect((await f.request("rollback", pending.json().data.confirmationId)).statusCode).toBe(502); f.enableCache();
    let started!: () => void, release!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; }), barrier = new Promise<void>((resolve) => { release = resolve; });
    const find = f.memory.deployments.findById.bind(f.memory.deployments); let paused = false;
    vi.spyOn(f.memory.deployments, "findById").mockImplementation(async (id) => { if (!paused && id === R && f.bodies.filter((body) => body.action === "deploy.execute").length >= 2) { paused = true; started(); await barrier; } return find(id); });
    const beforeLogs = await f.memory.deployments.listLogs(R), effects = f.docker.calls.length, claims = f.replay.claims;
    const response = f.request(); await ready; f.abortCurrent(); release(); await response;
    expect(f.complete).not.toHaveBeenCalled(); expect(await find(R)).toMatchObject({ status: "running", finishedAt: null }); expect(await f.memory.deployments.listLogs(R)).toEqual(beforeLogs); expect(f.docker.calls).toHaveLength(effects); expect(f.replay.claims).toBe(claims);
  });
  it.each(["expired", "superseded"])("preserves cached R running and command dispatching when %s inside atomic completion", async (fault) => {
    const f = await fixture(); f.loseReply(false); const pending = await f.request(), R = pending.json().data.deploymentId;
    expect((await f.request("rollback", pending.json().data.confirmationId)).statusCode).toBe(502); f.enableCache();
    f.complete.mockImplementationOnce(async (input, signal) => { const current = [...f.memory.completion.commands.values()][0]!; if (fault === "expired") current.executionAuthority!.projectLease.expiresAt = Date.now() - 1; else f.memory.completion.commands.set("successor", { ...structuredClone(current), id: "successor", executionAuthority: { ...structuredClone(current.executionAuthority!), commandId: "successor", projectLease: { ...current.executionAuthority!.projectLease, fence: current.executionAuthority!.projectLease.fence + 1 } } }); return InMemoryExecutionState.prototype.completeExecution.call(f.memory.completion, input, signal); });
    const response = await f.request(); expect(response.statusCode, response.body).toBe(409); const persisted = await f.memory.deployments.findById(R); expect(persisted).toMatchObject({ status: "running", finishedAt: null }); expect(persisted!.executionReceipt).toBeUndefined(); expect([...f.memory.completion.commands.values()][0]!.status).toBe("dispatching"); expect((await f.memory.deployments.listLogs(R)).some((row) => row.message === "Agent rollback succeeded.")).toBe(false);
  });
});


describe("rollback reviewed retry interleavings", () => {
  it.each(["expired", "consumed", "actor", "scope"])("never returns or refreshes an original confirmation that is %s", async (variant) => {
    const f = await fixture(), original = (await f.request()).json().data, command = [...f.memory.completion.commands.values()][0]!;
    const confirmation = { id: original.confirmationId, commandId: command.id, actorId: command.actorId, action: command.action, scope: command.scope, inputDigest: command.inputDigest, classification: "destructive" as const, expiresAt: command.expiresAt, consumedAt: null as Date | null };
    if (variant === "expired") confirmation.expiresAt = new Date(Date.now() - 1);
    if (variant === "consumed") confirmation.consumedAt = new Date();
    if (variant === "actor") confirmation.actorId = "other-actor";
    if (variant === "scope") confirmation.scope = { kind: "deployment", projectId: f.A.projectId, deploymentId: f.H.id };
    await f.memory.controls.bind(confirmation); const effects = f.docker.calls.length;
    const retry = await f.request(); expect(retry.statusCode).toBe(409); expect(retry.json().error.code).toBe("CONFIRMATION_REJECTED");
    expect((await f.request()).statusCode).toBe(409);
    expect(f.docker.calls).toHaveLength(effects); expect(f.memory.completion.commands.size).toBe(1);
    expect(await f.memory.deployments.findById(original.deploymentId)).toBeNull();
  });

  it("recovers the original confirmation after a lost first 202 and executes the same R once", async () => {
    const f = await fixture(), first = await f.request(), original = first.json().data;
    expect(first.statusCode).toBe(202);
    const retry = await f.request("rollback", undefined, f.A.id, f.H.id, f.H.snapshotHash!, "fresh-retry");
    expect(retry.json().data).toEqual(original);
    const response = await f.request("rollback", retry.json().data.confirmationId);
    expect(response.statusCode, response.body).toBe(200); expect(response.json().data.deployment.id).toBe(original.deploymentId);
    expect(f.memory.completion.commands.size).toBe(1); expect(f.complete).toHaveBeenCalledOnce(); expect(f.replay.claims).toBe(2);
  });
  it("converges concurrent pending retries on the original confirmation and R", async () => {
    const f = await fixture(); const responses = await Promise.all([f.request(), f.request()]);
    expect(responses.map((response) => response.statusCode)).toEqual([202, 202]);
    const original = responses[0]!.json().data; expect(original.confirmationId).toBeTruthy();
    expect(responses[1]!.json().data).toEqual(original); expect(f.memory.completion.commands.size).toBe(1);
    expect(f.replay.claims).toBe(1); expect(await f.memory.deployments.findById(original.deploymentId)).toBeNull();
  });
  it("recovers a reservation-to-bind fault without allocating another R or extending expiry", async () => {
    const f = await fixture(), resolve = f.memory.controls.resolve.bind(f.memory.controls);
    vi.spyOn(f.memory.controls, "resolve").mockImplementationOnce(async (command) => { await resolve(command); throw new Error("fault after durable reservation before confirmation bind"); });
    expect((await f.request()).statusCode).toBe(500);
    const original = structuredClone([...f.memory.completion.commands.values()][0]!);
    const recovered = await f.request(); expect(recovered.statusCode).toBe(202);
    expect(recovered.json().data).toMatchObject({ commandId: original.id, deploymentId: original.result!.deploymentId, confirmationRequired: true, correlationId: original.correlationId });
    expect(recovered.json().data.confirmationId).toBeTruthy(); expect((await f.request()).json().data).toEqual(recovered.json().data);
    expect([...f.memory.completion.commands.values()][0]!.expiresAt).toEqual(original.expiresAt);
    expect((await f.request("rollback", recovered.json().data.confirmationId)).statusCode).toBe(200); expect(f.complete).toHaveBeenCalledOnce();
  });
  it("resumes only the queued unclaimed R after project contention, with one effect across concurrent retries", async () => {
    const f = await fixture(), pending = await f.request(), original = pending.json().data;
    const blocker = createControlCommand({ actorId: "blocker", action: "deployment.stop", scope: { kind: "deployment", projectId: f.A.projectId, deploymentId: f.A.id }, input: {}, idempotencyKey: "other-stop", correlationId: "other-correlation" });
    blocker.status = "eligible"; f.memory.completion.commands.set(blocker.id, blocker);
    expect((await f.memory.controls.claimDeploymentStop(blocker)).claimed).toBe(true);
    expect((await f.request("rollback", original.confirmationId)).statusCode).toBe(202);
    const admitted = [...f.memory.completion.commands.values()].find((value) => value.id === original.commandId)!;
    expect(admitted.status).toBe("eligible"); expect(admitted.executionAuthority).toBeUndefined();
    expect(await f.memory.deployments.findById(original.deploymentId)).toMatchObject({ status: "queued", finishedAt: null });
    expect(f.replay.claims).toBe(1); blocker.status = "completed";
    const responses = await Promise.all([f.request(), f.request()]);
    expect(responses.some((response) => response.statusCode === 200)).toBe(true);
    expect(await f.memory.deployments.findById(original.deploymentId)).toMatchObject({ status: "succeeded", activeDeploymentId: f.A.id, sourceDeploymentId: f.H.id });
    expect(f.complete).toHaveBeenCalledOnce(); expect(f.replay.claims).toBe(2); expect([...f.memory.completion.commands.values()].find((value) => value.id === original.commandId)!.status).toBe("completed");
    expect((await f.request()).statusCode).toBe(200); expect(f.replay.claims).toBe(2);
  });
  it("retries a claim fault before commit without consuming confirmation or inserting R again", async () => {
    const f = await fixture(), pending = await f.request(), original = pending.json().data;
    const admit = vi.spyOn(f.memory.controls, "executeConfirmedDeploymentRollback");
    vi.spyOn(f.memory.controls, "claimDeploymentRollback").mockRejectedValueOnce(new Error("claim failed before commit"));
    expect((await f.request("rollback", original.confirmationId)).statusCode).toBe(500);
    expect(await f.memory.deployments.findById(original.deploymentId)).toMatchObject({ status: "queued" });
    const response = await f.request(); expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.deployment.id).toBe(original.deploymentId); expect(admit).toHaveBeenCalledOnce();
    expect(f.complete).toHaveBeenCalledOnce(); expect(f.replay.claims).toBe(2);
  });
});
