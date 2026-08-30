import { describe, expect, it } from "vitest";
import { createDeploymentSnapshot, createSourceIntent, FenceError, LeaseExpiredError, ReplayConflictError, type DeploymentSnapshotV1 } from "@deploylite/contracts";
import { DockerImageExecutor } from "./docker-image-executor.js";
import { FakeDockerImageTransport } from "./testing/fake-docker-image-transport.js";
import { InMemoryProtocolTransport } from "./protocol-memory.js";

const digest = `sha256:${"a".repeat(64)}`;
const policy = { policyVersion: "policy-1", trustedHosts: ["registry.example.com"], allowTags: true, allowDigests: true } as const;
const snapshot = (changes: Partial<DeploymentSnapshotV1> = {}): DeploymentSnapshotV1 => createDeploymentSnapshot({ deploymentId: "dep-1", projectId: "project-1", source: createSourceIntent({ sourceMode: "image", requestedReference: `registry.example.com/team/app@${digest}` }, policy), configRevision: "config-1", runtimeRevision: "runtime-1", runtimePort: 3000, secretRefs: [], policyVersion: policy.policyVersion, schemaVersion: 1, ...changes }, { sha256: () => "b".repeat(64) });
const setup = (transport: FakeDockerImageTransport, clock = { now: () => 1000 }, capabilities: readonly string[] = ["deploy.execute"]) => { const protocol = new InMemoryProtocolTransport({ clock, leasePolicy: { ttlMs: 10 }, retryPolicy: { maxAttempts: 1, deadlineMs: 0, backoffMs: () => 0 }, capabilities }); return { protocol, executor: new DockerImageExecutor({ protocol, transport, trustedHosts: policy.trustedHosts, allowedNetworks: ["deploylite"] }) }; };
const input = (protocol: InMemoryProtocolTransport, changes: Record<string, unknown> = {}) => ({ snapshot: snapshot(), commandId: "command-1", lease: protocol.claimLease("dep-1"), ...changes });

describe("DockerImageExecutor adversarial boundaries", () => {
  it.each([
    ["canonical JSON", { canonicalJson: "{}" }],
    ["canonical bytes", { canonicalBytes: new TextEncoder().encode("{}") }],
    ["tag-only image", { source: createSourceIntent({ sourceMode: "image", requestedReference: "registry.example.com/team/app:stable" }, policy) }],
    ["invalid port", { runtimePort: 0 }]
  ])("rejects tampered or unsafe %s without transport", async (_name, changes) => { const transport = new FakeDockerImageTransport(); const { protocol, executor } = setup(transport); const base = snapshot(changes as Partial<DeploymentSnapshotV1>); const candidate = _name === "canonical JSON" ? { ...base, canonicalJson: "{}" } : _name === "canonical bytes" ? { ...base, canonicalBytes: new TextEncoder().encode("{}") } : base; await expect(executor.execute(input(protocol, { snapshot: candidate }))).rejects.toThrow(); expect(transport.calls).toEqual([]); });

  it("rejects an untrusted host and malformed digest before protocol effects", async () => { const transport = new FakeDockerImageTransport(); const { protocol, executor } = setup(transport); const bad = snapshot({ source: { ...snapshot().source, image: { ...snapshot().source.image, registryHost: "evil.example.com", reference: `evil.example.com/team/app@${digest}` } } } as Partial<DeploymentSnapshotV1>); await expect(executor.execute(input(protocol, { snapshot: bad }))).rejects.toThrow("trusted"); expect(transport.calls).toEqual([]); });

  it("rejects expired and fenced leases before transport", async () => { let now = 1000; const transport = new FakeDockerImageTransport(); const expiredSetup = setup(transport, { now: () => now }); const expired = expiredSetup.protocol.claimLease("dep-1"); now = 1010; await expect(expiredSetup.executor.execute({ snapshot: snapshot(), commandId: "expired", lease: expired })).rejects.toThrow(LeaseExpiredError); const fencedSetup = setup(transport); const old = fencedSetup.protocol.claimLease("dep-1"); const current = fencedSetup.protocol.claimLease("dep-1"); await expect(fencedSetup.executor.execute({ snapshot: snapshot(), commandId: "stale", lease: old })).rejects.toThrow(FenceError); expect(current.fence).toBeGreaterThan(old.fence); expect(transport.calls).toEqual([]); });

  it("rejects a replay with a changed payload without invoking transport again", async () => { const transport = new FakeDockerImageTransport(); const { protocol, executor } = setup(transport); await executor.execute(input(protocol)); const changed = snapshot({ runtimePort: 3001 }); await expect(executor.execute({ snapshot: changed, commandId: "command-1", lease: protocol.claimLease("dep-1") })).rejects.toThrow(ReplayConflictError); expect(transport.calls).toEqual(["start", "health", "promote"]); });

  it("records rollback failure as a failed terminal outcome", async () => { const prior = { deploymentId: "dep-1", effectiveImage: `registry.example.com/team/old@${digest}`, runtimePort: 3000, health: "passed" as const, terminalStatus: "succeeded" as const, rollback: { target: null, result: "not-required" as const }, proven: true as const }; const transport = new FakeDockerImageTransport({ promote: new Error("promote failed"), restore: new Error("restore failed") }); const { protocol, executor } = setup(transport); const result = await executor.execute(input(protocol, { priorProvenReceipt: prior })); expect(result).toMatchObject({ terminalStatus: "failed", rollback: { target: prior.effectiveImage, result: "not-available" } }); expect(protocol.getAck("dep-1")).toMatchObject({ kind: "terminal-ack", status: "failed" }); expect(transport.calls).toEqual(["start", "health", "promote", "restore", "discard"]); });

  it("emits a canceled terminal ACK without any transport effect", async () => { const transport = new FakeDockerImageTransport(); const { protocol, executor } = setup(transport); const controller = new AbortController(); controller.abort(); const result = await executor.execute(input(protocol, { signal: controller.signal })); expect(result.terminalStatus).toBe("canceled"); expect(protocol.getAck("dep-1")).toMatchObject({ kind: "terminal-ack", status: "canceled" }); expect(transport.calls).toEqual([]); });
});
