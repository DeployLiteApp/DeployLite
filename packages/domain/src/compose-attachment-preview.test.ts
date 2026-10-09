import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { protocolPayloadFingerprint, type ComposeResourceObservationV1, type ComposeAttachmentPreviewInput } from "@deploylite/contracts";
import * as domain from "./index.js";

const policy = { policyVersion: "compose-test-1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true };
const image = `registry.example.com/app@sha256:${"a".repeat(64)}`;
const document = JSON.stringify({ services: { app: { image, networks: ["app"], volumes: [{ type: "volume", source: "data", target: "/data" }] } }, networks: { app: {} }, volumes: { data: {} } });
const preview = domain.createComposePreview(document, "project-1", policy);
type Observation = ComposeResourceObservationV1;
type Input = ComposeAttachmentPreviewInput;
type Dependencies = { -readonly [P in keyof domain.ComposeAttachmentPreviewDependencies]: domain.ComposeAttachmentPreviewDependencies[P] };
const call = domain.createComposeAttachmentPreview;
function observation(p = preview, kind: "network" | "volume" = "network"): Observation {
  const r = kind === "network" ? p.networks[0]! : p.volumes[0]!;
  return seal({ schemaVersion: 1, owner: "deploylite", agentId: "agent-1", projectId: p.projectId, kind, key: r.key, runtimeName: r.runtimeName, physicalIdentity: kind === "network" ? "b".repeat(64) : "2026-10-08T00:00:00Z", configDigest: p.configDigest, observedAt: 1_000, stateDigest: "", containers: [{ containerId: "c".repeat(64), service: "app", running: false, attached: false, mounts: [] }] });
}
function seal(o: Observation): Observation {
  const { stateDigest: _digest, observedAt: _time, ...state } = o;
  o.stateDigest = createHash("sha256").update(protocolPayloadFingerprint(state)).digest("hex"); return o;
}
function setup(o = observation()) {
  const inspect = vi.fn(async (_input: unknown, _signal: AbortSignal) => structuredClone(o));
  const deps: Dependencies = { imagePolicy: policy, owner: "deploylite", agentId: "agent-1", inspector: { inspect }, clock: { now: () => 1_010 }, maxAgeMs: 100 };
  const input: Input = { document, projectId: "project-1", kind: "network", key: "app", service: "app", action: "attach", expectedConfigDigest: preview.configDigest };
  return { input, deps, inspect, o };
}
describe("owned attachment observation preview", () => {
  it("binds a stopped target and current state without allowing execution", async () => {
    const s = setup(); const plan = await call(s.input, s.deps);
    expect(plan).toMatchObject({ status: "preview", executionAllowed: false, alreadySatisfied: false, containerId: "c".repeat(64), configDigest: preview.configDigest, stateDigest: s.o.stateDigest });
    expect(s.inspect).toHaveBeenCalledOnce();
    expect(s.inspect.mock.calls[0]?.[0]).toMatchObject({ kind: "network", key: "app", preview });
  });
  it("identifies an already attached network as a no-op", async () => {
    const s = setup(); s.o.containers[0]!.attached = true; seal(s.o);
    await expect(call(s.input, s.deps)).resolves.toMatchObject({ alreadySatisfied: true, executionAllowed: false });
  });
  it("checks the existing named-volume mount target and readonly mode", async () => {
    const s = setup(observation(preview, "volume")); s.input.kind = "volume"; s.input.key = "data";
    s.o.containers[0]!.attached = true; s.o.containers[0]!.mounts = [{ target: "/data", readOnly: false }]; seal(s.o);
    await expect(call(s.input, s.deps)).resolves.toMatchObject({ alreadySatisfied: true, executionAllowed: false });
  });
  it("rejects a stale requested preview before reading any runtime port", async () => {
    const s = setup(); s.input.expectedConfigDigest = "f".repeat(64);
    await expect(call(s.input, s.deps)).rejects.toMatchObject({ code: "COMPOSE_RESOURCE_STALE" }); expect(s.inspect).not.toHaveBeenCalled();
  });
  for (const field of ["owner", "agentId", "projectId"] as const) it(`rejects foreign ${field} from the observation port`, async () => {
    const s = setup(); s.o[field] = "foreign"; seal(s.o);
    await expect(call(s.input, s.deps)).rejects.toMatchObject({ code: "COMPOSE_RESOURCE_FOREIGN" });
  });
  for (const field of ["configDigest", "runtimeName", "key"] as const) it(`rejects changed ${field}`, async () => {
    const s = setup(); s.o[field] = field === "configDigest" ? "f".repeat(64) : field === "runtimeName" ? s.o.runtimeName.replace("-net-app", "-net-other") : "other"; seal(s.o);
    await expect(call(s.input, s.deps)).rejects.toMatchObject({ code: "COMPOSE_RESOURCE_STALE" });
  });
  it("rejects changed physical state against a prior server observation digest", async () => {
    const s = setup(); s.input.expectedStateDigest = s.o.stateDigest;
    s.o.physicalIdentity = "d".repeat(64); seal(s.o);
    await expect(call(s.input, s.deps)).rejects.toMatchObject({ code: "COMPOSE_RESOURCE_STALE" });
  });
  for (const observedAt of [500, 2_000]) it(`rejects expired or future observation time ${observedAt}`, async () => {
    const s = setup(); s.o.observedAt = observedAt;
    await expect(call(s.input, s.deps)).rejects.toMatchObject({ code: "COMPOSE_RESOURCE_STALE" });
  });
  it("refuses a running target even before it attaches", async () => {
    const s = setup(); s.o.containers[0]!.running = true; seal(s.o);
    await expect(call(s.input, s.deps)).rejects.toMatchObject({ code: "COMPOSE_RESOURCE_IN_USE" });
  });
  it("refuses another running consumer of the resource", async () => {
    const s = setup(); s.o.containers.push({ containerId: "d".repeat(64), service: "other", running: true, attached: true, mounts: [] }); seal(s.o);
    await expect(call(s.input, s.deps)).rejects.toMatchObject({ code: "COMPOSE_RESOURCE_IN_USE" });
  });
  it("refuses a stale volume mount configuration", async () => {
    const s = setup(observation(preview, "volume")); s.input.kind = "volume"; s.input.key = "data";
    s.o.containers[0]!.attached = true; s.o.containers[0]!.mounts = [{ target: "/wrong", readOnly: true }]; seal(s.o);
    await expect(call(s.input, s.deps)).rejects.toMatchObject({ code: "COMPOSE_ATTACHMENT_CONFLICT" });
  });
  it("refuses attaching a resource absent from desired service intent", async () => {
    const s = setup(); s.input.document = JSON.stringify({ services: { app: { image } }, networks: { app: {} } });
    s.input.expectedConfigDigest = domain.createComposePreview(s.input.document, "project-1", policy).configDigest;
    await expect(call(s.input, s.deps)).rejects.toMatchObject({ code: "COMPOSE_ATTACHMENT_CONFLICT" }); expect(s.inspect).not.toHaveBeenCalled();
  });
  it("refuses detachment while desired intent still uses the resource", async () => {
    const s = setup(); s.input.action = "detach";
    await expect(call(s.input, s.deps)).rejects.toMatchObject({ code: "COMPOSE_ATTACHMENT_CONFLICT" }); expect(s.inspect).not.toHaveBeenCalled();
  });
  it("previews detach of a stopped owned target after intent removes the attachment", async () => {
    const s = setup(); s.input.action = "detach"; s.input.document = JSON.stringify({ services: { app: { image } }, networks: { app: {} } });
    const p = domain.createComposePreview(s.input.document, "project-1", policy); s.input.expectedConfigDigest = p.configDigest;
    const o = observation(p); o.containers[0]!.attached = true; seal(o); s.deps.inspector.inspect = vi.fn(async () => o);
    await expect(call(s.input, s.deps)).resolves.toMatchObject({ action: "detach", alreadySatisfied: false, executionAllowed: false });
  });
  it("rejects missing and duplicate service identities instead of choosing a container", async () => {
    const s = setup(); s.o.containers = []; seal(s.o);
    await expect(call(s.input, s.deps)).rejects.toMatchObject({ code: "COMPOSE_ATTACHMENT_CONFLICT" });
    s.o.containers = [{ containerId: "c".repeat(64), service: "app", running: false, attached: false, mounts: [] }, { containerId: "d".repeat(64), service: "app", running: false, attached: false, mounts: [] }]; seal(s.o);
    await expect(call(s.input, s.deps)).rejects.toMatchObject({ code: "COMPOSE_ATTACHMENT_CONFLICT" });
  });
  it("refuses tampered state digest and unknown unsafe observation fields", async () => {
    const s = setup(); s.o.stateDigest = "f".repeat(64);
    await expect(call(s.input, s.deps)).rejects.toMatchObject({ code: "COMPOSE_INSPECTION_INVALID" });
    seal(s.o); Object.assign(s.o, { password: "must-not-leave-port" });
    await expect(call(s.input, s.deps)).rejects.toMatchObject({ code: "COMPOSE_INSPECTION_INVALID" });
  });
  it("does not expose clock failures through the server preview boundary", async () => {
    const s = setup(); s.deps.clock.now = () => { throw new Error("password=clock-private"); };
    const error = await call(s.input, s.deps).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "COMPOSE_INSPECTION_FAILED" }); expect(JSON.stringify(error)).not.toContain("clock-private");
  });
  it("captures the configured owner and age policy before awaiting the port", async () => {
    const s = setup(); s.deps.inspector.inspect = async () => {
      s.deps.owner = "changed-owner"; s.deps.maxAgeMs = 0; return structuredClone(s.o);
    };
    await expect(call(s.input, s.deps)).resolves.toMatchObject({ executionAllowed: false, containerId: "c".repeat(64) });
  });
  it("redacts untrusted port failures rather than reflecting their causes", async () => {
    const s = setup(); s.deps.inspector.inspect = async () => { throw new Error("password=must-not-leave-port"); };
    const e = await call(s.input, s.deps).catch((e: unknown) => e);
    expect(e).toMatchObject({ code: "COMPOSE_INSPECTION_FAILED" }); expect(JSON.stringify(e)).not.toContain("must-not-leave-port");
  });
});
