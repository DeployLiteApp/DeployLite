import { and, eq } from "drizzle-orm";
import { deploymentRedeployCommandResultSchema, type Deployment } from "@deploylite/contracts";
import {
  completeExecutionAtomically,
  type DeploymentExecutionRepository,
  type ExecutionCommandRecord,
  type ExecutionCompletionInput,
  type ExecutionCompletionOutcome,
  type ExecutionCompletionStore,
  type ExecutionCompletionTransaction
} from "@deploylite/domain";
import type { DeployLiteDb } from "../client.js";
import { controlCommands, deployments, type ControlCommandRow } from "../schema.js";
import { toDeployment } from "./deployment-data.js";

export class DbDeploymentExecutionRepository implements DeploymentExecutionRepository {
  constructor(private readonly db: DeployLiteDb) {}

  completeExecution(input: ExecutionCompletionInput): Promise<ExecutionCompletionOutcome> {
    const store: ExecutionCompletionStore = {
      transaction: (work) => this.db.transaction(async (tx) => {
        let lockedDeployment: Deployment | null = null;
        const transaction: ExecutionCompletionTransaction = {
          lockCommand: async (id) => {
            const [row] = await tx.select().from(controlCommands).where(eq(controlCommands.id, id)).limit(1).for("update");
            return row ? toExecutionCommand(row) : null;
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
          },
          saveCommand: async (command) => {
            const [saved] = await tx.update(controlCommands).set({ status: command.status, result: command.result, updatedAt: new Date() })
              .where(and(eq(controlCommands.id, command.id), eq(controlCommands.status, "dispatching")))
              .returning({ id: controlCommands.id });
            if (!saved) throw new ExecutionCompletionConflict();
          }
        };
        return work(transaction);
      })
    };
    return completeExecutionAtomically(store, input).catch((error: unknown) => {
      if (error instanceof ExecutionCompletionConflict) return { kind: "conflict" };
      throw error;
    });
  }
}

class ExecutionCompletionConflict extends Error {}

function toExecutionCommand(row: ControlCommandRow): ExecutionCommandRecord {
  const parsed = deploymentRedeployCommandResultSchema.safeParse(row.result);
  if (!parsed.success || row.action !== "deployment.redeploy" || row.scopeKind !== "deployment"
    || (row.status !== "dispatching" && row.status !== "completed")) throw new ExecutionCompletionConflict();
  const result = parsed.data;
  let scope: unknown;
  try { scope = JSON.parse(row.scopeKey); } catch { throw new ExecutionCompletionConflict(); }
  if (!Array.isArray(scope) || scope.length !== 2 || scope[0] !== result.projectId || scope[1] !== result.sourceDeploymentId
    || row.id !== result.commandId || row.correlationId !== result.correlationId
    || result.status !== (row.status === "completed" ? "completed" : "eligible")) throw new ExecutionCompletionConflict();
  return { id: row.id, status: row.status, result };
}
