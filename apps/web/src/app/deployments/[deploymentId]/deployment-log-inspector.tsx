"use client";

import { useMemo, useState } from "react";
import type { LogEvent } from "@deploylite/contracts";
import { filterDeploymentLogEvents, type LogSeverityFilter } from "./deployment-log-inspector-model";

export { filterDeploymentLogEvents } from "./deployment-log-inspector-model";
export type { LogFilter, LogSeverityFilter } from "./deployment-log-inspector-model";

export function DeploymentLogInspector({ events, variant = "default" }: { events: readonly LogEvent[]; variant?: "default" | "terminal" }) {
  const [query, setQuery] = useState("");
  const [severity, setSeverity] = useState<LogSeverityFilter>("all");
  const filteredEvents = useMemo(() => filterDeploymentLogEvents(events, { query, severity }), [events, query, severity]);
  const hasNoMatches = events.length > 0 && filteredEvents.length === 0;

  return (
    <div className={`flex flex-col gap-4 ${variant === "terminal" ? "text-zinc-100" : ""}`} data-testid="deployment-log-inspector">
      <div className={`flex flex-col gap-3 rounded-md border p-4 sm:flex-row sm:items-end ${variant === "terminal" ? "border-zinc-800 bg-zinc-900" : ""}`}>
        <div className="flex min-w-0 flex-1 flex-col gap-1"><label htmlFor="deployment-log-search" className="text-sm font-medium">Search log events</label><input id="deployment-log-search" name="deployment-search" autoComplete="off" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search messages and metadata…" className={`h-9 rounded-md border px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${variant === "terminal" ? "border-zinc-700 bg-zinc-950 text-zinc-100 placeholder:text-zinc-500" : "bg-background"}`} /></div>
        <div className="flex flex-col gap-1 sm:w-44"><label htmlFor="deployment-log-severity" className="text-sm font-medium">Severity</label><select id="deployment-log-severity" value={severity} onChange={(event) => setSeverity(event.target.value as LogSeverityFilter)} className={`h-9 rounded-md border px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${variant === "terminal" ? "border-zinc-700 bg-zinc-950 text-zinc-100" : "bg-background"}`}><option value="all">All severities</option><option value="debug">Debug</option><option value="info">Info</option><option value="warn">Warn</option><option value="error">Error</option></select></div>
        <button type="button" onClick={() => { setQuery(""); setSeverity("all"); }} className={`h-9 rounded-md border px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${variant === "terminal" ? "border-zinc-700 hover:bg-zinc-800" : "hover:bg-muted"}`}>Reset filters</button>
      </div>
      <p role="status" aria-live="polite" aria-atomic="true" className={`text-sm ${variant === "terminal" ? "text-zinc-400" : "text-muted-foreground"}`}>Showing {filteredEvents.length} of {events.length} events</p>
       {events.length === 0 ? <p className={`text-sm ${variant === "terminal" ? "text-zinc-400" : "text-muted-foreground"}`} data-testid="log-empty-state">No log events are available yet.</p> : hasNoMatches ? <p className={`text-sm ${variant === "terminal" ? "text-zinc-400" : "text-muted-foreground"}`} data-testid="log-no-match-state">No log events match the current filters.</p> : <ol className="flex flex-col gap-3" aria-label="Deployment log events" data-testid="deployment-log-events">
         {filteredEvents.map((event) => <li key={event.id} className={`rounded-md border p-3 ${variant === "terminal" ? "border-zinc-800 bg-zinc-900/70" : ""}`} data-testid={`log-event-${event.id}`}><span className="sr-only" aria-hidden="true">{`${event.sequence} ${event.level.toUpperCase()} ${event.message}`}</span><div className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-xs ${variant === "terminal" ? "text-zinc-400" : "text-muted-foreground"}`}><span className={`font-mono font-medium ${variant === "terminal" ? "text-zinc-200" : "text-foreground"}`}>#{event.sequence}</span><span className={`font-medium uppercase ${variant === "terminal" ? "text-zinc-200" : "text-foreground"}`}>{event.level}</span><time dateTime={event.timestamp}>{event.timestamp}</time></div><p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{event.message}</p><dl className={`mt-3 grid gap-2 text-xs sm:grid-cols-2 ${variant === "terminal" ? "text-zinc-400" : "text-muted-foreground"}`}><div><dt className={variant === "terminal" ? "font-medium text-zinc-200" : "font-medium text-foreground"}>Request ID</dt><dd className="break-all font-mono">{event.requestId}</dd></div><div><dt className={variant === "terminal" ? "font-medium text-zinc-200" : "font-medium text-foreground"}>Correlation ID</dt><dd className="break-all font-mono">{event.correlationId}</dd></div></dl></li>)}
      </ol>}
    </div>
  );
}
