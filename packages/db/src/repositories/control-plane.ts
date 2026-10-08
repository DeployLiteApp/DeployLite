import { FenceError, deploymentExecutionAuthoritySchema, projectControlAuthoritySchema, type DeploymentExecutionAuthorityV1, type ProjectControlAuthorityV1 } from "@deploylite/contracts";
import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import type { ConfirmedDeploymentRedeployInput, ConfirmedDeploymentRedeployOutcome, ConfirmedDeploymentStopInput, ConfirmedDeploymentStopOutcome, ConfirmedProjectDeleteInput, ConfirmedProjectDeleteOutcome, ControlCommand, ControlCommandRepository, ControlConfirmation, ControlConfirmationRepository, ControlDeleteRepository, ControlGrant, ControlGrantRepository, ConfirmationOutcome, ControlRollbackRepository, ControlRedeployRepository, ControlStopRepository, ProjectUpdateControlRepository } from "@deploylite/domain";
import { claimDeploymentAuthority, claimProjectUpdateAuthority, validateProjectUpdateAuthority as validateProjectUpdateAuthorityInMemory, validateStopCompletion, validateDeploymentAuthority, validateInitialExecution, validateRollbackReservation, isRollbackAdmissionBound, isRollbackClaimBound, createConfirmation, evaluateConfirmation, ConfirmationRejectedError, IdempotencyConflictError, scopeKey } from "@deploylite/domain";

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

export type ControlDeleteFaultStage = "confirmation-consumed" | "project-deleted" | "command-completed" | "audit-recorded" | "redeploy-deployment-inserted" | "authority-claimed";

export class DbControlCommandRepository implements ControlDeleteRepository, ControlStopRepository, ControlRedeployRepository, ProjectUpdateControlRepository, ControlConfirmationRepository {
  constructor(private readonly db: DeployLiteDb, private readonly injectFault?: (stage: ControlDeleteFaultStage) => void | Promise<void>) {}

