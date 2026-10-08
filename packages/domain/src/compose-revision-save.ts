import { composeResourcePageSchema, composeRevisionSchema, composeRevisionSaveRequestSchema, composeRevisionSaveCommandResultSchema,
  type ComposePreviewV1, type ComposeRevisionV1, type ComposeRevisionSaved, type ComposeResourceMetadata, type ComposeResourcePage, type ImageReferencePolicyV1 } from "@deploylite/contracts";
import type { AuditEventInput } from "./index.js";
import { createComposePreview } from "./compose-preview.js";
import { ComposeRevisionError, type ComposeRevisionPageOptions, type ComposeRevisionPage } from "./compose-revision.js";
import { createControlCommand, digestControlInput, resolveControlCommandInMemory, type ControlCommand } from "./control-plane.js";

export type PreparedComposeRevisionSave = { command: ControlCommand; preview: ComposePreviewV1; composeId: string | null; expectedRevisionId: string | null; createdAt: string; requestId: string };
export type PrepareComposeRevisionSaveInput = { document: string; projectId: string; composeId: string | null; expectedRevisionId: string | null;
  expectedPreviewDigest: string; actorId: string; idempotencyKey: string; correlationId: string; requestId: string; now: Date };
export type ComposeRevisionSaveStore = {
  available(): boolean; save(input: PreparedComposeRevisionSave): Promise<ComposeRevisionSaved>;
  findRevision(projectId: string, revisionId: string): Promise<ComposeRevisionV1 | null>;
  findLatestRevision(projectId: string, composeId: string): Promise<ComposeRevisionV1 | null>;
  listRevisions(projectId: string, composeId: string, options: ComposeRevisionPageOptions): Promise<ComposeRevisionPage>;
  listResources(projectId: string, options: ComposeRevisionPageOptions): Promise<ComposeResourcePage>;
};
const identifier = /^[A-Za-z0-9_-]{1,200}$/;
function invalid(): never { throw new ComposeRevisionError("COMPOSE_REVISION_INVALID"); }
function conflict(): never { throw new ComposeRevisionError("COMPOSE_REVISION_CONFLICT"); }
function intent(input: Pick<PreparedComposeRevisionSave, "composeId" | "expectedRevisionId" | "preview">) {
  return { operation: "compose.revision.save", projectId: input.preview.projectId, composeId: input.composeId, expectedRevisionId: input.expectedRevisionId, configDigest: input.preview.configDigest };
}
export function prepareComposeRevisionSave(input: PrepareComposeRevisionSaveInput, policy: ImageReferencePolicyV1): PreparedComposeRevisionSave {
  const request = { document: input.document, composeId: input.composeId, expectedRevisionId: input.expectedRevisionId, expectedPreviewDigest: input.expectedPreviewDigest };
  if (!composeRevisionSaveRequestSchema.safeParse(request).success) invalid();
  if (!identifier.test(input.actorId) || !identifier.test(input.projectId) || !identifier.test(input.idempotencyKey)
    || !input.correlationId || input.correlationId.length > 200 || !input.requestId || input.requestId.length > 200 || !Number.isFinite(input.now?.valueOf())) invalid();
  const preview = createComposePreview(input.document, input.projectId, policy);
  if (preview.configDigest !== input.expectedPreviewDigest) throw new ComposeRevisionError("COMPOSE_PREVIEW_STALE");
  const binding = { preview, composeId: input.composeId, expectedRevisionId: input.expectedRevisionId };
  const command = createControlCommand({ actorId: input.actorId, action: "project.update", scope: { kind: "project", projectId: input.projectId },
    input: intent(binding), idempotencyKey: input.idempotencyKey, correlationId: input.correlationId, expiresAt: new Date(input.now.valueOf() + 15 * 60_000) });
  // Saving intent is nondestructive and does not authorize a runtime operation.
  command.status = "eligible";
  return { ...binding, command, createdAt: input.now.toISOString(), requestId: input.requestId };
}
export function validatePreparedComposeRevisionSave(input: PreparedComposeRevisionSave): void {
  const c = input.command;
  if (c.action !== "project.update" || c.scope.kind !== "project" || c.scope.projectId !== input.preview.projectId || c.status !== "eligible"
    || c.executionAuthority || !identifier.test(c.id) || !identifier.test(c.actorId) || !identifier.test(c.idempotencyKey)
    || !Number.isFinite(c.expiresAt?.valueOf()) || c.inputDigest !== digestControlInput(intent(input))
    || (input.composeId === null) !== (input.expectedRevisionId === null)
    || (input.composeId !== null && (!identifier.test(input.composeId) || !identifier.test(input.expectedRevisionId!)))) invalid();
  // Reuse the closed saved-record shape to validate prepared preview fields.
  if (!composeRevisionSchema.safeParse({ schemaVersion: 1, id: c.id, projectId: input.preview.projectId, composeId: input.composeId ?? c.id,
    number: 1, createdBy: c.actorId, createdAt: input.createdAt, preview: input.preview }).success) invalid();
}
export function buildComposeRevisionSave(input: PreparedComposeRevisionSave, current: ControlCommand, latest: ComposeRevisionV1 | null, now: Date) {
  if (current.status !== "eligible" || current.expiresAt <= now || current.action !== "project.update" || current.scope.kind !== "project"
    || current.actorId !== input.command.actorId || current.inputDigest !== input.command.inputDigest || current.scope.projectId !== input.preview.projectId) conflict();
  if (input.composeId === null ? latest !== null : !latest || latest.projectId !== input.preview.projectId || latest.composeId !== input.composeId || latest.id !== input.expectedRevisionId) conflict();
  const parsed = composeRevisionSchema.safeParse({ schemaVersion: 1, id: current.id, projectId: input.preview.projectId, composeId: input.composeId ?? current.id,
    number: (latest?.number ?? 0) + 1, createdBy: current.actorId, createdAt: input.createdAt, preview: input.preview });
  if (!parsed.success) invalid(); const revision = parsed.data;
  const result = composeRevisionSaveCommandResultSchema.parse({ commandId: current.id, action: "project.update", operation: "compose.revision.save", projectId: revision.projectId,
    composeId: revision.composeId, revisionId: revision.id, revisionNumber: revision.number, configDigest: revision.preview.configDigest, correlationId: current.correlationId, status: "completed" });
  return { revision, command: { ...current, status: "completed" as const, result } };
}
export function replayComposeRevisionSave(input: PreparedComposeRevisionSave, current: ControlCommand, revision: ComposeRevisionV1 | null): ComposeRevisionSaved {
  const parsed = composeRevisionSaveCommandResultSchema.safeParse(current.result), saved = composeRevisionSchema.safeParse(revision);
  if (current.status !== "completed" || !parsed.success || !saved.success || parsed.data.commandId !== current.id || parsed.data.projectId !== input.preview.projectId
    || parsed.data.revisionId !== saved.data.id || parsed.data.composeId !== saved.data.composeId || saved.data.projectId !== input.preview.projectId
    || parsed.data.revisionNumber !== saved.data.number || parsed.data.configDigest !== input.preview.configDigest || saved.data.preview.configDigest !== input.preview.configDigest) invalid();
  return { revision: saved.data, commandId: current.id, idempotent: true };
}
export function composeRevisionSaveAudit(input: PreparedComposeRevisionSave, command: ControlCommand): AuditEventInput {
  return { actorUserId: command.actorId, action: "compose.revision.saved", targetType: "project", targetId: input.preview.projectId,
    requestId: input.requestId, correlationId: command.correlationId, metadata: { commandId: command.id, inputDigest: command.inputDigest,
      serviceCount: input.preview.services.length, networkCount: input.preview.networks.length, volumeCount: input.preview.volumes.length } };
}
export function composeResourceMetadata(revision: ComposeRevisionV1): ComposeResourceMetadata {
  return { id: revision.composeId, projectId: revision.projectId, latestRevisionId: revision.id, latestNumber: revision.number,
    updatedAt: revision.createdAt, serviceNames: revision.preview.services.map((service) => service.name) };
}
export function validateComposePageOptions(options: ComposeRevisionPageOptions): void {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100 || !Number.isInteger(options.offset) || options.offset < 0 || options.offset > 1_000_000) invalid();
}
/** Explicit reference adapter only. The ledger belongs to the existing shared controls. */
export class InMemoryComposeRevisionSaveStore implements ComposeRevisionSaveStore {
  readonly #revisions = new Map<string, ComposeRevisionV1>();
  readonly #latest = new Map<string, ComposeRevisionV1>();
  constructor(private readonly options: { ledger: { commands: Map<string, ControlCommand> }; appendAudit(input: AuditEventInput): void; clock?: () => Date }) {}
  available(): boolean { return true; }
  async save(input: PreparedComposeRevisionSave): Promise<ComposeRevisionSaved> {
    validatePreparedComposeRevisionSave(input);
    const staged = new Map(this.options.ledger.commands), { command } = resolveControlCommandInMemory(staged, input.command);
    if (command.status === "completed") return replayComposeRevisionSave(input, command, this.#revisions.get(command.id) ?? null);
    const next = buildComposeRevisionSave(input, command, this.#latest.get(input.composeId ?? command.id) ?? null, this.options.clock?.() ?? new Date());
    if (this.#revisions.has(next.revision.id)) conflict();
    // The reference audit sink is synchronous; no await/effect can interleave publication.
    const key = [...staged].find(([, entry]) => entry.id === command.id)![0];
    const revisionCopy = structuredClone(next.revision); staged.set(key, structuredClone(next.command));
    this.options.appendAudit(composeRevisionSaveAudit(input, next.command));
    this.#revisions.set(next.revision.id, revisionCopy); this.#latest.set(next.revision.composeId, revisionCopy);
    this.options.ledger.commands = staged;
    return { revision: structuredClone(next.revision), commandId: next.command.id, idempotent: false };
  }
  async findRevision(projectId: string, id: string): Promise<ComposeRevisionV1 | null> { const value = this.#revisions.get(id); return value?.projectId === projectId ? structuredClone(value) : null; }
  async findLatestRevision(projectId: string, id: string): Promise<ComposeRevisionV1 | null> { const value = this.#latest.get(id); return value?.projectId === projectId ? structuredClone(value) : null; }
  async listRevisions(projectId: string, composeId: string, options: ComposeRevisionPageOptions): Promise<ComposeRevisionPage> {
    validateComposePageOptions(options); const records = [...this.#revisions.values()].filter((item) => item.projectId === projectId && item.composeId === composeId).sort((a, b) => b.number - a.number);
    return { ...options, total: records.length, revisions: structuredClone(records.slice(options.offset, options.offset + options.limit)) };
  }
  async listResources(projectId: string, options: ComposeRevisionPageOptions): Promise<ComposeResourcePage> {
    validateComposePageOptions(options); const records = [...this.#latest.values()].filter((item) => item.projectId === projectId).sort((a, b) => a.composeId.localeCompare(b.composeId));
    return composeResourcePageSchema.parse({ ...options, total: records.length, resources: records.slice(options.offset, options.offset + options.limit).map(composeResourceMetadata) });
  }
}
