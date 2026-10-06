import { createHash } from "node:crypto";
import { dockerImageExecutionReceiptSchema, trustedPriorExecutionReceiptSchema, TransportCanceledError, type DeploymentSnapshotV1 } from "@deploylite/contracts";
import { AuthenticatedAgentCommandReceiver, DigestDeploymentDispatcher } from "@deploylite/agent";
import { AuthenticatedAgentDeploymentTransport } from "./agent-transport.js";
import { parseDeployLiteEnv } from "@deploylite/config";
import { InMemoryExecutionState, InMemoryProtocolTransport, type DeploymentExecutionRepository, type ExecutionCompletionInput } from "@deploylite/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApiApp, createInMemoryExecutionRepositories, createRuntimeRepositories, type DeploymentDispatcher } from "./app.js";

const imageDigest = `sha256:${"b".repeat(64)}`;
const imageReference = `registry.example.com/team/terminal@${imageDigest}`;
const apps: Awaited<ReturnType<typeof buildApiApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

function receipt(snapshot: DeploymentSnapshotV1, terminalStatus: "failed" | "canceled" | "succeeded") {
  expect(snapshot.hash).toBe(createHash("sha256").update(snapshot.canonicalBytes).digest("hex"));
  return dockerImageExecutionReceiptSchema.parse({
    deploymentId: snapshot.deploymentId, effectiveImage: imageReference, runtimePort: snapshot.runtimePort,
    runtimeConfig: { hostPort: 43000, containerPort: 3000 },
    health: terminalStatus === "succeeded" ? "passed" : "failed", terminalStatus,
    rollback: { target: null, result: terminalStatus === "succeeded" ? "not-required" : "not-available" },
    proven: terminalStatus === "succeeded"
  });
}

async function fixture(dispatcher: DeploymentDispatcher, completion?: DeploymentExecutionRepository, memory = createInMemoryExecutionRepositories(), useCustomRepositories = Boolean(completion)) {
  const save = vi.spyOn(memory.deployments, "save");
  const state = useCustomRepositories ? {
    deployments: memory.deployments, controlDeletes: memory.controls, controlRedeploy: memory.controls,
    executionCompletion: completion, deploymentDispatcher: dispatcher
  } : { deploymentDispatcher: dispatcher };
  const app = await buildApiApp({ env: { NODE_ENV: "test", DEPLOYLITE_BCRYPT_COST: "10" }, state });
  apps.push(app);
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "admin@example.test", password: "deploylite-admin-password" } });
  expect(login.statusCode).toBe(200);
  const cookie = login.headers["set-cookie"] as string;
  const headers = { cookie, "x-deployment-idempotency-key": "initial-terminal", "x-request-id": "terminal-request" };
  const deploy = () => app.inject({ method: "POST", url: "/api/v1/projects/project_mock_1/deployments", headers, payload: { imageReference, agentId: "agent_mock_1", commitSha: "abcdef1" } });
  return { app, memory, save, headers, deploy };
}