  async resolve(command: ControlCommand): Promise<{ command: ControlCommand; created: boolean }> {
    if (command.action === "deployment.rollback") return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`deploylite:rollback:${command.actorId}:${command.idempotencyKey}`}, 0))`);
      const [row] = await tx.select().from(controlCommands).where(and(eq(controlCommands.actorUserId, command.actorId), eq(controlCommands.action, command.action), eq(controlCommands.idempotencyKey, command.idempotencyKey))).limit(1);
      if (row) { const current = toCommand(row); validateRollbackReservation(current, command); return { command: current, created: false }; }
      validateRollbackReservation(command, command);
      return this.resolveOn(command, tx);
    });
    return this.resolveOn(command, this.db);
  }

  private async resolveOn(command: ControlCommand, db: Pick<DeployLiteDb, "insert" | "select">): Promise<{ command: ControlCommand; created: boolean }> {
    return resolveControlCommandOn(db, command);
  }

  async findByIdempotency(actorId: string, idempotencyKey: string, action: "deployment.redeploy" | "deployment.stop" | "deployment.rollback" = "deployment.redeploy"): Promise<ControlCommand | null> {
    const [row] = await this.db.select().from(controlCommands).where(and(eq(controlCommands.actorUserId, actorId), eq(controlCommands.action, action), eq(controlCommands.idempotencyKey, idempotencyKey))).limit(1);
    return row ? toCommand(row) : null;
  }

  async resolveRollbackConfirmation(command: ControlCommand, now?: Date): Promise<ControlConfirmation | null> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(controlCommands).where(eq(controlCommands.id, command.id)).limit(1).for("update");
      if (!row) return null;
      const current = toCommand(row); validateRollbackReservation(current, command);
      if (current.status !== "pending_confirmation" || current.expiresAt <= (now ?? new Date())) return null;
      let [stored] = await tx.select().from(controlCommandConfirmations).where(eq(controlCommandConfirmations.commandId, current.id)).limit(1);
      if (!stored) {
        const confirmation = createConfirmation({ command: current, classification: "destructive" });
        await tx.insert(controlCommandConfirmations).values({ id: confirmation.id, commandId: confirmation.commandId, actorUserId: confirmation.actorId, action: confirmation.action, scopeKind: confirmation.scope.kind, scopeKey: scopeKey(confirmation.scope), inputDigest: confirmation.inputDigest, classification: confirmation.classification, expiresAt: confirmation.expiresAt, consumedAt: null }).onConflictDoNothing();
        [stored] = await tx.select().from(controlCommandConfirmations).where(eq(controlCommandConfirmations.commandId, current.id)).limit(1);
      }
      if (!stored || stored.scopeKind !== current.scope.kind || stored.scopeKey !== scopeKey(current.scope)) return null;
      const confirmation: ControlConfirmation = { id: stored.id, commandId: stored.commandId, actorId: stored.actorUserId, action: stored.action as ControlConfirmation["action"], scope: current.scope, inputDigest: stored.inputDigest, classification: stored.classification as ControlConfirmation["classification"], expiresAt: stored.expiresAt, consumedAt: stored.consumedAt };
      try { evaluateConfirmation(current, confirmation, now ?? new Date()); }
      catch (error) { if (error instanceof ConfirmationRejectedError) return null; throw error; }
      return confirmation;
    });
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

  async claimDeploymentStop(command: ControlCommand) { return this.claimExecutionAuthority(command); }

  private async claimExecutionAuthority(command: ControlCommand) {
    return this.db.transaction(async (tx) => {
      const [hint] = await tx.select().from(controlCommands).where(eq(controlCommands.id, command.id)).limit(1);
      if (!hint) throw new Error("Control command was not found");
      const hinted = toCommand(hint);
      if (hinted.scope.kind !== "deployment") throw new Error("Execution authority requires deployment scope");
      const projectId = hinted.scope.projectId;
      // Held until commit/rollback; every execute and stop claimant uses this namespace.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`deploylite:execution:${projectId}`}, 0))`);
      const [row] = await tx.select().from(controlCommands).where(eq(controlCommands.id, command.id)).limit(1).for("update");
      if (!row) throw new Error("Control command was not found");
      const current = toCommand(row);
      const related = await tx.select().from(controlCommands).where(or(
        and(eq(controlCommands.scopeKind, "project"), eq(controlCommands.scopeKey, projectId)),
        and(eq(controlCommands.scopeKind, "deployment"), sql`${controlCommands.scopeKey}::jsonb ->> 0 = ${projectId}`)
      ));
      const executionId = current.action === "deployment.stop" ? hinted.scope.deploymentId : (current.result?.action === "deployment.redeploy" || current.result?.action === "deployment.rollback") ? current.result.deploymentId : null;
      if (current.action === "deployment.rollback") {
        validateRollbackReservation(current, command);
        const result = current.result as import("@deploylite/contracts").DeploymentRollbackCommandResult;
        const [execution] = await tx.select().from(deployments).where(eq(deployments.id, result.deploymentId)).limit(1).for("update");
        const [historical] = await tx.select().from(deployments).where(eq(deployments.id, result.sourceDeploymentId)).limit(1).for("share");
        if (!isRollbackClaimBound(current, execution ? toDeployment(execution) : null, historical ? toDeployment(historical) : null, new Date())) return { command: current, claimed: false };
      }
      const authority = executionId ? claimDeploymentAuthority(related.map(toCommand), current, executionId) : null;
      if (!authority) return { command: current, claimed: false };
      const [saved] = await tx.update(controlCommands).set({ status: "dispatching", executionAuthority: authority, updatedAt: new Date() }).where(and(eq(controlCommands.id, current.id), eq(controlCommands.status, "eligible"))).returning();
      if (!saved) throw new Error("Execution authority claim lost its command CAS");
      await this.fault("authority-claimed");
      return { command: toCommand(saved), claimed: true, authority };
    });
  }

  async claimProjectUpdate(command: ControlCommand) {
    return this.db.transaction(async (tx) => {
      const [hint] = await tx.select().from(controlCommands).where(eq(controlCommands.id, command.id)).limit(1);
      if (!hint) throw new Error("Control command was not found");
      const hinted = toCommand(hint);
      if (hinted.action !== "project.update" || hinted.scope.kind !== "project") throw new Error("Project update authority requires project scope");
      const projectId = hinted.scope.projectId;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`deploylite:execution:${projectId}`}, 0))`);
      const [row] = await tx.select().from(controlCommands).where(eq(controlCommands.id, command.id)).limit(1).for("update");
      if (!row) throw new Error("Control command was not found");
      const current = toCommand(row);
      const relatedRows = await tx.select().from(controlCommands).where(or(
        and(eq(controlCommands.scopeKind, "project"), eq(controlCommands.scopeKey, projectId)),
        and(eq(controlCommands.scopeKind, "deployment"), sql`${controlCommands.scopeKey}::jsonb ->> 0 = ${projectId}`)
      ));
      const authority = claimProjectUpdateAuthority(relatedRows.map(toCommand), current);
      if (!authority) return { command: current, claimed: false };
      const [saved] = await tx.update(controlCommands).set({ status: "dispatching", executionAuthority: authority, updatedAt: new Date() }).where(and(eq(controlCommands.id, current.id), eq(controlCommands.status, "eligible"))).returning();
      if (!saved) throw new Error("Project update authority claim lost its command CAS");
      await this.fault("authority-claimed");
      return { command: toCommand(saved), claimed: true, authority };
    });
  }

  async validateProjectUpdateAuthority(authority: ProjectControlAuthorityV1, now = Date.now()): Promise<void> {
    const request = projectControlAuthoritySchema.parse(authority);
    const rows = await this.db.select().from(controlCommands).where(or(
      and(eq(controlCommands.scopeKind, "project"), eq(controlCommands.scopeKey, request.projectId)),
      and(eq(controlCommands.scopeKind, "deployment"), sql`${controlCommands.scopeKey}::jsonb ->> 0 = ${request.projectId}`)
    ));
    validateProjectUpdateAuthorityInMemory(rows.map(toCommand), request, now);
  }

  async validateInitialExecution(projectId: string, executionId: string, binding: import("@deploylite/domain").InitialExecutionBinding): Promise<void> {
    const [row] = await this.db.select().from(deployments).where(eq(deployments.id, executionId)).limit(1);
    const related = await this.db.select().from(controlCommands).where(or(
      and(eq(controlCommands.scopeKind, "project"), eq(controlCommands.scopeKey, projectId)),
      and(eq(controlCommands.scopeKind, "deployment"), sql`${controlCommands.scopeKey}::jsonb ->> 0 = ${projectId}`)
    ));
    validateInitialExecution(related.map(toCommand), row ? toDeployment(row) : null, projectId, executionId, binding);
  }
  async validateDeploymentAuthority(authority: DeploymentExecutionAuthorityV1, now = Date.now()): Promise<void> {
    const request = deploymentExecutionAuthoritySchema.parse(authority);
    const rows = await this.db.select().from(controlCommands).where(or(
      and(eq(controlCommands.scopeKind, "project"), eq(controlCommands.scopeKey, request.projectId)),
      and(eq(controlCommands.scopeKind, "deployment"), sql`${controlCommands.scopeKey}::jsonb ->> 0 = ${request.projectId}`)
    ));
    validateDeploymentAuthority(rows.map(toCommand), request, now);
  }

  async completeDeploymentStop(command: ControlCommand, result: Parameters<ControlStopRepository["completeDeploymentStop"]>[1], signal?: AbortSignal): Promise<ControlCommand> {
    command = structuredClone(command); result = structuredClone(result);
    return this.db.transaction(async (tx) => {
      const [hint] = await tx.select().from(controlCommands).where(eq(controlCommands.id, command.id)).limit(1);
      if (!hint) throw new Error("Control command was not found");
      const hinted = toCommand(hint); if (hinted.scope.kind !== "deployment") throw new FenceError();
      const projectId = hinted.scope.projectId;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`deploylite:execution:${projectId}`}, 0))`);
      const [row] = await tx.select().from(controlCommands).where(eq(controlCommands.id, command.id)).limit(1).for("update");
      if (!row) throw new Error("Control command was not found");
      const current = toCommand(row);
      if (current.status === "completed") { validateStopCompletion([], current, command, result); return current; }
      const related = await tx.select().from(controlCommands).where(or(
        and(eq(controlCommands.scopeKind, "project"), eq(controlCommands.scopeKey, projectId)),
        and(eq(controlCommands.scopeKind, "deployment"), sql`${controlCommands.scopeKey}::jsonb ->> 0 = ${projectId}`)
      ));
      validateStopCompletion(related.map(toCommand), current, command, result);
      const authority = command.executionAuthority!;
      const minExpiry = Math.min(authority.projectLease.expiresAt, authority.executionLease.expiresAt, authority.sourceLease?.expiresAt ?? Infinity);
      signal?.throwIfAborted();
      const [completed] = await tx.update(controlCommands).set({ status: "completed", result, updatedAt: new Date() }).where(and(
        eq(controlCommands.id, command.id), eq(controlCommands.status, "dispatching"),
        sql`${controlCommands.executionAuthority} = ${JSON.stringify(authority)}::jsonb`,
        sql`${controlCommands.expiresAt} > clock_timestamp()`, sql`to_timestamp(${minExpiry} / 1000.0) > clock_timestamp()`
      )).returning();
      if (!completed) throw new FenceError("Stop completion lost authority CAS");
      signal?.throwIfAborted();
      return toCommand(completed);
    });
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
      await tx.insert(deployments).values({ id: deployment.id, projectId: deployment.projectId, agentId: deployment.agentId, status: deployment.status, commitSha: deployment.commitSha, snapshotHash, startedAt: new Date(deployment.startedAt), finishedAt: null, metadata: { sourceDeploymentId: deployment.sourceDeploymentId, snapshotOriginId: deployment.snapshotOriginId } });
      await this.fault("redeploy-deployment-inserted");
      const result = redeployResult(command, "eligible", deployment.id, snapshotHash);
      const [eligible] = await tx.update(controlCommands).set({ status: "eligible", result, updatedAt: now }).where(and(eq(controlCommands.id, command.id), eq(controlCommands.status, "pending_confirmation"))).returning();
      if (!eligible) throw new Error("Control command was not pending");
      await tx.insert(controlCommandAudits).values({ commandId: command.id, confirmationId: confirmation.id, correlationId: command.correlationId, outcome: "accepted", reason: null });
      return { command: toCommand(eligible), accepted: true, reason: null, result, deployment, alreadyCompleted: false };
    });
  }

  async claimDeploymentRedeploy(command: ControlCommand) {
    const claim = await this.claimExecutionAuthority(command);
    const id = (claim.command.result?.action === "deployment.redeploy" || claim.command.result?.action === "deployment.rollback") ? claim.command.result.deploymentId : null;
    const row = id ? (await this.db.select().from(deployments).where(eq(deployments.id, id)).limit(1))[0] : null;
    return { ...claim, deployment: row ? toDeployment(row) : null };
  }

  async completeDeploymentRedeploy(command: ControlCommand, result: import("@deploylite/contracts").DeploymentRedeployCommandResult): Promise<ControlCommand> {
    if (result.commandId !== command.id || result.action !== "deployment.redeploy" || result.correlationId !== command.correlationId || result.status !== "completed" || command.scope.kind !== "deployment" || result.projectId !== command.scope.projectId || result.sourceDeploymentId !== command.scope.deploymentId) throw new Error("Deployment redeploy result does not match command");
    const expected = command.result;
    if (!expected || expected.action !== "deployment.redeploy" || expected.status !== "eligible" || expected.projectId !== result.projectId || expected.sourceDeploymentId !== result.sourceDeploymentId || expected.deploymentId === null || expected.deploymentId !== result.deploymentId || expected.snapshotHash !== result.snapshotHash) throw new Error("Deployment redeploy result does not match persisted command");
    const [completed] = await this.db.update(controlCommands).set({ status: "completed", result, updatedAt: new Date() }).where(and(eq(controlCommands.id, command.id), or(eq(controlCommands.status, "eligible"), eq(controlCommands.status, "dispatching")))).returning();
    if (completed) return toCommand(completed); const [current] = await this.db.select().from(controlCommands).where(eq(controlCommands.id, command.id)).limit(1); if (!current) throw new Error("Control command was not found"); return toCommand(current);
  }

  async executeConfirmedDeploymentRollback({ command, confirmation, deployment, now = new Date() }: Parameters<ControlRollbackRepository["executeConfirmedDeploymentRollback"]>[0]) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(controlCommands).where(eq(controlCommands.id, command.id)).limit(1).for("update");
      if (!row) throw new Error("Rollback command was not found");
      const current = toCommand(row); validateRollbackReservation(current, command);
      const reserved = current.result as import("@deploylite/contracts").DeploymentRollbackCommandResult;
      if (current.status === "completed") return { command: current, accepted: true, reason: null, result: reserved, deployment: null, alreadyCompleted: true };
      if (current.status === "eligible" || current.status === "dispatching") {
        const [existing] = await tx.select().from(deployments).where(eq(deployments.id, reserved.deploymentId)).limit(1);
        return { command: current, accepted: true, reason: null, result: reserved, deployment: existing ? toDeployment(existing) : null, alreadyCompleted: false };
      }
      const [historical] = await tx.select().from(deployments).where(eq(deployments.id, reserved.sourceDeploymentId)).limit(1).for("share");
      if (!isRollbackAdmissionBound(current, deployment, historical ? toDeployment(historical) : null, now)) return { command: current, accepted: false, reason: "execution_binding_rejected", result: null, deployment: null, alreadyCompleted: false };
      const [consumed] = await tx.update(controlCommandConfirmations).set({ consumedAt: now }).where(and(eq(controlCommandConfirmations.id, confirmation.id), eq(controlCommandConfirmations.commandId, current.id), eq(controlCommandConfirmations.actorUserId, current.actorId), eq(controlCommandConfirmations.action, "deployment.rollback"), eq(controlCommandConfirmations.scopeKind, current.scope.kind), eq(controlCommandConfirmations.scopeKey, scopeKey(current.scope)), eq(controlCommandConfirmations.inputDigest, current.inputDigest), eq(controlCommandConfirmations.classification, "destructive"), isNull(controlCommandConfirmations.consumedAt), gt(controlCommandConfirmations.expiresAt, now), lte(controlCommandConfirmations.expiresAt, current.expiresAt))).returning();
      if (!consumed) return { command: current, accepted: false, reason: "confirmation_rejected", result: null, deployment: null, alreadyCompleted: false };
      await tx.insert(deployments).values({ id: deployment.id, projectId: deployment.projectId, agentId: deployment.agentId, status: deployment.status, commitSha: deployment.commitSha, snapshotHash: deployment.snapshotHash, startedAt: new Date(deployment.startedAt), finishedAt: null, metadata: { activeDeploymentId: deployment.activeDeploymentId, sourceDeploymentId: deployment.sourceDeploymentId, snapshotOriginId: deployment.snapshotOriginId } });
      await this.fault("redeploy-deployment-inserted");
      const result = { ...reserved, status: "eligible" as const };
      const [eligible] = await tx.update(controlCommands).set({ status: "eligible", result, updatedAt: now }).where(and(eq(controlCommands.id, current.id), eq(controlCommands.status, "pending_confirmation"))).returning();
      if (!eligible) throw new Error("Rollback command lost confirmation CAS");
      await tx.insert(controlCommandAudits).values({ commandId: current.id, confirmationId: confirmation.id, correlationId: current.correlationId, outcome: "accepted", reason: null });
      return { command: toCommand(eligible), accepted: true, reason: null, result, deployment, alreadyCompleted: false };
    });
  }
  async claimDeploymentRollback(command: ControlCommand) { return this.claimDeploymentRedeploy(command); }

  private async fault(stage: ControlDeleteFaultStage): Promise<void> { await this.injectFault?.(stage); }
}

