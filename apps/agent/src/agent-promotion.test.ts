import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeploymentSnapshot, createSourceIntent, type AgentExecutionCommand, type DeploymentExecutionAuthorityV1 } from "@deploylite/contracts";
import { signAgentTransport } from "@deploylite/config";
import { claimDeploymentAuthority, createControlCommand, validateDeploymentAuthority, type ControlCommand, type DockerImageExecutionReceiptV1 } from "@deploylite/domain";
import { AuthenticatedAgentCommandReceiver } from "./agent-transport.js";

const digest = `sha256:${"a".repeat(64)}`, image = `registry.example.com/team/app@${digest}`;
const key = "transport_test_key_123";
const policy = { maxOutageMs: 30_000, maxRecoveryMs: 60_000 };
function fixture() {
  let time = 1; const effects: string[] = []; const forwarded: Array<Record<string, unknown>> = [];
  const snapshot = createDeploymentSnapshot({ deploymentId: "A", projectId: "project", agentId: "configured-agent", source: createSourceIntent({ sourceMode: "image", requestedReference: image }, { policyVersion: "p1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true }), configRevision: "c1", runtimeRevision: "r1", runtimePort: 3000, secretRefs: [], policyVersion: "p1", schemaVersion: 1 }, { sha256: (bytes) => createHash("sha256").update(bytes).digest("hex") });
  const command: ControlCommand = { ...createControlCommand({ actorId: "actor", action: "deployment.redeploy", scope: { kind: "deployment", projectId: "project", deploymentId: "A" }, input: {}, idempotencyKey: "key", correlationId: "corr", expiresAt: new Date(200_000) }), id: "control", status: "eligible" };
  const commands = [command]; const authority = claimDeploymentAuthority(commands, command, "B", time)!;
  const prior = { schemaVersion: 1 as const, candidateId: "A:candidate:prior", deploymentId: "A", projectId: "project", snapshotOriginId: "A", snapshotHash: snapshot.hash, effectiveImageDigest: digest, runtimeHost: "configured-agent", container: "deploylite-active-A", containerId: "1".repeat(64), hostPort: 43000, containerPort: 3000, network: null };
  const body = { schemaVersion: 2 as const, agentId: "configured-agent", commandId: "deploy_B", deploymentId: "B", sourceDeploymentId: "A", projectId: "project", snapshot: { ...snapshot, canonicalBytes: undefined }, snapshotHash: snapshot.hash, requiredCapabilities: ["deploy.execute"], lease: authority.executionLease, authority, replacement: { prior, effectiveImage: image, policy: { ...policy } }, context: { requestId: "req", correlationId: "corr" }, timeoutMs: 30_000, cancellationRequested: false };
  const receipt: DockerImageExecutionReceiptV1 = { deploymentId: "B", candidateId: "B:candidate:deploy_B", effectiveImage: image, runtimePort: 3000, runtimeConfig: { hostPort: 43000, containerPort: 3000 }, health: "passed", terminalStatus: "succeeded", rollback: { target: null, result: "not-required" }, proven: true, executionReceipt: { ...prior, deploymentId: "B", candidateId: "B:candidate:deploy_B", container: "deploylite-active-B", containerId: "2".repeat(64) } };
  const settled = new Map<string, { fingerprint: string; receipt: Record<string, unknown> }>();
  const validator = { validateInitialExecution: async () => {}, validateDeploymentAuthority: async (value: DeploymentExecutionAuthorityV1) => { validateDeploymentAuthority(commands, value, time); } };
  let loseDuringDispatch = false;
  const options = { agentId: "configured-agent", trustKey: key, capabilities: ["deploy.execute", "deployment.stop"], now: () => time, authorityValidator: validator,
    dispatcher: { runtimeConfig: { hostPort: 43000, containerPort: 3000 }, promotionPolicy: policy, dispatch: async (_snapshot: unknown, _id: string, _signal?: AbortSignal, _lease?: unknown, value?: { executionDeploymentId?: string; runtimeHost?: string; authority?: { assertValid(): Promise<void> } }) => {
      forwarded.push(value as Record<string, unknown> ?? {}); if (loseDuringDispatch) command.status = "completed";
      await value?.authority?.assertValid(); effects.push("execute"); return receipt;
    } },
    stopDispatcher: { stop: async (_input: unknown, _signal?: AbortSignal, _lease?: unknown, authority?: { assertValid(): Promise<void> }) => { await authority?.assertValid(); effects.push("stop"); return "stopped" as const; } },
    replayStore: { claim: async (id: string, fingerprint: string) => { const old = settled.get(id); if (old) { if (old.fingerprint !== fingerprint) throw new Error("payload conflict"); return { claimed: false, receipt: old.receipt }; } return { claimed: true, claimToken: "claim" }; }, wait: async () => { throw new Error("unexpected wait"); }, complete: async (id: string, value: { fingerprint: string; receipt: Record<string, unknown> }) => { settled.set(id, structuredClone(value)); }, release: async () => {} } };
  const receiver = new AuthenticatedAgentCommandReceiver(options);
  const receive = (value: unknown = body) => receiver.receive(value, signAgentTransport(JSON.stringify(value), key));
  return { receiver, body, effects, forwarded, receive, options, command, loseDuringDispatch: () => { loseDuringDispatch = true; }, expire: () => { time = 200_000; } };
}

describe("configured receiver shared authority and replacement bindings", () => {
  it("preserves INITIAL v1 with the production authority reader configured while controls without a claim remain rejected", async () => {
    const f = fixture();
    f.options.dispatcher.dispatch = async () => ({ deploymentId: "A", candidateId: "A:candidate:initial", effectiveImage: image, runtimePort: 3000, runtimeConfig: { hostPort: 43000, containerPort: 3000 }, terminalStatus: "succeeded", health: "passed", proven: true, rollback: { target: null, result: "not-required" }, executionReceipt: { ...f.body.replacement.prior, candidateId: "A:candidate:initial" } });
    const { authority: _authority, replacement: _replacement, sourceDeploymentId: _source, ...fields } = f.body;
    const initial = { ...fields, schemaVersion: 1, commandId: "initial", deploymentId: "A", lease: { deploymentId: "A", leaseId: "initial-owner", fence: 1, expiresAt: 100_000 } };
    expect(await f.receive(initial)).toMatchObject({ schemaVersion: 1, deploymentId: "A", receipt: { executionReceipt: { containerId: "1".repeat(64) } } });
    const control = { ...f.body, commandId: "unsigned-authority" } as Record<string, unknown>; delete control.authority;
    await expect(f.receive(control)).rejects.toThrow();
  });
  it("rejects expiry that occurs while a fresh authority read is awaiting before effects", async () => {
    const f = fixture(); const validate = f.options.authorityValidator.validateDeploymentAuthority;
    f.options.authorityValidator.validateDeploymentAuthority = async (value) => { await validate(value); f.expire(); };
    await expect(f.receive()).rejects.toThrow(); expect(f.effects).toEqual([]); expect(f.forwarded).toEqual([]);
  });
  it("forwards validated prior and explicit policy plus a live authority guard without another effect on replay", async () => {
    const f = fixture(); const first = await f.receive();
    expect(f.forwarded[0]).toMatchObject({ priorProvenReceipt: { deploymentId: "A", projectId: "project", executionReceipt: f.body.replacement.prior }, promotionPolicy: policy, authority: { assertValid: expect.any(Function) } });
    expect(await f.receive()).toEqual(first); expect(f.effects).toEqual(["execute"]);
  });
  it.each(["projectId", "deploymentId", "snapshotOriginId", "snapshotHash", "effectiveImageDigest", "runtimeHost", "hostPort", "containerPort", "network"])("rejects signed mismatched previous %s before replay or effects", async (field) => {
    const f = fixture(); const body = structuredClone(f.body); const prior = body.replacement.prior as unknown as Record<string, unknown>;
    prior[field] = field === "snapshotHash" ? "b".repeat(64) : field === "effectiveImageDigest" ? `sha256:${"b".repeat(64)}` : field === "hostPort" ? 44000 : field === "containerPort" ? 8080 : "other";
    await expect(f.receive(body)).rejects.toThrow(); expect(f.effects).toEqual([]);
  });
  it.each(["missing-authority", "wrong-owner", "expired-source", "wrong-policy", "missing-validator"])("rejects %s before dispatch", async (fault) => {
    const f = fixture(); const body = structuredClone(f.body) as unknown as Record<string, any>;
    if (fault === "missing-authority") delete body.authority;
    if (fault === "wrong-owner") body.authority.projectLease.leaseId = "equal-fence-other-owner";
    if (fault === "expired-source") body.authority.sourceLease.expiresAt = 0;
    if (fault === "wrong-policy") body.replacement.policy.maxRecoveryMs = 60_001;
    if (fault === "missing-validator") { const options = { ...f.options, authorityValidator: undefined }; const receiver = new AuthenticatedAgentCommandReceiver(options); await expect(receiver.receive(body, signAgentTransport(JSON.stringify(body), key))).rejects.toThrow(); }
    else await expect(f.receive(body)).rejects.toThrow();
    expect(f.effects).toEqual([]);
  });
  it("revalidates persisted authority from the dispatcher guard after asynchronous loss", async () => {
    const f = fixture(); f.loseDuringDispatch();
    await expect(f.receive()).rejects.toThrow(); expect(f.effects).toEqual([]);
  });
  it("cannot replay a changed previous runtime identity as an equal command", async () => {
    const f = fixture(); await f.receive(); const changed = structuredClone(f.body); changed.replacement.prior.containerId = "3".repeat(64);
    await expect(f.receive(changed)).rejects.toThrow(); expect(f.effects).toEqual(["execute"]);
  });
});

afterEach(() => vi.useRealTimers());
function stopBody(f: ReturnType<typeof fixture>) {
  return { schemaVersion: 1, action: "deployment.stop", agentId: "configured-agent", commandId: "stop", projectId: "project", deploymentId: "A", candidateId: "A:candidate:prior", effectiveImage: image, requiredCapabilities: ["deployment.stop"], lease: { deploymentId: "A", leaseId: "stop-owner", fence: 3, expiresAt: 200_000 }, context: { requestId: "req", correlationId: "corr" }, timeoutMs: 30_000, cancellationRequested: false };
}
describe("replay admission cancellation and settling deadlines", () => {
  it("rejects a pre-aborted execute without claiming or dispatching", async () => {
    const f = fixture(), abort = new AbortController(); abort.abort(); const claim = vi.spyOn(f.options.replayStore, "claim");
    await expect(f.receiver.receive(f.body, signAgentTransport(JSON.stringify(f.body), key), abort.signal)).rejects.toThrow();
    expect(claim).not.toHaveBeenCalled(); expect(f.effects).toEqual([]);
  });
  it.each(["execute", "stop"])("observes abort during %s claim before dispatch", async (action) => {
    const f = fixture(), abort = new AbortController(); let resume!: () => void; const barrier = new Promise<void>((resolve) => { resume = resolve; });
    let entered!: () => void; const ready = new Promise<void>((resolve) => { entered = resolve; });
    const release = vi.fn(async () => {});
    const receiver = new AuthenticatedAgentCommandReceiver({ ...f.options, authorityValidator: action === "stop" ? undefined : f.options.authorityValidator, replayStore: { ...f.options.replayStore, claim: async () => { entered(); await barrier; return { claimed: true, claimToken: "owner" }; }, release } });
    const body = action === "stop" ? stopBody(f) : f.body; const pending = receiver.receive(body, signAgentTransport(JSON.stringify(body), key), abort.signal);
    const result = pending.then(() => "resolved", () => "rejected"); await ready; abort.abort(); resume(); await Promise.resolve(); await Promise.resolve();
    expect(await result).toBe("rejected"); expect(f.effects).toEqual([]); expect(release).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledWith(body.commandId, "owner");
  });
  it.each(["execute", "stop"])("cancels %s replay wait without releasing another owner", async (action) => {
    vi.useFakeTimers(); const f = fixture(), abort = new AbortController(); let resume!: (value: Record<string, unknown>) => void;
    const release = vi.fn(async () => {}); const wait = new Promise<Record<string, unknown>>((resolve) => { resume = resolve; });
    const receiver = new AuthenticatedAgentCommandReceiver({ ...f.options, authorityValidator: action === "stop" ? undefined : f.options.authorityValidator, replayStore: { ...f.options.replayStore, claim: async () => ({ claimed: false }), wait: async () => wait, release } });
    const body = action === "stop" ? stopBody(f) : f.body; let outcome = "pending";
    const pending = receiver.receive(body, signAgentTransport(JSON.stringify(body), key), abort.signal).then(() => { outcome = "resolved"; }, () => { outcome = "rejected"; });
    await vi.advanceTimersByTimeAsync(0); abort.abort(); await vi.advanceTimersByTimeAsync(0);
    try { expect(outcome).toBe("rejected"); expect(release).not.toHaveBeenCalled(); expect(f.effects).toEqual([]); }
    finally { resume({}); await pending; }
  });
  it.each(["replacement", "initial", "stop", "claim", "wait"])("settles a never-ending %s admission read within preparation without late effects", async (stage) => {
    vi.useFakeTimers(); const f = fixture(); let resume!: () => void; const barrier = new Promise<void>((resolve) => { resume = resolve; }); const release = vi.fn(async () => {});
    const validator = { validateDeploymentAuthority: async () => barrier, validateInitialExecution: async () => barrier };
    const receiver = new AuthenticatedAgentCommandReceiver({ ...f.options, authorityValidator: validator, replayStore: { ...f.options.replayStore, claim: async () => { if (stage === "claim") await barrier; return { claimed: stage !== "wait", claimToken: "owner" }; }, wait: async () => { await barrier; return {}; }, release } });
    const { authority: _a, replacement: _r, sourceDeploymentId: _s, ...initial } = f.body;
    const body = stage === "initial" ? { ...initial, schemaVersion: 1, deploymentId: "A", lease: { ...initial.lease, deploymentId: "A" } } : stage === "stop" ? { ...stopBody(f), authority: { ...f.body.authority, action: "deployment.stop", sourceLease: undefined, executionLease: { ...f.body.authority.executionLease, deploymentId: "A" } }, lease: { ...f.body.authority.executionLease, deploymentId: "A" } } : f.body;
    let outcome = "pending"; const pending = receiver.receive(body, signAgentTransport(JSON.stringify(body), key)).then(() => { outcome = "resolved"; }, () => { outcome = "rejected"; });
    await vi.advanceTimersByTimeAsync(30_000);
    try { expect(outcome).toBe("rejected"); expect(f.effects).toEqual([]); }
    finally { resume(); await vi.advanceTimersByTimeAsync(0); await pending; }
    expect(f.effects).toEqual([]);
  });
});

it("rejects an admission read that consumes the entire preparation budget even before the timer callback runs", async () => {
  vi.useFakeTimers(); vi.setSystemTime(0); const f = fixture();
  f.options.authorityValidator.validateDeploymentAuthority = async () => { vi.setSystemTime(30_000); };
  await expect(f.receive()).rejects.toThrow(); expect(f.effects).toEqual([]);
});

it.each(["execute", "stop"])("settles %s admission cancellation even when token cleanup never returns", async (action) => {
  vi.useFakeTimers(); const f = fixture(); let resume!: () => void; const cleanup = new Promise<void>((resolve) => { resume = resolve; }); const release = vi.fn(async () => cleanup);
  const receiver = new AuthenticatedAgentCommandReceiver({ ...f.options, authorityValidator: { validateDeploymentAuthority: async () => new Promise<void>(() => {}) }, replayStore: { ...f.options.replayStore, release } });
  const body = action === "execute" ? f.body : { ...stopBody(f), authority: { ...f.body.authority, action: "deployment.stop", sourceLease: undefined, executionLease: { ...f.body.authority.executionLease, deploymentId: "A" } }, lease: { ...f.body.authority.executionLease, deploymentId: "A" } };
  let outcome = "pending"; const pending = receiver.receive(body, signAgentTransport(JSON.stringify(body), key)).then(() => { outcome = "resolved"; }, () => { outcome = "rejected"; });
  await vi.advanceTimersByTimeAsync(30_000);
  try { expect(outcome).toBe("rejected"); expect(f.effects).toEqual([]); expect(release).toHaveBeenCalledWith(body.commandId, "claim"); }
  finally { resume(); await pending; }
});