describe("initial digest terminal API draft", () => {
  it.each(["failed", "canceled"] as const)("uses the default shared memory port for %s without proof", async (terminalStatus) => {
    const complete = vi.spyOn(InMemoryExecutionState.prototype, "completeExecution");
    const dispatcher: DeploymentDispatcher = { available: () => true, dispatch: async (snapshot) => receipt(snapshot, terminalStatus) };
    const { app, headers, deploy } = await fixture(dispatcher);
    const response = await deploy();
    expect(complete).toHaveBeenCalledOnce();
    expect(response.statusCode, response.body).toBe(200);
    const deployment = response.json().data.deployment;
    const detail = await app.inject({ method: "GET", url: `/api/v1/deployments/${deployment.id}`, headers });
    expect(detail.json().data.deployment).toMatchObject({ status: terminalStatus, snapshotHash: response.json().data.snapshotHash, snapshotOriginId: deployment.id });
    expect(detail.json().data.deployment).not.toHaveProperty("executionReceipt");
    const replay = await deploy();
    expect(replay.json().data).toMatchObject({ replayed: true, deployment });
    expect(complete).toHaveBeenCalledOnce();
    const stream = await app.inject({ method: "GET", url: `/api/v1/deployments/${deployment.id}/logs/stream`, headers });
    expect(stream.body).toContain(`"status":"${terminalStatus}"`);
    expect(stream.body.indexOf("event: deployment.log")).toBeLessThan(stream.body.indexOf("event: deployment.status"));
  });

  it("binds the canonical snapshot before the first digest execution insert", async () => {
    let snapshot!: DeploymentSnapshotV1;
    const dispatcher: DeploymentDispatcher = { available: () => true, async dispatch(value) { snapshot = value; return receipt(value, "failed"); } };
    const { save, deploy } = await fixture(dispatcher, { completeExecution: async () => ({ kind: "conflict" }) });
    await deploy();
    expect(save.mock.calls.find(([row]) => row.id === snapshot.deploymentId)?.[0]).toMatchObject({ status: "queued", snapshotHash: snapshot.hash, snapshotOriginId: snapshot.deploymentId });
  });

  it.each(["failed", "canceled"] as const)("injects the port with canonical initial bindings for %s", async (terminalStatus) => {
    const shared = createInMemoryExecutionRepositories();
    const complete = vi.fn((input: ExecutionCompletionInput) => shared.completion.completeExecution(input));
    let snapshot!: DeploymentSnapshotV1;
    const dispatcher: DeploymentDispatcher = { available: () => true, async dispatch(value) { snapshot = value; return receipt(value, terminalStatus); } };
    // The injected repositories and completion port must own the same actual maps.
    const { save, deploy } = await fixture(dispatcher, { completeExecution: complete }, shared);
    const response = await deploy();
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]?.[0]).toMatchObject({ commandId: null, commandResult: null, proof: null, expectedStatus: "running", executionId: snapshot.deploymentId, projectId: snapshot.projectId, sourceExecutionId: null, snapshotOriginId: snapshot.deploymentId, snapshotHash: snapshot.hash, runtimeHost: "agent_mock_1", effectiveImageDigest: imageDigest, terminalStatus });
    expect(save.mock.calls.find(([row]) => row.id === snapshot.deploymentId)?.[0]).toMatchObject({ status: "queued", snapshotHash: snapshot.hash, snapshotOriginId: snapshot.deploymentId });
    expect(save.mock.calls.filter(([row]) => row.id === snapshot.deploymentId).map(([row]) => row.status)).toEqual(["queued", "running"]);
    expect(response.statusCode, response.body).toBe(200);
    await expect(shared.deployments.findById(snapshot.deploymentId)).resolves.toMatchObject({ status: terminalStatus, finishedAt: expect.any(String) });
  });

  it.each([["conflict", 409], ["not-found", 404]] as const)("keeps the prior running state on completion %s", async (kind, statusCode) => {
    const dispatcher: DeploymentDispatcher = { available: () => true, dispatch: async (snapshot) => receipt(snapshot, "failed") };
    const complete = vi.fn(async () => ({ kind }));
    const { app, memory, save, headers, deploy } = await fixture(dispatcher, { completeExecution: complete });
    const response = await deploy();
    expect(response.statusCode, response.body).toBe(statusCode);
    const execution = (await memory.deployments.list()).find((row) => row.id !== "dep_mock_1")!;
    expect(execution).toMatchObject({ status: "running", finishedAt: null });
    expect(save.mock.calls.filter(([row]) => row.id === execution.id).map(([row]) => row.status)).toEqual(["queued", "running"]);
    const stream = await app.inject({ method: "GET", url: `/api/v1/deployments/${execution.id}/logs/stream`, headers });
    expect(stream.body).not.toContain("Agent execution failed.");
    expect(stream.body).not.toContain('"status":"failed"');
    await expect(memory.deployments.listLogs(execution.id)).resolves.toHaveLength(1);
  });

  it.each(["failed", "canceled"] as const)("preserves legacy custom-repository receipt targets for %s without an injected port", async (terminalStatus) => {
    let candidateId = "";
    const dispatcher: DeploymentDispatcher = { available: () => true, async dispatch(snapshot) {
      candidateId = `${snapshot.deploymentId}:candidate:legacy-observed`;
      return dockerImageExecutionReceiptSchema.parse({ ...receipt(snapshot, terminalStatus), candidateId });
    } };
    const shared = createInMemoryExecutionRepositories();
    const { memory, deploy } = await fixture(dispatcher, undefined, shared, true);
    const response = await deploy();
    expect(response.statusCode, response.body).toBe(200);
    const deployment = response.json().data.deployment;
    expect(deployment).toMatchObject({ status: terminalStatus, stopTarget: { candidateId, effectiveImage: imageReference } });
    await expect(memory.deployments.findById(deployment.id)).resolves.toMatchObject(deployment);
  });

  it.each(["receipt", "dispatch-error"])("does not fallback-save a failure when %s completion storage fails", async (scenario) => {
    const dispatcher: DeploymentDispatcher = { available: () => true, async dispatch(snapshot) { if (scenario === "dispatch-error") throw new Error("dispatch fixture failure"); return receipt(snapshot, "failed"); } };
    const complete = vi.fn(async () => { throw new Error("completion fixture storage failure"); });
    const { memory, save, deploy } = await fixture(dispatcher, { completeExecution: complete });
    const response = await deploy();
    expect(response.statusCode).toBe(500);
    expect(complete).toHaveBeenCalledOnce();
    const execution = (await memory.deployments.list()).find((row) => row.id !== "dep_mock_1")!;
    expect(execution).toMatchObject({ status: "running", finishedAt: null });
    expect(save.mock.calls.filter(([row]) => row.id === execution.id).map(([row]) => row.status)).toEqual(["queued", "running"]);
    await expect(memory.deployments.listLogs(execution.id)).resolves.toHaveLength(1);
  });

  it.each([[new Error("dispatch fixture failure"), "failed"], [new TransportCanceledError(), "canceled"]] as const)("persists a transport %s through the port as %s", async (error, terminalStatus) => {
    const complete = vi.spyOn(InMemoryExecutionState.prototype, "completeExecution");
    const dispatcher: DeploymentDispatcher = { available: () => true, async dispatch() { throw error; } };
    const { app, headers, deploy } = await fixture(dispatcher);
    const response = await deploy();
    const executionId = complete.mock.calls[0]![0].executionId;
    const detail = await app.inject({ method: "GET", url: `/api/v1/deployments/${executionId}`, headers });
    expect(detail.json().data.deployment).toMatchObject({ status: terminalStatus, finishedAt: expect.any(String) });
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]?.[0]).toMatchObject({ terminalStatus, commandId: null, commandResult: null, proof: null });
    expect(response.statusCode).toBe(502);
  });

  it("assembles the database completion port without connecting to PostgreSQL", async () => {
    let snapshot!: DeploymentSnapshotV1;
    const dispatcher: DeploymentDispatcher = { available: () => true, async dispatch(value) { snapshot = value; return receipt(value, "failed"); } };
    const { deploy } = await fixture(dispatcher);
    await deploy();
    const transaction = vi.fn(async () => { throw new Error("database transaction fixture sentinel"); });
    const repositories = await createRuntimeRepositories(parseDeployLiteEnv({ NODE_ENV: "test", DATABASE_URL: "postgres://fixture:fixture@fixture.invalid/fixture" }), { db: { pool: {} as never, client: { transaction } as never } });
    const state = repositories.state as typeof repositories.state & { executionCompletion?: DeploymentExecutionRepository };
    const input: ExecutionCompletionInput = { commandId: null, commandResult: null, proof: null, expectedStatus: "running", executionId: snapshot.deploymentId, projectId: snapshot.projectId, sourceExecutionId: null, snapshotOriginId: snapshot.deploymentId, snapshotHash: snapshot.hash, runtimeHost: "agent_mock_1", effectiveImageDigest: imageDigest, terminalStatus: "failed", finishedAt: "2026-10-04T12:00:00.000Z" };
    const invoke = async () => state.executionCompletion?.completeExecution(input);
    await expect(invoke()).rejects.toThrow("database transaction fixture sentinel");
    expect(transaction).toHaveBeenCalledOnce();
  });

  it("retains readable legacy success without inventing observed proof", async () => {
    const complete = vi.spyOn(InMemoryExecutionState.prototype, "completeExecution");
    const dispatcher: DeploymentDispatcher = { available: () => true, dispatch: async (snapshot) => receipt(snapshot, "succeeded") };
    const { deploy } = await fixture(dispatcher);
    const response = await deploy();
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.deployment.status).toBe("succeeded");
    expect(response.json().data.deployment).not.toHaveProperty("executionReceipt");
    expect(complete).not.toHaveBeenCalled();
  });
});

