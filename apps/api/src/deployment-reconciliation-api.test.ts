import { afterEach, describe, expect, it, vi } from "vitest";
import type { Deployment, DeploymentSnapshotV1 } from "@deploylite/contracts";
import { parseDeployLiteEnv } from "@deploylite/config";
import { AuthenticatedAgentCommandReceiver, DigestDeploymentDispatcher } from "@deploylite/agent";
import { InMemoryExecutionState, InMemoryProtocolTransport } from "@deploylite/domain";
import { AuthenticatedAgentDeploymentTransport } from "./agent-transport.js";
import { buildApiApp, createInMemoryExecutionRepositories, createRuntimeRepositories } from "./app.js";
import { createPromotionDockerRunner } from "./testing/promotion-docker-runner.js";
const image = `registry.example.com/team/app@sha256:${"b".repeat(64)}`, policy = { maxOutageMs: 30_000, maxRecoveryMs: 60_000 };
const apps: Awaited<ReturnType<typeof buildApiApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); vi.restoreAllMocks(); });
async function fixture() {
  const runtime = await createRuntimeRepositories(parseDeployLiteEnv({ NODE_ENV: "test", DEPLOYLITE_BCRYPT_COST: "10" }));
  const memory = createInMemoryExecutionRepositories(runtime.state.projects, runtime.auth.audit), docker = createPromotionDockerRunner();
  const dispatcher = new DigestDeploymentDispatcher({ protocol: new InMemoryProtocolTransport({ clock: { now: Date.now }, leasePolicy: { ttlMs: 120_000 }, retryPolicy: { maxAttempts: 1, deadlineMs: 0, backoffMs: () => 0 }, capabilities: ["deploy.execute"] }), runner: docker.runner, owner: "configured-owner", hostPort: 43000, temporaryHostPort: 43001, containerPort: 3000, trustedHosts: ["registry.example.com"], promotionPolicy: policy });
  const records = new Map<string, { fingerprint: string; receipt: Record<string, unknown> }>();
  let cache = true, queryHook: (() => Promise<void>) | undefined, currentRaw: any, lose: "redeploy" | "stop" | "initial" | undefined;
  const claim = vi.fn(async (id: string, fingerprint: string) => { const old = records.get(id); if (old) { if (old.fingerprint !== fingerprint) throw new Error("replay conflict"); return { claimed: false, receipt: old.receipt }; } return { claimed: true, claimToken: "claim" }; });
  const wait = vi.fn(async () => { throw new Error("must not wait"); }), release = vi.fn(async () => {});
  const lookup = vi.fn(async (id: string, fingerprint: string) => { const old = records.get(id); if (!cache || !old) return null; if (old.fingerprint !== fingerprint) throw new Error("replay conflict"); return structuredClone(old.receipt); });
  const receiver = new AuthenticatedAgentCommandReceiver({ agentId: "agent_mock_1", trustKey: "transport_test_key_123", capabilities: ["deploy.execute", "deployment.stop"], dispatcher, stopDispatcher: dispatcher, authorityValidator: memory.controls, replayStore: { lookup, claim, wait, release, complete: async (id, value) => { records.set(id, structuredClone(value)); } } });
  const queries: any[] = [], bodies: any[] = [];
  const transport = new AuthenticatedAgentDeploymentTransport({ endpoint: "https://agent.test", agentId: "agent_mock_1", trustKey: "transport_test_key_123", fetch: async (url, init) => {
    const signature = String((init?.headers as Record<string, string>)["x-deploylite-signature"]);
    if (String(url).endsWith("/capabilities")) return new Response(JSON.stringify({ schemaVersion: 1, agentId: receiver.agentId, capabilities: receiver.capabilities, protocolVersions: [1, 2] }), { headers: { "x-deploylite-request-signature": signature } });
    const body = JSON.parse(String(init?.body));
    if (String(url).endsWith("/receipt")) { queries.push(body); await queryHook?.(); return new Response(JSON.stringify(await receiver.readReceipt(body, signature, init?.signal ?? undefined))); }
    bodies.push(body); const result = await receiver.receive(body, signature, init?.signal ?? undefined);
    if ((lose === "redeploy" && body.schemaVersion === 2) || (lose === "stop" && body.action === "deployment.stop") || (lose === "initial" && body.schemaVersion === 1 && !body.action)) throw new Error("reply lost after observed effects");
    return new Response(JSON.stringify(result));
  } });
  const snapshots = new Map<string, DeploymentSnapshotV1>(), complete = vi.spyOn(memory.completion, "completeExecution"), stopComplete = vi.spyOn(memory.controls, "completeDeploymentStop");
  const app = await buildApiApp({ env: { NODE_ENV: "test", DEPLOYLITE_BCRYPT_COST: "10" }, auth: runtime.auth, state: { ...runtime.state, deployments: memory.deployments, executionCompletion: memory.completion, controlDeletes: memory.controls, controlRedeploy: memory.controls, deploymentDispatcher: transport, deploymentStopDispatcher: transport, snapshots: { saveSnapshot: async (value) => { snapshots.set(value.hash, structuredClone(value)); }, findByHash: async (hash) => structuredClone(snapshots.get(hash) ?? null) }, controlGrants: { listForActor: async (actorId) => ["deployment.redeploy", "deployment.stop"].map((action) => ({ id: action, actorId, action: action as "deployment.redeploy" | "deployment.stop", scope: { kind: "platform" as const } })) } } }); app.addHook("onRequest", async (request) => { currentRaw = request.raw; }); apps.push(app);
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "admin@example.test", password: "deploylite-admin-password" } }); expect(login.statusCode).toBe(200); const cookie = login.headers["set-cookie"] as string;
  const initial = (key: string) => app.inject({ method: "POST", url: "/api/v1/projects/project_mock_1/deployments", headers: { cookie, "x-deployment-idempotency-key": key, "x-request-id": "original-correlation" }, payload: { imageReference: image, agentId: "agent_mock_1", commitSha: "abcdef1" } });
  const first = await initial("initial-A"); expect(first.statusCode, first.body).toBe(200); const A = first.json().data.deployment as Deployment; expect(A.executionReceipt).toBeDefined(); complete.mockClear();
  const request = (action: "stop" | "redeploy", key: string, confirmation?: string, correlationId = "original-correlation", hash = A.snapshotHash!, id = A.id) => app.inject({ method: "POST", url: `/api/v1/deployments/${id}/${action}`, headers: { cookie, "x-control-idempotency-key": key, "x-request-id": correlationId, ...(confirmation ? { "x-control-confirmation-id": confirmation } : {}) }, ...(action === "redeploy" ? { payload: { snapshotHash: hash } } : {}) });
  const confirm = async (action: "stop" | "redeploy", key = action) => { const pending = await request(action, key); expect(pending.statusCode, pending.body).toBe(202); return () => request(action, key, pending.json().data.confirmationId); };
  return { setQueryHook: (value: typeof queryHook) => { queryHook = value; }, abortCurrent: () => { currentRaw.emit("aborted"); }, app, runtime, memory, docker, records, snapshots, complete, stopComplete, claim, wait, release, lookup, queries, bodies, A, request, confirm, initial, setCache: (value: boolean) => { cache = value; }, lose: (value: typeof lose) => { lose = value; } };
}

