"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { deploymentSchema, deploymentStopAgentReceiptSchema, deploymentStopCommandResultSchema, idSchema, type Deployment, type CanonicalRole } from "@deploylite/contracts";
import { z } from "zod";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { createAuthApiRequest, createAuthApiUrl, metadataApiPaths } from "@/lib/auth-boundary";
import { createDeploymentControlWait, hasBoundSuccessfulExecution, type DeploymentControlAttemptContext } from "@/lib/deployment-redeploy";

export type StopOutcome = { kind: "success" | "pending" | "error"; message: string; retryable?: boolean; canPrepareNew?: boolean; requestId?: string; correlationId?: string };
export type StopOptions = { deploymentId: string; apiBaseUrl: string | null; idempotencyKey: string; confirmation?: DeploymentControlAttemptContext; expectedDeployment?: Deployment; fetchImpl?: typeof fetch };

const stopCopy = {
  unconfigured: "Configure DEPLOYLITE_WEB_API_BASE_URL before stopping deployments.",
  success: "Stop confirmed by the server. Refreshing deployment evidence.",
  idempotentSuccess: "Stop was already confirmed by the server. Refreshing deployment evidence.",
  pending: "Stop request is pending. Refresh deployment evidence for the final status.",
  terminal: "This deployment is already terminal. Refresh deployment evidence to reconcile the current status.",
  rejected: "Confirmation was rejected or expired. Refresh deployment evidence before preparing another request.",
  idempotency: "This stop attempt conflicts with another request. Refresh deployment evidence.",
  malformed: "The stop response was invalid. Check the same request and refresh deployment evidence.",
  unavailable: "Deployment stop is unavailable. Outcome is unresolved. Check the same request and refresh deployment evidence.",
  unresolved: "Stop outcome is unresolved. Check the same request and refresh deployment evidence."
} as const;

const envelope = <Data extends z.ZodTypeAny>(data: Data) => z.object({ data, error: z.null(), requestId: idSchema }).strict();
const prepareEnvelope = envelope(z.object({ commandId: idSchema, confirmationId: idSchema, confirmationRequired: z.literal(true) }).strict());
const pendingEnvelope = envelope(z.object({ commandId: idSchema, pending: z.literal(true) }).strict());
const successEnvelope = envelope(z.object({ deployment: deploymentSchema, receipt: deploymentStopAgentReceiptSchema, command: deploymentStopCommandResultSchema }).strict());
const storedCommand = z.object({ id: idSchema, action: z.literal("deployment.stop"), scope: z.object({ kind: z.literal("deployment"), projectId: idSchema, deploymentId: idSchema }).strict(),
  idempotencyKey: z.string().min(1).max(200), status: z.literal("completed"), correlationId: idSchema, result: deploymentStopCommandResultSchema });
const replayEnvelope = envelope(z.object({ deployment: deploymentSchema, command: z.union([storedCommand, deploymentStopCommandResultSchema]), idempotent: z.literal(true) }).strict());
const pendingCommand = storedCommand.omit({ result: true }).extend({ status: z.enum(["eligible", "dispatching"]) });
const storedPendingEnvelope = envelope(z.object({ command: pendingCommand, pending: z.literal(true) }).strict());
const commandReplayEnvelope = envelope(z.object({ command: storedCommand, idempotent: z.literal(true) }).strict());
const errorEnvelope = z.object({ data: z.null(), error: z.object({ code: z.string().min(1), message: z.string().min(1), correlationId: idSchema }).strict(), requestId: idSchema }).strict();

function messageForConflict(code: string): string {
  if (code === "DEPLOYMENT_TERMINAL" || code === "DEPLOYMENT_ALREADY_STOPPED") return stopCopy.terminal;
  if (["CONFIRMATION_REJECTED", "CONFIRMATION_EXPIRED", "CONFIRMATION_REQUIRED"].includes(code)) return stopCopy.rejected;
  if (code === "IDEMPOTENCY_CONFLICT") return stopCopy.idempotency;
  if (code === "COMMAND_PENDING" || code === "DEPLOYMENT_STOP_PENDING") return stopCopy.pending;
  return stopCopy.unresolved;
}

