import { and, eq, gt, isNull, lte, or } from "drizzle-orm";
import type { ConfirmedDeploymentRedeployInput, ConfirmedDeploymentRedeployOutcome, ConfirmedDeploymentStopInput, ConfirmedDeploymentStopOutcome, ConfirmedProjectDeleteInput, ConfirmedProjectDeleteOutcome, ControlCommand, ControlCommandRepository, ControlConfirmation, ControlConfirmationRepository, ControlDeleteRepository, ControlGrant, ControlGrantRepository, ConfirmationOutcome, ControlRedeployRepository, ControlStopRepository } from "@deploylite/domain";
import { IdempotencyConflictError, scopeKey } from "@deploylite/domain";

import type { DeployLiteDb } from "../client.js";
import { auditEvents, controlCommandAudits, controlCommandConfirmations, controlCommands, controlGrants, deployments, projects, type ControlCommandRow, type ControlGrantRow } from "../schema.js";
import { toDeployment } from "./deployment-data.js";

export class DbControlGrantRepository implements ControlGrantRepository {
  constructor(private readonly db: DeployLiteDb) {}

  async listForActor(actorId: string): Promise<ControlGrant[]> {
    const rows = await this.db.select().from(controlGrants).where(eq(controlGrants.actorUserId, actorId));
    return rows.map(toGrant);
  }
}

export type ControlDeleteFaultStage = "confirmation-consumed" | "project-deleted" | "command-completed" | "audit-recorded" | "redeploy-deployment-inserted";

export class DbControlCommandRepository implements ControlDeleteRepository, ControlStopRepository, ControlRedeployRepository, ControlConfirmationRepository {
  constructor(private readonly db: DeployLiteDb, private readonly injectFault?: (stage: ControlDeleteFaultStage) => void | Promise<void>) {}

  async resolve(command: ControlCommand): Promise<{ command: ControlCommand; created: boolean }> {
    const key = scopeKey(command.scope);
    const [created] = await this.db.insert(controlCommands).values({
      id: command.id, actorUserId: command.actorId, action: command.action, scopeKind: command.scope.kind, scopeKey: key,
      inputDigest: command.inputDigest, idempotencyKey: command.idempotencyKey, correlationId: command.correlationId,
      status: command.status, expiresAt: command.expiresAt, result: command.result ?? null
    }).onConflictDoNothing().returning();
    if (created) return { command: toCommand(created), created: true };

    const [existing] = await this.db.select().from(controlCommands).where(and(
      eq(controlCommands.actorUserId, command.actorId), eq(controlCommands.action, command.action),
      eq(controlCommands.scopeKey, key), eq(controlCommands.idempotencyKey, command.idempotencyKey)
    )).limit(1);
    if (!existing) throw new Error("Idempotency command was not found after conflict");
    if (existing.inputDigest !== command.inputDigest) throw new IdempotencyConflictError();
    return { command: toCommand(existing), created: false };
  }

  async findByIdempotency(actorId: string, idempotencyKey: string): Promise<ControlCommand | null> {
    const [row] = await this.db.select().from(controlCommands).where(and(eq(controlCommands.actorUserId, actorId), eq(controlCommands.action, "deployment.redeploy"), eq(controlCommands.idempotencyKey, idempotencyKey))).limit(1);
    return row ? toCommand(row) : null;
  }

  async bind(confirmation: ControlConfirmation): Promise<void> {
    await this.db.insert(controlCommandConfirmations).values({ id: confirmation.id, commandId: confirmation.commandId, actorUserId: confirmation.actorId, action: confirmation.action, scopeKind: confirmation.scope.kind, scopeKey: scopeKey(confirmation.scope), inputDigest: confirmation.inputDigest, classification: confirmation.classification, expiresAt: confirmation.expiresAt, consumedAt: confirmation.consumedAt });
  }

  async complete(command: ControlCommand): Promise<ControlCommand> {
    const [completed] = await this.db.update(controlCommands).set({ status: "completed", updatedAt: new Date() }).where(and(eq(controlCommands.id, command.id), eq(controlCommands.status, "eligible"))).returning();
    if (completed) return toCommand(completed);
    const [current] = await this.db.select().from(controlCommands).where(eq(controlCommands.id, command.id)).limit(1);
    if (!current) throw new Error("Control command was not found");
    return toCommand(current);
  }

