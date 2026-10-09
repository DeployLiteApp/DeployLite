import { COMPOSE_PREVIEW_MAX_BYTES, COMPOSE_RESOURCE_INSPECTION_CAPABILITY, composeResourceCleanupInputSchema,
  composeResourceCleanupPreviewSchema, composeResourceCleanupConfirmationViewSchema,
  type CapabilityRegistry, type CanonicalRole, type ComposeResourceCleanupPreviewV1, type ComposeResourceCleanupConfirmationViewV1 } from "@deploylite/contracts";
import { awaitAbortable } from "./deployment-contract/docker-image-executor.js";
import { ComposeResourceInspectionError, createComposeResourceInspectionView, type ComposeAttachmentPreviewDependencies } from "./compose-resource-inspection.js";
import { createControlCommand, digestControlInput, evaluateConfirmation, ConfirmationRejectedError, PolicyEvaluator,
  type ControlCommand, type ControlConfirmation, type ControlGrantRepository } from "./control-plane.js";

export type ComposeResourceCleanupDependencies = Readonly<{
  inspection: ComposeAttachmentPreviewDependencies; capabilities: CapabilityRegistry;
  actorId: string; role: CanonicalRole; correlationId: string; idempotencyKey: string;
  grants: ControlGrantRepository; deadlineMs: number; confirmationTtlMs: number;
}>;
export type PreparedComposeResourceCleanup = Readonly<{
  command: ControlCommand; preview: ComposeResourceCleanupPreviewV1; owner: string; agentId: string; preparedAtMs: number;
}>;
type Code = "COMPOSE_CLEANUP_INVALID" | "COMPOSE_CLEANUP_FORBIDDEN" | "COMPOSE_CLEANUP_UNAVAILABLE" | "COMPOSE_CLEANUP_FOREIGN"
  | "COMPOSE_CLEANUP_STALE" | "COMPOSE_CLEANUP_IN_USE" | "COMPOSE_CLEANUP_FAILED" | "COMPOSE_CLEANUP_EXPIRED" | "COMPOSE_CLEANUP_CONFIRMATION_REJECTED";
export class ComposeResourceCleanupError extends Error {
  constructor(readonly code: Code) { super("Resource cleanup preparation is unavailable or outside policy."); this.name = "ComposeResourceCleanupError"; }
}
function fail(code: Code): never { throw new ComposeResourceCleanupError(code); }
const identity = /^[A-Za-z0-9_-]{1,200}$/;
function binding(preview: ComposeResourceCleanupPreviewV1, owner: string, agentId: string) { return { ...preview, owner, agentId }; }
function captured(supplied: ComposeResourceCleanupDependencies): ComposeResourceCleanupDependencies {
  const deps = { ...supplied, inspection: { ...supplied.inspection, imagePolicy: structuredClone(supplied.inspection.imagePolicy) } };
  if (![deps.actorId, deps.correlationId, deps.idempotencyKey, deps.inspection.owner, deps.inspection.agentId].every(v => typeof v === "string" && identity.test(v))
    || !Number.isSafeInteger(deps.deadlineMs) || deps.deadlineMs < 1 || deps.deadlineMs > 60_000
    || !Number.isSafeInteger(deps.confirmationTtlMs) || deps.confirmationTtlMs < 1 || deps.confirmationTtlMs > 900_000) fail("COMPOSE_CLEANUP_INVALID");
  return deps;
}
function rethrow(error: unknown): never {
  if (error instanceof ComposeResourceCleanupError) throw error;
  if (error instanceof ConfirmationRejectedError) fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED");
  if (error instanceof ComposeResourceInspectionError) {
    if (error.code === "COMPOSE_RESOURCE_FOREIGN") fail("COMPOSE_CLEANUP_FOREIGN");
    if (error.code === "COMPOSE_RESOURCE_STALE") fail("COMPOSE_CLEANUP_STALE");
    if (error.code === "COMPOSE_INSPECTION_INVALID" || error.code === "COMPOSE_RESOURCE_CONFLICT") fail("COMPOSE_CLEANUP_INVALID");
  }
  fail("COMPOSE_CLEANUP_FAILED");
}