it("reads the Stop action from the existing persisted command ledger without matching same-key redeploy", async () => {
  const { createDbClient, DbControlCommandRepository } = await import("@deploylite/db");
  const { createRequire } = await import("node:module"); const { getTableColumns } = createRequire(new URL("../../../packages/db/package.json", import.meta.url))("drizzle-orm"); const { controlCommands } = await import("../../../packages/db/src/schema.js");
  const calls: unknown[][] = []; const row: Record<string, unknown> = { id: "stop-command", actorUserId: "actor", action: "deployment.stop", scopeKind: "deployment", scopeKey: JSON.stringify(["project", "A"]), inputDigest: "digest", idempotencyKey: "shared-key", correlationId: "original-correlation", status: "completed", result: null, executionAuthority: null, expiresAt: new Date(), createdAt: new Date(), updatedAt: new Date() };
  const client = { query: async (_query: unknown, values: unknown[] = []) => { calls.push(values); return { rows: values.includes("deployment.stop") ? [Object.keys(getTableColumns(controlCommands)).map((field) => row[field])] : [] }; } };
  const repository = new DbControlCommandRepository(createDbClient(client as never));
  expect(await (repository.findByIdempotency as any)("actor", "shared-key", "deployment.stop")).toMatchObject({ id: "stop-command", action: "deployment.stop", actorId: "actor" });
  expect(calls).toEqual([["actor", "deployment.stop", "shared-key", 1]]);
});

