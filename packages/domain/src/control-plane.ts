import { createHash, randomUUID } from "node:crypto";
import type { CanonicalRole, ConfirmationClassification, ControlCommandStatus, ControlPlaneAction, ControlPlaneScope, Deployment, DeploymentRollbackCommandResult, DeploymentRedeployCommandResult, DeploymentStopCommandResult, DeploymentExecutionAuthorityV1, ComposeRevisionSaveCommandResult, ProjectControlAuthorityV1 } from "@deploylite/contracts";

export type ControlGrant = { id: string; actorId: string; action: ControlPlaneAction; scope: ControlPlaneScope };
export type ControlGrantRepository = { listForActor(actorId: string): Promise<ControlGrant[]> };
export type PolicyRequest = { actorId: string; role: CanonicalRole; action: ControlPlaneAction; scope: ControlPlaneScope; correlationId: string; grants: ControlGrant[] };
export type PolicyDecision = { allowed: true; grantId: string; correlationId: string } | { allowed: false; code: "FORBIDDEN" | "ROLE_DENIED" | "SCOPE_DENIED"; correlationId: string };
export type ControlCommand = { id: string; actorId: string; action: ControlPlaneAction; scope: ControlPlaneScope; inputDigest: string; idempotencyKey: string; correlationId: string; status: ControlCommandStatus; expiresAt: Date; result?: DeploymentStopCommandResult | DeploymentRedeployCommandResult | DeploymentRollbackCommandResult | ComposeRevisionSaveCommandResult; executionAuthority?: DeploymentExecutionAuthorityV1; projectExecutionAuthority?: ProjectControlAuthorityV1 };
export type ControlConfirmation = { id: string; commandId: string; actorId: string; action: ControlPlaneAction; scope: ControlPlaneScope; inputDigest: string; classification: ConfirmationClassification; expiresAt: Date; consumedAt: Date | null };
export type ConfirmationOutcome = { command: ControlCommand; accepted: boolean; reason: string | null };
export type ConfirmedProjectDeleteInput = { command: ControlCommand; confirmation: ControlConfirmation; projectId: string; requestId: string; now?: Date };
export type ConfirmedProjectDeleteOutcome = ConfirmationOutcome & { removed: boolean; auditRecorded: boolean; alreadyCompleted: boolean };
export type ConfirmedDeploymentStopInput = { command: ControlCommand; confirmation: ControlConfirmation; requestId: string; now?: Date };
export type ConfirmedDeploymentStopOutcome = ConfirmationOutcome & { result: DeploymentStopCommandResult | null; alreadyCompleted: boolean };
export type ConfirmedDeploymentRedeployInput = { command: ControlCommand; confirmation: ControlConfirmation; deployment: Deployment; requestId: string; snapshotHash: string; now?: Date };
export type ConfirmedDeploymentRedeployOutcome = ConfirmationOutcome & { result: DeploymentRedeployCommandResult | null; deployment: Deployment | null; alreadyCompleted: boolean };

const readOnlyRoles = new Set<CanonicalRole>(["read-only", "auditor"]);

export class PolicyEvaluator {
  evaluate(request: PolicyRequest): PolicyDecision {
    if (readOnlyRoles.has(request.role)) return { allowed: false, code: "ROLE_DENIED", correlationId: request.correlationId };
    const actionGrants = request.grants.filter((grant) => grant.actorId === request.actorId && grant.action === request.action);
    const grant = actionGrants.find((candidate) => grantApplies(candidate.scope, request.scope, request.role));
    if (grant) return { allowed: true, grantId: grant.id, correlationId: request.correlationId };
    return { allowed: false, code: actionGrants.length ? "SCOPE_DENIED" : "FORBIDDEN", correlationId: request.correlationId };
  }
}

export function digestControlInput(input: unknown): string {
  return createHash("sha256").update(stableJson(input)).digest("hex");
}

export function createControlCommand(input: Omit<ControlCommand, "id" | "inputDigest" | "status" | "expiresAt"> & { input: unknown; expiresAt?: Date }): ControlCommand {
  return { id: randomUUID(), actorId: input.actorId, action: input.action, scope: input.scope, inputDigest: digestControlInput(input.input), idempotencyKey: input.idempotencyKey, correlationId: input.correlationId, status: "pending_confirmation", expiresAt: input.expiresAt ?? new Date(Date.now() + 15 * 60_000) };
}

export function createConfirmation(input: { command: ControlCommand; classification: ConfirmationClassification; expiresAt?: Date }): ControlConfirmation {
  const { command } = input;
  return { id: randomUUID(), commandId: command.id, actorId: command.actorId, action: command.action, scope: command.scope, inputDigest: command.inputDigest, classification: input.classification, expiresAt: input.expiresAt ?? command.expiresAt, consumedAt: null };
}

export class ConfirmationRejectedError extends Error {
  readonly code = "CONFIRMATION_REJECTED";
  constructor() { super("Confirmation is not eligible for this command"); this.name = "ConfirmationRejectedError"; }
}

