"use client";
import { useEffect, useRef, useState } from "react";
import { readManagedDatabaseTelemetry, type TelemetryOptions, type TelemetryObservation } from "@/lib/managed-database-telemetry";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
type Props = Omit<TelemetryOptions, "fetchImpl" | "signal">;
const healthNames = {healthy: "Healthy", unhealthy: "Unhealthy", starting: "Starting", unknown: "Unknown", "not-running": "Stopped"};
/** Sequential bounded reads retain stopped logs; pausing/searching creates no runtime effects. */
export function ManagedDatabaseTelemetryPanel({preparation, apiBaseUrl}: Props) {
  const [view, setView] = useState<"health" | "metrics" | "logs">("health");
  const [live, setLive] = useState(true), [manual, setManual] = useState(0);
  const [tail, setTail] = useState(100), [since, setSince] = useState(""), [search, setSearch] = useState("");
  const [observation, setObservation] = useState<TelemetryObservation | null>(null);
  const [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  const previousKey = useRef(""), previousManual = useRef(0);
  const sourceKey = JSON.stringify([apiBaseUrl, preparation, view, tail, since]);
  useEffect(() => {
    if (previousKey.current !== sourceKey) { setObservation(null); setMessage(""); previousKey.current = sourceKey; }
    if (!live && manual === previousManual.current) { setBusy(false); return; }
    previousManual.current = manual;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    let selection: {tail: number; since?: string} | undefined;
    if (view === "logs") {
      if (since && !Number.isFinite(Date.parse(since))) { setMessage("Choose a valid start time."); return; }
      selection = {tail, ...(since ? {since: new Date(since).toISOString()} : {})};
    }
    async function load() {
      setBusy(true);
      try {
        const result = await readManagedDatabaseTelemetry(view, {preparation, apiBaseUrl, signal: controller.signal}, selection);
        if (controller.signal.aborted) return;
        setObservation(result.kind === "ready" ? result.observation : null);
        setMessage(result.kind === "ready" ? "" : "Database observation is unavailable.");
      } catch {
        if (controller.signal.aborted) return;
        setObservation(null); setMessage("Database observation is unavailable.");
      }
      if (!controller.signal.aborted) { setBusy(false); if (live) timer = setTimeout(() => void load(), 5000); }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [apiBaseUrl, preparation, view, tail, since, live, manual, sourceKey]);
  const logs = observation?.action === "database.runtime.logs" ? [observation.logs.stdout, observation.logs.stderr].filter(Boolean).join("\n") : "";
  const filteredLogs = search ? logs.split("\n").filter(line => line.toLocaleLowerCase().includes(search.toLocaleLowerCase())).join("\n") : logs;
  return <Card>
    <CardHeader><CardTitle>Database telemetry</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      <div className="flex flex-wrap gap-2" aria-label="Database observation views">
        {(["health", "metrics", "logs"] as const).map(value => <Button key={value} variant={view === value ? "default" : "outline"} aria-pressed={view === value} onClick={() => setView(value)}>
          {value[0]!.toUpperCase() + value.slice(1)}
        </Button>)}
        <Button variant="outline" onClick={() => setLive(value => !value)}>{live ? "Pause live" : "Resume live"}</Button>
        <Button variant="outline" disabled={busy} onClick={() => setManual(value => value + 1)}>Refresh</Button>
      </div>
      {view === "logs" ? <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1 text-sm">Log lines<select aria-label="Log lines" value={tail} onChange={event => setTail(Number(event.target.value))} className="h-9 w-full rounded-md border bg-background px-3">
          {[100, 300, 500, 1000, 5000].map(value => <option key={value} value={value}>{value}</option>)}
        </select></label>
        <label className="space-y-1 text-sm">Since (local time)<Input aria-label="Since (local time)" type="datetime-local" value={since} onChange={event => setSince(event.target.value)} /></label>
        <label className="space-y-1 text-sm">Search logs<Input aria-label="Search logs" value={search} onChange={event => setSearch(event.target.value)} /></label>
      </div> : null}
      {message ? <p role="status" className="text-sm text-muted-foreground">{message}</p> : null}
      {observation ? <>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Badge variant="outline">{healthNames[observation.health]}</Badge>
          <span>{live ? "Live" : "Paused"}</span>
          <span>Observed {new Date(observation.observedAt).toLocaleString()}</span>
        </div>
        {observation.action === "database.runtime.metrics" ? observation.metrics ? <dl className="grid gap-3 sm:grid-cols-3">
          <div><dt>CPU</dt><dd>{observation.metrics.cpuPercent}%</dd></div>
          <div><dt>Memory</dt><dd>{observation.metrics.memoryUsage} ({observation.metrics.memoryPercent}%)</dd></div>
          <div><dt>Processes / threads</dt><dd>{observation.metrics.pids}</dd></div>
          <div><dt>Network I/O</dt><dd>{observation.metrics.networkIO}</dd></div>
          <div><dt>Block I/O</dt><dd>{observation.metrics.blockIO}</dd></div>
        </dl> : <p>No metrics while stopped.</p> : null}
        {observation.action === "database.runtime.logs" ? <pre aria-label="Database logs" className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border bg-muted p-3 text-xs">{filteredLogs || "No matching log lines."}</pre> : null}
      </> : busy ? <p role="status" className="text-sm text-muted-foreground">Loading observation…</p> : null}
    </CardContent>
  </Card>;
}
