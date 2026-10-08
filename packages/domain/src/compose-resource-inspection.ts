import { createHash } from "node:crypto";
import { composeAttachmentPreviewInputSchema, composeAttachmentPreviewSchema, composeNetworkAttachmentCommandInputSchema, composeResourceAttachmentCommandSchema, composeResourceInspectionInputSchema, composeResourceInspectionViewSchema,
  composeResourceObservationSchema, protocolPayloadFingerprint, type Clock, type ComposeAttachmentPreviewInput, type ComposeAttachmentPreviewV1,
  type ComposeNetworkAttachmentCommandInput, type ComposePreviewV1, type ComposeResourceAttachmentCommandV1, type ComposeResourceInspectionInput, type ComposeResourceInspectionViewV1, type ComposeResourceKind,
  type ComposeResourceObservationV1, type ImageReferencePolicyV1, type CanonicalRole } from "@deploylite/contracts";
import { awaitAbortable } from "./deployment-contract/docker-image-executor.js";
import { createComposePreview } from "./compose-preview.js";
import { createControlCommand, digestControlInput, PolicyEvaluator, type ControlCommand, type ControlCommandRepository, type ControlGrantRepository } from "./control-plane.js";

export type ComposeInspectionErrorCode = "COMPOSE_INSPECTION_INVALID" | "COMPOSE_INSPECTION_UNSUPPORTED" | "COMPOSE_INSPECTION_FAILED" | "COMPOSE_INSPECTION_LIMIT" | "COMPOSE_INSPECTION_CANCELED" | "COMPOSE_INSPECTION_UNSTABLE" | "COMPOSE_RESOURCE_FOREIGN" | "COMPOSE_RESOURCE_CONFLICT" | "COMPOSE_RESOURCE_STALE" | "COMPOSE_RESOURCE_IN_USE" | "COMPOSE_ATTACHMENT_CONFLICT" | "COMPOSE_ATTACHMENT_FORBIDDEN" | "COMPOSE_ATTACHMENT_UNSUPPORTED";
export class ComposeResourceInspectionError extends Error {
  constructor(readonly code: ComposeInspectionErrorCode) { super("Compose resource observation is unavailable or outside policy."); this.name = "ComposeResourceInspectionError"; }
}
export type ComposeResourceInspectionContext = Readonly<{ requestId: string; correlationId: string }>;
export interface ComposeResourceInspector {
  inspect(input: Readonly<{ preview: ComposePreviewV1; kind: ComposeResourceKind; key: string }>, signal: AbortSignal, context?: ComposeResourceInspectionContext): Promise<ComposeResourceObservationV1>;
}
export function digestComposeResourceObservation(observation: ComposeResourceObservationV1): string {
  const { observedAt: _time, stateDigest: _digest, ...state } = observation;
  return createHash("sha256").update(protocolPayloadFingerprint(state)).digest("hex");
}
function fail(code: ComposeInspectionErrorCode): never { throw new ComposeResourceInspectionError(code); }
export type ComposeAttachmentPreviewDependencies = Readonly<{
  imagePolicy: ImageReferencePolicyV1; owner: string; agentId: string; inspector: ComposeResourceInspector; clock: Clock; maxAgeMs: number;
}>;
export type ComposeAttachmentCommandDependencies = ComposeAttachmentPreviewDependencies & Readonly<{
  actorId: string; role: CanonicalRole; grants: ControlGrantRepository; controlCommands: ControlCommandRepository;
  correlationId: string; idempotencyKey: string; commandTtlMs: number;
}>;
export type PreparedComposeAttachmentCommand = Readonly<{ command: ControlCommand; request: ComposeResourceAttachmentCommandV1; preview: ComposeAttachmentPreviewV1; canonicalDocument: string; agentId: string; created: boolean }>;
/** Stable idempotency digest for attachment intent; request and correlation identifiers stay on the shared command row. */
export function composeResourceAttachmentExecutionDigest(request: ComposeResourceAttachmentCommandV1): string {
  return digestControlInput(Object.fromEntries(Object.entries(request).filter(([key]) => key !== "idempotencyKey" && key !== "correlationId")));
}
type Resource = ComposePreviewV1["networks"][number] | ComposePreviewV1["volumes"][number];
function capture(deps: ComposeAttachmentPreviewDependencies): ComposeAttachmentPreviewDependencies {
  if (!Number.isSafeInteger(deps.maxAgeMs) || deps.maxAgeMs <= 0) fail("COMPOSE_INSPECTION_INVALID");
  return { ...deps, imagePolicy: structuredClone(deps.imagePolicy) };
}
function currentPreview(document: string, projectId: string, expectedDigest: string, deps: ComposeAttachmentPreviewDependencies): ComposePreviewV1 {
  let preview: ComposePreviewV1;
  try { preview = createComposePreview(document, projectId, deps.imagePolicy); } catch { fail("COMPOSE_INSPECTION_INVALID"); }
  if (preview.configDigest !== expectedDigest) fail("COMPOSE_RESOURCE_STALE");
  return preview;
}
async function observe(preview: ComposePreviewV1, kind: ComposeResourceKind, resource: Resource, deps: ComposeAttachmentPreviewDependencies, signal?: AbortSignal, context?: ComposeResourceInspectionContext): Promise<ComposeResourceObservationV1> {
  let observed: unknown;
  const abort = signal ?? new AbortController().signal;
  try { observed = await awaitAbortable(() => deps.inspector.inspect({ preview, kind, key: resource.key }, abort, context), abort); }
  catch (error) {
    if (error instanceof ComposeResourceInspectionError) throw error;
    if (abort.aborted) fail("COMPOSE_INSPECTION_CANCELED");
    fail("COMPOSE_INSPECTION_FAILED");
  }
  const validated = composeResourceObservationSchema.safeParse(observed);
  if (!validated.success) fail("COMPOSE_INSPECTION_INVALID");
  const observation = validated.data;
  if (digestComposeResourceObservation(observation) !== observation.stateDigest) fail("COMPOSE_INSPECTION_INVALID");
  if (observation.owner !== deps.owner || observation.agentId !== deps.agentId || observation.projectId !== preview.projectId) fail("COMPOSE_RESOURCE_FOREIGN");
  let now: number;
  try { now = deps.clock.now(); } catch { fail("COMPOSE_INSPECTION_FAILED"); }
  if (!Number.isSafeInteger(now) || now < observation.observedAt || now - observation.observedAt > deps.maxAgeMs
    || observation.configDigest !== preview.configDigest || observation.kind !== kind || observation.key !== resource.key || observation.runtimeName !== resource.runtimeName) fail("COMPOSE_RESOURCE_STALE");
  return observation;
}
/** A safe view of a fresh server-bound observation, not a runtime authority or ownership-adoption receipt. */
export async function createComposeResourceInspectionView(raw: ComposeResourceInspectionInput, supplied: ComposeAttachmentPreviewDependencies, signal?: AbortSignal, context?: ComposeResourceInspectionContext): Promise<ComposeResourceInspectionViewV1> {
  const deps = capture(supplied);
  const parsed = composeResourceInspectionInputSchema.safeParse(raw);
  if (!parsed.success) fail("COMPOSE_INSPECTION_INVALID");
  const input = parsed.data;
  const preview = currentPreview(input.document, input.projectId, input.expectedConfigDigest, deps);
  const resource = (input.kind === "network" ? preview.networks : preview.volumes).find(r => r.key === input.key);
  if (!resource) fail("COMPOSE_RESOURCE_CONFLICT");
  const observation = await observe(preview, input.kind, resource, deps, signal, context);
  return composeResourceInspectionViewSchema.parse({ schemaVersion: 1, status: "observed", executionAllowed: false,
    projectId: input.projectId, kind: input.kind, key: input.key, configDigest: observation.configDigest,
    stateDigest: observation.stateDigest, observedAt: observation.observedAt,
    containers: observation.containers.map(c => ({ service: c.service, running: c.running, attached: c.attached })) });
}
/** Server-side preview using an explicitly injected observation port, never a caller-supplied ownership receipt. */
export async function createComposeAttachmentPreview(raw: ComposeAttachmentPreviewInput, supplied: ComposeAttachmentPreviewDependencies, signal?: AbortSignal, context?: ComposeResourceInspectionContext): Promise<ComposeAttachmentPreviewV1> {
  const deps = capture(supplied);
  const parsed = composeAttachmentPreviewInputSchema.safeParse(raw);
  if (!parsed.success) fail("COMPOSE_INSPECTION_INVALID");
  const input = parsed.data;
  const preview = currentPreview(input.document, input.projectId, input.expectedConfigDigest, deps);
  const resource = (input.kind === "network" ? preview.networks : preview.volumes).find(r => r.key === input.key);
  const service = preview.services.find(s => s.name === input.service);
  if (!resource || !service) fail("COMPOSE_ATTACHMENT_CONFLICT");
  const desired = input.kind === "network" ? service.networks.includes(input.key) : service.volumes.some(m => m.source === input.key);
  if (desired !== (input.action === "attach")) fail("COMPOSE_ATTACHMENT_CONFLICT");
  const observation = await observe(preview, input.kind, resource, deps, signal, context);
  if (input.expectedStateDigest && input.expectedStateDigest !== observation.stateDigest) fail("COMPOSE_RESOURCE_STALE");
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

/** Prepare a project.update command from a fresh server-side preview; execution remains behind the shared command claim. */
export async function prepareComposeAttachmentControlCommand(raw: ComposeNetworkAttachmentCommandInput | ComposeAttachmentPreviewInput, deps: ComposeAttachmentCommandDependencies, signal?: AbortSignal): Promise<PreparedComposeAttachmentCommand> {
  if (typeof raw === "object" && raw !== null && "kind" in raw && raw.kind === "volume") fail("COMPOSE_ATTACHMENT_UNSUPPORTED");
  const parsed = composeNetworkAttachmentCommandInputSchema.safeParse(raw);
  if (!parsed.success || !/^[A-Za-z0-9_-]{1,200}$/.test(deps.actorId) || !/^[A-Za-z0-9_-]{1,200}$/.test(deps.correlationId)
    || typeof deps.idempotencyKey !== "string" || deps.idempotencyKey.length < 1 || deps.idempotencyKey.length > 200
    || !Number.isSafeInteger(deps.commandTtlMs) || deps.commandTtlMs < 1 || deps.commandTtlMs > 60_000) fail("COMPOSE_INSPECTION_INVALID");
  const input = parsed.data;
  const decision = new PolicyEvaluator().evaluate({ actorId: deps.actorId, role: deps.role, action: "project.update", scope: { kind: "project", projectId: input.projectId },
    correlationId: deps.correlationId, grants: await deps.grants.listForActor(deps.actorId) });
  if (!decision.allowed) fail("COMPOSE_ATTACHMENT_FORBIDDEN");
  const preview = await createComposeAttachmentPreview({ document: input.document, projectId: input.projectId, kind: "network", key: input.key,
    service: input.service, action: input.action, expectedConfigDigest: input.expectedConfigDigest, expectedStateDigest: input.expectedStateDigest }, deps, signal,
  { requestId: deps.correlationId, correlationId: deps.correlationId });
  if (preview.containerId !== input.expectedContainerId || preview.stateDigest !== input.expectedStateDigest) fail("COMPOSE_RESOURCE_STALE");
  const configuration = currentPreview(input.document, input.projectId, input.expectedConfigDigest, deps);
  const resource = configuration.networks.find(candidate => candidate.key === input.key);
  if (!resource) fail("COMPOSE_ATTACHMENT_CONFLICT");
  let now: number;
  try { now = deps.clock.now(); } catch { fail("COMPOSE_INSPECTION_FAILED"); }
  if (!Number.isSafeInteger(now) || now < 0) fail("COMPOSE_INSPECTION_FAILED");
  const request = composeResourceAttachmentCommandSchema.parse({ schemaVersion: 1, action: "project.update", scope: { kind: "project", projectId: input.projectId },
    operation: "compose.resource.attachment", idempotencyKey: deps.idempotencyKey, correlationId: deps.correlationId,
    projectId: input.projectId, kind: "network", key: input.key, runtimeName: resource.runtimeName, service: input.service, attachmentAction: input.action,
    configDigest: preview.configDigest, stateDigest: preview.stateDigest, containerId: preview.containerId, alreadySatisfied: preview.alreadySatisfied });
  const command = { ...createControlCommand({ actorId: deps.actorId, action: request.action, scope: request.scope, input: Object.fromEntries(Object.entries(request).filter(([field]) => field !== "idempotencyKey" && field !== "correlationId")),
    idempotencyKey: request.idempotencyKey, correlationId: request.correlationId, expiresAt: new Date(now + deps.commandTtlMs) }), status: "eligible" as const };
  const resolved = await deps.controlCommands.resolve(command);
  return { command: resolved.command, request, preview, canonicalDocument: configuration.canonicalDocument, agentId: deps.agentId, created: resolved.created };
}
