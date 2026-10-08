import { createHash } from "node:crypto";
import { composeAttachmentPreviewInputSchema, composeAttachmentPreviewSchema, composeResourceObservationSchema,
  protocolPayloadFingerprint, type Clock, type ComposeAttachmentPreviewInput, type ComposeAttachmentPreviewV1,
  type ComposePreviewV1, type ComposeResourceKind, type ComposeResourceObservationV1, type ImageReferencePolicyV1 } from "@deploylite/contracts";
import { createComposePreview } from "./compose-preview.js";

export type ComposeInspectionErrorCode = "COMPOSE_INSPECTION_INVALID" | "COMPOSE_INSPECTION_UNSUPPORTED" | "COMPOSE_INSPECTION_FAILED" | "COMPOSE_INSPECTION_LIMIT" | "COMPOSE_INSPECTION_CANCELED" | "COMPOSE_INSPECTION_UNSTABLE" | "COMPOSE_RESOURCE_FOREIGN" | "COMPOSE_RESOURCE_CONFLICT" | "COMPOSE_RESOURCE_STALE" | "COMPOSE_RESOURCE_IN_USE" | "COMPOSE_ATTACHMENT_CONFLICT";
export class ComposeResourceInspectionError extends Error {
  constructor(readonly code: ComposeInspectionErrorCode) { super("Compose resource observation is unavailable or outside policy."); this.name = "ComposeResourceInspectionError"; }
}
export interface ComposeResourceInspector {
  inspect(input: Readonly<{ preview: ComposePreviewV1; kind: ComposeResourceKind; key: string }>, signal: AbortSignal): Promise<ComposeResourceObservationV1>;
}
export function digestComposeResourceObservation(observation: ComposeResourceObservationV1): string {
  const { observedAt: _time, stateDigest: _digest, ...state } = observation;
  return createHash("sha256").update(protocolPayloadFingerprint(state)).digest("hex");
}
function fail(code: ComposeInspectionErrorCode): never { throw new ComposeResourceInspectionError(code); }
export type ComposeAttachmentPreviewDependencies = Readonly<{
  imagePolicy: ImageReferencePolicyV1; owner: string; agentId: string; inspector: ComposeResourceInspector; clock: Clock; maxAgeMs: number;
}>;
/** Server-side preview using an explicitly injected observation port, never a caller-supplied ownership receipt. */
export async function createComposeAttachmentPreview(raw: ComposeAttachmentPreviewInput, deps: ComposeAttachmentPreviewDependencies): Promise<ComposeAttachmentPreviewV1> {
  deps = { ...deps, imagePolicy: structuredClone(deps.imagePolicy) };
  const parsed = composeAttachmentPreviewInputSchema.safeParse(raw);
  if (!parsed.success || !Number.isSafeInteger(deps.maxAgeMs) || deps.maxAgeMs <= 0) fail("COMPOSE_INSPECTION_INVALID");
  const input = parsed.data;
  let preview: ComposePreviewV1;
  try { preview = createComposePreview(input.document, input.projectId, deps.imagePolicy); } catch { fail("COMPOSE_INSPECTION_INVALID"); }
  if (preview.configDigest !== input.expectedConfigDigest) fail("COMPOSE_RESOURCE_STALE");
  const resource = (input.kind === "network" ? preview.networks : preview.volumes).find(r => r.key === input.key);
  const service = preview.services.find(s => s.name === input.service);
  if (!resource || !service) fail("COMPOSE_ATTACHMENT_CONFLICT");
  const desired = input.kind === "network" ? service.networks.includes(input.key) : service.volumes.some(m => m.source === input.key);
  if (desired !== (input.action === "attach")) fail("COMPOSE_ATTACHMENT_CONFLICT");
  let observed: unknown;
  try { observed = await deps.inspector.inspect({ preview, kind: input.kind, key: input.key }, new AbortController().signal); }
  catch (error) { if (error instanceof ComposeResourceInspectionError) throw error; fail("COMPOSE_INSPECTION_FAILED"); }
  const validated = composeResourceObservationSchema.safeParse(observed);
  if (!validated.success) fail("COMPOSE_INSPECTION_INVALID");
  const observation = validated.data;
  if (digestComposeResourceObservation(observation) !== observation.stateDigest) fail("COMPOSE_INSPECTION_INVALID");
  if (observation.owner !== deps.owner || observation.agentId !== deps.agentId || observation.projectId !== input.projectId) fail("COMPOSE_RESOURCE_FOREIGN");
  let now: number;
  try { now = deps.clock.now(); } catch { fail("COMPOSE_INSPECTION_FAILED"); }
  if (!Number.isSafeInteger(now) || now < observation.observedAt || now - observation.observedAt > deps.maxAgeMs
    || observation.configDigest !== preview.configDigest || observation.kind !== input.kind || observation.key !== input.key
    || observation.runtimeName !== resource.runtimeName || (input.expectedStateDigest && input.expectedStateDigest !== observation.stateDigest)) fail("COMPOSE_RESOURCE_STALE");
  const targets = observation.containers.filter(c => c.service === service.name);
  if (targets.length !== 1) fail("COMPOSE_ATTACHMENT_CONFLICT");
  const container = targets[0]!;
  if (container.running || observation.containers.some(c => c.attached && c.running)) fail("COMPOSE_RESOURCE_IN_USE");
  if (input.kind === "volume" && input.action === "attach" && container.attached) {
    const mounts = service.volumes.filter(m => m.source === input.key).map(m => ({ target: m.target, readOnly: m.readOnly })).sort((a,b) => a.target.localeCompare(b.target));
    if (protocolPayloadFingerprint(mounts) !== protocolPayloadFingerprint([...container.mounts].sort((a,b) => a.target.localeCompare(b.target)))) fail("COMPOSE_ATTACHMENT_CONFLICT");
  }
  return composeAttachmentPreviewSchema.parse({ schemaVersion: 1, status: "preview", executionAllowed: false,
    projectId: input.projectId, kind: input.kind, key: input.key, service: input.service, action: input.action,
    configDigest: preview.configDigest, stateDigest: observation.stateDigest, containerId: container.containerId,
    alreadySatisfied: container.attached === (input.action === "attach") });
}