  async consume(command: ControlCommand, confirmation: ControlConfirmation, now = new Date()): Promise<ConfirmationOutcome> {
    return this.db.transaction(async (tx) => {
      const [consumed] = await tx.update(controlCommandConfirmations).set({ consumedAt: now }).where(and(eq(controlCommandConfirmations.id, confirmation.id), eq(controlCommandConfirmations.commandId, command.id), eq(controlCommandConfirmations.actorUserId, command.actorId), eq(controlCommandConfirmations.action, command.action), eq(controlCommandConfirmations.scopeKind, command.scope.kind), eq(controlCommandConfirmations.scopeKey, scopeKey(command.scope)), eq(controlCommandConfirmations.inputDigest, command.inputDigest), eq(controlCommandConfirmations.classification, "destructive"), isNull(controlCommandConfirmations.consumedAt), gt(controlCommandConfirmations.expiresAt, now))).returning();
      if (!consumed) {
        const [storedConfirmation] = await tx.select({ id: controlCommandConfirmations.id }).from(controlCommandConfirmations).where(eq(controlCommandConfirmations.id, confirmation.id)).limit(1);
        await tx.insert(controlCommandAudits).values({ commandId: command.id, confirmationId: storedConfirmation?.id ?? null, correlationId: command.correlationId, outcome: "rejected", reason: "confirmation_rejected" });
        const [current] = await tx.select().from(controlCommands).where(eq(controlCommands.id, command.id)).limit(1);
        if (!current) throw new Error("Control command was not found");
        return { command: toCommand(current), accepted: false, reason: "confirmation_rejected" };
      }
      const [eligible] = await tx.update(controlCommands).set({ status: "eligible", updatedAt: now }).where(eq(controlCommands.id, command.id)).returning();
      await tx.insert(controlCommandAudits).values({ commandId: command.id, confirmationId: confirmation.id, correlationId: command.correlationId, outcome: "accepted", reason: null });
      if (!eligible) throw new Error("Control command was not found");
      return { command: toCommand(eligible), accepted: true, reason: null };
    });
  }

