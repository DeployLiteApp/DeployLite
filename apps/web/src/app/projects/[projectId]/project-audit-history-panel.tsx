"use client";

import { useRef, useState } from "react";
import type { AuditEventListItem } from "@deploylite/contracts";
import { loadAuditEvents, type AuditListFailureReason } from "@/lib/auth-boundary";
import { AuditDrawer, type AuditDrawerState, type AuditLoadHandler } from "@/components/audit-drawer";
import { AUDIT_PAGE_SIZE, buildAuditHistoryRequest, createLatestAuditRequestRunner, resolveAuditHistoryResult, resolveAuditLoadIntent, type AuditHistoryFilters, type AuditHistoryCursor, type AuditLoadIntent } from "./audit-history-pagination-model";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/**
 * In-page audit history panel for a project. Renders a small summary table of
 * the latest events and a button that opens the full <AuditDrawer/> with
 * filterable history. The component owns the drawer's open state and keeps
 * the rendered preview in sync with the data the parent (server component)
 * fetched on first paint.
 */

type AuditHistoryFailure = { kind: "error"; reason: AuditListFailureReason; status?: number };
export { AUDIT_PAGE_SIZE, buildAuditHistoryRequest, createLatestAuditRequestRunner, resolveAuditHistoryResult, resolveAuditLoadIntent } from "./audit-history-pagination-model";
export type { AuditHistoryFilters, AuditHistoryCursor, AuditLoadIntent } from "./audit-history-pagination-model";
export type AuditHistoryRequest = Parameters<typeof loadAuditEvents>[0];

export type ProjectAuditHistoryPanelProps = {
  apiBaseUrl: string | null;
  cookieHeader: string;
  projectId: string;
  initialEvents: AuditEventListItem[];
  initialTotal: number;
  initialState: AuditDrawerState;
};

export function ProjectAuditHistoryPanel({
  apiBaseUrl,
  cookieHeader,
  projectId,
  initialEvents,
  initialTotal,
  initialState
}: ProjectAuditHistoryPanelProps) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<AuditEventListItem[]>(initialEvents);
  const [total, setTotal] = useState(initialTotal);
  const [state, setState] = useState<AuditDrawerState>(initialState);
  const [filters, setFilters] = useState<AuditHistoryFilters>({});
  const [limit] = useState(AUDIT_PAGE_SIZE);
  const [offset, setOffset] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const filtersRef = useRef<AuditHistoryFilters>(filters);
  const offsetRef = useRef(offset);
  const runnerRef = useRef<ReturnType<typeof createLatestAuditRequestRunner> | null>(null);
  filtersRef.current = filters;
  offsetRef.current = offset;
  if (!runnerRef.current) {
    runnerRef.current = createLatestAuditRequestRunner(loadAuditEvents, (request, result) => {
      const nextFilters = { actor: request.actor, action: request.action };
      filtersRef.current = nextFilters;
      offsetRef.current = request.offset ?? 0;
      setFilters(nextFilters);
      setOffset(request.offset ?? 0);
      const next = resolveAuditHistoryResult(result);
      setEvents(next.events);
      setTotal(next.total);
      setState(next.state);
    }, setIsLoading);
  }

  // The drawer accepts a sync OR async refresh callback; this handler is
  // async because the API roundtrip awaits the response before the
  // preview state can be updated. The drawer swallows the returned
  // promise internally, so the parent does not need a fire-and-forget
  // wrapper.
  const onRefresh: AuditLoadHandler = async (intent: AuditLoadIntent) => {
    const cursor: AuditHistoryCursor = resolveAuditLoadIntent(intent, { filters: filtersRef.current, offset: offsetRef.current });
    const request = buildAuditHistoryRequest({ apiBaseUrl, cookieHeader, projectId, cursor, limit });
    await runnerRef.current?.(request);
  };

  if (initialState.kind === "error" && initialState.reason === "forbidden") {
    return (
      <Card>
        <CardContent className="flex flex-col gap-2 py-6 text-sm text-muted-foreground">
          <span>Audit history is restricted to operator or admin sessions.</span>
        </CardContent>
      </Card>
    );
  }

  const previewEvents = events.slice(0, 5);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground" data-testid="project-audit-summary">
          {total} event(s) in the most recent window.
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setOpen(true)}
          data-testid="project-audit-open-drawer"
        >
          Open full audit history
        </Button>
      </div>

      {previewEvents.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="project-audit-empty">
          No audit events yet. The first privileged action will appear here.
        </p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="project-audit-preview">
          {previewEvents.map((event) => (
            <li key={event.id} className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
              <div className="flex flex-col gap-1">
                <span className="font-mono text-xs">{event.action}</span>
                <span className="text-xs text-muted-foreground">{new Date(event.timestamp).toLocaleString()}</span>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline">{event.targetType}</Badge>
                <span className="font-mono text-xs text-muted-foreground">{event.targetId}</span>
              </div>
            </li>
          ))}
        </ul>
      )}

      <AuditDrawer
        apiBaseUrl={apiBaseUrl}
        cookieHeader={cookieHeader}
        projectId={projectId}
        open={open}
        onOpenChange={setOpen}
        state={state}
        events={events}
        total={total}
        limit={limit}
        offset={offset}
        onRefresh={onRefresh}
        isLoading={isLoading}
      />
    </div>
  );
}
