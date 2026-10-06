"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import type { CanonicalRole, Deployment } from "@deploylite/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { hasBoundSuccessfulExecution } from "@/lib/deployment-redeploy";
import { createRollbackAttempt, runDeploymentRollback, type RollbackAttempt, type RollbackOutcome } from "@/lib/deployment-rollback";

export type DeploymentRollbackControlProps = { deployment: Deployment; expectedActiveDeploymentId: string; historicalDeployments: Deployment[]; role: CanonicalRole; apiBaseUrl: string | null; fetchImpl?: typeof fetch };
export function DeploymentRollbackControl({ deployment, expectedActiveDeploymentId, historicalDeployments, role, apiBaseUrl, fetchImpl }: DeploymentRollbackControlProps) {
  const router = useRouter(), selectorId = useId(), attempt = useRef<RollbackAttempt | null>(null), submitting = useRef(false);
  const [historicalId, setHistoricalId] = useState(""), [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [outcome, setOutcome] = useState<RollbackOutcome | null>(null);
  if ((role !== "admin" && role !== "operator") || (!attempt.current && !hasBoundSuccessfulExecution(deployment, expectedActiveDeploymentId))) return null;
  const choices = historicalDeployments.filter((H) => createRollbackAttempt(deployment, H, expectedActiveDeploymentId, "visibility") !== null);
  const H = choices.find((candidate) => candidate.id === historicalId);
  const selected = attempt.current ?? (H ? createRollbackAttempt(deployment, H, expectedActiveDeploymentId, "visibility") : null);
  async function submit() {
    if (submitting.current || outcome?.canPrepareNew) return;
    if (!attempt.current && H) attempt.current = createRollbackAttempt(deployment, H, expectedActiveDeploymentId, crypto.randomUUID());
    if (!attempt.current) return;
    submitting.current = true; setBusy(true); setOutcome(null);
    try {
      const result = await runDeploymentRollback(attempt.current, { apiBaseUrl, fetchImpl }); setOutcome(result);
      if (result.kind !== "error") { setOpen(false); router.refresh(); }
    } finally { submitting.current = false; setBusy(false); }
  }
  function prepareNew() {
    if (submitting.current || !outcome?.canPrepareNew || !attempt.current) return;
    attempt.current = Object.freeze({ ...attempt.current, idempotencyKey: crypto.randomUUID(), confirmation: {} });
    setOutcome(null);
  }
  const feedback = outcome ? <Alert variant={outcome.kind === "error" ? "destructive" : "default"} role={outcome.kind === "error" ? "alert" : "status"} aria-live={outcome.kind === "error" ? "assertive" : "polite"} aria-atomic="true">
    <AlertTitle>Rollback request</AlertTitle><AlertDescription>
      <p>{outcome.message}</p>
      {outcome.requestId ? <p className="break-all text-xs">Request: {outcome.requestId} · Correlation: {outcome.correlationId}</p> : null}
      {outcome.deploymentId ? <Link className="underline" href={`/deployments/${encodeURIComponent(outcome.deploymentId)}`}>View execution evidence</Link> : null}
    </AlertDescription>
  </Alert> : null;
  return <div className="flex min-w-0 flex-col gap-3" aria-busy={busy}>
    <label htmlFor={selectorId} className="text-sm font-medium">Historical execution</label>
    <select id={selectorId} value={historicalId} onChange={(event) => setHistoricalId(event.target.value)} disabled={busy || !!attempt.current} className="w-full min-w-0 rounded-md border bg-background p-2 text-sm">
      <option value="">Choose a historical execution</option>
      {choices.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.id}</option>)}
    </select>
    <Dialog open={open} onOpenChange={(value) => { if (!submitting.current) setOpen(value); }}>
      <DialogTrigger render={<Button type="button" variant="outline" disabled={!selected || busy || !apiBaseUrl || outcome?.kind === "completed"}>Rollback to snapshot</Button>} />
      <DialogContent showCloseButton={!busy} aria-busy={busy} className="max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain sm:max-w-md">
        <DialogHeader><DialogTitle>Rollback to selected snapshot?</DialogTitle>
          <DialogDescription>Create a new execution from the chosen historical snapshot. The server checks access, current workload ownership and whether this configuration is supported. Execution history stays unchanged.</DialogDescription>
        </DialogHeader>
        {selected ? <>
          <p className="break-all text-sm">Expected execution: {selected.activeDeploymentId}</p>
          <p className="break-all text-sm">Historical execution: {selected.historicalDeploymentId}</p>
          <p className="break-all font-mono text-xs">{selected.snapshotHash}</p>
        </> : null}
        {busy ? <p role="status" aria-live="polite">Submitting rollback. Wait for the server response.</p> : feedback}
        <DialogFooter className="sm:flex-wrap">
          <DialogClose render={<Button type="button" variant="outline" disabled={busy}>Cancel</Button>} />
          {outcome?.canPrepareNew ? <Button type="button" variant="outline" onClick={prepareNew} disabled={busy}>Prepare new rollback request</Button> : null}
          <Button type="button" onClick={() => void submit()} disabled={!selected || busy || !apiBaseUrl || outcome?.canPrepareNew}>{busy ? "Submitting rollback…" : outcome?.retryable ? "Check same request" : "Confirm rollback"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    {!apiBaseUrl ? <p role="status">Configure the API before requesting rollback.</p> : null}
    {!open ? feedback : null}
    {!open && busy ? <p role="status" aria-live="polite">Checking rollback request. Wait for the server response.</p> : null}
    {!open && outcome?.retryable ? <Button type="button" variant="outline" onClick={() => void submit()} disabled={busy}>Check same request</Button> : null}
  </div>;
}
