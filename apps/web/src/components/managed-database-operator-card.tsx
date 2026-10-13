"use client";
import { useEffect, useRef, useState } from "react";
import { managedDatabaseProfileRequestSchema, type ManagedDatabaseEngineV1, type ManagedDatabaseHealthPreparationV1, type ManagedDatabaseStartPreparationV1 } from "@deploylite/contracts";
import { applyManagedDatabase, prepareManagedDatabase, startManagedDatabase, stopManagedDatabase, type DatabaseClientOptions, type PreparedDatabaseView } from "@/lib/managed-database-lifecycle";
import { ManagedDatabaseTelemetryPanel } from "./managed-database-telemetry-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
const engines: ReadonlyArray<readonly [ManagedDatabaseEngineV1, string]> = [["postgres", "PostgreSQL"], ["mysql", "MySQL"], ["mariadb", "MariaDB"], ["mongodb", "MongoDB"], ["redis", "Redis"]];
export function ManagedDatabaseOperatorCard({projectId, apiBaseUrl}: {projectId: string; apiBaseUrl: string | null}) {
  const [engine, setEngine] = useState<ManagedDatabaseEngineV1>("postgres"), [name, setName] = useState("");
  const [preview, setPreview] = useState<PreparedDatabaseView | null>(null);
  const [source, setSource] = useState<ManagedDatabaseHealthPreparationV1 | null>(null);
  const [stopped, setStopped] = useState<ManagedDatabaseStartPreparationV1 | null>(null);
  const [telemetryRevision, setTelemetryRevision] = useState(0);
  const [busy, setBusy] = useState(""), [message, setMessage] = useState("");
  const pending = useRef<AbortController | null>(null), attempts = useRef(new Map<string, string>());
  useEffect(() => {
    setPreview(null); setSource(null); setStopped(null); setMessage(""); setBusy(""); attempts.current.clear();
    return () => {pending.current?.abort(); pending.current = null;};
  }, [projectId, apiBaseUrl]);
  function clearSelection() {setPreview(null); setSource(null); setStopped(null); setMessage("");}
  async function run(label: string, work: (options: DatabaseClientOptions) => Promise<void>) {
    if (pending.current) return;
    const controller = new AbortController(); pending.current = controller; setBusy(label); setMessage("");
    try {await work({apiBaseUrl, signal: controller.signal});}
    catch {if (!controller.signal.aborted) setMessage("Database operation could not be confirmed.");}
    finally {if (pending.current === controller) {pending.current = null; if (!controller.signal.aborted) setBusy("");}}
  }
  function attempt(operation: string, input: unknown) {
    const identity = JSON.stringify([apiBaseUrl, operation, input]);
    let key = attempts.current.get(identity);
    if (!key) {key = crypto.randomUUID(); attempts.current.set(identity, key);}
    return {identity, key};
  }
  function prepare() {
    const input = managedDatabaseProfileRequestSchema.safeParse({schemaVersion: 1, projectId, databaseId: name, engine});
    if (!input.success) {setMessage("Choose a valid database name and engine."); return;}
    void run("Preparing", async options => {
      const result = await prepareManagedDatabase(input.data, options); if (options.signal?.aborted) return;
      if (result.kind === "error" || result.preparation.projectId !== projectId || result.preparation.databaseId !== name || result.preparation.engine !== engine) {
        setPreview(null); setMessage("Database preparation could not be confirmed."); return;
      }
      setPreview({preparation: result.preparation, connection: result.connection}); setMessage("Database prepared.");
    });
  }
  function create() {
    if (!preview) return; const current = preview, token = attempt("apply", current.preparation);
    void run("Creating", async options => {
      const result = await applyManagedDatabase(current.preparation, options, token.key); if (options.signal?.aborted) return;
      if (result.kind === "error") {setMessage("Database creation could not be confirmed."); return;}
      attempts.current.delete(token.identity); setSource(result.preparation); setStopped(null); setMessage("Database created.");
    });
  }
  function stop() {
    if (!source) return; const current = source, token = attempt("stop", current);
    void run("Stopping", async options => {
      const result = await stopManagedDatabase(current, options, token.key); if (options.signal?.aborted) return;
      if (result.kind === "error") {setMessage("Database stop could not be confirmed."); return;}
      attempts.current.delete(token.identity); setStopped(result.preparation); setTelemetryRevision(value => value + 1); setMessage("Stop completed.");
    });
  }
  function start() {
    if (!stopped) return; const current = stopped, token = attempt("start", current);
    void run("Starting", async options => {
      const result = await startManagedDatabase(current, options, token.key); if (options.signal?.aborted) return;
      if (result.kind === "error") {setMessage("Database start could not be confirmed."); return;}
      attempts.current.delete(token.identity); setStopped(null); setTelemetryRevision(value => value + 1); setMessage("Start completed.");
    });
  }
  return <div className="space-y-4">
    <Card>
      <CardHeader><CardTitle>Native databases</CardTitle><CardDescription>Create a database on this project's internal network.</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm">Engine<select aria-label="Engine" value={engine} disabled={Boolean(busy)} onChange={event => {setEngine(event.target.value as ManagedDatabaseEngineV1); clearSelection();}} className="h-9 w-full rounded-md border bg-background px-3">
            {engines.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          <label className="space-y-1 text-sm">Database name<Input aria-label="Database name" value={name} maxLength={60} disabled={Boolean(busy)} onChange={event => {setName(event.target.value); clearSelection();}} placeholder="orders" /></label>
        </div>
        <p className="text-sm text-muted-foreground">Use lowercase letters, numbers, underscores or hyphens, starting with a letter.</p>
        <Button disabled={Boolean(busy) || !apiBaseUrl} onClick={prepare}>Prepare database</Button>
        {preview ? <div className="space-y-2 rounded-md border p-3 text-sm">
          <p>Internal connection</p><p>{preview.connection.hostname}:{preview.connection.port}</p>
          <p>Database: {preview.connection.databaseName}</p><p>User: {preview.connection.username}</p>
          {preview.connection.authenticationDatabase ? <p>Authentication database: {preview.connection.authenticationDatabase}</p> : null}
          <p className="text-muted-foreground">Credentials are stored in project secrets.</p>
          {!source ? <Button disabled={Boolean(busy)} onClick={create}>Create database</Button> : <div className="flex gap-2">
            <Button variant="outline" disabled={Boolean(busy)} onClick={stop}>Stop database</Button>
            <Button variant="outline" disabled={Boolean(busy) || !stopped} onClick={start}>Start database</Button>
          </div>}
        </div> : null}
        {busy ? <p role="status">{busy}…</p> : message ? <p role="status">{message}</p> : null}
      </CardContent>
    </Card>
    {source ? <ManagedDatabaseTelemetryPanel key={telemetryRevision} preparation={source} apiBaseUrl={apiBaseUrl} /> : null}
  </div>;
}
