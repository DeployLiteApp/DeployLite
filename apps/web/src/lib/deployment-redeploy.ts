import { deploymentSchema, deploymentRedeployCommandResultSchema, dockerImageExecutionReceiptSchema, idSchema, type Deployment } from "@deploylite/contracts";
import { z } from "zod";
import { createAuthApiRequest, createAuthApiUrl, metadataApiPaths } from "./auth-boundary";

export type DeploymentControlAttemptContext = {
  id?: string; commandId?: string; requestId?: string; correlationId?: string; unresolved?: boolean;
};
export type RedeployAttempt = Readonly<{
  sourceDeploymentId: string; projectId: string; snapshotHash: string; snapshotOriginId: string;
  runtimeHost: string; effectiveImageDigest: string; idempotencyKey: string;
  confirmation: DeploymentControlAttemptContext;
}>;
export type RedeployOutcome = { kind: "completed" | "pending" | "error"; message: string; retryable: boolean; canPrepareNew?: boolean; requestId?: string; correlationId?: string; deploymentId?: string };
export type RedeployOptions = { apiBaseUrl: string | null; fetchImpl?: typeof fetch };

// This bounds browser waiting, not server effects or the accepted outage/recovery policy.
// Default preparation, execution, recovery and reconciliation can use 150s; allow transport margin.
export function createDeploymentControlWait() {
  const controller = new AbortController();
  const deadline = performance.now() + 180_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("Client wait elapsed")); }, 180_000);
  });
  return {
    async read(url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<{ response: Response; raw: unknown }> {
      const work = (async () => {
        const response = await fetchImpl(url, { ...init, signal: controller.signal });
        let raw: unknown;
        try { raw = await response.json(); } catch { raw = null; }
        return { response, raw };
      })();
      const reply = await Promise.race([work, expired]);
      if (performance.now() >= deadline) { controller.abort(); throw new Error("Client wait elapsed"); }
      return reply;
    },
    dispose() { if (timer !== undefined) clearTimeout(timer); }
  };
}

// Metadata permits a request; only the server can establish current workload ownership.
function selectedSuccessfulExecution(deployment: Deployment, expectedSourceDeploymentId: string): Deployment | null {
  const parsed = deploymentSchema.safeParse(deployment);
  if (!parsed.success) return null;
  const d = parsed.data, p = d.executionReceipt;
  if (d.id !== expectedSourceDeploymentId || d.status !== "succeeded" || !d.finishedAt || !p ||
    p.deploymentId !== d.id || p.projectId !== d.projectId || p.runtimeHost !== d.agentId ||
    p.snapshotOriginId !== d.snapshotOriginId || p.snapshotHash !== d.snapshotHash ||
    p.candidateId !== d.stopTarget?.candidateId || p.effectiveImageDigest !== d.stopTarget?.effectiveImage.split("@")[1]) return null;
  return d;
}

export function hasBoundSuccessfulExecution(deployment: Deployment, expectedSourceDeploymentId: string): boolean {
  return selectedSuccessfulExecution(deployment, expectedSourceDeploymentId) !== null;
}

export function createRedeployAttempt(deployment: Deployment, expectedSourceDeploymentId: string, idempotencyKey: string): RedeployAttempt | null {
  if (!idempotencyKey || idempotencyKey.length > 200) return null;
  const d = selectedSuccessfulExecution(deployment, expectedSourceDeploymentId);
  if (!d) return null;
  const p = d.executionReceipt!;
  return Object.freeze({ sourceDeploymentId: d.id, projectId: d.projectId, snapshotHash: p.snapshotHash,
    snapshotOriginId: p.snapshotOriginId, runtimeHost: p.runtimeHost, effectiveImageDigest: p.effectiveImageDigest,
    idempotencyKey, confirmation: {} });
}

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const envelope = <T extends z.ZodTypeAny>(data: T) => z.object({ data, error: z.null(), requestId: idSchema }).strict();
const preparation = envelope(z.object({ commandId: idSchema, confirmationId: idSchema, confirmationRequired: z.literal(true), correlationId: idSchema }).strict());
// Select safe command fields; server-owned leases/actor/expiry are not browser authority.
const storedCommand = z.object({ id: idSchema, action: z.literal("deployment.redeploy"),
  scope: z.object({ kind: z.literal("deployment"), projectId: idSchema, deploymentId: idSchema }).strict(),
  inputDigest: hash, idempotencyKey: z.string().min(1).max(200), correlationId: idSchema,
  status: z.enum(["eligible", "dispatching", "completed"]), result: deploymentRedeployCommandResultSchema.optional() });
