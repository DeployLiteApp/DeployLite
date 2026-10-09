import { composeResourceCleanupPreviewSchema, composeResourceCleanupConfirmationViewSchema, composeResourceCleanupReceiptSchema,
  composeResourceCleanupExecutionReceiptSchema, type ComposeResourceCleanupExecutionReceiptV1,
  type ComposeResourceCleanupReceiptV1, type ComposeResourceCleanupConfirmationViewV1 } from "@deploylite/contracts";
import { ComposeResourceCleanupError, type PreparedComposeResourceCleanup } from "./compose-resource-cleanup.js";
import { createConfirmation, digestControlInput, evaluateConfirmation, IdempotencyConflictError, resolveControlCommandInMemory,
  type ControlCommand, type ControlConfirmation } from "./control-plane.js";
import type { InMemoryExecutionState } from "./deployment-contract/execution-memory-state.js";
import type { AuditEventInput } from "./index.js";

export type ComposeResourceCleanupSubject = Readonly<{ actorId: string; projectId: string; idempotencyKey: string; confirmationId: string }>;
export type ComposeResourceCleanupRecord = Readonly<{ command: ControlCommand; confirmation: ControlConfirmation }>;
type StoredRecord = Readonly<{ prepared: PreparedComposeResourceCleanup; confirmation: ControlConfirmation; receipt: ComposeResourceCleanupReceiptV1 }>;
/** Atomically persists existing control metadata and safe audit, with no execution effects. */
export type ComposeResourceCleanupStore = Readonly<{
  available(): boolean;
  save(input: PreparedComposeResourceCleanup, requestId: string, signal?: AbortSignal): Promise<ComposeResourceCleanupReceiptV1>;
  find(subject: ComposeResourceCleanupSubject, signal?: AbortSignal): Promise<ComposeResourceCleanupRecord>;
  admit(input: PreparedComposeResourceCleanup, view: ComposeResourceCleanupConfirmationViewV1, requestId: string, signal?: AbortSignal): Promise<ComposeResourceCleanupReceiptV1>;
  claimExecution(input: PreparedComposeResourceCleanup, confirmationId: string, requestId: string, signal?: AbortSignal): Promise<ComposeResourceCleanupReceiptV1>;
  completeExecution(input: PreparedComposeResourceCleanup, confirmationId: string, execution: ComposeResourceCleanupExecutionReceiptV1,
    requestId: string, signal?: AbortSignal): Promise<ComposeResourceCleanupReceiptV1>;
}>;
type Options = Readonly<{
  ledger: InMemoryExecutionState; clock(): number;
  /** Synchronous transaction: publish and audit both commit, or neither becomes visible. */
  commitAudit(input: AuditEventInput, publish: () => void): void;
}>;
const identity = /^[A-Za-z0-9_-]{1,200}$/;
function fail(code: ConstructorParameters<typeof ComposeResourceCleanupError>[0]): never { throw new ComposeResourceCleanupError(code); }
export function validatePreparedComposeResourceCleanup(input: PreparedComposeResourceCleanup, now: number): void {
  const parsed = composeResourceCleanupPreviewSchema.safeParse(input.preview), c = input.command;
  if (!parsed.success || ![input.owner, input.agentId, c.id, c.actorId, c.idempotencyKey, c.correlationId].every(v => typeof v === "string" && identity.test(v))
    || !Number.isSafeInteger(input.preparedAtMs) || input.preparedAtMs < 0 || !Number.isSafeInteger(now) || now < input.preparedAtMs
    || c.action !== "project.delete" || c.scope.kind !== "project" || c.scope.projectId !== parsed.data.projectId || c.status !== "pending_confirmation"
    || c.result || c.executionAuthority || !(c.expiresAt instanceof Date) || !Number.isSafeInteger(c.expiresAt.valueOf())
    || c.expiresAt.valueOf() <= input.preparedAtMs || c.expiresAt.valueOf() > input.preparedAtMs + parsed.data.confirmationTtlMs
    || c.inputDigest !== digestControlInput({ ...parsed.data, owner: input.owner, agentId: input.agentId })) fail("COMPOSE_CLEANUP_INVALID");
  if (c.expiresAt.valueOf() <= now) fail("COMPOSE_CLEANUP_EXPIRED");
}
export function composeResourceCleanupExecutionDigest(input: PreparedComposeResourceCleanup, confirmationId: string): string {
  return digestControlInput({ operation: "compose.resource.cleanup", commandId: input.command.id, confirmationId,
    projectId: input.preview.projectId, agentId: input.agentId, inputDigest: input.command.inputDigest, kind: input.preview.kind,
    key: input.preview.key, configDigest: input.preview.configDigest, stateDigest: input.preview.stateDigest });
}
function protect<T>(work: () => T): T {
  try { return work(); }
  catch (error) { if (error instanceof ComposeResourceCleanupError || error instanceof IdempotencyConflictError) throw error; fail("COMPOSE_CLEANUP_FAILED"); }
}