export function evaluateConfirmation(command: ControlCommand, confirmation: ControlConfirmation, now = new Date()): { eligible: true } {
  if (confirmation.commandId !== command.id || confirmation.actorId !== command.actorId || confirmation.action !== command.action || !scopesEqual(confirmation.scope, command.scope) || confirmation.inputDigest !== command.inputDigest || confirmation.classification !== "destructive" || confirmation.expiresAt <= now || confirmation.expiresAt > command.expiresAt || confirmation.consumedAt !== null) throw new ConfirmationRejectedError();
  return { eligible: true };
}

export class IdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_CONFLICT";
  constructor() { super("Idempotency key was already used with different command input"); this.name = "IdempotencyConflictError"; }
}

/** Shared actor/action/scope/idempotency resolution; callers supply the existing ledger. */
export function resolveControlCommandInMemory(commands: Map<string, ControlCommand>, command: ControlCommand): { command: ControlCommand; created: boolean } {
  const key = `${command.actorId}:${command.action}:${scopeKey(command.scope)}:${command.idempotencyKey}`;
  const current = commands.get(key);
  if (current) {
    if (current.inputDigest !== command.inputDigest) throw new IdempotencyConflictError();
    return { command: structuredClone(current), created: false };
  }
  commands.set(key, structuredClone(command));
  return { command: structuredClone(command), created: true };
}

export type ControlCommandRepository = {
  resolve(command: ControlCommand): Promise<{ command: ControlCommand; created: boolean }>;
  complete(command: ControlCommand): Promise<ControlCommand>;
};
export type ProjectUpdateControlRepository = ControlCommandRepository & {
  claimProjectUpdate(command: ControlCommand): Promise<{ command: ControlCommand; claimed: boolean; authority?: ProjectControlAuthorityV1 }>;
  validateProjectUpdateAuthority(authority: ProjectControlAuthorityV1, now?: number): Promise<void>;
};
export type ControlConfirmationRepository = {
  bind(confirmation: ControlConfirmation): Promise<void>;
  consume(command: ControlCommand, confirmation: ControlConfirmation, now?: Date): Promise<ConfirmationOutcome>;
};
export type ControlDeleteRepository = ControlCommandRepository & ControlConfirmationRepository & {
  executeConfirmedProjectDelete(input: ConfirmedProjectDeleteInput): Promise<ConfirmedProjectDeleteOutcome>;
};
export type ControlStopRepository = ControlCommandRepository & ControlConfirmationRepository & {
  findByIdempotency?(actorId: string, idempotencyKey: string, action?: "deployment.redeploy" | "deployment.stop" | "deployment.rollback"): Promise<ControlCommand | null>;
  validateDeploymentAuthority?(authority: DeploymentExecutionAuthorityV1, now?: number): Promise<void>;
  executeConfirmedDeploymentStop(input: ConfirmedDeploymentStopInput): Promise<ConfirmedDeploymentStopOutcome>;
  claimDeploymentStop(command: ControlCommand): Promise<{ command: ControlCommand; claimed: boolean; authority?: DeploymentExecutionAuthorityV1 }>;
  completeDeploymentStop(command: ControlCommand, result: DeploymentStopCommandResult, signal?: AbortSignal): Promise<ControlCommand>;
};
export type ControlRedeployRepository = ControlCommandRepository & ControlConfirmationRepository & {
  validateDeploymentAuthority?(authority: DeploymentExecutionAuthorityV1, now?: number): Promise<void>;
  findByIdempotency(actorId: string, idempotencyKey: string, action?: "deployment.redeploy" | "deployment.stop" | "deployment.rollback"): Promise<ControlCommand | null>;
  executeConfirmedDeploymentRedeploy(input: ConfirmedDeploymentRedeployInput): Promise<ConfirmedDeploymentRedeployOutcome>;
  claimDeploymentRedeploy(command: ControlCommand): Promise<{ command: ControlCommand; claimed: boolean; deployment: Deployment | null; authority?: DeploymentExecutionAuthorityV1 }>;
  completeDeploymentRedeploy(command: ControlCommand, result: DeploymentRedeployCommandResult): Promise<ControlCommand>;
};

export function scopeKey(scope: ControlPlaneScope): string { return scope.kind === "platform" ? "platform" : scope.kind === "project" ? scope.projectId : JSON.stringify([scope.projectId, scope.deploymentId]); }

function scopesEqual(left: ControlPlaneScope, right: ControlPlaneScope): boolean {
  if (left.kind === "platform" && right.kind === "platform") return true;
  if (left.kind === "project" && right.kind === "project") return left.projectId === right.projectId;
  if (left.kind === "deployment" && right.kind === "deployment") return left.projectId === right.projectId && left.deploymentId === right.deploymentId;
  return false;
}

