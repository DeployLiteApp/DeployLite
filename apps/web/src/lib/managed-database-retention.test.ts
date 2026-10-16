import {expect, it, vi} from "vitest";
import {previewManagedDatabaseRetention} from "./managed-database-retention";
const scope = {projectId: "project-a", databaseId: "orders"};
const input = {schemaVersion: 1, volumeKey: "db-orders", destinationId: "destination-a", keepNewest: 1};
function fixture() {
  const plan = {...input, projectId: scope.projectId, operation: "backup.retention.preview", executionAllowed: false,
    retainedArchiveIds: ["new-compose", "protected-native"], protectedArchiveIds: ["protected-native"],
    deletionCandidates: [{archiveId: "candidate", archiveSha256: "a".repeat(64), manifestSha256: "b".repeat(64), createdAtMs: 1}],
    inventoryDigest: "c".repeat(64), planDigest: "d".repeat(64)};
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({data: {plan}, error: null, requestId: "preview-request"})));
  return {plan, fetchImpl, options: {apiBaseUrl: "https://api.example.test", actorId: "actor-a", fetchImpl}};
}
it("explicitly POSTs the existing strict count contract with current actor, cookies and no command key", async () => {
  const f = fixture(), result = await previewManagedDatabaseRetention(scope, f.options, input);
  expect(result).toEqual({kind: "ready", plan: f.plan}); expect(f.fetchImpl).toHaveBeenCalledOnce();
  const [url, request] = f.fetchImpl.mock.calls[0]!;
  expect(String(url)).toBe("https://api.example.test/api/v1/projects/project-a/backups/retention/preview");
  expect(request).toMatchObject({method: "POST", credentials: "include", redirect: "error", cache: "no-store"});
  expect(JSON.parse(String(request!.body))).toEqual(input);
  expect(new Headers(request!.headers).get("x-deploylite-expected-actor-id")).toBe("actor-a");
  expect(new Headers(request!.headers).has("idempotency-key")).toBe(false);
});
it.each([{keepNewest: 0}, {keepNewest: 10001}, {keepNewest: 1.5}, {volumeKey: "db-foreign"}, {protectedArchiveIds: []}, {execute: true}])("refuses invalid count/scope/caller authority %# before HTTP", async extra => {
  const f = fixture(); expect((await previewManagedDatabaseRetention(scope, f.options, {...input, ...extra})).kind).toBe("error"); expect(f.fetchImpl).not.toHaveBeenCalled();
});
it.each(["project", "volume", "destination", "count", "effect", "private", "missing-protection", "overlap", "duplicate", "unretained-protection", "future"])("withholds detached or incomplete %s plan", async field => {
  const f = fixture(), plan = f.plan as Record<string, unknown>;
  if (field === "project") plan.projectId = "foreign";
  if (field === "volume") plan.volumeKey = "db-foreign";
  if (field === "destination") plan.destinationId = "foreign";
  if (field === "count") plan.keepNewest = 2;
  if (field === "effect") plan.executionAllowed = true;
  if (field === "private") plan.password = "private-sentinel";
  if (field === "missing-protection") delete plan.protectedArchiveIds;
  if (field === "overlap") plan.retainedArchiveIds = ["candidate", "protected-native"];
  if (field === "duplicate") plan.retainedArchiveIds = ["new-compose", "new-compose", "protected-native"];
  if (field === "unretained-protection") plan.protectedArchiveIds = ["foreign"];
  if (field === "future") f.plan.deletionCandidates[0]!.createdAtMs = Date.now() + 100000;
  expect(await previewManagedDatabaseRetention(scope, f.options, input)).toEqual({kind: "error", message: "Retention preview is unavailable."});
});
it.each([403, 409, 503])("withholds forbidden/stale/unavailable %s without exposing errors or retrying", async status => {
  const f = fixture(); f.fetchImpl.mockImplementation(async () => new Response("private-sentinel", {status}));
  expect((await previewManagedDatabaseRetention(scope, f.options, input)).kind).toBe("error"); expect(f.fetchImpl).toHaveBeenCalledOnce();
});
it("never fetches on invalid actor or pre-abort", async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  expect((await previewManagedDatabaseRetention(scope, {...f.options, signal: controller.signal}, input)).kind).toBe("error");
  expect((await previewManagedDatabaseRetention(scope, {...f.options, actorId: ""}, input)).kind).toBe("error"); expect(f.fetchImpl).not.toHaveBeenCalled();
});

it.each(["missing-newest", "excess-unprotected"])("withholds contradictory %s count summaries", async field => {
  const f = fixture(); f.plan.retainedArchiveIds = field === "missing-newest" ? [] : ["new-compose", "protected-native", "extra"];
  if (field === "missing-newest") f.plan.protectedArchiveIds = [];
  expect((await previewManagedDatabaseRetention(scope, f.options, input)).kind).toBe("error");
});
