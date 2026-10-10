import Fastify, { type preHandlerAsyncHookHandler } from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { registerBackupRetentionPreviewRoute } from "./backup-retention-preview-route.js";
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
const body = {schemaVersion: 1, volumeKey: "data", destinationId: "local-1", keepNewest: 1};
function record(archiveId: string, createdAtMs: number) {
  return {schemaVersion: 1 as const, createdAtMs, receipt: {schemaVersion: 1 as const, action: "compose.volume.backup" as const, agentId: "agent-1", commandId: "command-1", projectId: "project-1", inputDigest: "a".repeat(64), correlationId: "correlation-1", volumeKey: "data", destinationId: "local-1", archiveId, status: "created" as const, consistency: "stopped" as const, archiveBytes: 100, entries: 2, archiveSha256: "b".repeat(64), manifestSha256: "c".repeat(64), idempotent: false, redacted: true as const}};
}
async function fixture(options: {authenticated?: boolean; grantScope?: string; available?: boolean; auditFails?: boolean; hung?: boolean; foreignAgent?: boolean; dropInventoryAfterAudit?: boolean; changeAgentAfterAudit?: boolean} = {}) {
  const inventory = {available: vi.fn(() => true), list: vi.fn(async () => options.hung ? new Promise<ReturnType<typeof record>[]>(() => {}) : [record("old", 1), record("middle", 2), record("new", 3)].map(row => options.foreignAgent ? {...row, receipt: {...row.receipt, agentId: "foreign"}} : row))};
  const protections = {available: () => options.available ?? true, list: vi.fn(async () => ["old"])};
  const projects = {findById: vi.fn(async (id: string) => ({id}))};
  const audit = {append: vi.fn(async (event: unknown) => { if (options.auditFails) throw new Error("private-audit-sentinel"); if ((event as {action?: string}).action === "backup.retention.preview") {
      if (options.dropInventoryAfterAudit) inventory.available.mockReturnValue(false);
      if (options.changeAgentAfterAudit) access.agentId = "foreign";
    } return event; })};
  const requireAuth: preHandlerAsyncHookHandler = async (request, reply) => {
    if (options.authenticated === false) return void reply.code(401).send({error: {code: "UNAUTHENTICATED"}});
    Object.assign(request, {auth: {user: {id: "actor-1", role: "operator"}}, correlationContext: {requestId: "request-1", correlationId: "correlation-1"}});
  };
  const access = {agentId: "agent-1", inventory, protections, deadlineMs: 20};
  const app = Fastify(); apps.push(app);
  registerBackupRetentionPreviewRoute(app, {prefix: "/api/v1", projects: projects as never, audit: audit as never,
    grants: {listForActor: async actorId => [{id: "grant-1", actorId, action: "project.update", scope: {kind: "project", projectId: options.grantScope ?? "project-1"}}]},
    access: new Map([["project-1", access]]), requireAuth, requireRole: async () => {},
    ok: (_request, data) => ({data}), error: (_request, code, message) => ({error: {code, message}})});
  return {inventory, protections, projects, audit, post: (payload: unknown = body) => app.inject({method: "POST", url: "/api/v1/projects/project-1/backups/retention/preview", payload: payload as Record<string, unknown>})};
}
it("returns only a scoped effect-free plan and appends correlated safe audit", async () => {
  const f = await fixture(), response = await f.post();
  expect(response.statusCode).toBe(200);
  expect(response.json().data.plan).toMatchObject({executionAllowed: false, protectedArchiveIds: ["old"], retainedArchiveIds: ["new", "old"], deletionCandidates: [{archiveId: "middle"}]});
  expect(f.audit.append).toHaveBeenCalledWith(expect.objectContaining({action: "backup.retention.preview", targetId: "project-1", correlationId: "correlation-1", metadata: expect.objectContaining({inventoryDigest: expect.any(String), planDigest: expect.any(String)})}));
});
it("requires authentication before reading inventory or project", async () => {
  const f = await fixture({authenticated: false}); expect((await f.post()).statusCode).toBe(401);
  expect(f.inventory.list).not.toHaveBeenCalled(); expect(f.projects.findById).not.toHaveBeenCalled();
});
it("requires the existing project.update grant before any project or archive read", async () => {
  const f = await fixture({grantScope: "foreign"}); expect((await f.post()).statusCode).toBe(403);
  expect(f.inventory.list).not.toHaveBeenCalled(); expect(f.projects.findById).not.toHaveBeenCalled();
});
it.each([{backups: []}, {protectedArchiveIds: []}, {execute: true}])("rejects caller inventory, protection and execution authority %#", async extra => {
  const f = await fixture(); expect((await f.post({...body, ...extra})).statusCode).toBe(400);
  expect(f.inventory.list).not.toHaveBeenCalled();
});
it("fails closed when server restore-protection storage is unavailable", async () => {
  const f = await fixture({available: false}); expect((await f.post()).statusCode).toBe(503);
  expect(f.inventory.list).not.toHaveBeenCalled();
});
it("rejects a stale inventory digest with conflict", async () => {
  const f = await fixture(); expect((await f.post({...body, expectedInventoryDigest: "e".repeat(64)})).statusCode).toBe(409);
});
it("does not claim success or expose private errors when audit storage fails", async () => {
  const f = await fixture({auditFails: true}), response = await f.post();
  expect(response.statusCode).toBe(503); expect(response.body).not.toContain("private-audit-sentinel");
});
it("bounds a storage read that ignores cancellation", async () => {
  const f = await fixture({hung: true}); expect((await f.post()).statusCode).toBe(503);
});

it("rejects archive evidence from another configured agent", async () => {
  const f = await fixture({foreignAgent: true}); expect((await f.post()).statusCode).toBe(503);
});

it("withholds the preview when durable inventory becomes unavailable during audit", async () => {
  const f = await fixture({dropInventoryAfterAudit: true}); expect((await f.post()).statusCode).toBe(503);
});
it("withholds the preview when its configured agent changes during audit", async () => {
  const f = await fixture({changeAgentAfterAudit: true}); expect((await f.post()).statusCode).toBe(503);
});