export function toCommand(row: ControlCommandRow): ControlCommand {
  const scope = row.scopeKind === "platform" ? { kind: "platform" as const } : row.scopeKind === "deployment" ? (() => { const [projectId, deploymentId] = JSON.parse(row.scopeKey) as [string, string]; return { kind: "deployment" as const, projectId, deploymentId }; })() : { kind: "project" as const, projectId: row.scopeKey };
  const projectUpdate = row.action === "project.update" && row.executionAuthority !== null ? { projectExecutionAuthority: projectControlAuthoritySchema.parse(row.executionAuthority) } : {};
  const deploymentAuthority = row.action !== "project.update" && row.executionAuthority !== null ? { executionAuthority: deploymentExecutionAuthoritySchema.parse(row.executionAuthority) } : {};
  return { id: row.id, actorId: row.actorUserId, action: row.action as ControlCommand["action"], scope, inputDigest: row.inputDigest, idempotencyKey: row.idempotencyKey, correlationId: row.correlationId, status: row.status as ControlCommand["status"], expiresAt: row.expiresAt, ...(row.result ? { result: row.result as never } : {}), ...projectUpdate, ...deploymentAuthority };
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

/** Resolve through the existing command table inside a caller-owned transaction. */
export async function resolveControlCommandOn(db: Pick<DeployLiteDb, "insert" | "select">, command: ControlCommand): Promise<{ command: ControlCommand; created: boolean }> {
  const key = scopeKey(command.scope);
  const [created] = await db.insert(controlCommands).values({
    id: command.id, actorUserId: command.actorId, action: command.action, scopeKind: command.scope.kind, scopeKey: key,
    inputDigest: command.inputDigest, idempotencyKey: command.idempotencyKey, correlationId: command.correlationId,
    status: command.status, expiresAt: command.expiresAt, result: command.result ?? null
  }).onConflictDoNothing().returning();
  if (created) return { command: toCommand(created), created: true };

  const [existing] = await db.select().from(controlCommands).where(and(
    eq(controlCommands.actorUserId, command.actorId), eq(controlCommands.action, command.action),
    eq(controlCommands.scopeKey, key), eq(controlCommands.idempotencyKey, command.idempotencyKey)
  )).limit(1);
  if (!existing) throw new Error("Idempotency command was not found after conflict");
  if (existing.inputDigest !== command.inputDigest) throw new IdempotencyConflictError();
  return { command: toCommand(existing), created: false };
}
