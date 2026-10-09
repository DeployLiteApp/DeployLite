import { z } from "zod";
import { COMPOSE_RESOURCE_INSPECTION_CAPABILITY, composePreviewSchema, composeResourceObservationSchema,
  protocolPayloadFingerprint, type CapabilityRegistry, type Clock, type ComposePreviewV1,
  type ComposeResourceKind, type ImageReferencePolicyV1 } from "@deploylite/contracts";
import { awaitAbortable, createComposePreview, ComposeResourceInspectionError, digestComposeResourceObservation,
  type ComposeInspectionErrorCode, type ComposeResourceInspector } from "@deploylite/domain";
import type { DockerCliRunner } from "./docker-cli-image-transport.js";
import { COMPOSE_CONTAINER_INSPECT_FORMAT, COMPOSE_NETWORK_INSPECT_FORMAT, COMPOSE_VOLUME_INSPECT_FORMAT } from "./docker-compose-resource-argv.js";

const id = z.string().regex(/^[a-f0-9]{64}$/);
const nullableText = z.string().max(512).nullable();
const common = { name: z.string().max(160), driver: z.string().max(64), scope: z.string().max(64),
  optionsCount: z.number().int().nonnegative(), owner: nullableText, projectId: nullableText, resourceKind: nullableText, resourceKey: nullableText };
