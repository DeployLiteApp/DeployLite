import type { Deployment, DeploymentExecutionAuthorityV1 } from "@deploylite/contracts";
import { validateDeploymentAuthority, validateInitialExecution, type InitialExecutionBinding } from "./deployment-authority.js";
import type { ControlCommand } from "../control-plane.js";
import { completeExecutionAtomically, type ExecutionCommandRecord, type ExecutionCompletionInput, type ExecutionCompletionOutcome, type ExecutionCompletionStore, type ExecutionCompletionTransaction } from "./execution-completion.js";

export class InMemoryExecutionState implements ExecutionCompletionStore {
  deployments = new Map<string, Deployment>();
  commands = new Map<string, ControlCommand>();

  completeExecution(input: ExecutionCompletionInput, signal?: AbortSignal): Promise<ExecutionCompletionOutcome> { return completeExecutionAtomically(this, input, signal); }

  async transaction<T>(work: (transaction: ExecutionCompletionTransaction) => Promise<T>, signal?: AbortSignal): Promise<T> {
    for (;;) {
      const baseDeployments = structuredClone(this.deployments), baseCommands = structuredClone(this.commands);
      const stagedDeployments = structuredClone(baseDeployments), stagedCommands = structuredClone(baseCommands);
      const lockedProjects = new Set<string>();
      let validatedInitial: { projectId: string; executionId: string; binding: InitialExecutionBinding } | undefined;
      let validatedAuthority: DeploymentExecutionAuthorityV1 | undefined;
      const lockedDeployments = new Set<string>(), lockedCommands = new Set<string>();
      const transaction: ExecutionCompletionTransaction = {
        lockProjectAuthority: async (projectId) => { lockedProjects.add(projectId); },
        validateInitialExecution: async (projectId, executionId, binding) => {
          try { validateInitialExecution([...stagedCommands.values()], stagedDeployments.get(executionId), projectId, executionId, binding); validatedInitial = { projectId, executionId, binding }; return true; }
          catch { return false; }
        },
        validateAuthority: async (authority) => {
          try { validateDeploymentAuthority([...stagedCommands.values()], authority); validatedAuthority = authority; return true; }
          catch { return false; }
        },
        lockCommand: async (id) => { const entry = [...stagedCommands].find(([, command]) => command.id === id); if (entry) lockedCommands.add(entry[0]); return structuredClone(entry?.[1] as ExecutionCommandRecord | undefined ?? null); },
        lockDeployment: async (id) => { lockedDeployments.add(id); return structuredClone(stagedDeployments.get(id) ?? null); },
        saveDeployment: async (deployment) => { stagedDeployments.set(deployment.id, structuredClone(deployment)); },
        saveCommand: async (command) => { const key = [...stagedCommands].find(([, current]) => current.id === command.id)?.[0]; if (key) stagedCommands.set(key, structuredClone(command) as ControlCommand); }
      };
      const result = await work(transaction);
      if ([...lockedDeployments].some((id) => !equal(this.deployments.get(id), baseDeployments.get(id))) || [...lockedCommands].some((key) => !equal(this.commands.get(key), baseCommands.get(key)))) continue;
      if ([...lockedProjects].some((projectId) => !equal(projectCommands(this.commands, projectId), projectCommands(baseCommands, projectId)))) continue;
      if (validatedInitial) { try { validateInitialExecution([...this.commands.values()], this.deployments.get(validatedInitial.executionId), validatedInitial.projectId, validatedInitial.executionId, validatedInitial.binding); } catch { continue; } }
      if (validatedAuthority) { try { validateDeploymentAuthority([...this.commands.values()], validatedAuthority); } catch { continue; } }
      const nextDeployments = new Map(this.deployments), nextCommands = new Map(this.commands);
      for (const [id, value] of stagedDeployments) if (!equal(value, baseDeployments.get(id))) nextDeployments.set(id, value);
      for (const [key, value] of stagedCommands) if (!equal(value, baseCommands.get(key))) nextCommands.set(key, value);
      // Equal durable replay is read-only; an abort fences every new map publication.
      if (!equal([...nextDeployments], [...this.deployments]) || !equal([...nextCommands], [...this.commands])) signal?.throwIfAborted();
      this.deployments = nextDeployments; this.commands = nextCommands;
      return result;
    }
  }
}

function equal(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }

function projectCommands(commands: Map<string, ControlCommand>, projectId: string): ControlCommand[] { return [...commands.values()].filter((command) => command.scope.kind === "deployment" && command.scope.projectId === projectId); }
