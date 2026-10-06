import { deploymentSchema, deploymentRollbackCommandResultSchema, dockerImageExecutionReceiptSchema, idSchema, type Deployment } from "@deploylite/contracts";
import { z } from "zod";
import { createAuthApiRequest, createAuthApiUrl, metadataApiPaths } from "./auth-boundary";
import { createDeploymentControlWait, hasBoundSuccessfulExecution, type DeploymentControlAttemptContext, type RedeployOptions, type RedeployOutcome } from "./deployment-redeploy";

export type RollbackAttempt = Readonly<{
  activeDeploymentId: string; historicalDeploymentId: string; projectId: string;
  snapshotHash: string; snapshotOriginId: string; runtimeHost: string; effectiveImageDigest: string;
  activeEffectiveImage: string; hostPort: number; containerPort: number; network: string | null;
  idempotencyKey: string; confirmation: DeploymentControlAttemptContext & { deploymentId?: string };
}>;
export type RollbackOutcome = RedeployOutcome;

// Metadata permits a selected request. Snapshot support and current ownership are server decisions.
export function createRollbackAttempt(A: Deployment, H: Deployment, expectedActiveDeploymentId: string, idempotencyKey: string): RollbackAttempt | null {
  if (!idempotencyKey || idempotencyKey.length > 200 || !hasBoundSuccessfulExecution(A, expectedActiveDeploymentId) || !hasBoundSuccessfulExecution(H, H.id)) return null;
  const active = deploymentSchema.parse(A), historical = deploymentSchema.parse(H);
  const a = active.executionReceipt!, h = historical.executionReceipt!;
  if (active.projectId !== historical.projectId || a.runtimeHost !== h.runtimeHost || a.hostPort !== h.hostPort || a.containerPort !== h.containerPort || a.network !== h.network) return null;
  return Object.freeze({ activeDeploymentId: active.id, historicalDeploymentId: historical.id, projectId: active.projectId,
    snapshotHash: h.snapshotHash, snapshotOriginId: h.snapshotOriginId, runtimeHost: h.runtimeHost, effectiveImageDigest: h.effectiveImageDigest,
    activeEffectiveImage: active.stopTarget!.effectiveImage, hostPort: h.hostPort, containerPort: h.containerPort, network: h.network,
    idempotencyKey, confirmation: {} });
}

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const envelope = <T extends z.ZodTypeAny>(data: T) => z.object({ data, error: z.null(), requestId: idSchema }).strict();
const preparation = envelope(z.object({ commandId: idSchema, deploymentId: z.string().uuid(), confirmationId: idSchema,
  confirmationRequired: z.literal(true), correlationId: idSchema }).strict());
// Select safe evidence fields; actor/lease/expiry metadata does not grant browser authority.
const storedCommand = z.object({ id: idSchema, action: z.literal("deployment.rollback"),
  scope: z.object({ kind: z.literal("deployment"), projectId: idSchema, deploymentId: idSchema }).strict(),
  inputDigest: hash, idempotencyKey: z.string().min(1).max(200), correlationId: idSchema,
  status: z.enum(["pending_confirmation", "eligible", "dispatching", "completed", "rejected"]), result: deploymentRollbackCommandResultSchema.optional() });
const pending = envelope(z.object({ command: storedCommand, pending: z.literal(true) }).strict());
const replay = envelope(z.object({ command: storedCommand, deploymentId: z.string().uuid(), idempotent: z.literal(true) }).strict());
const terminal = envelope(z.object({ deployment: deploymentSchema, command: deploymentRollbackCommandResultSchema, execution: dockerImageExecutionReceiptSchema }).strict());
const failure = z.object({ data: z.null(), error: z.object({ code: z.string().min(1), message: z.string().min(1), correlationId: idSchema }).strict(), requestId: idSchema }).strict();