function successProof(snapshot: DeploymentSnapshotV1, patch: Record<string, unknown> = {}) {
  const proof = trustedPriorExecutionReceiptSchema.parse({ schemaVersion: 1, candidateId: `${snapshot.deploymentId}:candidate:deploy_${snapshot.deploymentId}`, deploymentId: snapshot.deploymentId, projectId: snapshot.projectId, snapshotOriginId: snapshot.deploymentId, snapshotHash: snapshot.hash, effectiveImageDigest: imageDigest, runtimeHost: "agent_mock_1", container: "observed-active", containerId: "physical-api-container", hostPort: 43000, containerPort: 3000, network: null, ...patch });
  return { ...receipt(snapshot, "succeeded"), deploymentId: proof.deploymentId, candidateId: proof.candidateId, effectiveImage: `registry.example.com/team/terminal@${proof.effectiveImageDigest}`, runtimePort: proof.containerPort, executionReceipt: proof };
}
function observedAgent() {
  const calls: string[][] = []; const settled = new Map<string, any>();
  let labels: Record<string, string> = {}; let wire: any;
  const physicalId = "c".repeat(64); const imageId = `sha256:${"a".repeat(64)}`;
  const bindings = { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "43000" }] };
  const dispatcher = new DigestDeploymentDispatcher({ hostPort: 43000, containerPort: 3000, owner: "configured-owner", trustedHosts: ["registry.example.com"], protocol: new InMemoryProtocolTransport({ clock: { now: () => 1 }, leasePolicy: { ttlMs: 30000 }, retryPolicy: { maxAttempts: 1, deadlineMs: 0, backoffMs: () => 0 }, capabilities: ["deploy.execute"] }), runner: { run: async (argv) => {
    calls.push([...argv]);
    if (argv[1] === "run") labels = Object.fromEntries(argv.filter((value) => value.startsWith("com.deploylite.")).map((value) => value.split(/=(.*)/s).slice(0, 2)));
    const deploymentId = labels["com.deploylite.deployment"];
    const stdout = argv[1] === "container" ? JSON.stringify({ id: physicalId, name: `/deploylite-active-${deploymentId}`, imageId, owner: "configured-owner", projectId: labels["com.deploylite.project"], deploymentId, candidateId: labels["com.deploylite.candidate"], effectiveImage: labels["com.deploylite.image"], running: true, health: "healthy", hostBindings: bindings, portBindings: bindings, networkMode: "default", networks: { bridge: { networkId: "d".repeat(64), endpointId: "e".repeat(64) } } })
      : argv[1] === "image" ? JSON.stringify(imageId) : (argv[3] ?? "").includes("State.Health") ? "healthy" : (argv[3] ?? "").includes("com.deploylite.owner") ? `configured-owner|${deploymentId}|${labels["com.deploylite.candidate"]}|${labels["com.deploylite.image"]}` : "";
    return { exitCode: 0, signal: null, stdout, stderr: "" };
  } } });
  const receiver = new AuthenticatedAgentCommandReceiver({ agentId: "agent_mock_1", trustKey: "transport_test_key_123", capabilities: ["deploy.execute"], dispatcher, now: () => 1, replayStore: { claim: async (id, fingerprint) => { const prior = settled.get(id); if (prior) { if (prior.fingerprint !== fingerprint) throw new Error("replay conflict"); return { claimed: false, receipt: prior.receipt }; } return { claimed: true, claimToken: "claim" }; }, wait: async (id) => settled.get(id).receipt, complete: async (id, value) => { settled.set(id, structuredClone(value)); }, release: async () => {} } });
  const transport = new AuthenticatedAgentDeploymentTransport({ endpoint: "https://agent.test", agentId: "agent_mock_1", trustKey: "transport_test_key_123", now: () => 1, fetch: async (_url, init) => { wire = await receiver.receive(JSON.parse(String(init?.body)), String((init?.headers as Record<string, string>)["x-deploylite-signature"])); return new Response(JSON.stringify(wire)); } });
  return { transport, calls, physicalId, get wire() { return wire; } };
}

