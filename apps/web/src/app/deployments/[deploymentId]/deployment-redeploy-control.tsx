"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { CanonicalRole, Deployment } from "@deploylite/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { createRedeployAttempt, runDeploymentRedeploy, type RedeployAttempt, type RedeployOutcome } from "@/lib/deployment-redeploy";

export type DeploymentRedeployControlProps = { deployment: Deployment; expectedSourceDeploymentId: string; role: CanonicalRole; apiBaseUrl: string | null; fetchImpl?: typeof fetch };
export function DeploymentRedeployControl({ deployment, expectedSourceDeploymentId, role, apiBaseUrl, fetchImpl }: DeploymentRedeployControlProps) {
  const router = useRouter(), attempt = useRef<RedeployAttempt | null>(null), submitting = useRef(false);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [outcome, setOutcome] = useState<RedeployOutcome | null>(null);
  const eligible = createRedeployAttempt(deployment, expectedSourceDeploymentId, "visibility");
  if (!eligible || (role !== "admin" && role !== "operator")) return null;
  const selected = attempt.current ?? eligible;
  async function submit() {
    if (submitting.current || outcome?.canPrepareNew) return;
    attempt.current ??= createRedeployAttempt(deployment, expectedSourceDeploymentId, crypto.randomUUID());
    if (!attempt.current) return;
    submitting.current = true; setBusy(true); setOutcome(null);
    try {
      const result = await runDeploymentRedeploy(attempt.current, { apiBaseUrl, fetchImpl }); setOutcome(result);
      if (result.kind !== "error") { setOpen(false); router.refresh(); }
    } finally { submitting.current = false; setBusy(false); }
  }
  function prepareNew() {
    if (submitting.current || !outcome?.canPrepareNew || !attempt.current) return;
    attempt.current = Object.freeze({ ...attempt.current, idempotencyKey: crypto.randomUUID(), confirmation: {} });
    setOutcome(null);
  }
  const feedback = outcome ? <Alert variant={outcome.kind === "error" ? "destructive" : "default"} role={outcome.kind === "error" ? "alert" : "status"} aria-live={outcome.kind === "error" ? "assertive" : "polite"} aria-atomic="true">
    <AlertTitle>Redeploy request</AlertTitle><AlertDescription>
      <p>{outcome.message}</p>
      {outcome.requestId ? <p className="break-all text-xs">Request: {outcome.requestId} · Correlation: {outcome.correlationId}</p> : null}
      {outcome.deploymentId ? <Link className="underline" href={`/deployments/${encodeURIComponent(outcome.deploymentId)}`}>View execution evidence</Link> : null}
    </AlertDescription>
  </Alert> : null;
  return <div className="flex min-w-0 flex-col gap-3" aria-busy={busy}>
    <Dialog open={open} onOpenChange={(value) => { if (!submitting.current) setOpen(value); }}>
      <DialogTrigger render={<Button type="button" variant="outline" disabled={busy || !apiBaseUrl || outcome?.kind === "completed"}>Redeploy snapshot</Button>} />
      <DialogContent showCloseButton={!busy} aria-busy={busy} className="max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain sm:max-w-md">
        <DialogHeader><DialogTitle>Redeploy snapshot?</DialogTitle>
          <DialogDescription>Create a new execution from this immutable snapshot. The server checks authorization and whether the source still owns the workload.</DialogDescription>
        </DialogHeader>
        <p className="break-all text-sm">Source execution: {selected.sourceDeploymentId}</p>
        <p className="break-all font-mono text-xs">{selected.snapshotHash}</p>
        {busy ? <p role="status" aria-live="polite">Submitting redeploy. Wait for the server response.</p> : feedback}
        <DialogFooter className="sm:flex-wrap">
          <DialogClose render={<Button type="button" variant="outline" disabled={busy}>Cancel</Button>} />
          {outcome?.canPrepareNew ? <Button type="button" variant="outline" onClick={prepareNew} disabled={busy}>Prepare new redeploy request</Button> : null}
          <Button type="button" onClick={() => void submit()} disabled={busy || !apiBaseUrl || outcome?.canPrepareNew}>{busy ? "Submitting redeploy…" : outcome?.retryable ? "Check same request" : "Confirm redeploy"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    {!apiBaseUrl ? <p role="status">Configure the API before redeploying.</p> : null}
    {!open ? feedback : null}
    {!open && busy ? <p role="status" aria-live="polite">Checking redeploy request. Wait for the server response.</p> : null}
    {!open && outcome?.retryable ? <Button type="button" variant="outline" onClick={() => void submit()} disabled={busy}>Check same request</Button> : null}
  </div>;
}