export async function runDeploymentRollback(attempt: RollbackAttempt, { apiBaseUrl, fetchImpl = fetch }: RedeployOptions): Promise<RollbackOutcome> {
  if (!apiBaseUrl) return { kind: "error", message: "Configure the API before requesting rollback.", retryable: false };
  // Capture A/H and configuration before any await; only the server supplies R and confirmation.
  const { activeDeploymentId, historicalDeploymentId, projectId, snapshotHash, snapshotOriginId, runtimeHost,
    effectiveImageDigest, activeEffectiveImage, hostPort, containerPort, network, idempotencyKey } = attempt;
  let confirmationId = attempt.confirmation.id, commandId = attempt.confirmation.commandId, reservedId = attempt.confirmation.deploymentId;
  let boundCorrelationId = commandId && reservedId ? attempt.confirmation.correlationId : undefined;
  let receivedContext = { requestId: attempt.confirmation.requestId, correlationId: attempt.confirmation.correlationId };
  const url = createAuthApiUrl(metadataApiPaths.deploymentRollback(activeDeploymentId), apiBaseUrl);
  const matchesIdentity = (id: string, correlation: string, R: string) => (!commandId || id === commandId) &&
    (!boundCorrelationId || correlation === boundCorrelationId) && (!reservedId || R === reservedId) && R !== activeDeploymentId && R !== historicalDeploymentId;
  const matchesResult = (r: z.infer<typeof deploymentRollbackCommandResultSchema>) => r.projectId === projectId &&
    r.activeDeploymentId === activeDeploymentId && r.sourceDeploymentId === historicalDeploymentId && r.snapshotHash === snapshotHash && matchesIdentity(r.commandId, r.correlationId, r.deploymentId);
  const matchesStored = (c: z.infer<typeof storedCommand>) => c.scope.projectId === projectId && c.scope.deploymentId === activeDeploymentId &&
    c.idempotencyKey === idempotencyKey && (!commandId || c.id === commandId) && (!boundCorrelationId || c.correlationId === boundCorrelationId) &&
    !!c.result && matchesResult(c.result) && c.result.commandId === c.id && c.result.correlationId === c.correlationId;
  // Error correlation is request diagnostics; only validated command evidence binds identity.
  const bindCommand = (id: string, R: string, correlationId: string, requestId: string) => {
    commandId = id; reservedId = R; boundCorrelationId = correlationId;
    receivedContext = { requestId, correlationId };
    Object.assign(attempt.confirmation, receivedContext, { commandId, deploymentId: reservedId });
  };
  const unknown = (message: string): RollbackOutcome => {
    Object.assign(attempt.confirmation, { requestId: receivedContext.requestId, correlationId: boundCorrelationId, unresolved: true });
    return { kind: "error", message, retryable: true, ...receivedContext, ...(reservedId ? { deploymentId: reservedId } : {}) };
  };
  const invalid = () => unknown("The rollback response was invalid. Outcome is unresolved; check the same request before starting another.");
  const wait = createDeploymentControlWait();
  try {
    for (let step = 0; step < 2; step++) {
      let response: Response, raw: unknown;
      try {
        ({ response, raw } = await wait.read(url, { ...createAuthApiRequest({ method: "POST", body: { historicalDeploymentId, snapshotHash } }),
          headers: { "content-type": "application/json", "x-control-idempotency-key": idempotencyKey,
            ...(confirmationId ? { "x-control-confirmation-id": confirmationId } : {}) } }, fetchImpl));
      } catch { return unknown("Rollback response was not received. Outcome is unresolved; check the same request and refresh execution evidence."); }
      try {
        if (response.status === 202) {
          const prepared = preparation.safeParse(raw);
          if (prepared.success && step === 0 && !confirmationId) {
            const p = prepared.data.data;
            if (!matchesIdentity(p.commandId, p.correlationId, p.deploymentId)) return invalid();
            bindCommand(p.commandId, p.deploymentId, p.correlationId, prepared.data.requestId);
            confirmationId = p.confirmationId; attempt.confirmation.id = confirmationId;
            continue;
          }
          const { data, requestId } = pending.parse(raw), c = data.command;
          if (!matchesStored(c) || c.status === "completed" || c.status === "rejected" || !["pending_confirmation", "eligible"].includes(c.result!.status)) return invalid();
          bindCommand(c.id, c.result!.deploymentId, c.correlationId, requestId);
          attempt.confirmation.unresolved = true;
          return { kind: "pending", message: "Rollback is pending. Check the same request or refresh execution evidence.", retryable: true,
            ...receivedContext, deploymentId: reservedId };
        }
        if (response.status === 200) {
          const repeated = replay.safeParse(raw);
          if (repeated.success) {
            const { data, requestId } = repeated.data, c = data.command;
            if (!matchesStored(c) || c.status !== "completed" || c.result?.status !== "completed" || data.deploymentId !== c.result.deploymentId) return invalid();
            bindCommand(c.id, data.deploymentId, c.correlationId, requestId);
            return { kind: "completed", message: "Stored rollback command is completed. Open execution evidence for its status.", retryable: false,
              requestId, correlationId: c.correlationId, deploymentId: data.deploymentId };
          }
          const { data, requestId } = terminal.parse(raw), d = data.deployment, c = data.command, execution = data.execution;
          const p = d.executionReceipt;
          if (!matchesResult(c) || c.status !== "completed" || d.id !== c.deploymentId || d.projectId !== projectId ||
            d.activeDeploymentId !== activeDeploymentId || d.sourceDeploymentId !== historicalDeploymentId || d.snapshotOriginId !== snapshotOriginId ||
            d.snapshotHash !== snapshotHash || d.agentId !== runtimeHost || !d.finishedAt || execution.deploymentId !== d.id || execution.terminalStatus !== d.status ||
            ((execution.candidateId !== undefined || d.status === "succeeded") && execution.candidateId !== d.stopTarget?.candidateId) || execution.effectiveImage !== d.stopTarget?.effectiveImage ||
            (execution.runtimeConfig && (execution.runtimeConfig.hostPort !== hostPort || execution.runtimeConfig.containerPort !== containerPort || (execution.runtimeConfig.networkName ?? null) !== network)) ||
            execution.effectiveImage.split("@")[1] !== effectiveImageDigest || execution.runtimePort !== containerPort ||
            JSON.stringify(execution.executionReceipt) !== JSON.stringify(p) ||
            (execution.rollback.target !== null && execution.rollback.target !== activeEffectiveImage) ||
            (d.status === "succeeded" && (!hasBoundSuccessfulExecution(d, d.id) || p!.hostPort !== hostPort || p!.containerPort !== containerPort || p!.network !== network))) return invalid();
          bindCommand(c.commandId, d.id, c.correlationId, requestId);
          return { kind: "completed", message: `Rollback execution ${d.status}. Open execution evidence.`, retryable: false,
            requestId, correlationId: c.correlationId, deploymentId: d.id };
        }
        const { error, requestId } = failure.parse(raw);
        const denied = response.status === 401 || response.status === 403;
        const rejected = response.status === 409 && ["CONFIRMATION_REQUIRED", "CONFIRMATION_REJECTED", "IDEMPOTENCY_CONFLICT", "ROLLBACK_REJECTED", "ROLLBACK_SNAPSHOT_INELIGIBLE"].includes(error.code);
        const canPrepareNew = response.status === 409 && error.code === "CONFIRMATION_REJECTED" && !attempt.confirmation.unresolved;
        const retryable = !!attempt.confirmation.unresolved || (!denied && !rejected && response.status !== 404);
        receivedContext = { requestId, correlationId: boundCorrelationId ?? error.correlationId };
        if (retryable) Object.assign(attempt.confirmation, { requestId, correlationId: boundCorrelationId, unresolved: true });
        return { kind: "error", retryable, canPrepareNew, ...receivedContext,
          message: denied ? `Server denied rollback authorization. Refresh your session or access.${attempt.confirmation.unresolved ? " The earlier outcome is unresolved; check the same request." : ""}` :
            rejected && !attempt.confirmation.unresolved ? "Server rejected the selected request or its confirmation. Refresh execution evidence before preparing another request." :
              "Rollback is unavailable or unresolved. Check the same request and refresh execution evidence." };
      } catch { return invalid(); }
    }
    return invalid();
  } finally { wait.dispose(); }
}
