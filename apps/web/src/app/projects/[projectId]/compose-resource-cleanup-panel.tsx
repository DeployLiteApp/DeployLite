"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { ComposePreviewV1, ComposeResourceCleanupInput, ComposeResourceCleanupReceiptV1, ComposeResourceInspectionViewV1, ComposeResourceKind } from "@deploylite/contracts";
import { Button } from "@/components/ui/button";
import { confirmProjectComposeCleanup, previewProjectComposeCleanup } from "./compose-resource-cleanup-client";

type Resource = Readonly<{ kind: ComposeResourceKind; key: string; runtimeName: string }>;
type Intent = Readonly<{ input: ComposeResourceCleanupInput; idempotencyKey: string }>;
type Mode = "preview" | "confirm";
type Failure = Readonly<{ mode: Mode; message: string; recoverable: boolean; stale: boolean }>;

export function ComposeResourceCleanupPanel({ projectId, apiBaseUrl, document, preview, resource, inspection, onLockChange }:
  Readonly<{ projectId: string; apiBaseUrl: string | null; document: string; preview: ComposePreviewV1; resource: Resource; inspection: ComposeResourceInspectionViewV1 | null; onLockChange(locked: boolean): void }>) {
  const id = useId(), request = useRef<AbortController | null>(null), pendingMode = useRef<Mode | null>(null), lastObservation = useRef<ComposeResourceInspectionViewV1 | null>(null);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [receipt, setReceipt] = useState<ComposeResourceCleanupReceiptV1 | null>(null);
  const [pending, setPending] = useState<Mode | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [notice, setNotice] = useState("");
  const attached = inspection?.containers.some(container => container.attached) ?? false;
  const stale = failure?.stale ?? false;

  useEffect(() => {
    if (!inspection) return;
    if (lastObservation.current && lastObservation.current !== inspection) {
      request.current?.abort(); request.current = null; pendingMode.current = null;
      setIntent(null); setReceipt(null); setPending(null); setFailure(null);
      setNotice("A fresh resource observation replaced this cleanup review. Review the exact target again.");
      onLockChange(false);
    }
    lastObservation.current = inspection;
  }, [inspection, onLockChange]);

  useEffect(() => () => { request.current?.abort(); request.current = null; pendingMode.current = null; onLockChange(false); }, [onLockChange]);

  async function previewExact(next: Intent) {
    if (request.current) return;
    const controller = new AbortController(); request.current = controller; pendingMode.current = "preview";
    setPending("preview"); setFailure(null); setNotice("");
    const result = await previewProjectComposeCleanup({ ...next.input, apiBaseUrl, idempotencyKey: next.idempotencyKey, signal: controller.signal });
    if (request.current !== controller) return;
    request.current = null; pendingMode.current = null; setPending(null);
    if (result.kind === "ready") {
      setReceipt(result.receipt);
      setNotice(result.receipt.status === "eligible" ? "Admission is already recorded. No physical cleanup was performed." : "Review this exact target and confirm only if you want to record its cleanup admission.");
      if (result.receipt.status === "eligible") onLockChange(false);
    } else setFailure({ mode: "preview", message: result.message, recoverable: result.recoverable, stale: result.stale });
  }

  async function confirmExact(current: Intent, currentReceipt: ComposeResourceCleanupReceiptV1) {
    if (request.current || currentReceipt.status !== "pending_confirmation") return;
    const controller = new AbortController(); request.current = controller; pendingMode.current = "confirm";
    setPending("confirm"); setFailure(null); setNotice("");
    const result = await confirmProjectComposeCleanup({ ...current.input, apiBaseUrl, idempotencyKey: current.idempotencyKey,
      commandId: currentReceipt.commandId, confirmationId: currentReceipt.confirmationId, signal: controller.signal });
    if (request.current !== controller) return;
    request.current = null; pendingMode.current = null; setPending(null);
    if (result.kind === "ready") {
      setReceipt(result.receipt);
      setNotice("Cleanup admission is recorded. No network or volume was removed.");
      onLockChange(false);
    } else setFailure({ mode: "confirm", message: result.message, recoverable: result.recoverable, stale: result.stale });
  }

  function startPreview() {
    if (!inspection || attached || pending || !apiBaseUrl || stale) return;
    const next: Intent = { input: { document, projectId, kind: resource.kind, key: resource.key,
      expectedConfigDigest: preview.configDigest, expectedStateDigest: inspection.stateDigest }, idempotencyKey: globalThis.crypto.randomUUID() };
    onLockChange(true);
    setIntent(next); setReceipt(null); setFailure(null); setNotice(""); void previewExact(next);
  }

  function retryExact() {
    if (pending || !failure?.recoverable || !intent) return;
    if (failure.mode === "preview") void previewExact(intent);
    else if (receipt) void confirmExact(intent, receipt);
  }

  function stopWaiting() {
    const mode = pendingMode.current;
    if (!mode) return;
    request.current?.abort(); request.current = null; pendingMode.current = null; setPending(null);
    setFailure({ mode, message: "The browser stopped waiting. The server may have saved this exact request; recover it before starting another preview.", recoverable: true, stale: false });
  }

  function dismissLocalState() {
    const wasPending = pending !== null, hadReceipt = receipt !== null, wasAdmitted = receipt?.status === "eligible";
    request.current?.abort(); request.current = null; pendingMode.current = null;
    setPending(null); setIntent(null); setReceipt(null); setFailure(null); setStaleNotice(wasPending, hadReceipt, wasAdmitted);
    onLockChange(false);
  }

  function setStaleNotice(wasPending: boolean, hadReceipt: boolean, wasAdmitted: boolean) {
    if (wasAdmitted) setNotice("The admission receipt was dismissed from this page. It remains recorded; no resource was removed.");
    else if (wasPending || failure?.mode === "confirm" || hadReceipt) setNotice("The local review was dismissed. A server-side admission may still be pending or recorded; this button does not remove resources.");
    else setNotice("The local request was dismissed. If the preview response was lost, the server may retain an unused confirmation until it expires; no resource was removed.");
  }

  const blocked = !inspection || attached || pending !== null || !apiBaseUrl || stale;
  const canConfirm = !!intent && receipt?.status === "pending_confirmation" && !pending && !failure && !stale;
  const target = `${resource.kind}: ${resource.key}`;
  return <section aria-labelledby={`${id}-heading`} className="flex flex-col gap-3 text-sm">
    <h4 id={`${id}-heading`} className="font-medium">Confirmed cleanup admission</h4>
    <p className="text-muted-foreground">This reviews one observed network or volume and records confirmation only. It never removes a resource.</p>
    <dl className="grid gap-1 sm:grid-cols-[10rem_1fr]">
      <dt>Exact target</dt><dd>{target}</dd>
      <dt>Planned runtime name</dt><dd className="break-all font-mono text-xs">{resource.runtimeName}</dd>
      {inspection ? <><dt>Observed state digest</dt><dd className="break-all font-mono text-xs">{inspection.stateDigest}</dd></> : null}
    </dl>
    {attached ? <p className="text-muted-foreground">This resource is attached to an observed container. Inspect again after it is detached.</p> : null}
    {stale ? <p className="text-muted-foreground">The resource state changed. Inspect it again before continuing.</p> : null}
    <div className="flex flex-wrap gap-2">
      {!receipt || failure?.mode === "preview" ? <Button type="button" variant="outline" disabled={blocked || !!intent && !failure?.recoverable}
        onClick={failure?.mode === "preview" ? retryExact : startPreview}>{pending === "preview" ? "Reviewing cleanup target..." : failure?.mode === "preview" && failure.recoverable ? "Retry exact preview" : "Preview cleanup admission"}</Button> : null}
      {canConfirm ? <Button type="button" disabled={blocked} onClick={() => void confirmExact(intent!, receipt!)}>
        Confirm exact admission
      </Button> : null}
      {failure?.mode === "confirm" && failure.recoverable ? <Button type="button" variant="outline" disabled={!!pending} onClick={retryExact}>
        Recover exact confirmation
      </Button> : null}
      {pending ? <Button type="button" variant="outline" onClick={stopWaiting}>Stop waiting</Button> : null}
      {!pending && (receipt?.status === "pending_confirmation" || failure || receipt?.status === "eligible") ? <Button type="button" variant="outline" onClick={dismissLocalState}>
        {failure?.mode === "confirm" ? "Dismiss local state" : receipt?.status === "eligible" ? "Dismiss receipt" : "Cancel confirmation"}
      </Button> : null}
    </div>
    <p role={failure ? "alert" : "status"} aria-live="polite" className={failure ? "text-destructive" : "text-muted-foreground"}>
      {(failure?.message ?? notice) || (pending === "preview" ? "Checking the exact target and saving a pending confirmation..."
        : pending === "confirm" ? "Recording this confirmation. No physical cleanup is requested."
        : receipt?.status === "pending_confirmation" ? `Confirmation required for ${target}; it expires at ${new Date(receipt.expiresAt).toLocaleString()}. No resource was removed.`
        : receipt?.status === "eligible" ? "Admission recorded. No physical cleanup was performed."
        : !apiBaseUrl ? "Cleanup admission is unavailable until the project API is configured."
        : !inspection ? "Inspect this resource before previewing its cleanup admission."
        : attached ? "Attached resources cannot be admitted for cleanup."
        : "Preview and confirmation only. No resource is removed.")}
    </p>
  </section>;
}
