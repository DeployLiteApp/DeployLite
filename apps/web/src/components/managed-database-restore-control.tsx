"use client";
import {useEffect, useRef, useState} from "react";
import {z} from "zod";
import {managedDatabaseRestoreSelectionSchema, managedDatabaseRestoreReceiptSchema} from "@deploylite/contracts";
import {prepareManagedDatabaseRestore, applyManagedDatabaseRestore, preparedManagedDatabaseRestoreSchema} from "@/lib/managed-database-restore";
import {Dialog, DialogContent, DialogTitle, DialogDescription} from "@/components/ui/dialog";
import {Button} from "@/components/ui/button";
type Props = {selection: z.infer<typeof managedDatabaseRestoreSelectionSchema>; apiBaseUrl: string; actorId: string;
  currentState: "running" | "stopped" | null; disabled?: boolean; onRestored?(): void; onBusyChange?(busy: boolean): void};
const identity = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const journalSchema = z.object({key: identity, selection: managedDatabaseRestoreSelectionSchema,
  prepared: preparedManagedDatabaseRestoreSchema.nullable(), uncertainApply: z.boolean(), confirmedReceipt: managedDatabaseRestoreReceiptSchema.nullable()}).strict();
type Attempt = z.infer<typeof journalSchema>;
/** Public original retry state is saved before either request; only explicit confirmation can apply. */
export function ManagedDatabaseRestoreControl({selection, apiBaseUrl, actorId, currentState, disabled, onRestored, onBusyChange}: Props) {
  const scope = JSON.stringify([apiBaseUrl, actorId, selection]), slot = "deploylite.native-restore:" + scope;
  const current = useRef(scope); current.current = scope;
  const callbacks = useRef({onRestored, onBusyChange}); callbacks.current = {onRestored, onBusyChange};
  const active = useRef<AbortController | null>(null), original = useRef<Attempt | null>(null);
  const [loadedScope, setLoadedScope] = useState(""), [opened, setOpened] = useState(false), [blocked, setBlocked] = useState(false);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [, setRevision] = useState(0);
  useEffect(() => {
    original.current = null; setOpened(false); setBusy(false); setBlocked(false); setMessage("");
    try {
      identity.parse(actorId); const source = managedDatabaseRestoreSelectionSchema.parse(selection), raw = sessionStorage.getItem(slot);
      if (raw !== null) {
        if (raw.length > 131072) throw new Error("unavailable");
        const saved = journalSchema.parse(JSON.parse(raw)), prepared = saved.prepared;
        if (JSON.stringify(saved.selection) !== JSON.stringify(source) || (saved.uncertainApply && !prepared)
          || (prepared && (JSON.stringify(prepared.selection) !== JSON.stringify(source) || prepared.idempotencyKey !== saved.key
            || prepared.command.idempotencyKey !== saved.key || prepared.command.scope.projectId !== source.projectId
            || Date.parse(prepared.confirmation.expiresAt) > Date.parse(prepared.command.expiresAt)))) throw new Error("unavailable");
        original.current = saved;
      }
    } catch {setBlocked(true); setMessage("The original restore request could not be recovered.");}
    setLoadedScope(scope);
    return () => {active.current?.abort(); active.current = null; callbacks.current.onBusyChange?.(false);};
  }, [scope, slot, actorId]);
  const attempt = loadedScope === scope ? original.current : null;
  const stateAllowsRestore = selection.engine === "redis" ? currentState !== null : currentState === "running";
  const expired = attempt?.prepared && !attempt.uncertainApply && Date.parse(attempt.prepared.confirmation.expiresAt) <= Date.now();
  useEffect(() => {
    if (!opened || !attempt?.prepared || attempt.uncertainApply) return;
    const remaining = Date.parse(attempt.prepared.confirmation.expiresAt) - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => setRevision(value => value + 1), Math.min(remaining, 60000)); return () => clearTimeout(timer);
  }, [opened, attempt?.prepared, attempt?.uncertainApply]);
  function persist(value: Attempt) {
    const raw = JSON.stringify(journalSchema.parse(value)); sessionStorage.setItem(slot, raw);
    if (sessionStorage.getItem(slot) !== raw) throw new Error("unavailable"); original.current = value; setRevision(value => value + 1);
  }
  function finish(controller: AbortController) {if (active.current === controller) {active.current = null; setBusy(false);}}
  async function prepare() {
    if (active.current || disabled || blocked || loadedScope !== scope) return;
    const previous = original.current;
    if (previous?.prepared && !previous.confirmedReceipt) {setOpened(true); setMessage(""); callbacks.current.onBusyChange?.(true); return;}
    if (!stateAllowsRestore) return;
    let saved: Attempt;
    try {
      saved = previous && !previous.confirmedReceipt ? previous : {key: crypto.randomUUID(), selection: managedDatabaseRestoreSelectionSchema.parse(structuredClone(selection)), prepared: null, uncertainApply: false, confirmedReceipt: null};
      persist(saved);
    } catch {setBlocked(true); setMessage("The original restore request could not be saved."); return;}
    const controller = new AbortController(); active.current = controller; setBusy(true); setMessage(""); callbacks.current.onBusyChange?.(true);
    let show = false;
    try {
      const result = await prepareManagedDatabaseRestore(saved.selection, {apiBaseUrl, actorId, signal: controller.signal}, saved.key);
      if (controller.signal.aborted || current.current !== scope) return;
      if (result.kind === "ready") {
        const prepared = preparedManagedDatabaseRestoreSchema.parse(result.prepared);
        if (prepared.idempotencyKey !== saved.key || JSON.stringify(prepared.selection) !== JSON.stringify(saved.selection)) throw new Error("unavailable");
        persist({...saved, prepared}); setOpened(true); show = true;
      } else setMessage("Restore preparation could not be confirmed. Retry the original request.");
    } catch {if (!controller.signal.aborted && current.current === scope) setMessage("Restore preparation could not be confirmed. Retry the original request.");}
    finally {finish(controller); if (!show && current.current === scope) callbacks.current.onBusyChange?.(false);}
  }
  async function apply() {
    const saved = original.current;
    if (active.current || blocked || !saved?.prepared || saved.confirmedReceipt || loadedScope !== scope
      || (!saved.uncertainApply && (Date.parse(saved.prepared.confirmation.expiresAt) <= Date.now() || !stateAllowsRestore))) return;
    try {persist({...saved, uncertainApply: true});} catch {setBlocked(true); setMessage("The original restore request could not be saved."); return;}
    const controller = new AbortController(); active.current = controller; setBusy(true); setMessage("");
    try {
      const result = await applyManagedDatabaseRestore(saved.prepared, {apiBaseUrl, actorId, signal: controller.signal});
      if (controller.signal.aborted || current.current !== scope) return;
      if (result.kind === "ready") {
        persist({...saved, uncertainApply: false, confirmedReceipt: result.receipt}); setOpened(false); setMessage("Restore completed.");
        callbacks.current.onBusyChange?.(false); callbacks.current.onRestored?.();
      } else setMessage("Restore could not be confirmed. Retry the original confirmation.");
    } catch {if (!controller.signal.aborted && current.current === scope) setMessage("Restore could not be confirmed. Retry the original confirmation.");}
    finally {finish(controller);}
  }
  function cancel() {if (active.current) return; setOpened(false); setMessage(""); callbacks.current.onBusyChange?.(false);}
  return <div>
    <Button variant="destructive" disabled={disabled || busy || blocked || opened || loadedScope !== scope || (!attempt?.prepared && !stateAllowsRestore)} onClick={() => void prepare()}>
      {attempt?.uncertainApply ? "Retry restore confirmation" : attempt && !attempt.prepared ? "Retry restore preparation" : "Restore backup"}
    </Button>
    {message && !opened ? <p role="status">{message}</p> : null}
    <Dialog open={opened && Boolean(attempt?.prepared)} onOpenChange={value => {if (!value) cancel();}}>
      <DialogContent showCloseButton={false}><DialogTitle>Restore database</DialogTitle>
        <DialogDescription>Restore replaces current database data with this backup.</DialogDescription>
        <p>{selection.databaseId} · {selection.archiveId}</p>
        {expired ? <p>The original approval has expired.</p> : null}
        {message ? <p role="status">{message}</p> : null}
        <Button variant="destructive" disabled={busy || blocked || Boolean(expired) || (!attempt?.uncertainApply && !stateAllowsRestore)} onClick={() => void apply()}>{attempt?.uncertainApply ? "Retry original restore" : "Confirm restore"}</Button>
        <Button variant="outline" disabled={busy} onClick={cancel}>Cancel</Button>
      </DialogContent>
    </Dialog>
  </div>;
}