  async executeConfirmedProjectDelete({ command, confirmation, projectId, requestId, now = new Date() }: ConfirmedProjectDeleteInput): Promise<ConfirmedProjectDeleteOutcome> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(controlCommands).where(eq(controlCommands.id, command.id)).limit(1);
      if (!current) throw new Error("Control command was not found");
      if (current.status === "completed") return { command: toCommand(current), accepted: true, reason: null, removed: true, auditRecorded: true, alreadyCompleted: true };
      const [consumed] = await tx.update(controlCommandConfirmations).set({ consumedAt: now }).where(and(eq(controlCommandConfirmations.id, confirmation.id), eq(controlCommandConfirmations.commandId, command.id), eq(controlCommandConfirmations.actorUserId, command.actorId), eq(controlCommandConfirmations.action, command.action), eq(controlCommandConfirmations.scopeKind, command.scope.kind), eq(controlCommandConfirmations.scopeKey, scopeKey(command.scope)), eq(controlCommandConfirmations.inputDigest, command.inputDigest), eq(controlCommandConfirmations.classification, "destructive"), isNull(controlCommandConfirmations.consumedAt), gt(controlCommandConfirmations.expiresAt, now))).returning();
      if (!consumed) {
        await tx.insert(controlCommandAudits).values({ commandId: command.id, confirmationId: confirmation.id, correlationId: command.correlationId, outcome: "rejected", reason: "confirmation_rejected" });
        return { command: toCommand(current), accepted: false, reason: "confirmation_rejected", removed: false, auditRecorded: true, alreadyCompleted: false };
      }
      await this.fault("confirmation-consumed");
      const [deleted] = await tx.delete(projects).where(eq(projects.id, projectId)).returning({ id: projects.id });
      if (!deleted) throw new Error("Project was not found for confirmed deletion");
      await this.fault("project-deleted");
      const [completed] = await tx.update(controlCommands).set({ status: "completed", updatedAt: now }).where(and(eq(controlCommands.id, command.id), eq(controlCommands.status, "pending_confirmation"))).returning();
      if (!completed) throw new Error("Control command was not eligible for completion");
      await this.fault("command-completed");
      await tx.insert(controlCommandAudits).values({ commandId: command.id, confirmationId: confirmation.id, correlationId: command.correlationId, outcome: "completed", reason: null });
      await tx.insert(auditEvents).values({ actorUserId: command.actorId, action: "project.delete", targetType: "project", targetId: projectId, requestId, correlationId: command.correlationId, metadata: { commandId: command.id, confirmationId: confirmation.id } });
      await this.fault("audit-recorded");
      return { command: toCommand(completed), accepted: true, reason: null, removed: true, auditRecorded: true, alreadyCompleted: false };
    });
  }

  async executeConfirmedDeploymentStop({ command, confirmation, now = new Date() }: ConfirmedDeploymentStopInput): Promise<ConfirmedDeploymentStopOutcome> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(controlCommands).where(eq(controlCommands.id, command.id)).limit(1);
      if (!current) throw new Error("Control command was not found");
      if (command.action !== "deployment.stop" || confirmation.action !== "deployment.stop" || current.action !== "deployment.stop") {
        await tx.insert(controlCommandAudits).values({ commandId: command.id, confirmationId: confirmation.id, correlationId: command.correlationId, outcome: "rejected", reason: "invalid_action" });
        return { command: toCommand(current), accepted: false, reason: "invalid_action", result: null, alreadyCompleted: false };
      }
       if (current.status === "completed") return { command: toCommand(current), accepted: true, reason: null, result: current.result as ConfirmedDeploymentStopOutcome["result"], alreadyCompleted: true };
       if (current.status === "dispatching") return { command: toCommand(current), accepted: true, reason: null, result: current.result as ConfirmedDeploymentStopOutcome["result"], alreadyCompleted: false };
      if (current.status === "rejected") return { command: toCommand(current), accepted: false, reason: "command_rejected", result: stopResult(command, "rejected"), alreadyCompleted: false };
      const [consumed] = await tx.update(controlCommandConfirmations).set({ consumedAt: now }).where(and(eq(controlCommandConfirmations.id, confirmation.id), eq(controlCommandConfirmations.commandId, command.id), eq(controlCommandConfirmations.actorUserId, command.actorId), eq(controlCommandConfirmations.action, command.action), eq(controlCommandConfirmations.scopeKind, command.scope.kind), eq(controlCommandConfirmations.scopeKey, scopeKey(command.scope)), eq(controlCommandConfirmations.inputDigest, command.inputDigest), eq(controlCommandConfirmations.classification, "destructive"), isNull(controlCommandConfirmations.consumedAt), gt(controlCommandConfirmations.expiresAt, now), lte(controlCommandConfirmations.expiresAt, current.expiresAt))).returning();
      if (!consumed) {
        const [rejected] = await tx.update(controlCommands).set({ status: "rejected", updatedAt: now }).where(and(eq(controlCommands.id, command.id), eq(controlCommands.status, "pending_confirmation"))).returning();
        await tx.insert(controlCommandAudits).values({ commandId: command.id, confirmationId: confirmation.id, correlationId: command.correlationId, outcome: "rejected", reason: "confirmation_rejected" });
        return { command: toCommand(rejected ?? current), accepted: false, reason: "confirmation_rejected", result: stopResult(command, "rejected"), alreadyCompleted: false };
      }
      const [eligible] = await tx.update(controlCommands).set({ status: "eligible", updatedAt: now }).where(and(eq(controlCommands.id, command.id), eq(controlCommands.status, "pending_confirmation"))).returning();
      if (!eligible) throw new Error("Control command was not eligible");
      await tx.insert(controlCommandAudits).values({ commandId: command.id, confirmationId: confirmation.id, correlationId: command.correlationId, outcome: "accepted", reason: null });
      return { command: toCommand(eligible), accepted: true, reason: null, result: stopResult(command, "eligible"), alreadyCompleted: false };
    });
  }

  async claimDeploymentStop(command: ControlCommand) {
    const [claimed] = await this.db.update(controlCommands).set({ status: "dispatching", updatedAt: new Date() }).where(and(eq(controlCommands.id, command.id), eq(controlCommands.status, "eligible"))).returning();
    if (claimed) return { command: toCommand(claimed), claimed: true };
    const [current] = await this.db.select().from(controlCommands).where(eq(controlCommands.id, command.id)).limit(1);
    if (!current) throw new Error("Control command was not found");
    return { command: toCommand(current), claimed: false };
  }

  async completeDeploymentStop(command: ControlCommand, result: Parameters<ControlStopRepository["completeDeploymentStop"]>[1]): Promise<ControlCommand> {
    if (result.commandId !== command.id || result.action !== "deployment.stop" || result.correlationId !== command.correlationId || command.scope.kind !== "deployment" || result.projectId !== command.scope.projectId || result.deploymentId !== command.scope.deploymentId || result.status !== "completed") throw new Error("Deployment stop result does not match command");
    const [completed] = await this.db.update(controlCommands).set({ status: "completed", result, updatedAt: new Date() }).where(and(eq(controlCommands.id, command.id), or(eq(controlCommands.status, "eligible"), eq(controlCommands.status, "dispatching")))).returning();
    if (completed) return toCommand(completed);
    const [current] = await this.db.select().from(controlCommands).where(eq(controlCommands.id, command.id)).limit(1);
    if (!current) throw new Error("Control command was not found");
    return toCommand(current);
  }

  async executeConfirmedDeploymentRedeploy({ command, confirmation, deployment, requestId, snapshotHash, now = new Date() }: ConfirmedDeploymentRedeployInput): Promise<ConfirmedDeploymentRedeployOutcome> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(controlCommands).where(eq(controlCommands.id, command.id)).limit(1);
      if (!current) throw new Error("Control command was not found");
      if (current.status === "completed") return { command: toCommand(current), accepted: true, reason: null, result: current.result as ConfirmedDeploymentRedeployOutcome["result"], deployment: null, alreadyCompleted: true };
      if (current.status === "eligible" || current.status === "dispatching") return { command: toCommand(current), accepted: true, reason: null, result: current.result as ConfirmedDeploymentRedeployOutcome["result"], deployment, alreadyCompleted: false };
      if (current.status !== "pending_confirmation") return { command: toCommand(current), accepted: false, reason: "command_not_pending", result: redeployResult(command, "rejected", null, snapshotHash, "command_not_pending"), deployment: null, alreadyCompleted: false };
      const [consumed] = await tx.update(controlCommandConfirmations).set({ consumedAt: now }).where(and(eq(controlCommandConfirmations.id, confirmation.id), eq(controlCommandConfirmations.commandId, command.id), eq(controlCommandConfirmations.actorUserId, command.actorId), eq(controlCommandConfirmations.action, "deployment.redeploy"), eq(controlCommandConfirmations.scopeKind, command.scope.kind), eq(controlCommandConfirmations.scopeKey, scopeKey(command.scope)), eq(controlCommandConfirmations.inputDigest, command.inputDigest), eq(controlCommandConfirmations.classification, "destructive"), isNull(controlCommandConfirmations.consumedAt), gt(controlCommandConfirmations.expiresAt, now), lte(controlCommandConfirmations.expiresAt, current.expiresAt))).returning();
      if (!consumed) { const [rejected] = await tx.update(controlCommands).set({ status: "rejected", updatedAt: now, result: redeployResult(command, "rejected", null, snapshotHash) }).where(and(eq(controlCommands.id, command.id), eq(controlCommands.status, "pending_confirmation"))).returning(); await tx.insert(controlCommandAudits).values({ commandId: command.id, confirmationId: confirmation.id, correlationId: command.correlationId, outcome: "rejected", reason: "confirmation_rejected" }); return { command: toCommand(rejected ?? current), accepted: false, reason: "confirmation_rejected", result: redeployResult(command, "rejected", null, snapshotHash), deployment: null, alreadyCompleted: false }; }
      await tx.insert(deployments).values({ id: deployment.id, projectId: deployment.projectId, agentId: deployment.agentId, status: deployment.status, commitSha: deployment.commitSha, snapshotHash, startedAt: new Date(deployment.startedAt), finishedAt: null, metadata: { sourceDeploymentId: deployment.sourceDeploymentId } });
      await this.fault("redeploy-deployment-inserted");
      const result = redeployResult(command, "eligible", deployment.id, snapshotHash);
      const [eligible] = await tx.update(controlCommands).set({ status: "eligible", result, updatedAt: now }).where(and(eq(controlCommands.id, command.id), eq(controlCommands.status, "pending_confirmation"))).returning();
      if (!eligible) throw new Error("Control command was not pending");
      await tx.insert(controlCommandAudits).values({ commandId: command.id, confirmationId: confirmation.id, correlationId: command.correlationId, outcome: "accepted", reason: null });
      return { command: toCommand(eligible), accepted: true, reason: null, result, deployment, alreadyCompleted: false };
    });
  }

  async claimDeploymentRedeploy(command: ControlCommand) { const [claimed] = await this.db.update(controlCommands).set({ status: "dispatching", updatedAt: new Date() }).where(and(eq(controlCommands.id, command.id), eq(controlCommands.status, "eligible"))).returning(); const row = claimed ?? (await this.db.select().from(controlCommands).where(eq(controlCommands.id, command.id)).limit(1))[0]; if (!row) throw new Error("Control command was not found"); const id = (row.result as { deploymentId?: string } | null)?.deploymentId; const deployment = id ? (await this.db.select().from(deployments).where(eq(deployments.id, id)).limit(1))[0] ?? null : null; return { command: toCommand(row), claimed: Boolean(claimed), deployment: deployment ? toDeployment(deployment) : null }; }

  async completeDeploymentRedeploy(command: ControlCommand, result: import("@deploylite/contracts").DeploymentRedeployCommandResult): Promise<ControlCommand> {
    if (result.commandId !== command.id || result.action !== "deployment.redeploy" || result.correlationId !== command.correlationId || result.status !== "completed" || command.scope.kind !== "deployment" || result.projectId !== command.scope.projectId || result.sourceDeploymentId !== command.scope.deploymentId) throw new Error("Deployment redeploy result does not match command");
    const expected = command.result;
    if (!expected || expected.action !== "deployment.redeploy" || expected.status !== "eligible" || expected.projectId !== result.projectId || expected.sourceDeploymentId !== result.sourceDeploymentId || expected.deploymentId === null || expected.deploymentId !== result.deploymentId || expected.snapshotHash !== result.snapshotHash) throw new Error("Deployment redeploy result does not match persisted command");
    const [completed] = await this.db.update(controlCommands).set({ status: "completed", result, updatedAt: new Date() }).where(and(eq(controlCommands.id, command.id), or(eq(controlCommands.status, "eligible"), eq(controlCommands.status, "dispatching")))).returning();
    if (completed) return toCommand(completed); const [current] = await this.db.select().from(controlCommands).where(eq(controlCommands.id, command.id)).limit(1); if (!current) throw new Error("Control command was not found"); return toCommand(current);
  }

  private async fault(stage: ControlDeleteFaultStage): Promise<void> { await this.injectFault?.(stage); }
}

