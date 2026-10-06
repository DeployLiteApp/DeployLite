import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeploymentSnapshot, type Deployment, type DeploymentSnapshotV1, TransportTimeoutError, TransportCanceledError } from "@deploylite/contracts";
import { createHash } from "node:crypto";
import { parseDeployLiteEnv, signAgentTransport } from "@deploylite/config";
import { AuthenticatedAgentCommandReceiver, DigestDeploymentDispatcher } from "@deploylite/agent";
import { InMemoryExecutionState, InMemoryProtocolTransport } from "@deploylite/domain";
import { AuthenticatedAgentDeploymentTransport } from "./agent-transport.js";
import { buildApiApp, createInMemoryExecutionRepositories, createRuntimeRepositories } from "./app.js";
import { createPromotionDockerRunner } from "./testing/promotion-docker-runner.js";
const policy = { maxOutageMs: 30_000, maxRecoveryMs: 60_000 }, image = `registry.example.com/team/app@sha256:${"b".repeat(64)}`;
const apps: Awaited<ReturnType<typeof buildApiApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); vi.restoreAllMocks(); });
async function fixture(options?: { stopFault?: "lost" | "timeout" | "canceled" | "invalid"; alternateInitial?: boolean; initialStatus?: number; configureInitial?: (value: { app: Awaited<ReturnType<typeof buildApiApp>>; memory: ReturnType<typeof createInMemoryExecutionRepositories>; docker: ReturnType<typeof createPromotionDockerRunner>; cookie: string; dispatcher: DigestDeploymentDispatcher }) => (() => Promise<void>) }) {
  const runtime = await createRuntimeRepositories(parseDeployLiteEnv({ NODE_ENV: "test", DEPLOYLITE_BCRYPT_COST: "10" }));
  const memory = createInMemoryExecutionRepositories(runtime.state.projects, runtime.auth.audit), docker = createPromotionDockerRunner();
  const dispatcher = new DigestDeploymentDispatcher({ protocol: new InMemoryProtocolTransport({ clock: { now: Date.now }, leasePolicy: { ttlMs: 120_000 }, retryPolicy: { maxAttempts: 1, deadlineMs: 0, backoffMs: () => 0 }, capabilities: ["deploy.execute"] }), runner: docker.runner, owner: "configured-owner", hostPort: 43000, temporaryHostPort: 43001, containerPort: 3000, trustedHosts: ["registry.example.com"], promotionPolicy: policy });
  const settled = new Map<string, { fingerprint: string; receipt: Record<string, unknown> }>();
  const receiver = new AuthenticatedAgentCommandReceiver({ agentId: "agent_mock_1", trustKey: "transport_test_key_123", capabilities: ["deploy.execute", "deployment.stop"], dispatcher, stopDispatcher: dispatcher, authorityValidator: memory.controls, replayStore: { claim: async (id, fingerprint) => { const old = settled.get(id); if (old) { if (old.fingerprint !== fingerprint) throw new Error("replay conflict"); return { claimed: false, receipt: old.receipt }; } return { claimed: true, claimToken: "claim" }; }, wait: async () => { throw new Error("unexpected wait"); }, complete: async (id, value) => { settled.set(id, structuredClone(value)); }, release: async () => {} } });
  const bodies: any[] = []; let loseReply = false;
  const transport = new AuthenticatedAgentDeploymentTransport({ endpoint: "https://agent.test", agentId: "agent_mock_1", trustKey: "transport_test_key_123", fetch: async (url, init) => {
    const signature = String((init?.headers as Record<string, string>)["x-deploylite-signature"]);
    if (String(url).endsWith("/capabilities")) { expect(receiver.verifyRequest("GET /capabilities", signature)).toBe(true); return new Response(JSON.stringify({ schemaVersion: 1, agentId: receiver.agentId, capabilities: receiver.capabilities, protocolVersions: [1, 2] }), { headers: { "x-deploylite-request-signature": signature } }); }
    const body = JSON.parse(String(init?.body)); let requestSignature = signature;
    if (body.schemaVersion === 1 && !body.action && options?.alternateInitial) {
      const { hash: _hash, canonicalJson: _json, canonicalBytes: _bytes, ...projection } = body.snapshot;
      const alternate = createDeploymentSnapshot({ ...projection, configRevision: "validly-signed-other-config" }, { sha256: (bytes) => createHash("sha256").update(bytes).digest("hex") });
      body.snapshot = { ...alternate, canonicalBytes: undefined }; body.snapshotHash = alternate.hash;
      requestSignature = signAgentTransport(JSON.stringify(body), "transport_test_key_123");
      expect(receiver.verifyRequest(JSON.stringify(body), requestSignature)).toBe(true);
    }
    bodies.push(body); const result = await receiver.receive(body, requestSignature, init?.signal ?? undefined); if (body.action === "deployment.stop" && options?.stopFault) { if (options.stopFault === "timeout") throw new TransportTimeoutError(); if (options.stopFault === "canceled") throw new TransportCanceledError(); if (options.stopFault === "lost") throw new Error("Stop reply lost after effects"); result.agentId = "other-agent"; } if (body.schemaVersion === 2 && loseReply) throw new Error("reply lost after effects"); return new Response(JSON.stringify(result));
  } });
  const snapshots = new Map<string, DeploymentSnapshotV1>(); const complete = vi.spyOn(memory.completion, "completeExecution");
  const app = await buildApiApp({ env: { NODE_ENV: "test", DEPLOYLITE_BCRYPT_COST: "10" }, auth: runtime.auth, state: { ...runtime.state, deployments: memory.deployments, executionCompletion: memory.completion, controlDeletes: memory.controls, controlRedeploy: memory.controls, deploymentDispatcher: transport, deploymentStopDispatcher: transport, snapshots: { saveSnapshot: async (value) => { snapshots.set(value.hash, structuredClone(value)); }, findByHash: async (hash) => structuredClone(snapshots.get(hash) ?? null) }, controlGrants: { listForActor: async (actorId) => ["deployment.redeploy", "deployment.stop"].map((action) => ({ id: `${action}-grant`, actorId, action: action as "deployment.redeploy" | "deployment.stop", scope: { kind: "platform" as const } })) } } }); apps.push(app);
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "admin@example.test", password: "deploylite-admin-password" } }); expect(login.statusCode).toBe(200); const cookie = login.headers["set-cookie"] as string;
  const duringInitial = options?.configureInitial?.({ app, memory, docker, cookie, dispatcher });
  const initialRequest = app.inject({ method: "POST", url: "/api/v1/projects/project_mock_1/deployments", headers: { cookie }, payload: { imageReference: image, agentId: "agent_mock_1", commitSha: "abcdef1" } });
  await duringInitial?.(); const initial = await initialRequest;
  expect(initial.statusCode, initial.body).toBe(options?.initialStatus ?? 200); const A = initial.statusCode === 200 ? initial.json().data.deployment as Deployment : (await memory.deployments.list()).find((value) => value.snapshotHash)!; if (initial.statusCode === 200) expect(A.executionReceipt).toBeDefined(); complete.mockClear();
  const request = (action: "stop" | "redeploy", id: string, key: string, confirmation?: string) => app.inject({ method: "POST", url: `/api/v1/deployments/${id}/${action}`, headers: { cookie, "x-control-idempotency-key": key, ...(confirmation ? { "x-control-confirmation-id": confirmation } : {}) }, ...(action === "redeploy" ? { payload: { snapshotHash: A.snapshotHash } } : {}) });
  const confirm = async (action: "stop" | "redeploy", id = A.id, key: string = action) => { const pending = await request(action, id, key); expect(pending.statusCode, pending.body).toBe(202); expect(pending.json().data.confirmationRequired).toBe(true); return () => request(action, id, key, pending.json().data.confirmationId); };
  return { app, A, memory, docker, bodies, complete, request, confirm, loseReply: () => { loseReply = true; } };
}
describe("API signed promotion and shared execute-stop authority", () => {
  it("rejects validly signed alternative INITIAL canonical configuration against the persisted execution before effects", async () => {
    const f = await fixture({ alternateInitial: true, initialStatus: 502 });
    expect(f.bodies[0].snapshotHash).not.toBe(f.A.snapshotHash);
    expect(f.docker.calls).toEqual([]); expect(f.A.executionReceipt).toBeUndefined();
  });
  it.each(["before-executor", "before-promotion"])("fences a paused INITIAL candidate %s after confirmed Stop so no late workload or success appears", async (stage) => {
    let stoppedId = "", cutoff = 0;
    const f = await fixture({ initialStatus: 409, configureInitial: ({ app, memory, docker, cookie, dispatcher }) => {
      let prepared!: () => void, resume!: () => void;
      const ready = new Promise<void>((resolve) => { prepared = resolve; }), barrier = new Promise<void>((resolve) => { resume = resolve; });
      const dispatch = dispatcher.dispatch.bind(dispatcher);
      if (stage === "before-executor") vi.spyOn(dispatcher, "dispatch").mockImplementation(async (...args) => { prepared(); await barrier; return dispatch(...args); });
      else docker.setHook(async (argv) => { if (argv[1] === "inspect" && String(argv[argv.indexOf("--format") + 1]).includes("com.deploylite.owner") && !String(argv[argv.indexOf("--format") + 1]).includes("com.deploylite.project")) { prepared(); await barrier; } });
      return async () => {
        await ready; const A = (await memory.deployments.list()).find((value) => value.snapshotHash)!; stoppedId = A.id;
        const request = (confirmation?: string) => app.inject({ method: "POST", url: `/api/v1/deployments/${A.id}/stop`, headers: { cookie, "x-control-idempotency-key": "stop-initial", ...(confirmation ? { "x-control-confirmation-id": confirmation } : {}) } });
        const pending = await request(); expect(pending.statusCode, pending.body).toBe(202);
        const stopped = await request(pending.json().data.confirmationId);
        expect(stopped.statusCode, stopped.body).toBe(stage === "before-executor" ? 409 : 200);
        if (stage === "before-executor") expect(stopped.json().error.code).toBe("DEPLOY_STOP_NOT_CONFIRMED");
        expect([...memory.completion.commands.values()][0]?.executionAuthority?.executionLease.deploymentId).toBe(A.id);
        cutoff = docker.calls.length; resume();
      };
    } });
    expect(f.docker.containers.has(`deploylite-active-${stoppedId}`)).toBe(false);
    expect(f.A.executionReceipt).toBeUndefined(); expect(f.A.status).not.toBe("succeeded");
    expect(f.docker.calls.slice(cutoff).some((argv) => ["run", "rename", "start"].includes(argv[1]!))).toBe(false);
  });
  it("stops trusted active A without rewriting its historical succeeded status or proof", async () => {
    const f = await fixture(), before = structuredClone(f.A);
    const response = await (await f.confirm("stop"))(); expect(response.statusCode, response.body).toBe(200);
    expect(await f.memory.deployments.findById(f.A.id)).toEqual(before);
    expect(f.docker.containers.get(`deploylite-active-${f.A.id}`)?.running).toBe(false);
    expect([...f.memory.completion.commands.values()][0]).toMatchObject({ status: "completed", result: { reason: "stopped" } });
  });
  it("composes actual shared claim, signed receiver, executor, inspected CLI and atomic B proof; stopping active B preserves its immutable success history", async () => {
    const f = await fixture(), historicalA = structuredClone(f.A);
    const response = await (await f.confirm("redeploy"))(); expect(response.statusCode, response.body).toBe(200); const B = response.json().data.deployment as Deployment;
    const command = [...f.memory.completion.commands.values()][0]!;
    expect(f.bodies.at(-1)).toMatchObject({ authority: command.executionAuthority, replacement: { prior: f.A.executionReceipt, policy } });
    expect(f.docker.containers.get(`deploylite-active-${f.A.id}`)?.running).toBe(false);
    expect(f.docker.containers.get(`deploylite-active-${B.id}`)).toMatchObject({ running: true, hostPort: 43000, id: B.executionReceipt!.containerId });
    expect(B.executionReceipt!.containerId).not.toBe(f.A.executionReceipt!.containerId); expect(f.complete).toHaveBeenCalledOnce();
    expect(await f.memory.deployments.findById(f.A.id)).toEqual(historicalA);
    const immutable = structuredClone(B), stop = await (await f.confirm("stop", B.id, "stop-B"))(); expect(stop.statusCode, stop.body).toBe(200);
    expect(await f.memory.deployments.findById(B.id)).toEqual(immutable); expect(f.docker.containers.get(`deploylite-active-${B.id}`)?.running).toBe(false);
    expect(f.bodies.at(-1)).toMatchObject({ authority: { action: "deployment.stop", executionLease: { deploymentId: B.id, fence: command.executionAuthority!.projectLease.fence + 1 } } });
    const effects = f.docker.calls.length; expect((await f.request("stop", B.id, "stop-B")).statusCode).toBe(200); expect(f.docker.calls).toHaveLength(effects);
  });
  it("leaves the old workload healthy and B running/unresolved when the persisted claim is changed before cutover", async () => {
    const f = await fixture(); f.docker.setHook(async (argv) => { if (argv[1] === "run" && argv.includes("127.0.0.1:43001:3000")) { const command = [...f.memory.completion.commands.values()][0]!; command.executionAuthority!.projectLease.leaseId = "changed-owner"; } });
    const response = await (await f.confirm("redeploy"))(); expect(response.statusCode).toBe(409); expect(f.complete).not.toHaveBeenCalled();
    const B = (await f.memory.deployments.list()).find((value) => value.sourceDeploymentId === f.A.id)!; expect(B.status).toBe("running"); expect(B.executionReceipt).toBeUndefined();
    expect(f.docker.containers.get(`deploylite-active-${f.A.id}`)?.running).toBe(true); expect(f.docker.calls.some((argv) => argv[1] === "stop")).toBe(false);
    expect([...f.memory.completion.commands.values()][0]?.status).toBe("dispatching");
  });
  it.each(["expired", "superseded"])("rejects %s authority at atomic completion after the API guard without publishing terminal state", async (fault) => {
    const f = await fixture();
    f.complete.mockImplementationOnce(async (input) => {
      const commands = [...f.memory.completion.commands.values()], current = commands[0]!;
      if (fault === "expired") current.executionAuthority!.projectLease.expiresAt = Date.now() - 1;
      else f.memory.completion.commands.set("newer", { ...structuredClone(current), id: "newer", executionAuthority: { ...structuredClone(current.executionAuthority!), commandId: "newer", projectLease: { ...current.executionAuthority!.projectLease, fence: current.executionAuthority!.projectLease.fence + 1 } } });
      return InMemoryExecutionState.prototype.completeExecution.call(f.memory.completion, input);
    });
    const response = await (await f.confirm("redeploy"))(); expect(response.statusCode, response.body).toBe(409);
    const B = (await f.memory.deployments.list()).find((value) => value.sourceDeploymentId === f.A.id)!;
    expect(B.status).toBe("running"); expect(B.executionReceipt).toBeUndefined();
    expect([...f.memory.completion.commands.values()][0]?.status).toBe("dispatching");
    expect(f.docker.containers.get(`deploylite-active-${B.id}`)?.running).toBe(true);
  });
  it("excludes stop A during prepared replacement B and replays B without another effect", async () => {
    const f = await fixture(), confirmB = await f.confirm("redeploy"), confirmStopA = await f.confirm("stop", f.A.id, "race-stop-A");
    let prepared!: () => void, resume!: () => void;
    const preparation = new Promise<void>((resolve) => { prepared = resolve; }), barrier = new Promise<void>((resolve) => { resume = resolve; });
    f.docker.setHook(async (argv) => { if (argv[1] === "run" && argv.includes("127.0.0.1:43001:3000")) { prepared(); await barrier; } });
    const replacement = confirmB(); await preparation;
    const raced = await confirmStopA(); expect(raced.statusCode, raced.body).toBe(202);
    expect(f.docker.calls.some((argv) => argv[1] === "stop")).toBe(false);
    expect(f.docker.containers.get(`deploylite-active-${f.A.id}`)?.running).toBe(true);
    resume(); const response = await replacement; expect(response.statusCode, response.body).toBe(200);
    const effects = f.docker.calls.length;
    expect((await f.request("redeploy", f.A.id, "redeploy")).statusCode).toBe(200);
    expect(f.docker.calls).toHaveLength(effects);
    expect([...f.memory.completion.commands.values()].find((command) => command.action === "deployment.stop")?.status).toBe("eligible");
  });
  it("keeps transport failure unresolved rather than releasing destructive authority without terminal recovery evidence", async () => {
    const f = await fixture(); f.loseReply();
    const response = await (await f.confirm("redeploy"))(); expect(response.statusCode).toBe(502);
    const B = (await f.memory.deployments.list()).find((value) => value.sourceDeploymentId === f.A.id)!;
    expect(f.complete).not.toHaveBeenCalled(); expect(B.status).toBe("running"); expect(B.executionReceipt).toBeUndefined();
    expect([...f.memory.completion.commands.values()][0]?.status).toBe("dispatching");
    expect(f.docker.containers.get(`deploylite-active-${B.id}`)?.running).toBe(true);
  });
});