it("reconciles INITIAL lost reply from deploy_UUID and immutable snapshot without a new command or lease", async () => {
  const f = await fixture(); f.docker.containers.clear(); f.lose("initial"); const response = await f.initial("initial-lost"); expect(response.statusCode, response.body).toBe(200);
  const initial = response.json().data.deployment as Deployment; expect(initial.status).toBe("succeeded"); expect(initial.executionReceipt).toBeDefined(); expect(f.queries.at(-1)).toMatchObject({ action: "deploy.execute", commandId: `deploy_${initial.id}`, sourceDeploymentId: null, authority: null, replacement: null }); expect(f.memory.completion.commands.size).toBe(0);
  const claims = f.claim.mock.calls.length, effects = f.docker.calls.length; expect((await f.initial("initial-lost")).json().data.deployment.finishedAt).toBe(initial.finishedAt); expect(f.claim).toHaveBeenCalledTimes(claims); expect(f.docker.calls).toHaveLength(effects);
});
it("leaves INITIAL unknown running then reads its original cache on same-key retry without another effect", async () => {
  const f = await fixture(); f.docker.containers.clear(); f.lose("initial"); f.setCache(false); const lost = await f.initial("initial-delayed"); expect(lost.statusCode, lost.body).toBe(502);
  const execution = (await f.memory.deployments.list()).find((row) => row.id !== f.A.id && row.snapshotHash)!; expect(execution.status).toBe("running"); expect(execution.executionReceipt).toBeUndefined(); const effects = f.docker.calls.length, claims = f.claim.mock.calls.length;
  f.setCache(true); const replay = await f.initial("initial-delayed"); expect(replay.statusCode, replay.body).toBe(200); expect(replay.json().data.deployment.executionReceipt).toEqual(f.records.get(`deploy_${execution.id}`)!.receipt.executionReceipt); expect(f.docker.calls).toHaveLength(effects); expect(f.claim).toHaveBeenCalledTimes(claims); expect(f.queries.at(-1)).toMatchObject({ correlationId: "original-correlation", snapshotHash: execution.snapshotHash });
});
it("reconciles cached INITIAL failure truthfully without requiring a success proof", async () => {
  const f = await fixture(); f.docker.containers.clear(); f.docker.setHook(async (argv) => { if (argv[1] === "run") throw new Error("candidate failed before effects"); }); f.lose("initial"); f.setCache(false);
  expect((await f.initial("initial-failed-reply")).statusCode).toBe(502); const execution = (await f.memory.deployments.list()).find((row) => row.id !== f.A.id && row.snapshotHash)!; expect(execution.status).toBe("running"); expect(f.records.get(`deploy_${execution.id}`)!.receipt).toMatchObject({ terminalStatus: "failed", proven: false });
  f.setCache(true); const replay = await f.initial("initial-failed-reply"); expect(replay.statusCode, replay.body).toBe(200); expect(replay.json().data.deployment.status).toBe("failed"); expect(replay.json().data.deployment.executionReceipt).toBeUndefined(); expect(f.memory.completion.commands.size).toBe(0);
});
it("reconciles Stop receipt after finalization storage failure without another Stop or claim", async () => {
  const f = await fixture(), before = structuredClone(f.A); f.stopComplete.mockRejectedValueOnce(new Error("storage unavailable"));
  expect((await (await f.confirm("stop"))()).statusCode).toBe(502); expect([...f.memory.completion.commands.values()][0]?.status).toBe("dispatching"); const effects = f.docker.calls.length, claims = f.claim.mock.calls.length;
  const retry = await f.request("stop", "stop", undefined, "fresh-correlation"); expect(retry.statusCode, retry.body).toBe(200); expect(await f.memory.deployments.findById(f.A.id)).toEqual(before); expect(f.docker.calls).toHaveLength(effects); expect(f.claim).toHaveBeenCalledTimes(claims); expect(f.stopComplete).toHaveBeenCalledTimes(2);
});
it.each(["expired", "superseded"] as const)("preserves Stop cached outcome unresolved when %s authority wins inside completion", async (fault) => {
  const f = await fixture(), before = structuredClone(f.A); f.lose("stop"); f.setCache(false); expect((await (await f.confirm("stop"))()).statusCode).toBe(502); f.setCache(true); const original = f.memory.controls.completeDeploymentStop.bind(f.memory.controls);
  f.stopComplete.mockImplementationOnce(async (command, result) => { const current = [...f.memory.completion.commands.values()][0]!; if (fault === "expired") current.executionAuthority!.projectLease.expiresAt = Date.now() - 1; else f.memory.completion.commands.set("newer", { ...structuredClone(current), id: "newer", executionAuthority: { ...structuredClone(current.executionAuthority!), commandId: "newer", projectLease: { ...current.executionAuthority!.projectLease, fence: current.executionAuthority!.projectLease.fence + 1 } } }); return original(command, result); });
  const retry = await f.request("stop", "stop"); expect(retry.statusCode, retry.body).toBe(409); expect([...f.memory.completion.commands.values()][0]?.status).toBe("dispatching"); expect(await f.memory.deployments.findById(f.A.id)).toEqual(before); expect((await f.memory.deployments.listLogs(f.A.id)).some((log) => log.message === "Authenticated agent stop confirmed.")).toBe(false);
});

