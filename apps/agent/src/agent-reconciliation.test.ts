import { Readable } from "node:stream";
import { startAgentServer } from "./server.js";
const http = vi.hoisted(() => ({ callback: undefined as any }));
vi.mock("node:http", () => ({ createServer: (callback: unknown) => { http.callback = callback; return { once: () => {}, removeListener: () => {}, listen: (_port: number, _host: string, ready: () => void) => ready(), close: (ready: () => void) => ready() }; } }));
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeploymentSnapshot, createSourceIntent } from "@deploylite/contracts";
import { signAgentTransport } from "@deploylite/config";
import { AuthenticatedAgentCommandReceiver } from "./agent-transport.js";
const key = "transport_test_key_123", image = `registry.example.com/team/app@sha256:${"a".repeat(64)}`;
const runtime = { hostPort: 43000, containerPort: 3000 };
function fixture() {
  const snapshot = createDeploymentSnapshot({ deploymentId: "A", projectId: "project", agentId: "configured-agent", source: createSourceIntent({ sourceMode: "image", requestedReference: image }, { policyVersion: "p1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true }), configRevision: "c1", runtimeRevision: "r1", runtimePort: 3000, secretRefs: [], policyVersion: "p1", schemaVersion: 1 }, { sha256: (bytes) => createHash("sha256").update(bytes).digest("hex") });
  const body = { schemaVersion: 1, agentId: "configured-agent", commandId: "original-command", deploymentId: "A", projectId: "project", snapshot: { ...snapshot, canonicalBytes: undefined }, snapshotHash: snapshot.hash, requiredCapabilities: ["deploy.execute"], lease: { leaseId: "original-lease", deploymentId: "A", fence: 1, expiresAt: 200_000 }, context: { requestId: "original-request", correlationId: "original-correlation" }, timeoutMs: 30_000, cancellationRequested: false };
  const inner = { deploymentId: "A", candidateId: "A:candidate:original-command", effectiveImage: image, runtimePort: 3000, runtimeConfig: runtime, terminalStatus: "succeeded" as const, health: "passed" as const, proven: true, rollback: { target: null, result: "not-required" as const }, executionReceipt: { schemaVersion: 1 as const, deploymentId: "A", candidateId: "A:candidate:original-command", projectId: "project", snapshotOriginId: "A", snapshotHash: snapshot.hash, effectiveImageDigest: `sha256:${"a".repeat(64)}`, runtimeHost: "configured-agent", container: "deploylite-active-A", containerId: "1".repeat(64), ...runtime, network: null } };
  const records = new Map<string, { fingerprint: string; receipt: Record<string, unknown> }>();
  const lookup = vi.fn(async (id: string, fingerprint: string) => { const row = records.get(id); if (!row) return null; if (row.fingerprint !== fingerprint) throw new Error("payload replay conflict"); return structuredClone(row.receipt); });
  const claim = vi.fn(async () => ({ claimed: true, claimToken: "claim" })), wait = vi.fn(async () => { throw new Error("must not wait"); }), release = vi.fn(async () => {});
  const dispatch = vi.fn(async () => inner), stop = vi.fn(async () => "stopped" as const);
  const options = { agentId: "configured-agent", trustKey: key, capabilities: ["deploy.execute", "deployment.stop"], now: () => 1, dispatcher: { runtimeConfig: runtime, dispatch }, stopDispatcher: { stop }, replayStore: { lookup, claim, wait, release, complete: async (id: string, value: { fingerprint: string; receipt: Record<string, unknown> }) => { records.set(id, structuredClone(value)); } } };
  const receiver = new AuthenticatedAgentCommandReceiver(options);
  const receive = (value: unknown) => receiver.receive(value, signAgentTransport(JSON.stringify(value), key));
  const query = { schemaVersion: 1, action: "deploy.execute", agentId: body.agentId, commandId: body.commandId, projectId: body.projectId, deploymentId: body.deploymentId, sourceDeploymentId: null, snapshot: body.snapshot, snapshotHash: body.snapshotHash, correlationId: body.context.correlationId, authority: null, replacement: null, timeoutMs: body.timeoutMs };
  const read = (value: unknown = query, signal?: AbortSignal) => receiver.readReceipt(value, signAgentTransport(`POST /deployments/receipt\n${JSON.stringify(value)}`, key), signal);
  return { receiver, body, query, receive, read, lookup, claim, wait, release, dispatch, stop, records };
}
afterEach(() => vi.useRealTimers());
describe("authenticated cache-only receipt lookup", () => {
  it("returns the original observed execution proof without another claim, wait, release or runtime effect", async () => {
    const f = fixture(), original = await f.receive(f.body); f.claim.mockClear();
    expect(await f.read()).toEqual({ schemaVersion: 1, action: "deploy.execute", agentId: f.body.agentId, commandId: f.body.commandId, correlationId: "original-correlation", receipt: original });
    expect(f.lookup).toHaveBeenCalledOnce(); expect(f.claim).not.toHaveBeenCalled(); expect(f.wait).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled(); expect(f.dispatch).toHaveBeenCalledOnce();
  });
  it("returns the original Stop receipt without calling Stop or acquiring a replay owner again", async () => {
    const f = fixture(); const body = { schemaVersion: 1, action: "deployment.stop", agentId: f.body.agentId, commandId: "original-stop", projectId: f.body.projectId, deploymentId: "A", candidateId: "original-candidate", effectiveImage: image, containerId: "1".repeat(64), requiredCapabilities: ["deployment.stop"], lease: f.body.lease, context: f.body.context, timeoutMs: 30_000, cancellationRequested: false };
    const original = await f.receive(body); f.claim.mockClear();
    const query = { schemaVersion: 1, action: body.action, agentId: body.agentId, commandId: body.commandId, projectId: body.projectId, deploymentId: body.deploymentId, candidateId: body.candidateId, effectiveImage: body.effectiveImage, containerId: body.containerId, correlationId: body.context.correlationId, authority: null, timeoutMs: body.timeoutMs };
    expect(await f.read(query)).toEqual({ schemaVersion: 1, action: "deployment.stop", agentId: body.agentId, commandId: body.commandId, correlationId: "original-correlation", receipt: original });
    expect(f.claim).not.toHaveBeenCalled(); expect(f.wait).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled(); expect(f.stop).toHaveBeenCalledOnce();
  });
});

it.each([undefined, "invalid", "execute-signature"])("authenticates cache-only target before lookup (%s)", async (fault) => {
  const f = fixture(); await f.receive(f.body);
  const signature = fault === "execute-signature" ? signAgentTransport(JSON.stringify(f.query), key) : fault;
  await expect(f.receiver.readReceipt(f.query, signature)).rejects.toThrow("authentication");
  expect(f.lookup).not.toHaveBeenCalled();
});
it.each(["agent", "project", "snapshot-project", "snapshot-hash", "canonical"])("rejects wrong original %s binding before cache access", async (fault) => {
  const f = fixture(); await f.receive(f.body); const query = structuredClone(f.query);
  if (fault === "agent") query.agentId = "other";
  else if (fault === "project") query.projectId = "other";
  else if (fault === "snapshot-project") query.snapshot.projectId = "other";
  else if (fault === "snapshot-hash") query.snapshotHash = "f".repeat(64);
  else query.snapshot.canonicalJson = "{}";
  await expect(f.read(query)).rejects.toThrow(); expect(f.lookup).not.toHaveBeenCalled();
});
it("settles a hanging cache lookup on caller cancellation without releasing any claim", async () => {
  const f = fixture(), controller = new AbortController(); f.lookup.mockImplementation(() => new Promise(() => {}));
  const outcome = f.read(f.query, controller.signal).then(() => "resolved", () => "rejected");
  await new Promise<void>((resolve) => setImmediate(resolve)); controller.abort();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(await Promise.race([outcome, Promise.resolve("still-pending")])).toBe("rejected");
  expect(f.claim).not.toHaveBeenCalled(); expect(f.wait).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled(); expect(f.dispatch).not.toHaveBeenCalled();
});
it("rejects a pre-aborted query before any replay access", async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  await expect(f.read(f.query, controller.signal)).rejects.toThrow("canceled"); expect(f.lookup).not.toHaveBeenCalled();
});
it("settles a never-resolving lookup at its explicit read budget without touching authority", async () => {
  vi.useFakeTimers(); const f = fixture(); f.lookup.mockImplementation(() => new Promise(() => {}));
  const outcome = f.read({ ...f.query, timeoutMs: 10 }).then(() => "resolved", () => "rejected");
  await vi.advanceTimersByTimeAsync(10);
  expect(await Promise.race([outcome, Promise.resolve("still-pending")])).toBe("rejected");
  expect(f.claim).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled(); expect(f.dispatch).not.toHaveBeenCalled();
});

it("mounts the actual cache-only HTTP callback without opening a listener or dispatching again", async () => {
  const f = fixture(), original = await f.receive(f.body); f.claim.mockClear();
  const server = await startAgentServer({ host: "127.0.0.1", port: 0, receiver: f.receiver, replayStore: {} as never });
  const request = Readable.from([JSON.stringify(f.query)]) as any; request.method = "POST"; request.url = "/deployments/receipt"; request.headers = { "x-deploylite-signature": signAgentTransport(`POST /deployments/receipt\n${JSON.stringify(f.query)}`, key) };
  const response = { destroyed: false, status: 0, body: "", writeHead(status: number) { this.status = status; return this; }, end(body = "") { this.body = body; } };
  await http.callback(request, response); expect(response.status).toBe(200); expect(JSON.parse(response.body).receipt).toEqual(original);
  expect(f.claim).not.toHaveBeenCalled(); expect(f.dispatch).toHaveBeenCalledOnce(); await server.close();
});

it.each(["agentId", "commandId", "projectId", "deploymentId", "candidateId", "effectiveImage", "containerId", "correlationId"])("rejects mismatched cached Stop %s rather than trusting durable cache blindly", async (field) => {
  const f = fixture(); const body = { schemaVersion: 1, action: "deployment.stop", agentId: f.body.agentId, commandId: "original-stop", projectId: f.body.projectId, deploymentId: "A", candidateId: "candidate-A", effectiveImage: image, containerId: "1".repeat(64), requiredCapabilities: ["deployment.stop"], lease: f.body.lease, context: f.body.context, timeoutMs: 30_000, cancellationRequested: false };
  await f.receive(body); const cached = f.records.get(body.commandId)!; cached.receipt[field] = field === "containerId" ? "2".repeat(64) : field === "effectiveImage" ? `registry.example.com/team/other@sha256:${"b".repeat(64)}` : "different";
  const query = { schemaVersion: 1, action: body.action, agentId: body.agentId, commandId: body.commandId, projectId: body.projectId, deploymentId: body.deploymentId, candidateId: body.candidateId, effectiveImage: body.effectiveImage, containerId: body.containerId, correlationId: body.context.correlationId, authority: null, timeoutMs: body.timeoutMs };
  await expect(f.read(query)).rejects.toThrow("scope"); expect(f.stop).toHaveBeenCalledOnce(); expect(f.wait).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled();
});
