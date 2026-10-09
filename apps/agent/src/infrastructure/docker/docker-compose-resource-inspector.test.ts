import { describe, expect, it } from "vitest";
import { InMemoryCapabilityRegistry, type CapabilityRegistry, type ComposeResourceKind } from "@deploylite/contracts";
import { createComposePreview, type ComposeResourceInspector } from "@deploylite/domain";
import { createDockerComposeResourceInspector } from "./docker-compose-resource-inspector.js";
import type { DockerComposeResourceInspectorOptions } from "./docker-compose-resource-inspector.js";
import type { DockerCliRunner } from "./docker-cli-image-transport.js";

const policy = { policyVersion: "compose-test-1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true };
const image = `registry.example.com/app@sha256:${"a".repeat(64)}`;
const preview = createComposePreview(JSON.stringify({ services: { app: { image, networks: ["app"], volumes: [{ type: "volume", source: "data", target: "/data" }] } }, networks: { app: {} }, volumes: { data: {} } }), "project-1", policy);
type Kind = ComposeResourceKind;
type Resource = { id?: string; createdAt?: string; name: string; driver: string; scope: string; internal?: boolean; optionsCount: number; owner: string; projectId: string; resourceKind: Kind; resourceKey: string };
type Container = { id: string; owner: string; projectId: string; service: string; composeRevisionId?: string; composeConfigDigest?: string; effectiveImage: string; running: boolean; networks: { name: string; networkId: string }[]; mounts: { type: string; name: string; target: string; readOnly: boolean }[]; configuredMounts: { type: string; name: string; target: string; readOnly: boolean }[] };
type Input = Parameters<ComposeResourceInspector["inspect"]>[0];
const create = createDockerComposeResourceInspector;
function fixture(kind: Kind = "network") {
  const r = kind === "network" ? preview.networks[0]! : preview.volumes[0]!;
  const resource: Resource = { ...(kind === "network" ? { id: "b".repeat(64), internal: false } : { createdAt: "2026-10-08T00:00:00Z" }), name: r.runtimeName, driver: r.driver, scope: "local", optionsCount: 0, owner: "deploylite", projectId: "project-1", resourceKind: kind, resourceKey: r.key };
  const container: Container = { id: "c".repeat(64), owner: "deploylite", projectId: "project-1", service: "app", effectiveImage: image, running: false, networks: [{ name: preview.networks[0]!.runtimeName, networkId: "b".repeat(64) }], mounts: [{ type: "volume", name: preview.volumes[0]!.runtimeName, target: "/data", readOnly: false }], configuredMounts: [{ type: "volume", name: preview.volumes[0]!.runtimeName, target: "/data", readOnly: false }] };
  const calls: readonly string[][] = [];
  const f = { resource, container, containers: [container], calls: calls as string[][], afterResource: undefined as Resource | undefined, afterContainer: undefined as Container | undefined, afterIds: undefined as string[] | undefined, reads: 0, lists: 0, containerReads: 0, runError: undefined as Error | undefined, outputOverride: undefined as string | undefined };
  const runner: DockerCliRunner = { run: async (argv) => {
    f.calls.push([...argv]); if (f.runError) throw f.runError;
    let stdout: string;
    if (argv[1] === kind && argv[2] === "inspect") stdout = JSON.stringify(++f.reads === 2 && f.afterResource ? f.afterResource : f.resource);
    else if (argv[1] === "container" && argv[2] === "ls") stdout = (++f.lists === 2 && f.afterIds ? f.afterIds : f.containers.map(c => c.id)).join("\n");
    else if (argv[1] === "container" && argv[2] === "inspect") { const id = argv.at(-1); const c = f.containers.find(c => c.id === id); stdout = JSON.stringify(++f.containerReads > f.containers.length && f.afterContainer ? f.afterContainer : c); }
    else throw new Error("unexpected mutation or argv");
    return { exitCode: 0, signal: null, stderr: "", stdout: f.outputOverride ?? stdout };
  } };
  const options = { runner, owner: "deploylite", agentId: "agent-1", imagePolicy: policy, capabilities: new InMemoryCapabilityRegistry(["compose.resource.inspect.v1"]) as CapabilityRegistry, clock: { now: () => 1_000 }, limits: { maxContainers: 8, maxOutputBytes: 4_096, deadlineMs: 1_000 } } satisfies DockerComposeResourceInspectorOptions;
  return { f, options, input: { preview: structuredClone(preview), kind, key: r.key } satisfies Input };
}
const inspect = (s: ReturnType<typeof fixture>, signal = new AbortController().signal) => create(s.options).inspect(s.input, signal);
describe("explicit read-only Compose resource inspection", () => {
  for (const kind of ["network", "volume"] as const) it(`observes exact owned ${kind} and stopped consumers with two matching snapshots`, async () => {
    const s = fixture(kind); const result = await inspect(s);
    expect(result).toMatchObject({ owner: "deploylite", agentId: "agent-1", runtimeName: s.f.resource.name, physicalIdentity: kind === "network" ? "b".repeat(64) : "2026-10-08T00:00:00Z", configDigest: preview.configDigest, containers: [{ containerId: "c".repeat(64), service: "app", running: false, attached: true }] });
    expect(result.stateDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(s.f.calls).toHaveLength(6);
    expect(s.f.calls.filter(a => a[2] === "ls")).toHaveLength(2);
    for (const argv of s.f.calls) { expect(argv[0]).toBe("docker"); expect(["inspect", "ls"]).toContain(argv[2]); expect(argv).toContain("--format"); }
    expect(s.f.calls.find(a => a[2] === "ls")).toEqual(["docker", "container", "ls", "--all", "--no-trunc", "--format", "{{.ID}}"]);
  });
  it("observes a stopped volume consumer from its configured mount when Docker has no active mount", async () => {
    const s = fixture("volume"); s.f.container.mounts = [];
    await expect(inspect(s)).resolves.toMatchObject({ containers: [{ containerId: "c".repeat(64), running: false, attached: true, mounts: [{ target: "/data", readOnly: false }] }] });
  });
  it("does not infer a running volume attachment from stored configuration alone", async () => {
    const s = fixture("volume"); s.f.container.running = true; s.f.container.mounts = [];
    await expect(inspect(s)).resolves.toMatchObject({ containers: [{ containerId: "c".repeat(64), running: true, attached: false, mounts: [] }] });
  });
  for (const field of ["owner", "projectId", "resourceKey", "resourceKind"] as const) it(`rejects foreign ${field} even when runtime name matches`, async () => {
    const s = fixture(); Object.assign(s.f.resource, { [field]: "foreign" });
    await expect(inspect(s)).rejects.toMatchObject({ code: "COMPOSE_RESOURCE_FOREIGN" }); expect(s.f.calls).toHaveLength(1);
  });
  for (const field of ["driver", "scope", "internal", "optionsCount", "name"] as const) it(`rejects incompatible resource ${field}`, async () => {
    const s = fixture(); Object.assign(s.f.resource, { [field]: field === "optionsCount" ? 1 : field === "internal" ? true : "foreign" });
    await expect(inspect(s)).rejects.toMatchObject({ code: "COMPOSE_RESOURCE_CONFLICT" });
  });
  it("refuses missing volume creation identity rather than inventing an ID", async () => {
    const s = fixture("volume"); delete s.f.resource.createdAt;
    await expect(inspect(s)).rejects.toMatchObject({ code: "COMPOSE_INSPECTION_INVALID" });
  });
  for (const field of ["owner", "projectId", "service", "effectiveImage"] as const) it(`rejects foreign consumer ${field}`, async () => {
    const s = fixture(); s.f.container[field] = "foreign";
    await expect(inspect(s)).rejects.toMatchObject({ code: "COMPOSE_RESOURCE_FOREIGN" });
  });
  it("retains a scoped stopped target without its current attachment", async () => {
    const s = fixture(); s.f.container.networks = [];
    await expect(inspect(s)).resolves.toMatchObject({ containers: [{ containerId: "c".repeat(64), attached: false }] });
  });
  it("observes a configured network by exact name while Docker has no endpoint ID for the stopped target", async () => {
    const s = fixture(); s.f.container.networks = [{ name: s.f.resource.name, networkId: "" }];
    await expect(inspect(s)).resolves.toMatchObject({ containers: [{ containerId: "c".repeat(64), running: false, attached: true,
      networks: [{ name: s.f.resource.name, networkId: "b".repeat(64) }] }] });
  });
  it("rejects a configured network with a different nonempty physical ID", async () => {
    const s = fixture(); s.f.container.networks = [{ name: s.f.resource.name, networkId: "d".repeat(64) }];
    await expect(inspect(s)).rejects.toMatchObject({ code: "COMPOSE_RESOURCE_CONFLICT" });
  });
  it("rejects a running target whose network endpoint ID is missing", async () => {
    const s = fixture(); s.f.container.running = true; s.f.container.networks = [{ name: s.f.resource.name, networkId: "" }];
    await expect(inspect(s)).rejects.toMatchObject({ code: "COMPOSE_RESOURCE_CONFLICT" });
  });
  it("selects the exact current revision after a cutover while ignoring a disconnected prior container", async () => {
    const s = fixture("volume"), prior = { ...structuredClone(s.f.container), id: "e".repeat(64), composeRevisionId: "revision-1",
      composeConfigDigest: "f".repeat(64), networks: [], mounts: [], configuredMounts: [] };
    Object.assign(s.f.container, { id: "d".repeat(64), composeRevisionId: "revision-2", composeConfigDigest: preview.configDigest });
    s.f.containers.splice(0, s.f.containers.length, prior, s.f.container);
    await expect(inspect(s)).resolves.toMatchObject({ containers: [{ containerId: "d".repeat(64), attached: true, composeRevisionId: "revision-2" }] });
  });
  it("rejects a prior revision that still consumes the inspected resource during cutover", async () => {
    const s = fixture("volume"), prior = { ...structuredClone(s.f.container), id: "e".repeat(64), composeRevisionId: "revision-1",
      composeConfigDigest: "f".repeat(64) };
    Object.assign(s.f.container, { id: "d".repeat(64), composeRevisionId: "revision-2", composeConfigDigest: preview.configDigest });
    s.f.containers.splice(0, s.f.containers.length, prior, s.f.container);
    await expect(inspect(s)).rejects.toMatchObject({ code: "COMPOSE_RESOURCE_CONFLICT" });
  });
  it("ignores a foreign non-consumer without publishing its metadata", async () => {
    const s = fixture(); s.f.containers.push({ ...structuredClone(s.f.container), id: "d".repeat(64), owner: "foreign", projectId: "other", effectiveImage: "password=outside-projection", networks: [], mounts: [], configuredMounts: [] });
    const result = await inspect(s); expect(result.containers).toHaveLength(1); expect(JSON.stringify(result)).not.toContain("outside-projection");
  });
  for (const kind of ["network", "volume"] as const) it(`rejects same-name recreated ${kind} between snapshots`, async () => {
    const s = fixture(kind); s.f.afterResource = { ...s.f.resource, ...(kind === "network" ? { id: "e".repeat(64) } : { createdAt: "2026-10-08T01:00:00Z" }) };
    await expect(inspect(s)).rejects.toMatchObject({ code: "COMPOSE_INSPECTION_UNSTABLE" });
  });
  it("rejects a target that starts running during observation", async () => {
    const s = fixture(); s.f.afterContainer = { ...s.f.container, running: true };
    await expect(inspect(s)).rejects.toMatchObject({ code: "COMPOSE_INSPECTION_UNSTABLE" });
  });
  it("rejects changed global consumer identities", async () => {
    const s = fixture(); s.f.afterIds = [];
    await expect(inspect(s)).rejects.toMatchObject({ code: "COMPOSE_INSPECTION_UNSTABLE" });
  });
  it("refuses malformed or duplicate IDs before container inspection", async () => {
    const s = fixture(); s.f.containers.push(structuredClone(s.f.container));
    await expect(inspect(s)).rejects.toMatchObject({ code: "COMPOSE_INSPECTION_INVALID" }); expect(s.f.containerReads).toBe(0);
  });
  it("refuses missing/disabled capability without any CLI call", async () => {
    const s = fixture(); s.options.capabilities = new InMemoryCapabilityRegistry([]);
    await expect(inspect(s)).rejects.toMatchObject({ code: "COMPOSE_INSPECTION_UNSUPPORTED" }); expect(s.f.calls).toHaveLength(0);
  });
  it("does not adopt forged planned names or config digests", async () => {
    const s = fixture(); s.input.preview.networks[0]!.runtimeName = "foreign";
    await expect(inspect(s)).rejects.toMatchObject({ code: "COMPOSE_INSPECTION_INVALID" }); expect(s.f.calls).toHaveLength(0);
  });
  it("bounds the all-container scan before inspecting any consumer", async () => {
    const s = fixture(); s.options.limits.maxContainers = 1; s.f.containers.push({ ...s.f.container, id: "d".repeat(64) });
    await expect(inspect(s)).rejects.toMatchObject({ code: "COMPOSE_INSPECTION_LIMIT" }); expect(s.f.containerReads).toBe(0);
  });
  it("bounds UTF8 output and refuses malformed metadata without leaking it", async () => {
    const s = fixture(); s.f.outputOverride = "password=" + "á".repeat(3_000);
    const error = await inspect(s).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "COMPOSE_INSPECTION_LIMIT" }); expect(JSON.stringify(error)).not.toContain("password=");
  });
  it("uses a fixed error for runner failures without copying stdout/stderr/cause", async () => {
    const s = fixture(); s.f.runError = new Error("password=must-not-leave-runner");
    const error = await inspect(s).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "COMPOSE_INSPECTION_FAILED" }); expect(JSON.stringify(error)).not.toContain("must-not-leave-runner");
  });
  it("handles cancellation before the first runner call", async () => {
    const s = fixture(); const c = new AbortController(); c.abort();
    await expect(inspect(s, c.signal)).rejects.toMatchObject({ code: "COMPOSE_INSPECTION_CANCELED" }); expect(s.f.calls).toHaveLength(0);
  });
  it("rechecks a revoked capability before any subsequent CLI call", async () => {
    const s = fixture(); s.options.capabilities = { has: () => s.f.calls.length === 0 };
    await expect(inspect(s)).rejects.toMatchObject({ code: "COMPOSE_INSPECTION_UNSUPPORTED" }); expect(s.f.calls).toHaveLength(1);
  });
  it("settles cancellation while a runner ignores the signal", async () => {
    const s = fixture(); const c = new AbortController(); s.options.runner = { run: () => { c.abort(); return new Promise(() => undefined); } };
    await expect(inspect(s, c.signal)).rejects.toMatchObject({ code: "COMPOSE_INSPECTION_CANCELED" });
  });
  it("does not expose initial clock failures and starts no CLI call", async () => {
    const s = fixture(); s.options.clock.now = () => { throw new Error("password=clock-private"); };
    const error = await inspect(s).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "COMPOSE_INSPECTION_FAILED" }); expect(JSON.stringify(error)).not.toContain("clock-private"); expect(s.f.calls).toHaveLength(0);
  });
  it("rejects an invalid starting clock even if subsequent readings are valid", async () => {
    const s = fixture(); let calls = 0; s.options.clock.now = () => ++calls === 1 ? Number.NaN : 1_000;
    await expect(inspect(s)).rejects.toMatchObject({ code: "COMPOSE_INSPECTION_LIMIT" }); expect(s.f.calls).toHaveLength(0);
  });
  it("settles a non-cooperating runner within its explicit deadline", async () => {
    const s = fixture(); s.options.limits.deadlineMs = 10; s.options.runner = { run: () => new Promise(() => undefined) };
    await expect(inspect(s)).rejects.toMatchObject({ code: "COMPOSE_INSPECTION_LIMIT" });
  });
});
