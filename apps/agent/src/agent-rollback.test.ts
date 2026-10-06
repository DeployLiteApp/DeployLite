import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signAgentTransport } from "@deploylite/config";
import { agentExecutionCommandSchema, createDeploymentSnapshot, createSourceIntent, deploymentRollbackCommandResultSchema, trustedPriorExecutionReceiptSchema } from "@deploylite/contracts";
import { InMemoryProtocolTransport } from "@deploylite/domain";
import { AuthenticatedAgentCommandReceiver } from "./agent-transport.js";
import { DigestDeploymentDispatcher } from "./deployment-dispatcher.js";
const key = "transport_test_key_123", policy = { maxOutageMs: 30_000, maxRecoveryMs: 60_000 };
const imageA = `registry.example.com/team/app@sha256:${"a".repeat(64)}`, imageH = `registry.example.com/team/app@sha256:${"b".repeat(64)}`;
function snapshot(origin: string, image: string) { return createDeploymentSnapshot({ schemaVersion: 1, deploymentId: origin, projectId: "project", agentId: "agent", source: createSourceIntent({ sourceMode: "image", requestedReference: image }, { policyVersion: "p1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true }), configRevision: "default", runtimeRevision: "default", runtimePort: 3000, secretRefs: [], policyVersion: "p1" }, { sha256: (bytes) => createHash("sha256").update(bytes).digest("hex") }); }
function fixture() {
  const A = snapshot("origin-A", imageA), H = snapshot("origin-H", imageH), calls: string[] = [];
  const prior = trustedPriorExecutionReceiptSchema.parse({ schemaVersion: 1, deploymentId: "A", projectId: "project", candidateId: "A:candidate:old", snapshotOriginId: A.deploymentId, snapshotHash: A.hash, effectiveImageDigest: imageA.split("@")[1], runtimeHost: "agent", container: "active-A", containerId: "1".repeat(64), hostPort: 43000, containerPort: 3000, network: null });
  const lease = (deploymentId: string) => ({ deploymentId, fence: 2, leaseId: `${deploymentId}:owner`, expiresAt: 200_000 });
  const authority = { projectId: "project", commandId: "control-R", action: "deployment.rollback" as const, projectLease: lease("project"), executionLease: lease("R"), sourceLease: lease("A") };
  const body = agentExecutionCommandSchema.parse({ schemaVersion: 2, agentId: "agent", commandId: "deploy_R", deploymentId: "R", sourceDeploymentId: "H", activeDeploymentId: "A", projectId: "project", snapshot: { ...H, canonicalBytes: undefined }, snapshotHash: H.hash, requiredCapabilities: ["deploy.execute"], lease: authority.executionLease, authority, replacement: { prior, effectiveImage: imageA, policy }, context: { requestId: "first-request", correlationId: "original-correlation" }, timeoutMs: 1000, cancellationRequested: false });
  if (body.schemaVersion !== 2) throw new Error("Rollback fixture must use wire v2");
  const records = new Map<string, any>();
  const replay = { claims: 0, lookups: 0, claim: async function(commandId: string, fingerprint: string) { this.claims++; const old = records.get(commandId); if (old) { if (old.fingerprint !== fingerprint) throw new Error("fingerprint conflict"); return { claimed: false, receipt: old.receipt }; } return { claimed: true, claimToken: "owner-token" }; }, lookup: async function(commandId: string, fingerprint: string) { this.lookups++; const old = records.get(commandId); if (old && old.fingerprint !== fingerprint) throw new Error("fingerprint conflict"); return old?.receipt ?? null; }, wait: async () => { throw new Error("must not wait"); }, release: async () => { throw new Error("must not release"); }, complete: async (commandId: string, value: any) => { records.set(commandId, value); } };
  const dispatcher = new DigestDeploymentDispatcher({ protocol: new InMemoryProtocolTransport({ clock: { now: () => 1 }, leasePolicy: { ttlMs: 200_000 }, retryPolicy: { maxAttempts: 1, deadlineMs: 0, backoffMs: () => 0 }, capabilities: ["deploy.execute"] }), hostPort: 43000, containerPort: 3000, trustedHosts: ["registry.example.com"], promotionPolicy: policy, transport: { startCandidate: async (candidate, _signal, context) => { expect(context?.prior.deploymentId).toBe("A"); expect(context?.prior.effectiveImage).toBe(imageA); calls.push(`start:${candidate.effectiveImage}`); }, checkHealth: async () => true, promoteCandidate: async (candidate) => { calls.push(`promote:${candidate.effectiveImage}`); return { container: "active-R", containerId: "3".repeat(64), imageId: "sha256:config-R", owner: "owner", projectId: "project", deploymentId: "R", candidateId: candidate.candidateId, effectiveImage: candidate.effectiveImage, running: true, health: "healthy", hostPort: 43000, containerPort: 3000, network: null }; }, restorePrior: async () => {}, discardCandidate: async () => {} } });
  const receiver = new AuthenticatedAgentCommandReceiver({ agentId: "agent", trustKey: key, capabilities: ["deploy.execute"], dispatcher, replayStore: replay, authorityValidator: { validateDeploymentAuthority: async (value) => { expect(value).toEqual(authority); } }, now: () => 1 });
  return { body, receiver, replay, calls, H, receive: () => receiver.receive(body, signAgentTransport(JSON.stringify(body), key)) };
}
describe("signed rollback independent active/historical/execution roles", () => {
  it("runs historical H and returns observed R while the independently bound prior remains A", async () => {
    const f = fixture(); const outcome = await f.receive().then((receipt) => ({ receipt, error: null }), (error: Error) => ({ receipt: null, error: error.message }));
    expect(outcome).toMatchObject({ error: null, receipt: { activeDeploymentId: "A", sourceDeploymentId: "H", deploymentId: "R", receipt: { effectiveImage: imageH, executionReceipt: { containerId: "3".repeat(64), snapshotOriginId: "origin-H", snapshotHash: f.H.hash } } } });
    expect(f.calls).toEqual([`start:${imageH}`, `promote:${imageH}`]);
  });
  it("retrieves the original signed rollback receipt without another claim or effect", async () => {
    const f = fixture(); const first = await f.receive().catch(() => null);
    const query = { schemaVersion: 1, action: "deploy.execute", agentId: "agent", commandId: f.body.commandId, projectId: "project", deploymentId: "R", sourceDeploymentId: "H", activeDeploymentId: "A", snapshot: f.body.snapshot, snapshotHash: f.body.snapshotHash, authority: f.body.authority, replacement: f.body.replacement, correlationId: "original-correlation", timeoutMs: 1000 };
    const cached = await f.receiver.readReceipt(query, signAgentTransport(`POST /deployments/receipt\n${JSON.stringify(query)}`, key)).catch(() => null);
    expect(first).not.toBeNull(); expect(cached).toMatchObject({ receipt: first });
    expect(f.replay.claims).toBe(1); expect(f.replay.lookups).toBe(1); expect(f.calls).toHaveLength(2);
  });
});


describe("signed rollback fails closed for unsupported historical runtime before claim", () => {
  it.each(["config", "runtime", "secrets"])("rejects historical %s before claim or effects", async (variant) => {
    const f = fixture(), { hash: _hash, canonicalJson: _json, canonicalBytes: _bytes, ...projection } = f.H;
    const changed = createDeploymentSnapshot({ ...projection, ...(variant === "config" ? { configRevision: "unmaterialized" } : variant === "runtime" ? { runtimeRevision: "unmaterialized" } : { secretRefs: [{ secretRefId: "historical-secret", version: 1 }] }) }, { sha256: (bytes) => createHash("sha256").update(bytes).digest("hex") });
    const body = agentExecutionCommandSchema.parse({ ...f.body, snapshot: { ...changed, canonicalBytes: undefined }, snapshotHash: changed.hash });
    await expect(f.receiver.receive(body, signAgentTransport(JSON.stringify(body), key))).rejects.toThrow();
    expect(f.replay.claims).toBe(0); expect(f.calls).toHaveLength(0);
  });
});
