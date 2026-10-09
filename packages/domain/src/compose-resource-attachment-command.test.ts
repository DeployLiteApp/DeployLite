import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { protocolPayloadFingerprint, type ComposeResourceObservationV1 } from "@deploylite/contracts";
import { createComposePreview } from "./compose-preview.js";
import { digestControlInput, resolveControlCommandInMemory, type ControlCommand } from "./control-plane.js";
import { composeResourceAttachmentExecutionDigest, prepareComposeAttachmentControlCommand, type ComposeAttachmentCommandDependencies } from "./compose-resource-inspection.js";

const policy = { policyVersion: "compose-test-1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true };
const image = `registry.example.com/app@sha256:${"a".repeat(64)}`;
const document = JSON.stringify({ services: { api: { image, networks: ["backend"] } }, networks: { backend: {} } });
const preview = createComposePreview(document, "project-1", policy);
function seal(value: ComposeResourceObservationV1): ComposeResourceObservationV1 {
  const { observedAt: _observedAt, stateDigest: _stateDigest, ...state } = value;
  value.stateDigest = createHash("sha256").update(protocolPayloadFingerprint(state)).digest("hex");
  return value;
}
function fixture(granted = true) {
  let now = 1_000;
  const observation = seal({ schemaVersion: 1, owner: "deploylite", agentId: "agent-1", projectId: "project-1", kind: "network", key: "backend",
    runtimeName: preview.networks[0]!.runtimeName, physicalIdentity: "b".repeat(64), configDigest: preview.configDigest, observedAt: now, stateDigest: "",
    containers: [{ containerId: "c".repeat(64), service: "api", running: false, attached: false, mounts: [] }] });
  const inspect = vi.fn(async () => structuredClone(observation));
  const ledger = new Map<string, ControlCommand>();
  const resolve = vi.fn(async (command: ControlCommand) => resolveControlCommandInMemory(ledger, command));
  const input = { document, projectId: "project-1", kind: "network" as const, key: "backend", service: "api", action: "attach" as const,
    expectedConfigDigest: preview.configDigest, expectedStateDigest: "", expectedContainerId: "c".repeat(64) };
  const deps: ComposeAttachmentCommandDependencies = {
    imagePolicy: policy, owner: "deploylite", agentId: "agent-1", inspector: { inspect }, clock: { now: () => now }, maxAgeMs: 100,
    actorId: "actor-1", role: "operator", grants: { listForActor: async () => granted ? [{ id: "grant-1", actorId: "actor-1", action: "project.update", scope: { kind: "project", projectId: "project-1" } }] : [] },
    controlCommands: { resolve, complete: async command => command }, correlationId: "corr-1", idempotencyKey: "attach-once", commandTtlMs: 5_000
  };
  input.expectedStateDigest = observation.stateDigest;
  return { deps, input, observation, inspect, resolve, ledger, advance: (ms: number) => { now += ms; } };
}

describe("Compose attachment command admission", () => {
  it("creates a project.update command from a freshly revalidated safe preview", async () => {
    const f = fixture(), result = await prepareComposeAttachmentControlCommand(f.input, f.deps);
    expect(result.command).toMatchObject({ action: "project.update", scope: { kind: "project", projectId: "project-1" }, status: "eligible" });
    expect(result.request).toMatchObject({ operation: "compose.resource.attachment", projectId: "project-1", kind: "network", key: "backend", service: "api", attachmentAction: "attach", stateDigest: f.observation.stateDigest, containerId: "c".repeat(64) });
    expect(result.command.inputDigest).toBe(composeResourceAttachmentExecutionDigest(result.request));
    expect(result.preview.executionAllowed).toBe(false);
    expect(f.inspect).toHaveBeenCalledOnce();
    expect(f.resolve).toHaveBeenCalledOnce();
  });

  it("requires an exact project.update grant before runtime inspection or command reservation", async () => {
    const f = fixture(false);
    await expect(prepareComposeAttachmentControlCommand(f.input, f.deps)).rejects.toMatchObject({ code: "COMPOSE_ATTACHMENT_FORBIDDEN" });
    expect(f.inspect).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
  });

  it("keeps volume attachment rejected until controlled recreation is implemented", async () => {
    const f = fixture();
    await expect(prepareComposeAttachmentControlCommand({ ...f.input, kind: "volume" }, f.deps)).rejects.toMatchObject({ code: "COMPOSE_ATTACHMENT_UNSUPPORTED" });
    expect(f.inspect).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
  });

  it("keeps the original command identity across request correlation IDs", async () => {
    const f = fixture(), first = await prepareComposeAttachmentControlCommand(f.input, f.deps);
    const replay = await prepareComposeAttachmentControlCommand(f.input, { ...f.deps, correlationId: "corr-2" });
    expect(replay.created).toBe(false);
    expect(replay.command.id).toBe(first.command.id);
    expect(replay.command.correlationId).toBe("corr-1");
    expect(replay.command.inputDigest).toBe(first.command.inputDigest);
  });

  it("replays the original command for identical intent and conflicts when observed state changes", async () => {
    const f = fixture(), first = await prepareComposeAttachmentControlCommand(f.input, f.deps), replay = await prepareComposeAttachmentControlCommand(f.input, f.deps);
    expect(replay.created).toBe(false);
    expect(replay.command.id).toBe(first.command.id);
    f.advance(1);
    f.observation.observedAt = 1_001;
    f.observation.physicalIdentity = "d".repeat(64);
    seal(f.observation);
    await expect(prepareComposeAttachmentControlCommand(f.input, f.deps)).rejects.toMatchObject({ code: "COMPOSE_RESOURCE_STALE" });
  });
});
