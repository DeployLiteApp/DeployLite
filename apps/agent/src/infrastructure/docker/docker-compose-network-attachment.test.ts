import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { COMPOSE_NETWORK_ATTACHMENT_CAPABILITY, InMemoryCapabilityRegistry, type ComposeNetworkAttachmentAgentCommandV1, type ComposeResourceObservationV1 } from "@deploylite/contracts";
import { createComposePreview, digestComposeResourceObservation, digestControlInput, type ComposeResourceInspector } from "@deploylite/domain";
import { createDockerComposeNetworkAttachmentExecutor } from "./docker-compose-network-attachment.js";
import type { DockerCliRunner } from "./docker-cli-image-transport.js";

const policy = { policyVersion: "compose-test-1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true };
const image = `registry.example.com/app@sha256:${"a".repeat(64)}`;
function fixture(action: "attach" | "detach" = "attach") {
  let now = 1_000;
  let attached = action === "detach";
  const document = JSON.stringify({ services: { api: { image, ...(action === "attach" ? { networks: ["backend"] } : {}) } }, networks: { backend: {} } });
  const preview = createComposePreview(document, "project-1", policy);
  const observation = (): ComposeResourceObservationV1 => {
    const result: ComposeResourceObservationV1 = { schemaVersion: 1, owner: "deploylite", agentId: "agent-1", projectId: "project-1", kind: "network", key: "backend",
      runtimeName: preview.networks.find(r => r.key === "backend")!.runtimeName, physicalIdentity: "b".repeat(64), configDigest: preview.configDigest,
      observedAt: now, stateDigest: "0".repeat(64), containers: [{ containerId: "c".repeat(64), service: "api", running: false, attached, mounts: [] }] };
    result.stateDigest = digestComposeResourceObservation(result);
    return result;
  };
  const initial = observation();
  const input = { schemaVersion: 1 as const, action: "project.update" as const, scope: { kind: "project" as const, projectId: "project-1" },
    operation: "compose.resource.attachment" as const, idempotencyKey: "attach-once", correlationId: "corr-1", projectId: "project-1", kind: "network" as const,
    key: "backend", runtimeName: preview.networks.find(r => r.key === "backend")!.runtimeName, service: "api", attachmentAction: action,
    configDigest: preview.configDigest, stateDigest: initial.stateDigest, containerId: "c".repeat(64), alreadySatisfied: false };
  const inputDigest = digestControlInput(input);
  const command = { schemaVersion: 1 as const, action: "compose.network.attachment" as const, agentId: "agent-1", commandId: "command-1", projectId: "project-1",
    operation: input.operation, idempotencyKey: input.idempotencyKey, inputDigest, canonicalDocument: preview.canonicalDocument, configDigest: preview.configDigest,
    stateDigest: initial.stateDigest, key: "backend", runtimeName: input.runtimeName, service: "api", attachmentAction: action, containerId: input.containerId,
    alreadySatisfied: false, requiredCapabilities: [COMPOSE_NETWORK_ATTACHMENT_CAPABILITY] as [typeof COMPOSE_NETWORK_ATTACHMENT_CAPABILITY],
    authority: { schemaVersion: 1 as const, projectId: "project-1", commandId: "command-1", action: "project.update" as const, inputDigest,
      projectLease: { projectId: "project-1", leaseId: "command-1:project:2", fence: 2, expiresAt: 10_000 } },
    lease: { projectId: "project-1", leaseId: "command-1:project:2", fence: 2, expiresAt: 10_000 },
    context: { requestId: "request-1", correlationId: "corr-1" }, timeoutMs: 5_000, cancellationRequested: false } satisfies ComposeNetworkAttachmentAgentCommandV1;
  const calls: string[][] = []; let mutationExitCode = 0;
  const runner: DockerCliRunner = { run: vi.fn(async argv => { calls.push([...argv]); if (argv[2] === "connect" || argv[2] === "disconnect") { if (mutationExitCode === 0) attached = argv[2] === "connect"; now++; } return { exitCode: mutationExitCode, signal: null, stdout: "", stderr: "" }; }) };
  const inspector: ComposeResourceInspector = { inspect: vi.fn(async () => observation()) };
  const authority = { assertValid: vi.fn(async () => undefined) };
  const executor = createDockerComposeNetworkAttachmentExecutor({ runner, inspector, owner: "deploylite", agentId: "agent-1", imagePolicy: policy, capabilities: new InMemoryCapabilityRegistry(["compose.resource.inspect.v1"]) });
  return { command, calls, runner, inspector, authority, executor, initial, observation, setAttached(value: boolean) { attached = value; now++; }, setMutationExitCode(value: number) { mutationExitCode = value; } };
}

describe("simulated Compose network attachment execution", () => {
  it("connects only the bound container ID and returns a terminal receipt", async () => {
    const f = fixture("attach");
    const receipt = await f.executor.execute(f.command, f.authority, new AbortController().signal);
    expect(f.calls).toEqual([["docker", "network", "connect", f.command.runtimeName, f.command.containerId]]);
    expect(f.authority.assertValid).toHaveBeenCalledOnce();
    expect(receipt).toMatchObject({ status: "attached", reconciled: false, resourceId: "b".repeat(64), beforeStateDigest: f.initial.stateDigest, redacted: true, reason: null });
  });

  it("disconnects the same exact container when requested", async () => {
    const f = fixture("detach");
    const receipt = await f.executor.execute(f.command, f.authority, new AbortController().signal);
    expect(f.calls).toEqual([["docker", "network", "disconnect", f.command.runtimeName, f.command.containerId]]);
    expect(receipt.status).toBe("detached");
  });

  it("reconciles an already-satisfied postcondition after a lost execution reply without a second mutation", async () => {
    const f = fixture("attach"); f.setAttached(true);
    const receipt = await f.executor.execute(f.command, f.authority, new AbortController().signal);
    expect(f.calls).toHaveLength(0);
    expect(receipt).toMatchObject({ status: "already-attached", reconciled: true, beforeStateDigest: f.observation().stateDigest, afterStateDigest: f.observation().stateDigest });
  });

  it("returns a failed terminal receipt with a fixed reason when the postcondition is absent", async () => {
    const f = fixture("attach"); f.setMutationExitCode(1);
    const receipt = await f.executor.execute(f.command, f.authority, new AbortController().signal);
    expect(receipt).toMatchObject({ status: "failed", reason: "mutation-failed", redacted: true });
    expect(JSON.stringify(receipt)).not.toContain("password");
  });

  it("rejects stale unsatisfied state and running targets before mutation", async () => {
    const stale = fixture("attach"); stale.setAttached(false); stale.command.stateDigest = "f".repeat(64);
    await expect(stale.executor.execute(stale.command, stale.authority, new AbortController().signal)).rejects.toThrow("network attachment state is stale");
    expect(stale.calls).toHaveLength(0);
    const running = fixture("attach"); (running.inspector.inspect as ReturnType<typeof vi.fn>).mockImplementation(async () => { const value = running.observation(); value.containers[0]!.running = true; value.stateDigest = digestComposeResourceObservation(value); return value; });
    await expect(running.executor.execute(running.command, running.authority, new AbortController().signal)).rejects.toThrow("network attachment target is unsafe or changed");
    expect(running.calls).toHaveLength(0);
  });
});