/** Explicit in-memory reference; production requires a transactional durable adapter. */
export class InMemoryComposeResourceCleanupStore implements ComposeResourceCleanupStore {
  private records = new Map<string, { prepared: PreparedComposeResourceCleanup; confirmationId: string }>();
  constructor(private readonly options: Options) {}
  available(): boolean { return true; }

  private read(id: string, now: number): StoredRecord {
    const saved = this.records.get(id); if (!saved) fail("COMPOSE_CLEANUP_INVALID");
    const prepared = structuredClone(saved.prepared), command = [...this.options.ledger.commands.values()].find(v => v.id === id);
    if (!command) fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED");
    const terminal = command.status === "dispatching" || command.status === "completed";
    validatePreparedComposeResourceCleanup(prepared, terminal ? prepared.preparedAtMs : now);
    const confirmation = this.options.ledger.confirmations.get(saved.confirmationId);
    const { result: _result, executionAuthority: _executionAuthority, projectExecutionAuthority: _projectExecutionAuthority, status: _status, ...commandFields } = command;
    if (!confirmation || digestControlInput({ ...commandFields, status: "pending_confirmation" }) !== digestControlInput(prepared.command)
      || command.action !== "project.delete" || command.scope.kind !== "project" || command.scope.projectId !== prepared.preview.projectId
      || !["pending_confirmation", "eligible", "dispatching", "completed"].includes(command.status) || !(confirmation.expiresAt instanceof Date) || !Number.isSafeInteger(confirmation.expiresAt.valueOf())
      || command.executionAuthority || command.projectExecutionAuthority || command.status === "dispatching" && command.result
      || command.status !== "completed" && command.result || confirmation.commandId !== id || confirmation.id !== saved.confirmationId) fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED");
    try {
      if (command.status === "pending_confirmation") evaluateConfirmation(command, confirmation, new Date(now));
      else if (command.status === "eligible") {
        if (!(confirmation.consumedAt instanceof Date) || !Number.isSafeInteger(confirmation.consumedAt.valueOf()) || confirmation.consumedAt.valueOf() < prepared.preparedAtMs || confirmation.consumedAt.valueOf() > now) fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED");
        evaluateConfirmation(command, { ...confirmation, consumedAt: null }, new Date(now));
      } else {
        if (!(confirmation.consumedAt instanceof Date) || !Number.isSafeInteger(confirmation.consumedAt.valueOf()) || confirmation.consumedAt.valueOf() < prepared.preparedAtMs
          || confirmation.consumedAt.valueOf() >= command.expiresAt.valueOf() || confirmation.expiresAt.valueOf() !== command.expiresAt.valueOf()) fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED");
        try { evaluateConfirmation(command, { ...confirmation, consumedAt: null }, new Date(command.expiresAt.valueOf() - 1)); }
        catch { fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED"); }
      }
    } catch { fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED"); }
    const execution = command.result ? composeResourceCleanupExecutionReceiptSchema.safeParse(command.result) : undefined;
    if (command.status === "dispatching" && command.result || command.status === "completed" && (!execution?.success || !this.matchesExecution(prepared, confirmation.id, execution.data))) fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED");
    const receipt = composeResourceCleanupReceiptSchema.parse({ commandId: id, confirmationId: saved.confirmationId, expiresAt: prepared.command.expiresAt.toISOString(),
      status: command.status, idempotent: false, preview: prepared.preview, ...(command.status === "completed" ? { execution: execution!.data } : {}) });
    return structuredClone({ prepared, confirmation, receipt });
  }

  private matchesExecution(prepared: PreparedComposeResourceCleanup, confirmationId: string, execution: ComposeResourceCleanupExecutionReceiptV1): boolean {
    return execution.commandId === prepared.command.id && execution.cleanupCommandId === prepared.command.id && execution.confirmationId === confirmationId
      && execution.projectId === prepared.preview.projectId && execution.inputDigest === prepared.command.inputDigest
      && execution.agentId === prepared.agentId && execution.correlationId === prepared.command.correlationId
      && execution.kind === prepared.preview.kind && execution.key === prepared.preview.key
      && execution.configDigest === prepared.preview.configDigest && execution.stateDigest === prepared.preview.stateDigest
      && execution.cleanupInputDigest === composeResourceCleanupExecutionDigest(prepared, confirmationId) && execution.redacted === true;
  }

  private commit(input: AuditEventInput, commands: Map<string, ControlCommand>, confirmations: Map<string, ControlConfirmation>,
    records: typeof this.records, signal?: AbortSignal): void {
    const ledger = this.options.ledger, prior = { commands: ledger.commands, confirmations: ledger.confirmations, records: this.records };
    let published = false;
    try {
      signal?.throwIfAborted();
      this.options.commitAudit(input, () => {
        signal?.throwIfAborted();
        if (published || ledger.commands !== prior.commands || ledger.confirmations !== prior.confirmations || this.records !== prior.records) fail("COMPOSE_CLEANUP_FAILED");
        ledger.commands = commands; ledger.confirmations = confirmations; this.records = records; published = true;
      });
      if (!published) fail("COMPOSE_CLEANUP_FAILED");
    } catch (error) {
      if (published) { ledger.commands = prior.commands; ledger.confirmations = prior.confirmations; this.records = prior.records; }
      throw error;
    }
  }

  async save(raw: PreparedComposeResourceCleanup, requestId: string, signal?: AbortSignal): Promise<ComposeResourceCleanupReceiptV1> {
    return protect(() => {
      const input = structuredClone(raw), now = this.options.clock(); signal?.throwIfAborted(); validatePreparedComposeResourceCleanup(input, now);
      if (!identity.test(requestId)) fail("COMPOSE_CLEANUP_INVALID");
      const commands = structuredClone(this.options.ledger.commands), resolved = resolveControlCommandInMemory(commands, input.command);
      if (!resolved.created) return { ...this.read(resolved.command.id, now).receipt, idempotent: true };
      const confirmation = createConfirmation({ command: resolved.command, classification: "destructive" });
      const confirmations = structuredClone(this.options.ledger.confirmations), records = new Map(this.records);
      confirmations.set(confirmation.id, confirmation); records.set(resolved.command.id, { prepared: input, confirmationId: confirmation.id });
      const receipt = composeResourceCleanupReceiptSchema.parse({ commandId: resolved.command.id, confirmationId: confirmation.id, expiresAt: resolved.command.expiresAt.toISOString(),
        status: "pending_confirmation", idempotent: false, preview: input.preview });
      this.commit(this.audit(input, requestId, "prepared"), commands, confirmations, records, signal);
      return structuredClone(receipt);
    });
  }

  async find(raw: ComposeResourceCleanupSubject, signal?: AbortSignal): Promise<ComposeResourceCleanupRecord> {
    return protect(() => {
      const subject = structuredClone(raw), now = this.options.clock(); signal?.throwIfAborted();
      if (![subject.actorId, subject.projectId, subject.idempotencyKey, subject.confirmationId].every(v => typeof v === "string" && identity.test(v))) fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED");
      const saved = [...this.records.values()].find(v => v.prepared.command.actorId === subject.actorId && v.prepared.preview.projectId === subject.projectId
        && v.prepared.command.idempotencyKey === subject.idempotencyKey && v.confirmationId === subject.confirmationId);
      if (!saved) fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED");
      const current = this.read(saved.prepared.command.id, now);
      const command = [...this.options.ledger.commands.values()].find(v => v.id === current.receipt.commandId);
      if (!command) fail("COMPOSE_CLEANUP_INVALID");
      return structuredClone({ command, confirmation: current.confirmation });
    });
  }

  async admit(raw: PreparedComposeResourceCleanup, rawView: ComposeResourceCleanupConfirmationViewV1, requestId: string, signal?: AbortSignal): Promise<ComposeResourceCleanupReceiptV1> {
    return protect(() => {
      const input = structuredClone(raw), view = structuredClone(rawView), now = this.options.clock(); signal?.throwIfAborted(); validatePreparedComposeResourceCleanup(input, now);
      if (!identity.test(requestId)) fail("COMPOSE_CLEANUP_INVALID");
      const stored = this.read(input.command.id, now), parsed = composeResourceCleanupConfirmationViewSchema.safeParse(view);
      if (!parsed.success || digestControlInput(input) !== digestControlInput(stored.prepared)
        || digestControlInput(parsed.data) !== digestControlInput({ ...stored.prepared.preview, commandId: stored.receipt.commandId, confirmationId: stored.confirmation.id, confirmationValidated: true })) fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED");
    if (stored.receipt.status !== "pending_confirmation") return { ...stored.receipt, idempotent: true };
      const commands = structuredClone(this.options.ledger.commands), confirmations = structuredClone(this.options.ledger.confirmations);
      const current = [...commands.values()].find(v => v.id === input.command.id)!; current.status = "eligible";
      confirmations.get(stored.confirmation.id)!.consumedAt = new Date(now);
      this.commit(this.audit(input, requestId, "admitted"), commands, confirmations, new Map(this.records), signal);
      return { ...stored.receipt, status: "eligible", idempotent: false };
    });
  }

  async claimExecution(raw: PreparedComposeResourceCleanup, confirmationId: string, requestId: string, signal?: AbortSignal): Promise<ComposeResourceCleanupReceiptV1> {
    return protect(() => {
      const input = structuredClone(raw), now = this.options.clock(); signal?.throwIfAborted();
      if (!identity.test(requestId) || !identity.test(confirmationId)) fail("COMPOSE_CLEANUP_INVALID");
      const stored = this.read(input.command.id, now);
      if (stored.confirmation.id !== confirmationId || digestControlInput(input) !== digestControlInput(stored.prepared)) fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED");
      if (!["eligible", "dispatching", "completed"].includes(stored.receipt.status)) fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED");
      if (stored.receipt.status !== "eligible") return { ...stored.receipt, idempotent: true };
      const commands = structuredClone(this.options.ledger.commands), current = [...commands.values()].find(v => v.id === input.command.id);
      if (!current || current.status !== "eligible" || current.executionAuthority || current.projectExecutionAuthority || current.result) fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED");
      current.status = "dispatching";
      this.commit(this.audit(input, requestId, "execution.started"), commands, structuredClone(this.options.ledger.confirmations), new Map(this.records), signal);
      return { ...stored.receipt, status: "dispatching", idempotent: false };
    });
  }

  async completeExecution(raw: PreparedComposeResourceCleanup, confirmationId: string, rawExecution: ComposeResourceCleanupExecutionReceiptV1,
    requestId: string, signal?: AbortSignal): Promise<ComposeResourceCleanupReceiptV1> {
    return protect(() => {
      const input = structuredClone(raw), parsed = composeResourceCleanupExecutionReceiptSchema.safeParse(structuredClone(rawExecution)), now = this.options.clock();
      signal?.throwIfAborted();
      if (!identity.test(requestId) || !identity.test(confirmationId) || !parsed.success || !this.matchesExecution(input, confirmationId, parsed.data)) fail("COMPOSE_CLEANUP_INVALID");
      const stored = this.read(input.command.id, now);
      if (stored.confirmation.id !== confirmationId || digestControlInput(input) !== digestControlInput(stored.prepared)) fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED");
      if (stored.receipt.status === "completed") {
        if (digestControlInput(stored.receipt.execution) !== digestControlInput(parsed.data)) fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED");
        return { ...stored.receipt, idempotent: true };
      }
      if (stored.receipt.status !== "dispatching") fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED");
      const commands = structuredClone(this.options.ledger.commands), current = [...commands.values()].find(v => v.id === input.command.id);
      if (!current || current.status !== "dispatching" || current.result || current.executionAuthority || current.projectExecutionAuthority) fail("COMPOSE_CLEANUP_CONFIRMATION_REJECTED");
      current.status = "completed"; current.result = parsed.data;
      this.commit(this.audit(input, requestId, "completed", parsed.data), commands, structuredClone(this.options.ledger.confirmations), new Map(this.records), signal);
      return { ...stored.receipt, status: "completed", idempotent: false, execution: parsed.data };
    });
  }

  private audit(input: PreparedComposeResourceCleanup, requestId: string, suffix: "prepared" | "admitted" | "execution.started" | "completed",
    execution?: ComposeResourceCleanupExecutionReceiptV1): AuditEventInput {
    return { actorUserId: input.command.actorId, action: `compose.resource.cleanup.${suffix}`, targetType: "project", targetId: input.preview.projectId,
      requestId, correlationId: input.command.correlationId, metadata: { projectId: input.preview.projectId, commandId: input.command.id, targetType: input.preview.kind,
        ...(execution ? { confirmationId: execution.confirmationId, terminalStatus: execution.terminalStatus, physicalIdentity: execution.physicalIdentity } : {}),
        inputDigest: input.command.inputDigest, configDigest: input.preview.configDigest, stateDigest: input.preview.stateDigest,
      } };
  }
}