export async function runDeploymentStop({ deploymentId, apiBaseUrl, idempotencyKey, confirmation = {}, expectedDeployment, fetchImpl = fetch }: StopOptions): Promise<StopOutcome> {
  if (!apiBaseUrl) return { kind: "error", message: stopCopy.unconfigured, retryable: false };
  const expected = expectedDeployment ? deploymentSchema.safeParse(expectedDeployment) : null;
  if (expected && !expected.success) return { kind: "error", message: stopCopy.malformed, retryable: false };
  const selected = expected?.success ? expected.data : undefined;
  const url = createAuthApiUrl(metadataApiPaths.deploymentStop(deploymentId), apiBaseUrl);
  let confirmationId = confirmation.id, commandId = confirmation.commandId;
  let receivedContext: { requestId?: string; correlationId?: string } = { requestId: confirmation.requestId, correlationId: confirmation.correlationId };
  const deploymentMatches = (d: Deployment) => d.id === deploymentId && (!selected || (d.projectId === selected.projectId && d.agentId === selected.agentId &&
    (selected.status !== "succeeded" || (d.status === "succeeded" && d.finishedAt === selected.finishedAt && JSON.stringify(d.executionReceipt) === JSON.stringify(selected.executionReceipt)))));
  const resultMatches = (c: z.infer<typeof deploymentStopCommandResultSchema>, d: Pick<Deployment, "projectId">) => c.action === "deployment.stop" && c.status === "completed" && c.deploymentId === deploymentId && c.projectId === d.projectId && (!commandId || c.commandId === commandId);
  const storedMatches = (c: Omit<z.infer<typeof pendingCommand>, "status">) => c.scope.deploymentId === deploymentId && c.idempotencyKey === idempotencyKey &&
    (!commandId || c.id === commandId) && (!selected || (selected.id === deploymentId && c.scope.projectId === selected.projectId));
  const wait = createDeploymentControlWait();
  const unknown = (message: string = stopCopy.unresolved): StopOutcome => {
    Object.assign(confirmation, receivedContext, { unresolved: true });
    return { kind: "error", message, retryable: true, ...receivedContext };
  };
  try { for (let step = 0; step < 2; step++) {
    let response: Response, raw: unknown;
    try { ({ response, raw } = await wait.read(url, { ...createAuthApiRequest({ method: "POST", body: {} }), headers: {
      "content-type": "application/json", "x-control-idempotency-key": idempotencyKey, ...(confirmationId ? { "x-control-confirmation-id": confirmationId } : {}) } }, fetchImpl)); }
    catch { return unknown(); }
    if (response.status === 401 || response.status === 403) {
      const denied = errorEnvelope.safeParse(raw);
      return { kind: "error", message: `You are not authorized to stop this deployment. Refresh your session or access.${confirmation.unresolved ? " The earlier outcome is unresolved; check the same request." : ""}`, retryable: !!confirmation.unresolved,
        ...(denied.success ? { requestId: denied.data.requestId, correlationId: denied.data.error.correlationId } : receivedContext) };
    }
    if (response.status >= 500) {
      const error = errorEnvelope.safeParse(raw);
      if (error.success) receivedContext = { requestId: error.data.requestId, correlationId: error.data.error.correlationId };
      return unknown(response.status === 503 ? stopCopy.unavailable : stopCopy.unresolved);
    }
    try {
      if (response.status === 202) {
        const prepared = prepareEnvelope.safeParse(raw);
        if (prepared.success && step === 0 && !confirmationId) {
          confirmationId = prepared.data.data.confirmationId; commandId = prepared.data.data.commandId;
          receivedContext = { requestId: prepared.data.requestId };
          Object.assign(confirmation, receivedContext, { id: confirmationId, commandId }); continue;
        }
        const stored = storedPendingEnvelope.safeParse(raw);
        if (stored.success) {
          const c = stored.data.data.command;
          if (!storedMatches(c)) throw new Error("stop pending identity mismatch");
          commandId = c.id; receivedContext = { requestId: stored.data.requestId, correlationId: c.correlationId };
          Object.assign(confirmation, receivedContext, { commandId, unresolved: true });
          return { kind: "pending", message: stopCopy.pending, retryable: true, ...receivedContext };
        }
        const value = pendingEnvelope.parse(raw);
        if (commandId && value.data.commandId !== commandId) throw new Error("stop command mismatch");
        Object.assign(confirmation, { requestId: value.requestId, unresolved: true });
        return { kind: "pending", message: stopCopy.pending, retryable: true, requestId: value.requestId };
      }
      if (response.status === 200) {
        const stored = commandReplayEnvelope.safeParse(raw);
        if (stored.success) {
          const c = stored.data.data.command, result = c.result;
          if (!storedMatches(c) || result.projectId !== c.scope.projectId || !resultMatches(result, { projectId: c.scope.projectId }) ||
            c.id !== result.commandId || c.correlationId !== result.correlationId || !["stopped", "already-stopped"].includes(result.reason ?? "")) throw new Error("stop replay identity mismatch");
          return { kind: "success", message: stopCopy.idempotentSuccess, retryable: false, requestId: stored.data.requestId, correlationId: c.correlationId };
        }
        const replay = replayEnvelope.safeParse(raw);
        if (replay.success) {
          const { deployment: d, command: c } = replay.data.data, result = "result" in c ? c.result : c;
          if (!deploymentMatches(d) || !resultMatches(result, d) || !d.finishedAt ||
            ("result" in c && (c.scope.projectId !== d.projectId || c.scope.deploymentId !== deploymentId || c.idempotencyKey !== idempotencyKey || c.id !== result.commandId || c.correlationId !== result.correlationId || !["stopped", "already-stopped"].includes(result.reason ?? ""))) ||
            (d.status === "succeeded" ? !("result" in c) || !hasBoundSuccessfulExecution(d, deploymentId) : d.status !== "canceled")) throw new Error("stop replay mismatch");
          return { kind: "success", message: stopCopy.idempotentSuccess, retryable: false, requestId: replay.data.requestId, correlationId: result.correlationId };
        }
        const { data, requestId } = successEnvelope.parse(raw), d = data.deployment, r = data.receipt, c = data.command;
        if (!deploymentMatches(d) || !resultMatches(c, d) || !["stopped", "already-stopped"].includes(r.status) ||
          r.commandId !== c.commandId || r.deploymentId !== deploymentId || r.projectId !== d.projectId || r.agentId !== d.agentId ||
          r.candidateId !== d.stopTarget?.candidateId || r.effectiveImage !== d.stopTarget?.effectiveImage ||
          (d.status === "succeeded" ? !hasBoundSuccessfulExecution(d, deploymentId) || r.containerId !== d.executionReceipt?.containerId : d.status !== "canceled")) throw new Error("stop identity mismatch");
        return { kind: "success", message: r.status === "already-stopped" ? "The deployment was already stopped. Refreshing deployment evidence." : stopCopy.success, retryable: false, requestId, correlationId: r.correlationId };
      }
      if (response.status === 409) {
        const error = errorEnvelope.parse(raw); const message = messageForConflict(error.error.code);
        const canPrepareNew = ["CONFIRMATION_REJECTED", "CONFIRMATION_EXPIRED"].includes(error.error.code) && !confirmation.unresolved;
        const retryable = !!confirmation.unresolved || message === stopCopy.pending || message === stopCopy.unresolved;
        const display = confirmation.unresolved && message !== stopCopy.pending && message !== stopCopy.unresolved ? stopCopy.unresolved : message;
        if (retryable) confirmation.unresolved = true;
        return { kind: "error", message: display, retryable, canPrepareNew, requestId: error.requestId, correlationId: error.error.correlationId };
      }
      return confirmation.unresolved ? unknown() : { kind: "error", message: stopCopy.rejected, retryable: false };
    } catch { return unknown(stopCopy.malformed); }
  }
  return unknown(stopCopy.malformed);
  } finally { wait.dispose(); }
}

