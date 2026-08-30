import type { LogEvent } from "@deploylite/contracts";

export type LogSeverityFilter = "all" | LogEvent["level"];
export type LogFilter = { query: string; severity: LogSeverityFilter };

export function filterDeploymentLogEvents(events: readonly LogEvent[], filter: LogFilter): LogEvent[] {
  const query = filter.query.trim().toLowerCase();
  return events.filter((event) => {
    if (filter.severity !== "all" && event.level !== filter.severity) return false;
    if (!query) return true;
    return [event.message, event.sequence, event.level, event.timestamp, event.requestId, event.correlationId].join(" ").toLowerCase().includes(query);
  });
}