function toCommand(row: ControlCommandRow): ControlCommand {
  const scope = row.scopeKind === "platform" ? { kind: "platform" as const } : row.scopeKind === "deployment" ? (() => { const [projectId, deploymentId] = JSON.parse(row.scopeKey) as [string, string]; return { kind: "deployment" as const, projectId, deploymentId }; })() : { kind: "project" as const, projectId: row.scopeKey };
  return { id: row.id, actorId: row.actorUserId, action: row.action as ControlCommand["action"], scope, inputDigest: row.inputDigest, idempotencyKey: row.idempotencyKey, correlationId: row.correlationId, status: row.status as ControlCommand["status"], expiresAt: row.expiresAt, ...(row.result ? { result: row.result as never } : {}) };
}

function stopResult(command: ControlCommand, status: "eligible" | "rejected") {
  if (command.scope.kind !== "deployment") throw new Error("Deployment stop requires deployment scope");
  return { commandId: command.id, action: "deployment.stop" as const, projectId: command.scope.projectId, deploymentId: command.scope.deploymentId, status, correlationId: command.correlationId, reason: status === "rejected" ? "confirmation_rejected" : null };
}
function redeployResult(command: ControlCommand, status: "eligible" | "rejected" | "completed", deploymentId: string | null = null, snapshotHash = "0".repeat(64), reason: string | null = null) { if (command.scope.kind !== "deployment") throw new Error("Deployment redeploy requires deployment scope"); return { commandId: command.id, action: "deployment.redeploy" as const, projectId: command.scope.projectId, sourceDeploymentId: command.scope.deploymentId, deploymentId, snapshotHash, status, correlationId: command.correlationId, reason: reason ?? (status === "rejected" ? "confirmation_rejected" : null) }; }

function toGrant(row: ControlGrantRow): ControlGrant {
  const scope = row.scopeKind === "platform" ? { kind: "platform" as const } : row.scopeKind === "deployment" ? (() => { const [projectId, deploymentId] = JSON.parse(row.scopeKey) as [string, string]; return { kind: "deployment" as const, projectId, deploymentId }; })() : { kind: "project" as const, projectId: row.scopeKey };
  return { id: row.id, actorId: row.actorUserId, action: row.action as ControlGrant["action"], scope };
}
