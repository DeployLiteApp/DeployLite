import type { AuditEventListItem } from "@deploylite/contracts";
import type { AuditListFailureReason, AuditListResult } from "@/lib/auth-boundary";

export const AUDIT_PAGE_SIZE = 50;
export type AuditHistoryFilters = { actor?: string; action?: string };
export type AuditHistoryCursor = { filters: AuditHistoryFilters; offset: number };
export type AuditHistoryRequest = { apiBaseUrl?: string; cookieHeader: string; projectId: string; actor?: string; action?: string; limit?: number; offset?: number };
export type AuditHistoryResultState = { events: AuditEventListItem[]; total: number; state: { kind: "ready" } | { kind: "error"; reason: AuditListFailureReason; status?: number } };
export type AuditLoadIntent = { kind: "refresh" } | { kind: "filter"; patch: AuditHistoryFilters } | { kind: "page"; offset: number };

export function resolveAuditLoadIntent(intent: AuditLoadIntent, current: AuditHistoryCursor): AuditHistoryCursor {
  if (intent.kind === "filter") return { filters: { ...current.filters, ...intent.patch }, offset: 0 };
  if (intent.kind === "page") return { filters: current.filters, offset: Math.max(0, intent.offset) };
  return { filters: current.filters, offset: Math.max(0, current.offset) };
}

export function buildAuditHistoryRequest({ apiBaseUrl, cookieHeader, projectId, cursor, limit = AUDIT_PAGE_SIZE }: { apiBaseUrl: string | null; cookieHeader: string; projectId: string; cursor: AuditHistoryCursor; limit?: number }): AuditHistoryRequest {
  return { apiBaseUrl: apiBaseUrl ?? undefined, cookieHeader, projectId, actor: cursor.filters.actor, action: cursor.filters.action, limit, offset: Math.max(0, cursor.offset) };
}

export function resolveAuditHistoryResult(result: AuditListResult): AuditHistoryResultState {
  if (result.kind === "ready") return { events: result.data.events, total: result.data.total, state: { kind: "ready" } };
  return { events: [], total: 0, state: { kind: "error", reason: result.reason, status: result.status } };
}

export function createLatestAuditRequestRunner(load: (request: AuditHistoryRequest) => Promise<AuditListResult>, commit: (request: AuditHistoryRequest, result: AuditListResult) => void, setLoading: (loading: boolean) => void): (request: AuditHistoryRequest) => Promise<void> {
  let generation = 0;
  return async (request) => {
    const requestGeneration = ++generation;
    setLoading(true);
    try {
      const result = await load(request);
      if (requestGeneration === generation) commit(request, result);
    } finally {
      if (requestGeneration === generation) setLoading(false);
    }
  };
}