function grantApplies(grantScope: ControlPlaneScope, requestedScope: ControlPlaneScope, role: CanonicalRole): boolean {
  if (grantScope.kind === "platform") return role === "admin";
  return scopesEqual(grantScope, requestedScope);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Compare retry intent using the durable reservation, never a second tentative UUID. */
export function validateRollbackReservation(current: ControlCommand, submitted: ControlCommand): void {
  const prior = current.result, next = submitted.result;
  if (current.action !== "deployment.rollback" || submitted.action !== current.action || current.actorId !== submitted.actorId || current.idempotencyKey !== submitted.idempotencyKey || current.scope.kind !== "deployment" || submitted.scope.kind !== "deployment" || prior?.action !== "deployment.rollback" || next?.action !== "deployment.rollback") throw new IdempotencyConflictError();
  const digest = (command: ControlCommand, result: DeploymentRollbackCommandResult, executionId = result.deploymentId) => digestControlInput({ actorId: command.actorId, projectId: result.projectId, activeDeploymentId: result.activeDeploymentId, sourceDeploymentId: result.sourceDeploymentId, deploymentId: executionId, snapshotHash: result.snapshotHash });
  if (prior.commandId !== current.id || next.commandId !== submitted.id || prior.projectId !== current.scope.projectId || prior.activeDeploymentId !== current.scope.deploymentId || next.projectId !== submitted.scope.projectId || next.activeDeploymentId !== submitted.scope.deploymentId || digest(current, prior) !== current.inputDigest || digest(submitted, next) !== submitted.inputDigest || digest(submitted, next, prior.deploymentId) !== current.inputDigest) throw new IdempotencyConflictError();
}

/** Admission uses durable R and historical H; the active recovery target stays independent. */
export function isRollbackAdmissionBound(command: ControlCommand, deployment: Deployment, historical: Deployment | null | undefined, now: Date): boolean {
  const result = command.result;
  return command.status === "pending_confirmation" && command.expiresAt > now && result?.action === "deployment.rollback"
    && deployment.id === result.deploymentId && deployment.projectId === result.projectId
    && deployment.activeDeploymentId === result.activeDeploymentId && deployment.sourceDeploymentId === result.sourceDeploymentId
    && deployment.snapshotHash === result.snapshotHash && deployment.status === "queued" && deployment.finishedAt === null && !deployment.executionReceipt
    && Boolean(historical) && historical!.id === result.sourceDeploymentId && historical!.projectId === result.projectId
    && historical!.snapshotHash === result.snapshotHash && Boolean(historical!.snapshotOriginId)
    && deployment.snapshotOriginId === historical!.snapshotOriginId && Boolean(historical!.agentId) && deployment.agentId === historical!.agentId;
}

export type ConfirmedDeploymentRollbackInput = Omit<ConfirmedDeploymentRedeployInput, "snapshotHash">;
export type ConfirmedDeploymentRollbackOutcome = ConfirmationOutcome & { result: DeploymentRollbackCommandResult | null; deployment: Deployment | null; alreadyCompleted: boolean };
export type ControlRollbackRepository = ControlCommandRepository & ControlConfirmationRepository & {
  resolveRollbackConfirmation?(command: ControlCommand, now?: Date): Promise<ControlConfirmation | null>;
  findByIdempotency(actorId: string, idempotencyKey: string, action?: "deployment.redeploy" | "deployment.stop" | "deployment.rollback"): Promise<ControlCommand | null>;
  validateDeploymentAuthority?(authority: DeploymentExecutionAuthorityV1, now?: number): Promise<void>;
  executeConfirmedDeploymentRollback(input: ConfirmedDeploymentRollbackInput): Promise<ConfirmedDeploymentRollbackOutcome>;
  claimDeploymentRollback(command: ControlCommand): ReturnType<ControlRedeployRepository["claimDeploymentRedeploy"]>;
};

/** Only an unchanged admitted execution with no prior effect claim may resume. */
export function isRollbackClaimBound(command: ControlCommand, deployment: Deployment | null | undefined, historical: Deployment | null | undefined, now: Date): boolean {
  return command.status === "eligible" && !command.executionAuthority && command.result?.action === "deployment.rollback" && command.result.status === "eligible"
    && Boolean(deployment) && isRollbackAdmissionBound({ ...command, status: "pending_confirmation" }, deployment!, historical, now);
}

/** Shared memory resolver, used by normal controls and atomic Compose staging. */
export function resolveControlCommandInMemory(commands: Map<string, ControlCommand>, command: ControlCommand): { command: ControlCommand; created: boolean } {
  const key = `${command.actorId}:${command.action}:${scopeKey(command.scope)}:${command.idempotencyKey}`;
  const existing = commands.get(key);
  if (existing) {
    if (existing.inputDigest !== command.inputDigest) throw new IdempotencyConflictError();
    return { command: structuredClone(existing), created: false };
  }
  commands.set(key, structuredClone(command));
  return { command: structuredClone(command), created: true };
}
