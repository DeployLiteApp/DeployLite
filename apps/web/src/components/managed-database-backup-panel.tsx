"use client";
import {useEffect, useRef, useState} from "react";
import {z} from "zod";
import {managedDatabaseBackupPreparationSchema, type ManagedDatabaseHealthPreparationV1} from "@deploylite/contracts";
import {backupManagedDatabase, readManagedDatabaseBackups, type ManagedDatabaseBackupView} from "@/lib/managed-database-backup";
import {Button} from "@/components/ui/button";
type Props = {preparation: ManagedDatabaseHealthPreparationV1; apiBaseUrl: string; actorId: string;
  currentState: "running" | "stopped" | null; disabled?: boolean; onBusyChange?(busy: boolean): void};
const identity = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const attemptSchema = z.object({key: identity, preparation: managedDatabaseBackupPreparationSchema,
  confirmedArchiveId: z.string().regex(/^backup_[a-f0-9]{32}$/).nullable()}).strict();
type Attempt = z.infer<typeof attemptSchema>;
/** Save the original public request before dispatch; reload and uncertainty never create a replacement. */
export function ManagedDatabaseBackupPanel({preparation, apiBaseUrl, actorId, currentState, disabled, onBusyChange}: Props) {
  const scope = JSON.stringify([apiBaseUrl, actorId, preparation]), slot = "deploylite.native-backup:" + scope;
  const current = useRef(scope); current.current = scope;
  const active = useRef<AbortController | null>(null);
  const preferred = useRef<{scope: string; destination: string} | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null), [loadedScope, setLoadedScope] = useState("");
  const [view, setView] = useState<ManagedDatabaseBackupView | null>(null), [destination, setDestination] = useState("");
  const [budget, setBudget] = useState(""), [blocked, setBlocked] = useState(false), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(""), [revision, setRevision] = useState(0);
  const visible = loadedScope === scope, pending = visible && attempt && !attempt.confirmedArchiveId;
  useEffect(() => {
    const controller = new AbortController();
    setLoadedScope(""); setView(null); setAttempt(null); setBlocked(false); setBusy(false); setMessage("");
    let stored: Attempt | null = null;
    try {
      identity.parse(actorId);
      const raw = sessionStorage.getItem(slot);
      if (raw !== null) {
        if (raw.length > 131072) throw new Error("unavailable");
        stored = attemptSchema.parse(JSON.parse(raw));
        const {destinationId: _destination, maxBytes: _bytes, ...source} = stored.preparation;
        if (JSON.stringify(source) !== JSON.stringify(preparation)) throw new Error("unavailable");
      }
      setAttempt(stored);
    } catch {setBlocked(true); setMessage("The original backup request could not be recovered.");}
    async function load() {
      const options = {apiBaseUrl, actorId, signal: controller.signal};
      const readScope = {projectId: preparation.projectId, databaseId: preparation.databaseId};
      const destinations = await readManagedDatabaseBackups(readScope, options);
      if (controller.signal.aborted || current.current !== scope) return;
      if (destinations.kind !== "ready") {setMessage("Backups are unavailable."); setLoadedScope(scope); return;}
      const chosen = preferred.current?.scope === scope ? preferred.current.destination : undefined;
      const selected = stored?.preparation.destinationId ?? chosen ?? destinations.destinations[0]?.destinationId;
      if (!selected) {setMessage("Backups are unavailable."); setLoadedScope(scope); return;}
      setDestination(selected); setBudget(String(stored?.preparation.maxBytes ?? destinations.destinations.find(value => value.destinationId === selected)?.maxBytes ?? ""));
      const inventory = await readManagedDatabaseBackups(readScope, options, selected);
      if (controller.signal.aborted || current.current !== scope) return;
      if (inventory.kind === "ready") setView(inventory); else setMessage("Backup inventory is unavailable.");
      setLoadedScope(scope);
    }
    void load();
    return () => {controller.abort(); active.current?.abort(); active.current = null; onBusyChange?.(false);};
  }, [scope, slot, preparation, apiBaseUrl, actorId, revision, onBusyChange]);
  const stateAllowsBackup = preparation.engine === "redis" ? currentState === "stopped" : currentState === "running";
  const selected = view?.destinations.find(value => value.destinationId === destination);
  const maxBytes = Number(budget), validBudget = /^\d+$/.test(budget) && Number.isSafeInteger(maxBytes) && maxBytes > 0 && selected && maxBytes <= selected.maxBytes;
  function persist(value: Attempt) {
    const raw = JSON.stringify(attemptSchema.parse(value));
    sessionStorage.setItem(slot, raw);
    if (sessionStorage.getItem(slot) !== raw) throw new Error("unavailable");
  }
  async function create() {
    if (active.current || disabled || blocked || !visible || (!pending && (!view || !validBudget || !stateAllowsBackup))) return;
    let original: Attempt;
    try {
      original = pending ? attempt! : {key: crypto.randomUUID(), preparation: managedDatabaseBackupPreparationSchema.parse({...preparation, destinationId: destination, maxBytes}), confirmedArchiveId: null};
      persist(original); setAttempt(original);
    } catch {setBlocked(true); setMessage("The original backup request could not be saved. No new request was sent."); return;}
    const controller = new AbortController(); active.current = controller; setBusy(true); onBusyChange?.(true); setMessage("");
    try {
      const result = await backupManagedDatabase(original.preparation, {apiBaseUrl, actorId, signal: controller.signal}, original.key);
      if (controller.signal.aborted || current.current !== scope) return;
      if (result.kind === "ready") {
        const confirmed = {...original, confirmedArchiveId: result.receipt.archiveId};
        persist(confirmed); setAttempt(confirmed);
        setView(previous => previous ? {...previous, backups: [...previous.backups.filter(row => row.receipt.archiveId !== result.receipt.archiveId), result.inventory]} : previous);
        setMessage("Backup completed.");
      } else setMessage("Backup could not be confirmed. Retry the original request.");
    } catch {if (!controller.signal.aborted && current.current === scope) setMessage("Backup could not be confirmed. Retry the original request.");}
    finally {if (active.current === controller) {active.current = null; setBusy(false); onBusyChange?.(false);}}
  }
  return <section aria-label="Database backups" className="space-y-2">
    <h3>Backups</h3>
    {message ? <p role="status">{message}</p> : null}
    {visible ? <>
      <label>Backup destination <select aria-label="Backup destination" value={destination} disabled={busy || Boolean(pending)} onChange={event => {
        preferred.current = {scope, destination: event.target.value}; setRevision(value => value + 1);
      }}>{view?.destinations.map(value => <option key={value.destinationId} value={value.destinationId}>{value.destinationId}</option>)}</select></label>
      <label>Maximum backup bytes <input aria-label="Maximum backup bytes" inputMode="numeric" value={budget} disabled={busy || Boolean(pending)} onChange={event => setBudget(event.target.value)} /></label>
      {!pending && !stateAllowsBackup ? <p>{preparation.engine === "redis" ? "Stop Redis before creating a backup." : "A current running database observation is required."}</p> : null}
      <Button disabled={busy || disabled || blocked || (!pending && (!view || !validBudget || !stateAllowsBackup))} onClick={() => void create()}>{pending ? "Retry backup confirmation" : "Create backup"}</Button>
      <Button variant="outline" disabled={busy} onClick={() => setRevision(value => value + 1)}>Reload backups</Button>
      <ul>{view?.backups.filter(row => row.receipt.destinationId === destination).map(row => <li key={row.receipt.archiveId}><span>{row.receipt.archiveId}</span> · {row.receipt.archiveBytes} bytes · {new Date(row.createdAtMs).toISOString()}</li>)}</ul>
      {attempt?.confirmedArchiveId && !view?.backups.some(row => row.receipt.archiveId === attempt.confirmedArchiveId) ? <p>{attempt.confirmedArchiveId}</p> : null}
    </> : <p>Loading backups…</p>}
  </section>;
}