describe("unresolved Stop preserves project exclusion", () => {
  it.each(["lost", "timeout", "canceled", "invalid"] as const)("retains Stop authority and immutable history after %s terminal evidence", async (stopFault) => {
    const f = await fixture({ stopFault }), before = structuredClone(f.A);
    const response = await (await f.confirm("stop"))();
    expect(response.statusCode, response.body).toBe(502); expect(response.json().error.code).toBe("DEPLOY_STOP_OUTCOME_UNKNOWN");
    const stop = [...f.memory.completion.commands.values()][0]!;
    expect(stop.status).toBe("dispatching"); expect(stop.result).toBeUndefined(); expect(stop.executionAuthority).toBeDefined();
    expect(await f.memory.deployments.findById(f.A.id)).toEqual(before);
    const effects = f.docker.calls.length; const competing = await (await f.confirm("redeploy", f.A.id, "competing"))();
    expect(competing.statusCode, competing.body).toBe(202); expect(f.docker.calls).toHaveLength(effects);
    expect([...f.memory.completion.commands.values()].find((value) => value.action === "deployment.redeploy")?.status).toBe("eligible");
  });
});


it.each(["expired", "superseded"])("does not publish Stop success when %s authority wins before command completion", async (fault) => {
  const f = await fixture(), before = structuredClone(f.A), complete = f.memory.controls.completeDeploymentStop.bind(f.memory.controls);
  vi.spyOn(f.memory.controls, "completeDeploymentStop").mockImplementationOnce(async (command, result) => {
    const current = [...f.memory.completion.commands.values()].find((value) => value.id === command.id)!;
    if (fault === "expired") current.executionAuthority!.projectLease.expiresAt = Date.now() - 1;
    else f.memory.completion.commands.set("newer", { ...structuredClone(current), id: "newer", executionAuthority: { ...structuredClone(current.executionAuthority!), commandId: "newer", projectLease: { ...current.executionAuthority!.projectLease, fence: current.executionAuthority!.projectLease.fence + 1 } } });
    return complete(command, result);
  });
  const response = await (await f.confirm("stop"))();
  expect(response.statusCode, response.body).toBe(409); expect(response.json().error.code).toBe("DEPLOY_STOP_OUTCOME_UNKNOWN");
  expect(await f.memory.deployments.findById(f.A.id)).toEqual(before);
  expect([...f.memory.completion.commands.values()][0]?.status).toBe("dispatching");
  expect((await f.memory.deployments.listLogs(f.A.id)).some((event) => event.message === "Authenticated agent stop confirmed.")).toBe(false);
});