/** Effect-free preparation. Resolve this command through the existing shared command repository. */
export async function prepareComposeResourceCleanup(raw: unknown, supplied: ComposeResourceCleanupDependencies, signal?: AbortSignal): Promise<PreparedComposeResourceCleanup> {
  try {
    const parsed = composeResourceCleanupInputSchema.safeParse(raw);
    if (!parsed.success || new TextEncoder().encode(parsed.data.document).length > COMPOSE_PREVIEW_MAX_BYTES) fail("COMPOSE_CLEANUP_INVALID");
    const input = parsed.data, deps = captured(supplied);
    const controller = new AbortController(), cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel();
    const timer = setTimeout(cancel, deps.deadlineMs);
    try {
      const grants = await awaitAbortable(() => deps.grants.listForActor(deps.actorId), controller.signal);
      const decision = new PolicyEvaluator().evaluate({ actorId: deps.actorId, role: deps.role, action: "project.delete",
        scope: { kind: "project", projectId: input.projectId }, correlationId: deps.correlationId, grants });
      if (!decision.allowed) fail("COMPOSE_CLEANUP_FORBIDDEN");
      if (!deps.capabilities.has(COMPOSE_RESOURCE_INSPECTION_CAPABILITY)) fail("COMPOSE_CLEANUP_UNAVAILABLE");
      const observed = await awaitAbortable(() => createComposeResourceInspectionView({ document: input.document, projectId: input.projectId,
        kind: input.kind, key: input.key, expectedConfigDigest: input.expectedConfigDigest }, deps.inspection, controller.signal), controller.signal);
      if (observed.stateDigest !== input.expectedStateDigest) fail("COMPOSE_CLEANUP_STALE");
      if (observed.containers.some(c => c.attached)) fail("COMPOSE_CLEANUP_IN_USE");
      if (!deps.capabilities.has(COMPOSE_RESOURCE_INSPECTION_CAPABILITY)) fail("COMPOSE_CLEANUP_UNAVAILABLE");
      const now = deps.inspection.clock.now(), expiresAt = new Date(now + deps.confirmationTtlMs);
      if (!Number.isSafeInteger(now) || now < observed.observedAt || now - observed.observedAt > deps.inspection.maxAgeMs
        || !Number.isSafeInteger(expiresAt.valueOf())) fail("COMPOSE_CLEANUP_STALE");
      const preview = composeResourceCleanupPreviewSchema.parse({ schemaVersion: 1, operation: "compose.resource.cleanup", status: "preview",
        executionAllowed: false, requiresConfirmation: true, projectId: input.projectId, kind: input.kind, key: input.key,
        configDigest: observed.configDigest, stateDigest: observed.stateDigest, confirmationTtlMs: deps.confirmationTtlMs });
      const command = createControlCommand({ actorId: deps.actorId, action: "project.delete", scope: { kind: "project", projectId: input.projectId },
        input: binding(preview, deps.inspection.owner, deps.inspection.agentId), idempotencyKey: deps.idempotencyKey, correlationId: deps.correlationId, expiresAt });
      if (controller.signal.aborted) fail("COMPOSE_CLEANUP_FAILED");
      return { command, preview, owner: deps.inspection.owner, agentId: deps.inspection.agentId, preparedAtMs: now };
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
  } catch (error) { rethrow(error); }
}

/** Revalidates trusted repository records. Does not consume a confirmation, claim authority or delete anything. */
export async function validateConfirmedComposeResourceCleanup(raw: unknown, original: PreparedComposeResourceCleanup | ControlCommand, suppliedConfirmation: ControlConfirmation,
  supplied: ComposeResourceCleanupDependencies, signal?: AbortSignal): Promise<ComposeResourceCleanupConfirmationViewV1> {
  try {
    const prepared = "preview" in original ? structuredClone(original) : undefined;
    const command = structuredClone(prepared?.command ?? original as ControlCommand), confirmation = structuredClone(suppliedConfirmation), deps = captured(supplied);
    const input = composeResourceCleanupInputSchema.safeParse(raw);
    const preview = prepared?.preview ?? (input.success ? { schemaVersion: 1, operation: "compose.resource.cleanup", status: "preview", executionAllowed: false, requiresConfirmation: true,
      projectId: input.data.projectId, kind: input.data.kind, key: input.data.key, configDigest: input.data.expectedConfigDigest, stateDigest: input.data.expectedStateDigest, confirmationTtlMs: deps.confirmationTtlMs } : null);
    const parsed = composeResourceCleanupPreviewSchema.safeParse(preview);
    const owner = prepared?.owner ?? deps.inspection.owner, agentId = prepared?.agentId ?? deps.inspection.agentId;
    const preparedAtMs = prepared?.preparedAtMs ?? (command.expiresAt instanceof Date ? command.expiresAt.valueOf() - deps.confirmationTtlMs : NaN);
    const now = deps.inspection.clock.now();
    if (!input.success || !parsed.success || ![owner, agentId, command.id, command.actorId, command.idempotencyKey, command.correlationId].every(v => typeof v === "string" && identity.test(v))
      || !Number.isSafeInteger(preparedAtMs) || !Number.isSafeInteger(now) || preparedAtMs > now
      || command.action !== "project.delete" || command.actorId !== deps.actorId || command.idempotencyKey !== deps.idempotencyKey
      || command.scope.kind !== "project" || command.scope.projectId !== parsed.data.projectId || command.status !== "pending_confirmation"
      || command.result || command.executionAuthority || !(command.expiresAt instanceof Date) || !Number.isSafeInteger(command.expiresAt.valueOf())
      || command.expiresAt.valueOf() !== preparedAtMs + parsed.data.confirmationTtlMs
      || (prepared && command.inputDigest !== digestControlInput(binding(parsed.data, owner, agentId)))) fail("COMPOSE_CLEANUP_INVALID");
    if (command.expiresAt.valueOf() <= now) fail("COMPOSE_CLEANUP_EXPIRED");
    if (!(confirmation.expiresAt instanceof Date) || !Number.isSafeInteger(confirmation.expiresAt.valueOf())) fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED");
    evaluateConfirmation(command, confirmation, new Date(now));
    if (owner !== deps.inspection.owner || agentId !== deps.inspection.agentId) fail("COMPOSE_CLEANUP_FOREIGN");
    const current = await prepareComposeResourceCleanup(input.data, deps, signal);
    if (current.command.inputDigest !== command.inputDigest) fail("COMPOSE_CLEANUP_STALE");
    const finished = deps.inspection.clock.now();
    if (!Number.isSafeInteger(finished) || finished < now) fail("COMPOSE_CLEANUP_FAILED");
    if (command.expiresAt.valueOf() <= finished) fail("COMPOSE_CLEANUP_EXPIRED");
    evaluateConfirmation(command, confirmation, new Date(finished));
    if (signal?.aborted) fail("COMPOSE_CLEANUP_FAILED");
    return composeResourceCleanupConfirmationViewSchema.parse({ ...current.preview, commandId: command.id, confirmationId: confirmation.id, confirmationValidated: true });
  } catch (error) { rethrow(error); }
}
