import { deploymentExecutionAuthoritySchema, deploymentStopCommandResultSchema, type DeploymentStopCommandResult, FenceError, LeaseExpiredError, protocolPayloadFingerprint, type Deployment, type DeploymentExecutionAuthorityV1 } from "@deploylite/contracts";
import { IdempotencyConflictError, type ControlCommand } from "../control-plane.js";

export type InitialExecutionBinding = Readonly<{ snapshotOriginId: string; snapshotHash: string; runtimeHost: string }>;

export type DeploymentAuthorityValidation = {
  validateInitialExecution?(projectId: string, executionId: string, binding: InitialExecutionBinding): Promise<void>;
  validateDeploymentAuthority(authority: DeploymentExecutionAuthorityV1, now?: number): Promise<void>;
};

/** Mutate the existing eligible command synchronously after repository row locks. */
export function claimDeploymentAuthority(commands: readonly ControlCommand[], current: ControlCommand, executionId: string, now = Date.now()): DeploymentExecutionAuthorityV1 | null {
  if (current.status !== "eligible" || current.scope.kind !== "deployment" || current.expiresAt.getTime() <= now) return null;
  const projectId = current.scope.projectId;
  const related = commands.filter((command) => command.scope.kind === "deployment" && command.scope.projectId === projectId);
  if (related.some((command) => command.id !== current.id && command.status === "dispatching" && command.expiresAt.getTime() > now)) return null;
  // INITIAL transport reserves fence 1; shared controls must advance beyond it.
  const fence = Math.max(1, ...related.map((command) => command.executionAuthority?.projectLease.fence ?? 0)) + 1;
  const lease = (deploymentId: string, kind: string) => ({ deploymentId, fence, leaseId: `${current.id}:${kind}:${fence}`, expiresAt: current.expiresAt.getTime() });
  const authority = deploymentExecutionAuthoritySchema.parse({ projectId, commandId: current.id, action: current.action,
    projectLease: lease(projectId, "project"), executionLease: lease(executionId, "execution"),
    ...((current.action === "deployment.redeploy" || current.action === "deployment.rollback") ? { sourceLease: lease(current.scope.deploymentId, "source") } : {}) });
  current.executionAuthority = structuredClone(authority);
  current.status = "dispatching";
  return authority;
}


export function validateDeploymentAuthority(commands: readonly ControlCommand[], submitted: DeploymentExecutionAuthorityV1, now = Date.now()): void {
  const authority = deploymentExecutionAuthoritySchema.parse(submitted);
  const leases = [authority.projectLease, authority.executionLease, ...(authority.sourceLease ? [authority.sourceLease] : [])];
  if (leases.some((lease) => lease.expiresAt <= now)) throw new LeaseExpiredError();
  const current = commands.find((command) => command.id === authority.commandId);
  if (!current || current.status !== "dispatching" || current.scope.kind !== "deployment" || current.scope.projectId !== authority.projectId || !current.executionAuthority || protocolPayloadFingerprint(current.executionAuthority) !== protocolPayloadFingerprint(authority)) throw new FenceError("Deployment authority no longer owns the command");
  if (commands.some((command) => command.scope.kind === "deployment" && command.scope.projectId === authority.projectId && (command.executionAuthority?.projectLease.fence ?? 0) > authority.projectLease.fence)) throw new FenceError();
}

/** INITIAL fence 1 cannot resume after a persisted stop/replacement control of that execution. */
export function validateInitialExecution(commands: readonly ControlCommand[], deployment: Deployment | null | undefined, projectId: string, executionId: string, binding: InitialExecutionBinding): void {
  if (!deployment || deployment.id !== executionId || deployment.projectId !== projectId || deployment.status !== "running") throw new FenceError("INITIAL execution no longer runs");
  if (deployment.snapshotOriginId !== binding.snapshotOriginId || deployment.snapshotHash !== binding.snapshotHash || deployment.agentId !== binding.runtimeHost) throw new FenceError("INITIAL immutable execution binding changed");
  if (commands.some((command) => command.scope.kind === "deployment" && command.scope.projectId === projectId && ((command.executionAuthority && [command.executionAuthority.executionLease, command.executionAuthority.sourceLease].some((lease) => lease?.deploymentId === executionId && lease.fence > 1)) || (command.action === "deployment.stop" && command.scope.deploymentId === executionId && ["dispatching", "completed"].includes(command.status))))) throw new FenceError("INITIAL execution superseded by control authority");
}

/** Equal terminal replay precedes mutable authority; every new Stop result requires the current claim. */
export function validateStopCompletion(commands: readonly ControlCommand[], current: ControlCommand, submitted: ControlCommand, input: DeploymentStopCommandResult): boolean {
  const result = deploymentStopCommandResultSchema.parse(input);
  const binding = (command: ControlCommand) => ({ id: command.id, actorId: command.actorId, action: command.action, scope: command.scope, inputDigest: command.inputDigest, idempotencyKey: command.idempotencyKey, correlationId: command.correlationId, authority: command.executionAuthority ?? null });
  if (current.action !== "deployment.stop" || current.scope.kind !== "deployment" || result.commandId !== current.id || result.projectId !== current.scope.projectId || result.deploymentId !== current.scope.deploymentId || result.correlationId !== current.correlationId || result.status !== "completed" || protocolPayloadFingerprint(binding(current)) !== protocolPayloadFingerprint(binding(submitted))) throw new IdempotencyConflictError();
  if (current.status === "completed") {
    if (protocolPayloadFingerprint(current.result) !== protocolPayloadFingerprint(result)) throw new IdempotencyConflictError();
    return true;
  }
  if (!submitted.executionAuthority || current.expiresAt.getTime() <= Date.now()) throw new FenceError("Stop completion no longer owns authority");
  validateDeploymentAuthority(commands, submitted.executionAuthority);
  return false;
}