const pending = envelope(z.object({ command: storedCommand, pending: z.literal(true), correlationId: idSchema.optional(), deployment: deploymentSchema.optional() }).strict());
const replay = envelope(z.object({ command: storedCommand, deploymentId: idSchema, snapshotHash: hash, idempotent: z.literal(true) }).strict());
const terminal = envelope(z.object({ deployment: deploymentSchema, command: deploymentRedeployCommandResultSchema,
  snapshotHash: hash, sourceDeploymentId: idSchema, execution: z.record(z.unknown()) }).strict());
const failure = z.object({ data: z.null(), error: z.object({ code: z.string().min(1), message: z.string().min(1), correlationId: idSchema }).strict(), requestId: idSchema }).strict();
const invalid = (): RedeployOutcome => ({ kind: "error", message: "The redeploy response was invalid. Check the same request before starting another.", retryable: true });

export async function runDeploymentRedeploy(attempt: RedeployAttempt, { apiBaseUrl, fetchImpl = fetch }: RedeployOptions): Promise<RedeployOutcome> {
  if (!apiBaseUrl) return { kind: "error", message: "Configure DEPLOYLITE_WEB_API_BASE_URL before redeploying.", retryable: false };
  // Capture identities before the first await; confirmation is retained for same-command retries.
  const { sourceDeploymentId, projectId, snapshotHash, snapshotOriginId, runtimeHost, effectiveImageDigest, idempotencyKey } = attempt;
  let confirmationId = attempt.confirmation.id, commandId = attempt.confirmation.commandId;
  let receivedContext: { requestId?: string; correlationId?: string } = {
    requestId: attempt.confirmation.requestId, correlationId: attempt.confirmation.correlationId
  };
  const url = createAuthApiUrl(metadataApiPaths.deploymentRedeploy(sourceDeploymentId), apiBaseUrl);
  const matchesResult = (r: z.infer<typeof deploymentRedeployCommandResultSchema>) => r.projectId === projectId && r.sourceDeploymentId === sourceDeploymentId && r.snapshotHash === snapshotHash && r.deploymentId !== null && (!commandId || r.commandId === commandId);
  const matchesStored = (c: z.infer<typeof storedCommand>) => c.scope.projectId === projectId && c.scope.deploymentId === sourceDeploymentId && c.idempotencyKey === idempotencyKey && (!commandId || c.id === commandId) && (!c.result || (matchesResult(c.result) && c.result.commandId === c.id && c.result.correlationId === c.correlationId));
  const wait = createDeploymentControlWait();
  const unknown = (message: string): RedeployOutcome => {
    Object.assign(attempt.confirmation, receivedContext, { unresolved: true });
    return { kind: "error", message, retryable: true, ...receivedContext };
  };
  const invalidReply = () => unknown(invalid().message);
  try { for (let step = 0; step < 2; step++) {
    let response: Response, raw: unknown;
    try {
      ({ response, raw } = await wait.read(url, { ...createAuthApiRequest({ method: "POST", body: { snapshotHash } }),
        headers: { "content-type": "application/json", "x-control-idempotency-key": idempotencyKey,
          ...(confirmationId ? { "x-control-confirmation-id": confirmationId } : {}) } }, fetchImpl));
    } catch { return unknown("Redeploy response was not received. Outcome is unresolved. Check the same request before starting another."); }
    try {
      if (response.status === 202) {
        const prepared = preparation.safeParse(raw);
        if (prepared.success && step === 0 && !confirmationId) {
          receivedContext = { requestId: prepared.data.requestId, correlationId: prepared.data.data.correlationId };
          confirmationId = prepared.data.data.confirmationId; commandId = prepared.data.data.commandId;
          Object.assign(attempt.confirmation, receivedContext, { id: confirmationId, commandId }); continue;
        }
        const { data, requestId } = pending.parse(raw), c = data.command, d = data.deployment;
        if (!matchesStored(c) || c.status === "completed" || (c.result && c.result.status !== "eligible") ||
          (d && (d.id !== c.result?.deploymentId || d.projectId !== projectId || d.sourceDeploymentId !== sourceDeploymentId ||
            d.snapshotHash !== snapshotHash || d.snapshotOriginId !== snapshotOriginId || d.agentId !== runtimeHost ||
            !["running", "queued"].includes(d.status) || d.finishedAt !== null || d.executionReceipt))) return invalidReply();
        Object.assign(attempt.confirmation, { requestId, correlationId: c.correlationId, unresolved: true });
        return { kind: "pending", message: "Redeploy is pending. Check the same request or refresh execution evidence.", retryable: true,
          requestId, correlationId: c.correlationId, ...(c.result?.deploymentId ? { deploymentId: c.result.deploymentId } : {}) };
      }
      if (response.status === 200) {
        const repeated = replay.safeParse(raw);
        if (repeated.success) {
          const { data, requestId } = repeated.data, c = data.command;
          if (!matchesStored(c) || c.status !== "completed" || c.result?.status !== "completed" || data.snapshotHash !== snapshotHash || data.deploymentId !== c.result.deploymentId) return invalidReply();
          return { kind: "completed", message: "Stored redeploy command is completed. Open execution evidence for its status.", retryable: false, requestId, correlationId: c.correlationId, deploymentId: data.deploymentId };
        }
        const { data, requestId } = terminal.parse(raw), d = data.deployment, c = data.command;
        const { projectId: executionProject, sourceDeploymentId: executionSource, snapshotHash: executionHash, correlationId: executionCorrelation, ...inner } = data.execution;
        const received = dockerImageExecutionReceiptSchema.parse(inner);
        if (!matchesResult(c) || c.status !== "completed" || d.id !== c.deploymentId || d.id === sourceDeploymentId ||
          d.projectId !== projectId || d.sourceDeploymentId !== sourceDeploymentId || d.snapshotOriginId !== snapshotOriginId || d.snapshotHash !== snapshotHash || d.agentId !== runtimeHost || !d.finishedAt ||
          data.sourceDeploymentId !== sourceDeploymentId || data.snapshotHash !== snapshotHash || executionProject !== projectId || executionSource !== sourceDeploymentId || executionHash !== snapshotHash || executionCorrelation !== c.correlationId ||
          received.deploymentId !== d.id || received.terminalStatus !== d.status || received.candidateId !== d.stopTarget?.candidateId || received.effectiveImage.split("@")[1] !== effectiveImageDigest ||
          JSON.stringify(received.executionReceipt) !== JSON.stringify(d.executionReceipt) ||
          (d.status === "succeeded" && !createRedeployAttempt(d, d.id, idempotencyKey))) return invalidReply();
        return { kind: "completed", message: `Redeploy execution ${d.status}. Open execution evidence.`, retryable: false,
          requestId, correlationId: c.correlationId, deploymentId: d.id };
      }
      const { error, requestId } = failure.parse(raw);
      const denied = response.status === 401 || response.status === 403;
      const confirmationRejected = response.status === 409 && ["CONFIRMATION_REQUIRED", "CONFIRMATION_REJECTED", "CONFIRMATION_EXPIRED", "IDEMPOTENCY_CONFLICT"].includes(error.code);
      const canPrepareNew = response.status === 409 && ["CONFIRMATION_REJECTED", "CONFIRMATION_EXPIRED"].includes(error.code) && !attempt.confirmation.unresolved;
      const retryable = !!attempt.confirmation.unresolved || (!denied && !confirmationRejected && response.status !== 404);
      if (retryable) attempt.confirmation.unresolved = true;
      return { kind: "error", retryable, canPrepareNew,
        message: denied ? `Server denied redeploy authorization. Refresh your session or access.${attempt.confirmation.unresolved ? " The earlier outcome is unresolved; check the same request." : ""}` : confirmationRejected && !attempt.confirmation.unresolved ? "Server rejected this request or its confirmation. Refresh evidence before preparing another request." : "Redeploy is unavailable or unresolved. Check the same request and refresh evidence.", requestId, correlationId: error.correlationId };
    } catch { return invalidReply(); }
  }
  return invalidReply();
  } finally { wait.dispose(); }
}