function attemptId(): string {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `stop-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function DeploymentStopControl({ deployment, role, apiBaseUrl, fetchImpl }: { deployment: Deployment; role: CanonicalRole; apiBaseUrl: string | null; fetchImpl?: typeof fetch }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const eligible = deployment.status === "running" && (role === "admin" || role === "operator");
  if (!eligible) return null;

  async function onConfirm() {
    if (pending) return;
    setPending(true);
    setMessage(null);
    const outcome = await runDeploymentStop({ deploymentId: deployment.id, apiBaseUrl, idempotencyKey: attemptId(), fetchImpl });
    setPending(false);
    setMessage(outcome.message);
    if (outcome.kind === "success" || outcome.kind === "pending" || outcome.message === stopCopy.terminal) {
      setOpen(false);
      router.refresh();
    }
  }

  return <div className="flex flex-col gap-3" data-testid="deployment-stop-control">
    <Dialog open={open} onOpenChange={(next) => { if (!pending) setOpen(next); }}>
      <DialogTrigger render={<Button type="button" variant="outline" className="border-destructive/40 text-destructive hover:bg-destructive/10" data-testid="deployment-stop-trigger">Stop deployment</Button>} />
      <DialogContent aria-busy={pending} className="max-h-[calc(100dvh-2rem)] overscroll-contain overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Stop deployment?</DialogTitle>
          <DialogDescription>This requests an authenticated stop for deployment {deployment.id}. The status changes only after the server confirms stop evidence.</DialogDescription>
        </DialogHeader>
        {pending ? <p role="status" aria-live="polite">Stopping deployment. The action is disabled until the server responds.</p> : null}
        <DialogFooter className="sm:flex-row">
          <DialogClose render={<Button className="w-full sm:w-auto" type="button" variant="outline" disabled={pending}>Cancel</Button>} />
          <Button className="w-full sm:w-auto" type="button" variant="destructive" onClick={() => void onConfirm()} disabled={pending} data-testid="deployment-stop-confirm">{pending ? "Stopping deployment…" : "Confirm stop deployment"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    {message ? <Alert variant={message === stopCopy.success || message.startsWith("The deployment was already stopped") || message === stopCopy.pending ? "default" : "destructive"} role="status" aria-live="polite" aria-atomic="true" data-testid="deployment-stop-result"><AlertTitle>{message === stopCopy.success || message.startsWith("The deployment was already stopped") ? "Deployment stop" : "Deployment stop not completed"}</AlertTitle><AlertDescription>{message}</AlertDescription></Alert> : null}
  </div>;
}
