"use client";
import {useCallback, useEffect, useRef, useState} from "react";
import {readManagedDatabaseInventory, type ManagedDatabaseInventoryEntry} from "@/lib/managed-database-inventory";
import {startManagedDatabase, stopManagedDatabase} from "@/lib/managed-database-lifecycle";
import {ManagedDatabaseBackupPanel} from "./managed-database-backup-panel";
import {ManagedDatabaseDeleteControl} from "./managed-database-delete-control";
import {ManagedDatabaseTelemetryPanel} from "./managed-database-telemetry-panel";
import {Button} from "@/components/ui/button";
import {Card, CardContent, CardHeader, CardTitle} from "@/components/ui/card";
type Props = {actorId?: string; projectId: string; apiBaseUrl: string; refreshKey?: number; selectedDatabaseId?: string; onSelect?(databaseId: string): void};
const engineNames = {postgres: "PostgreSQL", mysql: "MySQL", mariadb: "MariaDB", mongodb: "MongoDB", redis: "Redis"};
/** Recover original metadata; only explicit controls and fresh observations authorize runtime actions. */
export function ManagedDatabaseInventoryPanel({projectId, apiBaseUrl, refreshKey, selectedDatabaseId, onSelect, actorId}: Props) {
  const [entries, setEntries] = useState<ManagedDatabaseInventoryEntry[]>([]);
  const [loaded, setLoaded] = useState(false), [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(""), [manual, setManual] = useState(0);
  const [localSelection, setLocalSelection] = useState("");
  const [observation, setObservation] = useState<{scope: string; state: "running" | "stopped" | null} | null>(null);
  const [telemetryRevision, setTelemetryRevision] = useState(0), [busy, setBusy] = useState(false);
  const command = useRef<AbortController | null>(null);
  const attempts = useRef(new Map<string, string>());
  const scope = JSON.stringify([projectId, apiBaseUrl, actorId]);
  const currentScope = useRef(scope); currentScope.current = scope;
  const loadedScope = useRef("");
  const selection = selectedDatabaseId ?? localSelection;
  const selectionScope = JSON.stringify([scope, selection]);
  const currentSelection = useRef(selectionScope); currentSelection.current = selectionScope;
  const currentState = observation?.scope === selectionScope ? observation.state : null;
  const setCurrentState = useCallback((state: "running" | "stopped" | null) => setObservation({scope: selectionScope, state}), [selectionScope]);
  useEffect(() => {
    attempts.current.clear();
    return () => {command.current?.abort(); command.current = null;};
  }, [scope]);
  useEffect(() => {
    command.current?.abort(); command.current = null; setBusy(false);
    return () => {command.current?.abort(); command.current = null;};
  }, [selectionScope]);
  useEffect(() => {
    const controller = new AbortController();
    command.current?.abort(); command.current = null; setBusy(false);
    setEntries([]); setLoaded(false); setLoading(true); setObservation(null); setMessage(""); loadedScope.current = "";
    async function load() {
      try {
        const result = await readManagedDatabaseInventory(projectId, {apiBaseUrl, signal: controller.signal});
        if (controller.signal.aborted || currentScope.current !== scope) return;
        if (result.kind === "ready" && result.databases.every(entry => entry.preparation.projectId === projectId)) {
          loadedScope.current = scope; setEntries(result.databases); setLoaded(true);
        } else setMessage("Database inventory could not be loaded.");
      } catch {if (!controller.signal.aborted && currentScope.current === scope) setMessage("Database inventory could not be loaded.");}
      if (!controller.signal.aborted && currentScope.current === scope) setLoading(false);
    }
    void load(); return () => controller.abort();
  }, [projectId, apiBaseUrl, scope, refreshKey, manual]);
  const visible = loadedScope.current === scope ? entries : [];
  const selected = visible.find(entry => entry.preparation.databaseId === selection);
  function attemptIdentity(operation: "stop" | "start", entry: ManagedDatabaseInventoryEntry) {
    return JSON.stringify([apiBaseUrl, operation, operation === "stop" ? entry.source : entry.startPreparation]);
  }
  const retryStop = selected ? attempts.current.has(attemptIdentity("stop", selected)) : false;
  const retryStart = selected ? attempts.current.has(attemptIdentity("start", selected)) : false;
  async function control(operation: "stop" | "start") {
    if (command.current || !selected?.source || selected.preparation.projectId !== projectId || loadedScope.current !== scope) return;
    const identity = attemptIdentity(operation, selected), previousKey = attempts.current.get(identity);
    if (operation === "stop" && currentState !== "running" && !previousKey) return;
    if (operation === "start" && (!selected.startPreparation || (currentState !== "stopped" && !previousKey))) return;
    const key = previousKey ?? crypto.randomUUID(); attempts.current.set(identity, key);
    const controller = new AbortController(); command.current = controller; setBusy(true); setMessage("");
    try {
      const options = {apiBaseUrl, signal: controller.signal};
      const result = operation === "stop" ? await stopManagedDatabase(selected.source, options, key)
        : await startManagedDatabase(selected.startPreparation!, options, key);
      if (controller.signal.aborted || currentSelection.current !== selectionScope) return;
      if (result.kind === "ready") {
        attempts.current.delete(identity);
        setEntries(values => values.map(entry => entry.preparation.databaseId !== selection ? entry : {...entry,
          startPreparation: "preparation" in result ? result.preparation : null}));
        setMessage(operation === "stop" ? "Stop completed." : "Start completed.");
        setCurrentState(null); setTelemetryRevision(value => value + 1);
      } else setMessage("Database command could not be confirmed.");
    } catch {
      if (!controller.signal.aborted && currentSelection.current === selectionScope) setMessage("Database command could not be confirmed.");
    } finally {
      if (command.current === controller) {command.current = null; setBusy(false);}
    }
  }
  return <Card>
    <CardHeader><CardTitle>Stored databases</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      <Button variant="outline" disabled={busy || loading} onClick={() => setManual(value => value + 1)}>Reload databases</Button>
      {message ? <p role="status">{message}</p> : null}
      {loading ? <p role="status">Loading databases…</p> : loaded && visible.length === 0 ? <p>No stored databases.</p> : null}
      <div className="flex flex-wrap gap-2">{visible.map(entry => <Button key={entry.preparation.databaseId} disabled={busy}
        variant={selection === entry.preparation.databaseId ? "default" : "outline"} onClick={() => {
          if (selection === entry.preparation.databaseId) return;
          setCurrentState(null); setMessage(""); onSelect ? onSelect(entry.preparation.databaseId) : setLocalSelection(entry.preparation.databaseId);
        }}>{entry.preparation.databaseId} ({engineNames[entry.preparation.engine]})</Button>)}</div>
      {selected ? <>
        <p>{selected.connection.hostname}:{selected.connection.port} · {selected.connection.databaseName} · {selected.connection.username}</p>
        {selected.source ? <>
          <div className="flex gap-2">
            <Button disabled={busy || (currentState !== "running" && !retryStop)} onClick={() => void control("stop")}>{retryStop ? "Retry stop confirmation" : "Stop database"}</Button>
            <Button disabled={busy || !selected.startPreparation || (currentState !== "stopped" && !retryStart)} onClick={() => void control("start")}>{retryStart ? "Retry start confirmation" : "Start database"}</Button>
          </div>
          {actorId ? <ManagedDatabaseBackupPanel key={JSON.stringify([actorId, selected.source])} preparation={selected.source} apiBaseUrl={apiBaseUrl}
            actorId={actorId} currentState={currentState} disabled={busy} onBusyChange={setBusy} /> : null}
          <ManagedDatabaseDeleteControl preparation={selected.source} apiBaseUrl={apiBaseUrl} disabled={busy} onBusyChange={setBusy} onDeleted={()=>{
            onSelect?onSelect(""):setLocalSelection("");setObservation(null);setManual(value=>value+1);
          }} />
          <ManagedDatabaseTelemetryPanel key={`${selection}:${telemetryRevision}`} preparation={selected.source} apiBaseUrl={apiBaseUrl} onState={setCurrentState} />
        </> : <p>Runtime controls could not be recovered.</p>}
      </> : null}
    </CardContent>
  </Card>;
}
