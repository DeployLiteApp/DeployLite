import { describe, expect, it, vi } from "vitest";
import { AUDIT_PAGE_SIZE, buildAuditHistoryRequest, createLatestAuditRequestRunner, resolveAuditHistoryResult, resolveAuditLoadIntent, type AuditHistoryRequest } from "./audit-history-pagination-model.js";
import type { AuditListResult } from "@/lib/auth-boundary";

const request = (offset: number): AuditHistoryRequest => ({ apiBaseUrl: "https://api.example.test", cookieHeader: "session=operator", projectId: "project_alpha", limit: AUDIT_PAGE_SIZE, offset });
const ready = (offset: number): AuditListResult => ({ kind: "ready", requestId: `request_${offset}`, data: { events: [], total: 125, limit: AUDIT_PAGE_SIZE, offset } });

describe("audit pagination model", () => {
  it("resolves page, refresh, and filter intents with a fixed page size", () => {
    const current = { filters: { actor: "user_admin_1", action: "project." }, offset: 50 };
    expect(resolveAuditLoadIntent({ kind: "page", offset: 100 }, current)).toEqual({ filters: current.filters, offset: 100 });
    expect(resolveAuditLoadIntent({ kind: "refresh" }, current)).toEqual(current);
    expect(resolveAuditLoadIntent({ kind: "filter", patch: { actor: undefined } }, current)).toEqual({ filters: { actor: undefined, action: "project." }, offset: 0 });
  });
  it("builds exact requests for first, next, and final windows", () => {
    const base = { apiBaseUrl: "https://api.example.test", cookieHeader: "session=operator", projectId: "project_alpha" };
    expect(buildAuditHistoryRequest({ ...base, cursor: { filters: {}, offset: 0 } })).toMatchObject({ limit: 50, offset: 0 });
    expect(buildAuditHistoryRequest({ ...base, cursor: { filters: {}, offset: 50 } })).toMatchObject({ limit: 50, offset: 50 });
    expect(buildAuditHistoryRequest({ ...base, cursor: { filters: {}, offset: 100 } })).toMatchObject({ limit: 50, offset: 100 });
  });
  it("commits only the newest deferred response", async () => {
    const deferred: Array<{ resolve: (result: AuditListResult) => void }> = [];
    const load = vi.fn((nextRequest: AuditHistoryRequest) => new Promise<AuditListResult>((resolve) => { deferred.push({ resolve }); expect(nextRequest.limit).toBe(AUDIT_PAGE_SIZE); }));
    const commits: number[] = []; const loading: boolean[] = [];
    const run = createLatestAuditRequestRunner(load, (nextRequest) => commits.push(nextRequest.offset ?? 0), (value) => loading.push(value));
    const first = run(request(0)); const second = run(request(50));
    deferred[1]!.resolve(ready(50)); await second; deferred[0]!.resolve(ready(0)); await first;
    expect(commits).toEqual([50]); expect(loading).toEqual([true, true, false]);
  });
  it("preserves the existing error state shape", () => {
    expect(resolveAuditHistoryResult({ kind: "error", reason: "api-unreachable" })).toEqual({ events: [], total: 0, state: { kind: "error", reason: "api-unreachable", status: undefined } });
  });
});
