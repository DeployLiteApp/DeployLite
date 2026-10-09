import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sealAgentSecretEnvelope } from "@deploylite/config";
import { COMPOSE_VOLUME_ATTACHMENT_CAPABILITY, type ComposeResourceObservationV1, type ComposeVolumeAttachmentAgentCommandV1, type ImageReferencePolicyV1 } from "@deploylite/contracts";
import { createComposePreview, digestComposeResourceObservation } from "@deploylite/domain";
import { createDockerComposeVolumeAttachmentExecutor, type ComposeVolumeReplacementCandidateV1, type ComposeVolumeReplacementDriver } from "./docker-compose-volume-attachment.js";

const policy: ImageReferencePolicyV1 = { policyVersion: "compose-volume-agent-test-1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true };
const image = `registry.example.com/app@sha256:${"a".repeat(64)}`;
const trustKey = "compose_volume_agent_test_trust_key_123456";
const environment = { TOKEN: "fixture-private-value" };
const environmentDigest = createHash("sha256").update(JSON.stringify(environment)).digest("hex");
const networkId = "b".repeat(64), priorId = "1".repeat(64), candidateId = "2".repeat(64);
const oldDocument = JSON.stringify({ services: { api: { image, networks: ["backend"], volumes: [], environment: { TOKEN: "${APP_TOKEN}" } } }, networks: { backend: {} }, volumes: { data: {} } });
const newDocument = JSON.stringify({ services: { api: { image, networks: ["backend"], volumes: [{ type: "volume", source: "data", target: "/data" }], environment: { TOKEN: "${APP_TOKEN}" } } }, networks: { backend: {} }, volumes: { data: {} } });
const priorPreview = createComposePreview(oldDocument, "project-1", policy), nextPreview = createComposePreview(newDocument, "project-1", policy);
const networkName = nextPreview.networks.find(value => value.key === "backend")!.runtimeName;
const volumeName = nextPreview.volumes.find(value => value.key === "data")!.runtimeName;
const lease = { projectId: "project-1", leaseId: "lease-1", fence: 1, expiresAt: 10_000 };
const digest = (value: string) => value.repeat(64);
function observation(preview: typeof priorPreview, containerId: string, revisionId: string, mounts: Array<{ target: string; readOnly: boolean }>, attached: boolean): ComposeResourceObservationV1 {
  const value: ComposeResourceObservationV1 = { schemaVersion: 1, owner: "deploylite", agentId: "agent-1", projectId: "project-1", kind: "volume", key: "data",
    runtimeName: volumeName, physicalIdentity: "2026-10-08T00:00:00.000Z", configDigest: preview.configDigest, observedAt: 1_000, stateDigest: digest("0"),
    containers: [{ containerId, service: "api", running: true, attached, composeRevisionId: revisionId,
      composeConfigDigest: preview.configDigest, composeEnvironmentDigest: environmentDigest, networks: [{ name: networkName, networkId }], mounts }] };
  value.stateDigest = digestComposeResourceObservation(value);
  return value;
}

function networkObservation(preview: typeof priorPreview, container: ComposeResourceObservationV1["containers"][number]): ComposeResourceObservationV1 {
  const value: ComposeResourceObservationV1 = { schemaVersion: 1, owner: "deploylite", agentId: "agent-1", projectId: "project-1", kind: "network", key: "backend",
    runtimeName: networkName, physicalIdentity: networkId, configDigest: preview.configDigest, observedAt: 1_000, stateDigest: digest("0"),
    containers: [{ ...container, attached: true, mounts: [] }] };
  value.stateDigest = digestComposeResourceObservation(value);
  return value;
}

function fixture() {
  const before = observation(priorPreview, priorId, "revision-old", [], false);
  let current = before;
  let candidate: ComposeVolumeReplacementCandidateV1 | null = null;
  const calls: string[] = [];
  let healthy = true, priorHealthy = true, cutoverSucceeds = true, clean = true;
  const driver: ComposeVolumeReplacementDriver = {
    inspectContainer: async () => { calls.push("inspect-container"); return { healthcheck: true, health: "healthy", writableLayerClean: clean }; },
    findCandidate: async () => { calls.push("find-candidate"); return candidate; },
    createCandidate: async ({ name, command, preview, environment: provided }) => {
      calls.push("create-candidate");
      expect(name).toMatch(/^dl-[a-f0-9]{32}-vol-candidate$/); expect(provided).toEqual(environment);
      candidate = { containerId: candidateId, owner: "deploylite", projectId: command.projectId, service: command.service, commandId: command.commandId,
        revisionId: command.revisionId, configDigest: command.configDigest, environmentDigest, image: preview.services.find(value => value.name === command.service)!.image,
        running: true, networks: [networkName], mounts: [{ source: volumeName, target: "/data", readOnly: false }] };
      return candidateId;
    },
    waitUntilHealthy: async (containerId) => { calls.push("wait-healthy"); return containerId === priorId ? priorHealthy : healthy; },
    cutover: async () => { calls.push("cutover"); if (!cutoverSucceeds) throw new Error("fixture cutover failure"); current = observation(nextPreview, candidateId, "revision-new", [{ target: "/data", readOnly: false }], true); },
    restorePrior: async () => { calls.push("restore-prior"); current = before; },
    removeCandidate: async (_containerId, _commandId) => { calls.push("remove-candidate"); candidate = null; }
  };
  const inspector = { inspect: async ({ preview, kind }: { preview: typeof priorPreview; kind: "network" | "volume" }) => { calls.push(preview.configDigest === priorPreview.configDigest ? "inspect-prior" : "inspect-new"); const container = current.containers[0]!; return kind === "network" ? networkObservation(preview, container) : (() => { const projected = { ...current, configDigest: preview.configDigest, stateDigest: digest("0") }; projected.stateDigest = digestComposeResourceObservation(projected); return projected; })(); } };
  const command = {
    schemaVersion: 1, action: "compose.volume.attachment", agentId: "agent-1", commandId: "command-1", projectId: "project-1",
    operation: "compose.resource.attachment", idempotencyKey: "replace-once", inputDigest: digest("a"), priorRevisionId: "revision-old", revisionId: "revision-new",
    priorConfigDigest: priorPreview.configDigest, configDigest: nextPreview.configDigest, stateDigest: before.stateDigest, secretDigest: environmentDigest,
    priorCanonicalDocument: oldDocument, canonicalDocument: newDocument, sealedEnvironment: "", key: "data", runtimeName: volumeName, service: "api", attachmentAction: "attach",
    containerId: priorId, requiredCapabilities: [COMPOSE_VOLUME_ATTACHMENT_CAPABILITY],
    authority: { schemaVersion: 1, projectId: "project-1", commandId: "command-1", action: "project.update", inputDigest: digest("a"), projectLease: lease },
    lease, context: { requestId: "request-1", correlationId: "correlation-1" }, timeoutMs: 5_000, cancellationRequested: false
  } satisfies ComposeVolumeAttachmentAgentCommandV1;
  command.sealedEnvironment = sealAgentSecretEnvelope(environment, trustKey, { agentId: command.agentId, commandId: command.commandId, inputDigest: command.inputDigest, projectId: command.projectId });
  const executor = createDockerComposeVolumeAttachmentExecutor({ inspector, driver, owner: "deploylite", agentId: "agent-1", trustKey,
    imagePolicy: policy, capabilities: { has: capability => capability === COMPOSE_VOLUME_ATTACHMENT_CAPABILITY } });
  return { before, command, executor, driver, calls, setClean(value: boolean) { clean = value; }, setHealthy(value: boolean) { healthy = value; }, setCutoverSucceeds(value: boolean) { cutoverSucceeds = value; }, setResume(candidateHealthy = true) {
    healthy = candidateHealthy;
    candidate = { containerId: candidateId, owner: "deploylite", projectId: "project-1", service: "api", commandId: "command-1", revisionId: "revision-new",
      configDigest: nextPreview.configDigest, environmentDigest, image, running: true, networks: [networkName], mounts: [{ source: volumeName, target: "/data", readOnly: false }] };
    current = observation(nextPreview, candidateId, "revision-new", [{ target: "/data", readOnly: false }], true);
  } };
}

describe("simulated Compose volume replacement", () => {
  it("keeps the prior container running until the exact candidate passes health, then records the replacement", async () => {
    const f = fixture();
    const receipt = await f.executor.execute(f.command, { assertValid: async () => { f.calls.push("authority"); } }, new AbortController().signal);
    expect(f.calls.indexOf("create-candidate")).toBeLessThan(f.calls.indexOf("wait-healthy"));
    expect(f.calls.indexOf("wait-healthy")).toBeLessThan(f.calls.indexOf("cutover"));
    expect(receipt).toMatchObject({ status: "replaced", health: "passed", rollback: "not-required", priorContainerId: priorId, replacementContainerId: candidateId, redacted: true });
    expect(JSON.stringify(receipt)).not.toContain(environment.TOKEN);
  });

  it("rejects a dirty prior writable layer before creating or stopping anything", async () => {
    const f = fixture(); f.setClean(false);
    await expect(f.executor.execute(f.command, { assertValid: async () => undefined }, new AbortController().signal)).rejects.toThrow("preflight rejected");
    expect(f.calls).not.toContain("create-candidate"); expect(f.calls).not.toContain("cutover");
  });

  it("returns an explicit candidate failure while the prior service remains untouched", async () => {
    const f = fixture(); f.setHealthy(false);
    const receipt = await f.executor.execute(f.command, { assertValid: async () => undefined }, new AbortController().signal);
    expect(receipt).toMatchObject({ status: "failed", health: "failed", rollback: "not-required", reason: "candidate-failed" });
    expect(f.calls).not.toContain("cutover"); expect(f.calls).toContain("remove-candidate");
  });

  it("restores the prior service and removes only the candidate after a cutover failure", async () => {
    const f = fixture(); f.setCutoverSucceeds(false);
    const receipt = await f.executor.execute(f.command, { assertValid: async () => undefined }, new AbortController().signal);
    expect(receipt).toMatchObject({ status: "failed", health: "failed", rollback: "restored", reason: "cutover-failed" });
    expect(f.calls).toContain("restore-prior"); expect(f.calls).toContain("remove-candidate");
  });

  it("reconciles a healthy candidate after a lost terminal reply without creating a second candidate", async () => {
    const f = fixture(); f.setResume();
    const receipt = await f.executor.execute(f.command, { assertValid: async () => undefined }, new AbortController().signal);
    expect(receipt).toMatchObject({ status: "already-satisfied", health: "passed", reconciled: true, replacementContainerId: candidateId });
    expect(f.calls).not.toContain("create-candidate"); expect(f.calls).not.toContain("cutover");
  });

  it("restores the prior service when a lost-reply candidate is active but no longer healthy", async () => {
    const f = fixture(); f.setResume(false);
    const receipt = await f.executor.execute(f.command, { assertValid: async () => undefined }, new AbortController().signal);
    expect(receipt).toMatchObject({ status: "failed", health: "failed", rollback: "restored", reason: "candidate-failed", reconciled: true });
    expect(f.calls).toContain("restore-prior"); expect(f.calls).toContain("remove-candidate");
    expect(f.calls).not.toContain("create-candidate"); expect(f.calls).not.toContain("cutover");
  });
});
