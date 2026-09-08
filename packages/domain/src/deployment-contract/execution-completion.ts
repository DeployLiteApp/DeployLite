import { trustedPriorExecutionReceiptSchema, type Deployment, type DeploymentRedeployCommandResult, type TrustedPriorExecutionReceiptV1 } from "@deploylite/contracts";

export type ExecutionTerminalStatus = Extract<Deployment["status"], "succeeded" | "failed" | "canceled">;

export type ExecutionCompletionInput = Readonly<{
  commandId: string | null;
  expectedStatus: Deployment["status"];
  executionId: string;
  projectId: string;
  sourceExecutionId: string | null;
  snapshotOriginId: string;
  snapshotHash: string;
  runtimeHost: string;
  effectiveImageDigest: string;
  terminalStatus: ExecutionTerminalStatus;
  finishedAt: string;
  commandResult: DeploymentRedeployCommandResult | null;
  proof: TrustedPriorExecutionReceiptV1 | null;
}>;

export type ExecutionCommandRecord = Readonly<{
  id: string;
  status: "eligible" | "dispatching" | "completed";
  result: DeploymentRedeployCommandResult;
}>;

export type ExecutionCompletionOutcome =
  | Readonly<{ kind: "committed" | "replayed"; deployment: Deployment; command: ExecutionCommandRecord | null }>
  | Readonly<{ kind: "conflict" | "not-found" }>;

export type ExecutionCompletionTransaction = {
  lockCommand(id: string): Promise<ExecutionCommandRecord | null>;
  lockDeployment(id: string): Promise<Deployment | null>;
  saveDeployment(deployment: Deployment): Promise<void>;
  saveCommand(command: ExecutionCommandRecord): Promise<void>;
};

export type ExecutionCompletionStore = {
  transaction<T>(work: (transaction: ExecutionCompletionTransaction) => Promise<T>): Promise<T>;
};

export async function completeExecutionAtomically(
  store: ExecutionCompletionStore,
  input: ExecutionCompletionInput
): Promise<ExecutionCompletionOutcome> {
  const candidate = parseInput(input);
  return store.transaction(async (transaction) => {
    const command = candidate.commandId ? await transaction.lockCommand(candidate.commandId) : null;
    if (candidate.commandId && !command) return { kind: "not-found" };
    const deployment = await transaction.lockDeployment(candidate.executionId);
    if (!deployment) return { kind: "not-found" };
    if (!bindingsMatch(deployment, command, candidate) || (!isTerminal(deployment.status) && deployment.executionReceipt)) return { kind: "conflict" };

    const completedDeployment: Deployment = {
      ...deployment,
      status: candidate.terminalStatus,
      finishedAt: candidate.finishedAt,
      ...(candidate.proof ? { executionReceipt: candidate.proof } : {})
    };
    const completedCommand = command && candidate.commandResult
      ? { ...command, status: "completed" as const, result: candidate.commandResult }
      : null;

    if (isTerminal(deployment.status) || command?.status === "completed") {
      return semanticallyEqual(deployment, completedDeployment) && semanticallyEqual(command, completedCommand)
        ? { kind: "replayed", deployment: structuredClone(deployment), command: structuredClone(command) }
        : { kind: "conflict" };
    }
    if (deployment.status !== candidate.expectedStatus) return { kind: "conflict" };

    await transaction.saveDeployment(completedDeployment);
    if (completedCommand) await transaction.saveCommand(completedCommand);
    return {
      kind: "committed",
      deployment: structuredClone(completedDeployment),
      command: structuredClone(completedCommand)
    };
  });
}

function parseInput(input: ExecutionCompletionInput): ExecutionCompletionInput {
  const copy = structuredClone(input);
  const proof = copy.proof ? trustedPriorExecutionReceiptSchema.parse(copy.proof) : null;
  if (!copy.executionId || !copy.projectId || !copy.snapshotOriginId || !/^[a-f0-9]{64}$/.test(copy.snapshotHash)) throw new Error("Execution completion identity is invalid");
  if (!/^sha256:[a-f0-9]{64}$/.test(copy.effectiveImageDigest) || !copy.runtimeHost || Number.isNaN(Date.parse(copy.finishedAt))) throw new Error("Execution completion runtime binding is invalid");
  if ((copy.terminalStatus === "succeeded") !== Boolean(proof)) throw new Error("Successful completion requires trusted proof and ordinary failure forbids it");
  if (Boolean(copy.commandId) !== Boolean(copy.commandResult)) throw new Error("Command completion identity is invalid");
  return { ...copy, proof };
}

function bindingsMatch(deployment: Deployment, command: ExecutionCommandRecord | null, input: ExecutionCompletionInput): boolean {
  if (deployment.id !== input.executionId || deployment.projectId !== input.projectId || deployment.agentId !== input.runtimeHost || (deployment.sourceDeploymentId ?? null) !== input.sourceExecutionId || deployment.snapshotOriginId !== input.snapshotOriginId || deployment.snapshotHash !== input.snapshotHash) return false;
  if (input.proof && (input.proof.deploymentId !== input.executionId || input.proof.projectId !== input.projectId || input.proof.snapshotOriginId !== input.snapshotOriginId || input.proof.snapshotHash !== input.snapshotHash || input.proof.runtimeHost !== input.runtimeHost || input.proof.effectiveImageDigest !== input.effectiveImageDigest)) return false;
  if (!command) return input.commandId === null && input.commandResult === null;
  const result = input.commandResult;
  const expected = command.result;
  if (command.id !== input.commandId || !result) return false;
  if (command.status === "completed") return true;
  return result.commandId === command.id && result.action === "deployment.redeploy" && result.status === "completed"
    && result.projectId === input.projectId && result.sourceDeploymentId === input.sourceExecutionId
    && result.deploymentId === input.executionId && result.snapshotHash === input.snapshotHash
    && result.correlationId === expected.correlationId && expected.status === "eligible"
    && expected.projectId === result.projectId && expected.sourceDeploymentId === result.sourceDeploymentId
    && expected.deploymentId === result.deploymentId && expected.snapshotHash === result.snapshotHash;
}

function isTerminal(status: Deployment["status"]): status is ExecutionTerminalStatus {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

function semanticallyEqual(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  return JSON.stringify(value);
}
