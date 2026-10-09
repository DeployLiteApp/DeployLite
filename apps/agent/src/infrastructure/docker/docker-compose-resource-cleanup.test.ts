import { describe, expect, it, vi } from "vitest";
import { COMPOSE_RESOURCE_CLEANUP_CAPABILITY, COMPOSE_RESOURCE_INSPECTION_CAPABILITY, composeResourceCleanupAgentCommandSchema,
  type ComposeResourceCleanupAgentCommandV1, type ComposeResourceObservationV1, type ImageReferencePolicyV1 } from "@deploylite/contracts";
import { createComposePreview, digestComposeResourceObservation, digestControlInput, type ComposeResourceInspector } from "@deploylite/domain";
import { createDockerComposeResourceCleanupExecutor } from "./docker-compose-resource-cleanup.js";

const policy: ImageReferencePolicyV1 = { policyVersion: "cleanup-test-v1", trustedHosts: ["docker.io"], allowTags: false, allowDigests: true };
const document = JSON.stringify({ services: { app: { image: `docker.io/library/busybox@sha256:${"a".repeat(64)}` } }, networks: { backend: { internal: true } } });
const projectId = "project-cleanup", agentId = "agent-cleanup", owner = "deploylite", confirmationId = "confirm-cleanup";
const preview = createComposePreview(document, projectId, policy), resource = preview.networks.find(value => value.key === "backend")!;

function observation(overrides: Partial<ComposeResourceObservationV1> = {}): ComposeResourceObservationV1 {
  const raw = { schemaVersion: 1 as const, owner, agentId, projectId, kind: "network" as const, key: "backend", runtimeName: resource.runtimeName,
    physicalIdentity: "b".repeat(64), configDigest: preview.configDigest, observedAt: 100, stateDigest: "0".repeat(64), containers: [], ...overrides };
  raw.stateDigest = digestComposeResourceObservation(raw);
  return raw;
}

function command(): ComposeResourceCleanupAgentCommandV1 {
  const commandId = "cleanup-command", inputDigest = "c".repeat(64), stateDigest = observation().stateDigest;
  const cleanupInputDigest = digestControlInput({ operation: "compose.resource.cleanup", commandId, confirmationId, projectId, agentId,
    inputDigest, kind: "network", key: "backend", configDigest: preview.configDigest, stateDigest });
  return composeResourceCleanupAgentCommandSchema.parse({ schemaVersion: 1, action: "compose.resource.cleanup", agentId, commandId,
    cleanupCommandId: commandId, confirmationId, projectId, inputDigest, cleanupInputDigest, canonicalDocument: document,
    kind: "network", key: "backend", runtimeName: resource.runtimeName, configDigest: preview.configDigest, stateDigest,
    expiresAt: 5_000,
    requiredCapabilities: [COMPOSE_RESOURCE_CLEANUP_CAPABILITY], context: { requestId: "request-cleanup", correlationId: "correlation-cleanup" },
    timeoutMs: 2_000, cancellationRequested: false });
}

function fixture(current = observation(), outputs = ["", ""]) {
  const inspector: ComposeResourceInspector = { inspect: vi.fn(async () => structuredClone(current)) };
  const runner = { run: vi.fn(async (_argv: readonly string[], _signal: AbortSignal) => ({ stdout: outputs.shift() ?? "", stderr: "", exitCode: 0, signal: null })) };
  const capabilities = { has: (capability: string) => [COMPOSE_RESOURCE_INSPECTION_CAPABILITY, COMPOSE_RESOURCE_CLEANUP_CAPABILITY].includes(capability) };
  const executor = createDockerComposeResourceCleanupExecutor({ runner, inspector, owner, agentId, imagePolicy: policy, capabilities, now: () => 100 });
  return { executor, inspector, runner };
}

describe("Docker Compose resource cleanup executor", () => {
  it("removes only a fresh, owned, detached resource and verifies its exact name is absent", async () => {
    const f = fixture(), receipt = await f.executor.execute(command(), new AbortController().signal);
    expect(f.inspector.inspect).toHaveBeenCalledTimes(1);
    expect(f.runner.run.mock.calls.map(call => call[0])).toEqual([
      ["docker", "network", "rm", resource.runtimeName],
      ["docker", "network", "ls", "--filter", `name=^${resource.runtimeName}$`, "--format", "{{.Name}}"]
    ]);
    expect(receipt).toMatchObject({ action: "compose.resource.cleanup", status: "completed", terminalStatus: "removed", physicalIdentity: "b".repeat(64), redacted: true });
  });

  it.each([
    ["foreign owner", { owner: "other" }],
    ["foreign project", { projectId: "project-other" }],
    ["stale state", { physicalIdentity: "f".repeat(64) }],
    ["attached consumer", { containers: [{ containerId: "e".repeat(64), service: "app", running: false, attached: true, mounts: [] }] }]
  ])("fails closed for %s before removal", async (_name, override) => {
    const f = fixture(observation(override));
    await expect(f.executor.execute(command(), new AbortController().signal)).rejects.toThrow();
    expect(f.runner.run).not.toHaveBeenCalled();
  });

  it("does not report success if the resource is still present after the remove command", async () => {
    const f = fixture(observation(), ["", resource.runtimeName]);
    await expect(f.executor.execute(command(), new AbortController().signal)).rejects.toThrow();
    expect(f.runner.run).toHaveBeenCalledTimes(2);
  });
});