it.each(["initial", "stop"] as const)("rejects aborted cached %s while its terminal port waits before publication", async (action) => {
  const f = await fixture(); f.lose(action); f.setCache(false); if (action === "initial") f.docker.containers.clear();
  expect((action === "initial" ? await f.initial("abort-handoff") : await (await f.confirm(action))()).statusCode).toBe(502); f.setCache(true);
  const execution = action === "initial" ? (await f.memory.deployments.list()).find((row) => row.id !== f.A.id && row.snapshotHash)! : f.A;
  const beforeLogs = await f.memory.deployments.listLogs(execution.id);
  let started!: () => void, release!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; }), barrier = new Promise<void>((resolve) => { release = resolve; });
  if (action === "initial") f.complete.mockImplementationOnce(async (input, signal?: AbortSignal) => { started(); await barrier; return (InMemoryExecutionState.prototype.completeExecution as any).call(f.memory.completion, input, signal); });
  else { const original = f.memory.controls.completeDeploymentStop.bind(f.memory.controls); f.stopComplete.mockImplementationOnce(async (command, result, signal?: AbortSignal) => { started(); await barrier; return (original as any)(command, result, signal); }); }
  const request = action === "initial" ? f.initial("abort-handoff") : f.request(action, action); await ready; const effects = f.docker.calls.length, claims = f.claim.mock.calls.length; f.abortCurrent(); release(); await request;
  expect(await f.memory.deployments.findById(execution.id)).toEqual(execution); if (action === "stop") expect([...f.memory.completion.commands.values()][0]?.status).toBe("dispatching");
  expect(await f.memory.deployments.listLogs(execution.id)).toEqual(beforeLogs); expect(f.docker.calls).toHaveLength(effects); expect(f.claim).toHaveBeenCalledTimes(claims);
});
it.each(["immediate", "retry"] as const)("rejects legal proofless INITIAL cache success on %s recovery without a generic terminal save", async (when) => {
  const f = await fixture(); f.docker.containers.clear(); f.lose("initial"); const key = `proofless-${when}`;
  if (when === "retry") { f.setCache(false); expect((await f.initial(key)).statusCode).toBe(502); f.setCache(true); }
  f.lookup.mockImplementationOnce(async (id) => { const receipt = structuredClone(f.records.get(id)!.receipt); delete receipt.executionReceipt; return receipt; });
  const save = vi.spyOn(f.memory.deployments, "save"), response = await f.initial(key); expect(response.statusCode, response.body).toBe(409); expect(response.json().error.code).toBe("EXECUTION_PROOF_INVALID");
  const execution = (await f.memory.deployments.list()).find((row) => row.id !== f.A.id && row.snapshotHash)!; expect(execution).toMatchObject({ status: "running", finishedAt: null }); expect(execution.executionReceipt).toBeUndefined(); expect(save.mock.calls.some(([row]) => row.status === "succeeded")).toBe(false); expect(f.complete).not.toHaveBeenCalled(); expect((await f.memory.deployments.listLogs(execution.id)).some((row) => row.message === "Agent execution succeeded.")).toBe(false); expect(f.claim).toHaveBeenCalledTimes(2); expect(f.wait).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled();
});
it("keeps a concurrent confirmed Stop authoritative when immediate INITIAL cache supplies legal proofless success", async () => {
  const f = await fixture(); f.docker.containers.clear(); f.lose("initial"); let stopped: Deployment | undefined;
  f.setQueryHook(async () => { const id = f.queries.at(-1).deploymentId; const pending = await f.request("stop", "cache-stop", undefined, "stop-correlation", f.A.snapshotHash!, id); expect(pending.statusCode).toBe(202); expect((await f.request("stop", "cache-stop", pending.json().data.confirmationId, "stop-correlation", f.A.snapshotHash!, id)).statusCode).toBe(200); stopped = (await f.memory.deployments.findById(id))!; });
  f.lookup.mockImplementationOnce(async (id) => { const receipt = structuredClone(f.records.get(id)!.receipt); delete receipt.executionReceipt; return receipt; });
  const save = vi.spyOn(f.memory.deployments, "save"), response = await f.initial("proofless-concurrent-stop"); expect(response.statusCode, response.body).toBe(409); expect(response.json().error.code).toBe("EXECUTION_PROOF_INVALID"); expect(await f.memory.deployments.findById(stopped!.id)).toEqual(stopped); expect(stopped!.status).toBe("canceled"); expect(save.mock.calls.some(([row]) => row.status === "succeeded")).toBe(false); expect(f.complete).not.toHaveBeenCalled(); expect((await f.memory.deployments.listLogs(stopped!.id)).some((row) => row.message === "Agent execution succeeded.")).toBe(false);
});