describe("INITIAL signed observed proof atomic success", () => {
  it("persists received physical proof in the actual default shared store before SSE success", async () => {
    const agent = observedAgent(); const complete = vi.spyOn(InMemoryExecutionState.prototype, "completeExecution");
    const { app, headers, deploy } = await fixture(agent.transport);
    const response = await deploy(); expect(response.statusCode, response.body).toBe(200);
    const deployment = response.json().data.deployment;
    expect(agent.wire.receipt, JSON.stringify(agent.calls)).toMatchObject({ terminalStatus: "succeeded", executionReceipt: { containerId: agent.physicalId } });
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]?.[0]).toMatchObject({ terminalStatus: "succeeded", commandId: null, commandResult: null, sourceExecutionId: null, proof: agent.wire.receipt.executionReceipt });
    expect(deployment).toMatchObject({ status: "succeeded", executionReceipt: { container: `deploylite-active-${deployment.id}`, containerId: agent.physicalId, effectiveImageDigest: imageDigest, runtimeHost: "agent_mock_1", snapshotOriginId: deployment.id } });
    const detail = await app.inject({ method: "GET", url: `/api/v1/deployments/${deployment.id}`, headers });
    expect(detail.json().data.deployment.executionReceipt).toEqual(agent.wire.receipt.executionReceipt);
    const stream = await app.inject({ method: "GET", url: `/api/v1/deployments/${deployment.id}/logs/stream`, headers });
    expect(stream.body).toContain('"status":"succeeded"');
    expect(stream.body.indexOf("event: deployment.log")).toBeLessThan(stream.body.indexOf("event: deployment.status"));
    const effects = agent.calls.length; const replay = await deploy();
    expect(replay.json().data).toMatchObject({ replayed: true, deployment });
    expect(agent.calls).toHaveLength(effects); expect(complete).toHaveBeenCalledOnce();
    expect(agent.calls.filter((argv) => argv[1] === "container" || argv[1] === "image")).toHaveLength(2);
  });

  it.each([
    ["project", { projectId: "other" }], ["selected agent", { runtimeHost: "other" }], ["execution", { deploymentId: "other" }],
    ["candidate", { candidateId: "other" }], ["origin", { snapshotOriginId: "other" }], ["hash", { snapshotHash: "a".repeat(64) }],
    ["digest", { effectiveImageDigest: `sha256:${"a".repeat(64)}` }], ["container port", { containerPort: 8080 }], ["host alignment", { hostPort: 44000 }], ["network alignment", { network: "other" }]
  ])("rejects received proof with wrong %s without terminal publication", async (_field, patch) => {
    const complete = vi.fn(async () => { throw new Error("must not complete"); });
    const { app, memory, save, headers, deploy } = await fixture({ available: () => true, dispatch: async (snapshot) => successProof(snapshot, patch) }, { completeExecution: complete });
    const response = await deploy(); expect(response.statusCode, response.body).toBe(409); expect(complete).not.toHaveBeenCalled();
    const row = (await memory.deployments.list()).find((value) => value.id !== "dep_mock_1")!;
    expect(row).toMatchObject({ status: "running", finishedAt: null }); expect(row).not.toHaveProperty("executionReceipt");
    expect(save.mock.calls.filter(([value]) => value.id === row.id).map(([value]) => value.status)).toEqual(["queued", "running"]);
    const stream = await app.inject({ method: "GET", url: `/api/v1/deployments/${row.id}/logs/stream`, headers });
    expect(stream.body).not.toContain('"status":"succeeded"'); expect(stream.body).not.toContain("Agent execution succeeded.");
  });

  it.each([["conflict", 409], ["not-found", 404], ["storage", 500]] as const)("keeps running and publishes no success when atomic completion is %s", async (kind, status) => {
    const complete = vi.fn(async () => { if (kind === "storage") throw new Error("storage fault"); return { kind }; });
    const { app, memory, save, headers, deploy } = await fixture({ available: () => true, dispatch: async (snapshot) => successProof(snapshot) }, { completeExecution: complete });
    const response = await deploy(); expect(response.statusCode).toBe(status); expect(complete).toHaveBeenCalledOnce();
    const row = (await memory.deployments.list()).find((value) => value.id !== "dep_mock_1")!;
    expect(row).toMatchObject({ status: "running", finishedAt: null }); expect(row).not.toHaveProperty("executionReceipt");
    expect(save.mock.calls.filter(([value]) => value.id === row.id).map(([value]) => value.status)).toEqual(["queued", "running"]);
    await expect(memory.deployments.listLogs(row.id)).resolves.toHaveLength(1);
    const stream = await app.inject({ method: "GET", url: `/api/v1/deployments/${row.id}/logs/stream`, headers });
    expect(stream.body).not.toContain('"status":"succeeded"'); expect(stream.body).not.toContain("Agent execution succeeded.");
  });

  it("reuses durable finishedAt for semantic equal replay through the actual atomic port", async () => {
    const shared = createInMemoryExecutionRepositories(); const finishedAt = "2026-10-04T15:00:00.000Z";
    const complete = vi.fn((input: ExecutionCompletionInput) => shared.completion.completeExecution(input));
    const dispatcher: DeploymentDispatcher = { available: () => true, dispatch: async (snapshot) => {
      const result = successProof(snapshot);
      await shared.completion.completeExecution({ commandId: null, commandResult: null, proof: result.executionReceipt, expectedStatus: "running", executionId: snapshot.deploymentId, projectId: snapshot.projectId, sourceExecutionId: null, snapshotOriginId: snapshot.deploymentId, snapshotHash: snapshot.hash, runtimeHost: "agent_mock_1", effectiveImageDigest: imageDigest, terminalStatus: "succeeded", finishedAt });
      return result;
    } };
    const { save, deploy } = await fixture(dispatcher, { completeExecution: complete }, shared);
    const response = await deploy(); expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.deployment).toMatchObject({ status: "succeeded", finishedAt, executionReceipt: { containerId: "physical-api-container" } });
    expect(complete.mock.calls[0]?.[0].finishedAt).toBe(finishedAt);
    await expect(complete.mock.results[0]?.value).resolves.toMatchObject({ kind: "replayed" });
    expect(save.mock.calls.filter(([value]) => value.id === response.json().data.deployment.id).map(([value]) => value.status)).toEqual(["queued", "running"]);
  });

  it("does not downgrade observed success to a generic save when its atomic port is absent", async () => {
    const shared = createInMemoryExecutionRepositories();
    const { memory, save, deploy } = await fixture({ available: () => true, dispatch: async (snapshot) => successProof(snapshot) }, undefined, shared, true);
    const response = await deploy(); expect(response.statusCode).toBe(503);
    const row = (await memory.deployments.list()).find((value) => value.id !== "dep_mock_1")!;
    expect(row.status).toBe("running"); expect(row).not.toHaveProperty("executionReceipt");
    expect(save.mock.calls.filter(([value]) => value.id === row.id).map(([value]) => value.status)).toEqual(["queued", "running"]);
  });
});
