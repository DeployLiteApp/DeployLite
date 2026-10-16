"use client";
import {useEffect, useId, useRef, useState} from "react";
import {previewManagedDatabaseRetention, type ManagedDatabaseRetentionPlan} from "@/lib/managed-database-retention";
import {Button} from "@/components/ui/button";
export type RetentionPreviewPanelProps = {projectId: string; databaseId: string; destinationId: string; sourceIdentity: string;
  actorId: string; apiBaseUrl: string; disabled?: boolean};
/** Source/count-scoped local state only; render, reload and selection never send a preview request. */
export function ManagedDatabaseRetentionPreviewPanel({projectId, databaseId, destinationId, sourceIdentity, actorId, apiBaseUrl, disabled}: RetentionPreviewPanelProps) {
  const hintId = useId();
  const scope = JSON.stringify([projectId, databaseId, destinationId, sourceIdentity, actorId, apiBaseUrl]);
  const [count, setCount] = useState("");
  const key = JSON.stringify([scope, count]), current = useRef(key); current.current = key;
  const active = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [result, setResult] = useState<{key: string; plan: ManagedDatabaseRetentionPlan} | null>(null);
  const keepNewest = Number(count), valid = /^\d+$/.test(count) && Number.isSafeInteger(keepNewest) && keepNewest >= 1 && keepNewest <= 10000;
  useEffect(() => {
    setCount(""); setResult(null); setMessage(""); setBusy(false);
    return () => {active.current?.abort(); active.current = null;};
  }, [scope]);
  function change(value: string) {
    active.current?.abort(); active.current = null; setBusy(false); setResult(null); setMessage(""); setCount(value);
  }
  async function preview() {
    if (active.current || disabled || !valid || !destinationId) return;
    const controller = new AbortController(); active.current = controller; setBusy(true); setMessage(""); setResult(null);
    try {
      const value = await previewManagedDatabaseRetention({projectId, databaseId}, {apiBaseUrl, actorId, signal: controller.signal},
        {schemaVersion: 1, volumeKey: "db-" + databaseId, destinationId, keepNewest});
      if (controller.signal.aborted || current.current !== key) return;
      if (value.kind !== "ready" || value.plan.executionAllowed !== false || value.plan.projectId !== projectId || value.plan.volumeKey !== "db-" + databaseId
        || value.plan.destinationId !== destinationId || value.plan.keepNewest !== keepNewest) {setMessage("Retention preview is unavailable."); return;}
      setResult({key, plan: value.plan});
    } catch {if (!controller.signal.aborted && current.current === key) setMessage("Retention preview is unavailable.");}
    finally {if (active.current === controller) {active.current = null; setBusy(false);}}
  }
  const plan = result?.key === key ? result.plan : null;
  return <section aria-label="Count retention preview" className="space-y-2" aria-busy={busy}>
    <h4>Count retention preview</h4>
    <p>Preview only. No deletion is performed.</p>
    <p id={hintId}>Choose an integer from 1 to 10,000. Protected backups are also retained.</p>
    <label>Keep newest backups <input aria-describedby={hintId} aria-label="Keep newest backups" inputMode="numeric" value={count} onChange={event => change(event.target.value)} /></label>
    <Button variant="outline" disabled={disabled || busy || !valid || !destinationId} onClick={() => void preview()}>Preview retention</Button>
    {busy ? <p role="status">Loading retention preview…</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {plan ? <p role="status">Retained: {plan.retainedArchiveIds.length} · Protected: {plan.protectedArchiveIds.length} · Candidates: {plan.deletionCandidates.length}</p> : null}
  </section>;
}