const networkSchema = z.object({ ...common, id, internal: z.boolean() }).strict();
const volumeSchema = z.object({ ...common, createdAt: z.string().max(64).refine(v => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v))) }).strict();
const containerSchema = z.object({ id, owner: nullableText, projectId: nullableText, service: nullableText,
  composeRevisionId: nullableText.optional(), composeConfigDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(), composeEnvironmentDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  effectiveImage: z.string().max(512), running: z.boolean(),
  networks: z.array(z.object({ name: z.string().max(160), networkId: z.string().max(64) }).strict()).max(128),
  mounts: z.array(z.object({ type: z.string().max(32), name: z.string().max(160).nullable(), target: z.string().max(256), readOnly: z.boolean() }).strict()).max(128)
}).strict();
type Container = z.infer<typeof containerSchema>;
export type DockerComposeResourceInspectorOptions = Readonly<{
  runner: DockerCliRunner; owner: string; agentId: string; imagePolicy: ImageReferencePolicyV1;
  capabilities: CapabilityRegistry; clock: Clock;
  limits: Readonly<{ maxContainers: number; maxOutputBytes: number; deadlineMs: number }>;
}>;
function fail(code: ComposeInspectionErrorCode): never { throw new ComposeResourceInspectionError(code); }
/** Explicitly composed read-only adapter. No default runner, daemon access or mutation method. */
export function createDockerComposeResourceInspector(supplied: DockerComposeResourceInspectorOptions): ComposeResourceInspector {
  const options = { ...supplied, imagePolicy: structuredClone(supplied.imagePolicy), limits: { ...supplied.limits } };
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(options.owner) || !/^[A-Za-z0-9_-]{1,200}$/.test(options.agentId)
    || !Number.isSafeInteger(options.limits.maxContainers) || options.limits.maxContainers < 1 || options.limits.maxContainers > 128
    || !Number.isSafeInteger(options.limits.maxOutputBytes) || options.limits.maxOutputBytes < 1 || options.limits.maxOutputBytes > 1_048_576
    || !Number.isSafeInteger(options.limits.deadlineMs) || options.limits.deadlineMs < 1 || options.limits.deadlineMs > 60_000) fail("COMPOSE_INSPECTION_INVALID");
  return { async inspect(input, external) {
    if (external.aborted) fail("COMPOSE_INSPECTION_CANCELED");
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    external.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), options.limits.deadlineMs);
    let start = Number.NaN;
    function assertCurrent() {
      if (external.aborted) fail("COMPOSE_INSPECTION_CANCELED");
      const now = options.clock.now();
      if (!Number.isSafeInteger(now) || now < start || controller.signal.aborted || now - start >= options.limits.deadlineMs) fail("COMPOSE_INSPECTION_LIMIT");
      if (!options.capabilities.has(COMPOSE_RESOURCE_INSPECTION_CAPABILITY)) fail("COMPOSE_INSPECTION_UNSUPPORTED");
    }
    async function run(argv: readonly string[]): Promise<string> {
      assertCurrent();
      const result = await awaitAbortable(() => options.runner.run(Object.freeze([...argv]), controller.signal), controller.signal);
      assertCurrent();
      if (Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8") > options.limits.maxOutputBytes) fail("COMPOSE_INSPECTION_LIMIT");
      if (result.exitCode !== 0 || result.signal !== null) fail("COMPOSE_INSPECTION_FAILED");
      return result.stdout;
    }
    function parse<T>(schema: z.ZodType<T>, text: string): T {
      try { const parsed = schema.safeParse(JSON.parse(text)); if (parsed.success) return parsed.data; } catch { /* never reflect daemon output */ }
      fail("COMPOSE_INSPECTION_INVALID");
    }
    try {
      start = options.clock.now();
      if (!Number.isSafeInteger(start) || start < 0) fail("COMPOSE_INSPECTION_LIMIT");
      assertCurrent();
      const parsed = composePreviewSchema.safeParse(input.preview);
      if (!parsed.success || !["network", "volume"].includes(input.kind)) fail("COMPOSE_INSPECTION_INVALID");
      const preview: ComposePreviewV1 = createComposePreview(parsed.data.canonicalDocument, parsed.data.projectId, options.imagePolicy);
      if (protocolPayloadFingerprint(preview) !== protocolPayloadFingerprint(parsed.data)) fail("COMPOSE_INSPECTION_INVALID");
      const kind: ComposeResourceKind = input.kind;
      const planned = (kind === "network" ? preview.networks : preview.volumes).find(r => r.key === input.key);
      if (!planned) fail("COMPOSE_INSPECTION_INVALID");
      const resourceArgv = ["docker", kind, "inspect", "--format", kind === "network" ? COMPOSE_NETWORK_INSPECT_FORMAT : COMPOSE_VOLUME_INSPECT_FORMAT, planned.runtimeName];
      async function inspectResource() {
        const text = await run(resourceArgv);
        const r = kind === "network" ? parse(networkSchema, text) : parse(volumeSchema, text);
        if (r.owner !== options.owner || r.projectId !== preview.projectId || r.resourceKind !== kind || r.resourceKey !== planned!.key) fail("COMPOSE_RESOURCE_FOREIGN");
        if (r.name !== planned!.runtimeName || r.scope !== "local" || r.driver !== planned!.driver || r.optionsCount !== 0
          || ("internal" in r && r.internal !== (planned as ComposePreviewV1["networks"][number]).internal)) fail("COMPOSE_RESOURCE_CONFLICT");
        return r;
      }
      async function listIds() {
        // A global bounded --all scan includes stopped consumers; network/volume filters are insufficient evidence.
        const text = await run(["docker", "container", "ls", "--all", "--no-trunc", "--format", "{{.ID}}"]);
        const ids = text.trim() ? text.trim().split(/\r?\n/) : [];
        if (ids.length > options.limits.maxContainers) fail("COMPOSE_INSPECTION_LIMIT");
        if (ids.some(v => !id.safeParse(v).success) || new Set(ids).size !== ids.length) fail("COMPOSE_INSPECTION_INVALID");
        return ids.sort();
      }
      async function readContainers(ids: string[]) {
        const records: Container[] = [];
        for (const containerId of ids) {
          const c = parse(containerSchema, await run(["docker", "container", "inspect", "--format", COMPOSE_CONTAINER_INSPECT_FORMAT, containerId]));
          if (c.id !== containerId) fail("COMPOSE_INSPECTION_INVALID");
          c.networks.sort((a,b) => a.name.localeCompare(b.name)); c.mounts.sort((a,b) => a.target.localeCompare(b.target)); records.push(c);
        }
        return records;
      }
      const before = await inspectResource();
      const ids = await listIds(); const first = await readContainers(ids);
      const after = await inspectResource(); const afterIds = await listIds();
      if (protocolPayloadFingerprint(before) !== protocolPayloadFingerprint(after) || protocolPayloadFingerprint(ids) !== protocolPayloadFingerprint(afterIds)) fail("COMPOSE_INSPECTION_UNSTABLE");
      const second = await readContainers(afterIds);
      if (protocolPayloadFingerprint(first) !== protocolPayloadFingerprint(second)) fail("COMPOSE_INSPECTION_UNSTABLE");
      const physicalIdentity = "id" in before ? before.id : before.createdAt;
      const containers: { containerId: string; service: string; running: boolean; attached: boolean; composeRevisionId?: string; composeConfigDigest?: string; composeEnvironmentDigest?: string; networks: { name: string; networkId: string }[]; mounts: { target: string; readOnly: boolean }[] }[] = [];
      for (const c of first) {
        const matchingNetwork = c.networks.filter(n => n.name === planned.runtimeName || n.networkId === physicalIdentity);
        if (kind === "network" && matchingNetwork.some(n => n.name !== planned.runtimeName
          || n.networkId !== physicalIdentity && !(n.networkId === "" && !c.running))) fail("COMPOSE_RESOURCE_CONFLICT");
        const matchingMounts = c.mounts.filter(m => m.type === "volume" && m.name === planned.runtimeName);
        const attached = kind === "network" ? matchingNetwork.length > 0 : matchingMounts.length > 0;
        const service = preview.services.find(s => s.name === c.service);
        const owned = c.owner === options.owner && c.projectId === preview.projectId && service !== undefined && c.effectiveImage === service.image;
        if (attached && !owned) fail("COMPOSE_RESOURCE_FOREIGN");
        if (!owned) continue;
        // A stopped target can retain the configured network by name without an endpoint ID. The network itself
        // was ownership-bound above, so project this exact named edge using its current physical identity.
        const networks = c.networks.map(network => ({ name: network.name, networkId: kind === "network" && network.name === planned.runtimeName
          && network.networkId === "" && !c.running ? physicalIdentity : network.networkId }));
        containers.push({ containerId: c.id, service: service!.name, running: c.running, attached,
          ...(c.composeRevisionId ? { composeRevisionId: c.composeRevisionId } : {}),
          ...(c.composeConfigDigest ? { composeConfigDigest: c.composeConfigDigest } : {}),
          ...(c.composeEnvironmentDigest ? { composeEnvironmentDigest: c.composeEnvironmentDigest } : {}),
          networks,
          mounts: kind === "volume" ? matchingMounts.map(m => ({ target: m.target, readOnly: m.readOnly })) : [] });
      }
      const byService = new Map<string, typeof containers>();
      for (const container of containers) {
        const group = byService.get(container.service) ?? [];
        group.push(container); byService.set(container.service, group);
      }
      const selected = [];
      for (const group of byService.values()) {
        if (group.length === 1) { selected.push(group[0]!); continue; }
        // During an immutable revision cutover, a stopped prior container may remain
        // disconnected while the new revision owns the service. Never hide an old
        // revision that still consumes the resource being inspected.
        const current = group.filter(container => container.composeRevisionId && container.composeConfigDigest === preview.configDigest);
        if (current.length !== 1) fail("COMPOSE_RESOURCE_CONFLICT");
        if (group.some(container => container !== current[0] && container.attached)) fail("COMPOSE_RESOURCE_CONFLICT");
        selected.push(current[0]!);
      }
      const observation = composeResourceObservationSchema.parse({ schemaVersion: 1, owner: options.owner, agentId: options.agentId,
        projectId: preview.projectId, kind, key: planned.key, runtimeName: planned.runtimeName, physicalIdentity,
        configDigest: preview.configDigest, observedAt: options.clock.now(), stateDigest: "0".repeat(64), containers: selected });
      observation.stateDigest = digestComposeResourceObservation(observation);
      assertCurrent(); return observation;
    } catch (error) {
      if (external.aborted) fail("COMPOSE_INSPECTION_CANCELED");
      if (controller.signal.aborted) fail("COMPOSE_INSPECTION_LIMIT");
      if (error instanceof ComposeResourceInspectionError) throw error;
      fail("COMPOSE_INSPECTION_FAILED");
    } finally { clearTimeout(timer); external.removeEventListener("abort", onAbort); }
  } };
}
