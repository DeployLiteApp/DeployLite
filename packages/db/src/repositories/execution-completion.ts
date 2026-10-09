import { and, eq, gt, or, sql } from "drizzle-orm";
import { deploymentExecutionAuthoritySchema, deploymentRedeployCommandResultSchema, deploymentRollbackCommandResultSchema, type Deployment } from "@deploylite/contracts";
import {
  completeExecutionAtomically, validateDeploymentAuthority, validateInitialExecution,
  type DeploymentExecutionRepository,
  type ExecutionCommandRecord,
  type ExecutionCompletionInput,
  type ExecutionCompletionOutcome,
  type ExecutionCompletionStore,
  type ExecutionCompletionTransaction
} from "@deploylite/domain";
import type { DeployLiteDb } from "../client.js";
import { controlCommands, deployments, type ControlCommandRow } from "../schema.js";
import { toCommand } from "./control-plane.js";
import { toDeployment } from "./deployment-data.js";

export class DbDeploymentExecutionRepository implements DeploymentExecutionRepository {
  constructor(private readonly db: DeployLiteDb) {}

  completeExecution(input: ExecutionCompletionInput, signal?: AbortSignal): Promise<ExecutionCompletionOutcome> {
    const store: ExecutionCompletionStore = {
      transaction: (work) => this.db.transaction(async (tx) => {
        let wrote = false;
        let lockedDeployment: Deployment | null = null;
        let lockedCommand: ExecutionCommandRecord | null = null;
        const transaction: ExecutionCompletionTransaction = {
          lockProjectAuthority: async (projectId) => { await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`deploylite:execution:${projectId}`}, 0))`); },
          validateInitialExecution: async (projectId, executionId, binding) => {
            const related = await tx.select().from(controlCommands).where(or(
              and(eq(controlCommands.scopeKind, "project"), eq(controlCommands.scopeKey, projectId)),
              and(eq(controlCommands.scopeKind, "deployment"), sql`${controlCommands.scopeKey}::jsonb ->> 0 = ${projectId}`)
            ));
            try { validateInitialExecution(related.map(toCommand), lockedDeployment, projectId, executionId, binding); return true; }
            catch { return false; }
          },
          validateAuthority: async (authority) => {
            const related = await tx.select().from(controlCommands).where(or(
              and(eq(controlCommands.scopeKind, "project"), eq(controlCommands.scopeKey, authority.projectId)),
              and(eq(controlCommands.scopeKind, "deployment"), sql`${controlCommands.scopeKey}::jsonb ->> 0 = ${authority.projectId}`)
            ));
            try { validateDeploymentAuthority(related.map(toCommand), authority); return true; }
            catch { return false; }
          },
          lockCommand: async (id) => {
            const [row] = await tx.select().from(controlCommands).where(eq(controlCommands.id, id)).limit(1).for("update");
            lockedCommand = row ? toExecutionCommand(row) : null;
            return lockedCommand;
          },
          lockDeployment: async (id) => {
            const [row] = await tx.select().from(deployments).where(eq(deployments.id, id)).limit(1).for("update");
            lockedDeployment = row ? toDeployment(row) : null;
            return lockedDeployment;
          },
          saveDeployment: async (deployment) => {
            if (!lockedDeployment || lockedDeployment.id !== deployment.id) throw new ExecutionCompletionConflict();
            const [saved] = await tx.update(deployments).set({
              status: deployment.status, finishedAt: deployment.finishedAt ? new Date(deployment.finishedAt) : null,
              executionReceipt: deployment.executionReceipt ?? null, updatedAt: new Date()
            }).where(and(eq(deployments.id, deployment.id), eq(deployments.status, lockedDeployment.status)))
              .returning({ id: deployments.id });
            if (!saved) throw new ExecutionCompletionConflict();
            wrote = true;
          },
          saveCommand: async (command) => {
            const authority = lockedCommand?.executionAuthority;
            const expiresAt = authority ? Math.min(authority.projectLease.expiresAt, authority.executionLease.expiresAt, authority.sourceLease?.expiresAt ?? Infinity) : null;
            const [saved] = await tx.update(controlCommands).set({ status: command.status, result: command.result, updatedAt: new Date() })
              .where(and(eq(controlCommands.id, command.id), eq(controlCommands.status, "dispatching"), ...(authority ? [eq(controlCommands.executionAuthority, authority), gt(controlCommands.expiresAt, sql`clock_timestamp()`), sql`clock_timestamp() < to_timestamp(${expiresAt! / 1000})`] : [])))
              .returning({ id: controlCommands.id });
            if (!saved) throw new ExecutionCompletionConflict();
            wrote = true;
          }
        };
        const outcome = await work(transaction);
        if (wrote) signal?.throwIfAborted();
        return outcome;
      })
    };
    return completeExecutionAtomically(store, input, signal).catch((error: unknown) => {
      if (error instanceof ExecutionCompletionConflict) return { kind: "conflict" };
      throw error;
    });
  }
}

class ExecutionCompletionConflict extends Error {}

function toExecutionCommand(row: ControlCommandRow): ExecutionCommandRecord {
  const parsed = (row.action === "deployment.rollback" ? deploymentRollbackCommandResultSchema : deploymentRedeployCommandResultSchema).safeParse(row.result);
  if (!parsed.success || (row.action !== "deployment.redeploy" && row.action !== "deployment.rollback") || row.scopeKind !== "deployment"
    || (row.status !== "dispatching" && row.status !== "completed")) throw new ExecutionCompletionConflict();
  const result = parsed.data;
  let scope: unknown;
  try { scope = JSON.parse(row.scopeKey); } catch { throw new ExecutionCompletionConflict(); }
  if (!Array.isArray(scope) || scope.length !== 2 || scope[0] !== result.projectId || scope[1] !== (result.action === "deployment.rollback" ? result.activeDeploymentId : result.sourceDeploymentId)
    || row.id !== result.commandId || row.correlationId !== result.correlationId
    || result.status !== (row.status === "completed" ? "completed" : "eligible")) throw new ExecutionCompletionConflict();
  return { id: row.id, action: row.action, scope: { kind: "deployment", projectId: result.projectId, deploymentId: String(scope[1]) }, status: row.status, result, ...(row.executionAuthority ? { executionAuthority: deploymentExecutionAuthoritySchema.parse(row.executionAuthority) } : {}) };
}
