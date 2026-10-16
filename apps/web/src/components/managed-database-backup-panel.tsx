"use client";
import {useEffect, useRef, useState} from "react";
import {z} from "zod";
import {managedDatabaseBackupPreparationSchema, type ManagedDatabaseHealthPreparationV1} from "@deploylite/contracts";
import {backupManagedDatabase, readManagedDatabaseBackups, type ManagedDatabaseBackupView} from "@/lib/managed-database-backup";
import {ManagedDatabaseRestoreControl, readRecoverableManagedDatabaseRestores} from "./managed-database-restore-control";
import {Button} from "@/components/ui/button";
type Props = {preparation: ManagedDatabaseHealthPreparationV1; apiBaseUrl: string; actorId: string;
  currentState: "running" | "stopped" | null; disabled?: boolean; onRestored?(): void; onBusyChange?(busy: boolean): void};
const identity = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const attemptSchema = z.object({key: identity, preparation: managedDatabaseBackupPreparationSchema,
  confirmedArchiveId: z.string().regex(/^backup_[a-f0-9]{32}$/).nullable()}).strict();
type Attempt = z.infer<typeof attemptSchema>;
/** Save the original public request before dispatch; reload and uncertainty never create a replacement. */
export function ManagedDatabaseBackupPanel({preparation, apiBaseUrl, actorId, currentState, disabled, onRestored, onBusyChange}: Props) {
  const scope = JSON.stringify([apiBaseUrl, actorId, preparation]), slot = "deploylite.native-backup:" + scope;
  const current = useRef(scope); current.current = scope;
  const active = useRef<AbortController | null>(null);
  const preferred = useRef<{scope: string; destination: string} | null>(null);
  const [restoreNotice, setRestoreNotice] = useState<{scope: string} | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null), [loadedScope, setLoadedScope] = useState("");
  const [recoveries, setRecoveries] = useState<ReturnType<typeof readRecoverableManagedDatabaseRestores>>([]);
  const [view, setView] = useState<ManagedDatabaseBackupView | null>(null), [destination, setDestination] = useState("");
  const [budget, setBudget] = useState(""), [blocked, setBlocked] = useState(false), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(""), [revision, setRevision] = useState(0);
  const visible = loadedScope === scope, pending = visible && attempt && !attempt.confirmedArchiveId;
  useEffect(() => {
    const controller = new AbortController();
    setLoadedScope(""); setView(null); setRecoveries([]); setAttempt(null); setBlocked(false); setBusy(false); setMessage("");
    let stored: Attempt | null = null;
    try {
      identity.parse(actorId);
      setRecoveries(readRecoverableManagedDatabaseRestores(preparation, apiBaseUrl, actorId));
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
  function restored() {setRestoreNotice({scope}); onRestored?.(); setRevision(value => value + 1);}
  return <section aria-label="Database backups" className="space-y-2">
    <h3>Backups</h3>
    {restoreNotice?.scope === scope ? <p role="status">Restore completed.</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {visible ? <>
      {recoveries.map(selection => <div key={JSON.stringify(selection)}><p>Pending original restore · {selection.archiveId}</p>
        <ManagedDatabaseRestoreControl selection={selection} actorId={actorId} apiBaseUrl={apiBaseUrl} currentState={currentState}
          disabled={disabled || busy || blocked} onBusyChange={onBusyChange} onRestored={restored} />
      </div>)}
      <label>Backup destination <select aria-label="Backup destination" value={destination} disabled={busy || Boolean(pending)} onChange={event => {
        preferred.current = {scope, destination: event.target.value}; setRevision(value => value + 1);
      }}>{view?.destinations.map(value => <option key={value.destinationId} value={value.destinationId}>{value.destinationId}</option>)}</select></label>
      <label>Maximum backup bytes <input aria-label="Maximum backup bytes" inputMode="numeric" value={budget} disabled={busy || Boolean(pending)} onChange={event => setBudget(event.target.value)} /></label>
      {!pending && !stateAllowsBackup ? <p>{preparation.engine === "redis" ? "Stop Redis before creating a backup." : "A current running database observation is required."}</p> : null}
      <Button disabled={busy || disabled || blocked || (!pending && (!view || !validBudget || !stateAllowsBackup))} onClick={() => void create()}>{pending ? "Retry backup confirmation" : "Create backup"}</Button>
      <Button variant="outline" disabled={busy} onClick={() => setRevision(value => value + 1)}>Reload backups</Button>
      <ul>{view?.backups.filter(row => row.receipt.destinationId === destination).map(row => {
        const receipt = row.receipt, source = preparation.originalReceipt;
        const compatible = receipt.originalCommandId === source.commandId && receipt.profileId === preparation.profileId
          && (["projectId", "databaseId", "engine", "planDigest", "environmentFingerprint", "agentId", "containerId", "imageId", "volumeName", "networkName", "networkId", "volumeCreatedAt"] as const).every(key => receipt[key] === source[key]);
        return <li key={receipt.archiveId}><span>{receipt.archiveId}</span> · {receipt.archiveBytes} bytes · {new Date(row.createdAtMs).toISOString()}
          {selected && !recoveries.some(selection => selection.archiveId === receipt.archiveId && selection.destinationId === receipt.destinationId) ? <ManagedDatabaseRestoreControl selection={{...preparation, archiveId: receipt.archiveId, destinationId: receipt.destinationId,
            expectedArchiveSha256: receipt.archiveSha256, expectedManifestSha256: receipt.manifestSha256, maxBytes: selected.maxBytes}}
            actorId={actorId} apiBaseUrl={apiBaseUrl} currentState={currentState} disabled={disabled || busy || blocked || !compatible || receipt.archiveBytes > selected.maxBytes}
            onBusyChange={onBusyChange} onRestored={restored} /> : null}
        </li>;
      })}</ul>
      {attempt?.confirmedArchiveId && !view?.backups.some(row => row.receipt.archiveId === attempt.confirmedArchiveId) ? <p>{attempt.confirmedArchiveId}</p> : null}
    </> : <p>Loading backups…</p>}
  </section>;
}
