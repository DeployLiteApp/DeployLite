import type { Deployment } from "@deploylite/contracts";
import type { ControlCommand } from "../control-plane.js";
import { completeExecutionAtomically, type ExecutionCommandRecord, type ExecutionCompletionInput, type ExecutionCompletionOutcome, type ExecutionCompletionStore, type ExecutionCompletionTransaction } from "./execution-completion.js";

export class InMemoryExecutionState implements ExecutionCompletionStore {
  deployments = new Map<string, Deployment>();
  commands = new Map<string, ControlCommand>();

  completeExecution(input: ExecutionCompletionInput): Promise<ExecutionCompletionOutcome> { return completeExecutionAtomically(this, input); }

  async transaction<T>(work: (transaction: ExecutionCompletionTransaction) => Promise<T>): Promise<T> {
    for (;;) {
      const baseDeployments = structuredClone(this.deployments), baseCommands = structuredClone(this.commands);
      const stagedDeployments = structuredClone(baseDeployments), stagedCommands = structuredClone(baseCommands);
      const lockedDeployments = new Set<string>(), lockedCommands = new Set<string>();
      const transaction: ExecutionCompletionTransaction = {
        lockCommand: async (id) => { const entry = [...stagedCommands].find(([, command]) => command.id === id); if (entry) lockedCommands.add(entry[0]); return structuredClone(entry?.[1] as ExecutionCommandRecord | undefined ?? null); },
        lockDeployment: async (id) => { lockedDeployments.add(id); return structuredClone(stagedDeployments.get(id) ?? null); },
        saveDeployment: async (deployment) => { stagedDeployments.set(deployment.id, structuredClone(deployment)); },
        saveCommand: async (command) => { const key = [...stagedCommands].find(([, current]) => current.id === command.id)?.[0]; if (key) stagedCommands.set(key, structuredClone(command) as ControlCommand); }
      };
      const result = await work(transaction);
      if ([...lockedDeployments].some((id) => !equal(this.deployments.get(id), baseDeployments.get(id))) || [...lockedCommands].some((key) => !equal(this.commands.get(key), baseCommands.get(key)))) continue;
      const nextDeployments = new Map(this.deployments), nextCommands = new Map(this.commands);
      for (const [id, value] of stagedDeployments) if (!equal(value, baseDeployments.get(id))) nextDeployments.set(id, value);
      for (const [key, value] of stagedCommands) if (!equal(value, baseCommands.get(key))) nextCommands.set(key, value);
      this.deployments = nextDeployments; this.commands = nextCommands;
      return result;
    }
  }
}

function equal(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
