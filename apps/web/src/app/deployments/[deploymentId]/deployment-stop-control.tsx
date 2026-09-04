"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { deploymentSchema, deploymentStopAgentReceiptSchema, deploymentStopCommandResultSchema, idSchema, type Deployment, type CanonicalRole } from "@deploylite/contracts";
import { z } from "zod";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { createAuthApiRequest, createAuthApiUrl, metadataApiPaths } from "@/lib/auth-boundary";

export type StopOutcome = { kind: "success" | "pending" | "error"; message: string };
export type StopOptions = { deploymentId: string; apiBaseUrl: string | null; idempotencyKey: string; fetchImpl?: typeof fetch };

const stopCopy = {
  unconfigured: "Configure DEPLOYLITE_WEB_API_BASE_URL before stopping deployments.",
  success: "Stop confirmed by the server. Refreshing deployment evidence.",
  idempotentSuccess: "Stop was already confirmed by the server. Refreshing deployment evidence.",
  pending: "Stop request is already being reconciled. Refresh deployment evidence for the final status.",
  terminal: "This deployment is already terminal. Refresh deployment evidence to reconcile the current status.",
  rejected: "Confirmation was rejected or expired. The deployment status was not changed.",
  idempotency: "This stop attempt conflicts with another request. The deployment status was not changed.",
  malformed: "The stop response was invalid. Refresh deployment evidence before trying again.",
  unavailable: "Deployment stop is unavailable. The deployment status was not changed.",
  unreachable: "The local API is unreachable. The deployment status was not changed.",
  invalid: "The stop response was invalid. Refresh deployment evidence before trying again."
} as const;

const envelope = <Data extends z.ZodTypeAny>(data: Data) => z.object({ data, error: z.null(), requestId: idSchema }).strict();
const prepareEnvelope = envelope(z.object({ commandId: idSchema, confirmationId: idSchema, confirmationRequired: z.literal(true) }).strict());
const pendingEnvelope = envelope(z.object({ commandId: idSchema, pending: z.literal(true) }).strict());
const successEnvelope = envelope(z.object({ deployment: deploymentSchema, receipt: deploymentStopAgentReceiptSchema, command: deploymentStopCommandResultSchema }).strict());
const idempotentSuccessEnvelope = envelope(z.object({
  deployment: deploymentSchema.refine((deployment) => deployment.status === "canceled" && deployment.finishedAt !== null),
  command: deploymentStopCommandResultSchema.refine((command) => command.action === "deployment.stop" && command.status === "completed"),
  idempotent: z.literal(true)
}).strict());
const errorEnvelope = z.object({ data: z.null(), error: z.object({ code: z.string().min(1), message: z.string().min(1), correlationId: idSchema }).strict(), requestId: idSchema }).strict();

function messageForConflict(code: string): string {
  if (code === "DEPLOYMENT_TERMINAL" || code === "DEPLOYMENT_ALREADY_STOPPED") return stopCopy.terminal;
  if (code === "CONFIRMATION_REJECTED" || code === "CONFIRMATION_EXPIRED" || code === "CONFIRMATION_REQUIRED") return stopCopy.rejected;
  if (code === "IDEMPOTENCY_CONFLICT") return stopCopy.idempotency;
  if (code === "COMMAND_PENDING" || code === "DEPLOYMENT_STOP_PENDING") return stopCopy.pending;
  return stopCopy.malformed;
}

function messageForStatus(status: number): string {
  if (status === 401 || status === 403) return "You are not authorized to stop this deployment. The deployment status was not changed.";
  if (status === 503) return stopCopy.unavailable;
  return stopCopy.rejected;
}

export async function runDeploymentStop({ deploymentId, apiBaseUrl, idempotencyKey, fetchImpl = fetch }: StopOptions): Promise<StopOutcome> {
  if (!apiBaseUrl) return { kind: "error", message: stopCopy.unconfigured };
  const url = createAuthApiUrl(metadataApiPaths.deploymentStop(deploymentId), apiBaseUrl);
  const request = (confirmationId?: string) => fetchImpl(url, {
    ...createAuthApiRequest({ method: "POST", body: {} }),
    headers: { "content-type": "application/json", "x-control-idempotency-key": idempotencyKey, ...(confirmationId ? { "x-control-confirmation-id": confirmationId } : {}) }
  });
  let response: Response;
  const parseJson = async () => {
    try { return await response.json(); } catch { throw new Error("invalid stop response"); }
  };
  const readError = async () => errorEnvelope.parse(await parseJson()).error;
  try {
    response = await request();
    if (response.status === 202) {
      const firstPayload = await parseJson();
      const first = prepareEnvelope.safeParse(firstPayload);
      if (first.success) response = await request(first.data.data.confirmationId);
      else {
        const pending = pendingEnvelope.safeParse(firstPayload);
        if (pending.success) return { kind: "pending", message: stopCopy.pending };
        return { kind: "error", message: stopCopy.malformed };
      }
    }
  } catch {
    return { kind: "error", message: stopCopy.malformed };
  }
  if (response.status === 202) {
    try {
      return pendingEnvelope.parse(await parseJson()).data.pending
        ? { kind: "pending", message: stopCopy.pending }
        : { kind: "error", message: stopCopy.malformed };
    } catch { return { kind: "error", message: stopCopy.malformed }; }
  }
  if (response.ok) {
    try {
      const payload = await parseJson();
      const replay = idempotentSuccessEnvelope.safeParse(payload);
      if (replay.success) return { kind: "success", message: stopCopy.idempotentSuccess };
      const result = successEnvelope.parse(payload).data;
      return { kind: "success", message: result.receipt.status === "already-stopped" ? "The deployment was already stopped. Refreshing deployment evidence." : stopCopy.success };
    } catch { return { kind: "error", message: stopCopy.malformed }; }
  }
  if (response.status === 409) {
    try { return { kind: "error", message: messageForConflict((await readError()).code) }; }
    catch { return { kind: "error", message: stopCopy.malformed }; }
  }
  return { kind: "error", message: messageForStatus(response.status) };
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
