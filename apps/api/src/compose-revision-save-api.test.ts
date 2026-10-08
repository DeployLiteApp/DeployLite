import { afterEach, describe, expect, it, vi } from "vitest";
import { hashSessionToken } from "@deploylite/db";
import { createComposePreview, InMemoryComposeRevisionSaveStore, InMemoryEnvSecretValueRepository, type ProjectRepository } from "@deploylite/domain";
import type { CanonicalRole, ComposeRevisionV1, Project } from "@deploylite/contracts";
import { buildApiApp, createInMemoryExecutionRepositories, InMemoryAuditRepository, InMemoryAuthUserRepository, InMemorySessionRepository } from "./app.js";
const apps: Awaited<ReturnType<typeof buildApiApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); vi.restoreAllMocks(); });
const image = `registry.example.com/team/app@sha256:${"a".repeat(64)}`;
const policy = { policyVersion: "default-image-policy-v1", trustedHosts: ["registry.example.com"], allowTags: true, allowDigests: true };
const document = JSON.stringify({ services: { web: { image, environment: { TOKEN: "${APP_TOKEN}" } } } });
function payload(overrides: Record<string, unknown> = {}) { return { document, composeId: null, expectedRevisionId: null, expectedPreviewDigest: createComposePreview(document, "project-1", policy).configDigest, ...overrides }; }
async function fixture(options: { role?: CanonicalRole; permission?: "both" | "deploy-only" | "foreign"; capability?: "enabled" | "disabled" | "missing"; cookie?: boolean } = {}) {
  const project: Project = { id: "project-1", name: "Compose save", repoUrl: "https://github.com/DeployLiteApp/DeployLite", defaultBranch: "main", buildCommand: null, runCommand: null, port: null, description: null, imageTag: null };
  const projects: ProjectRepository = { save: async (item) => item, findById: async (id) => id === project.id ? project : null, list: async () => [project], remove: async () => false };
  const audit = new InMemoryAuditRepository(), shared = createInMemoryExecutionRepositories(projects, audit);
  const store = new InMemoryComposeRevisionSaveStore({ ledger: shared.completion, appendAudit: (input) => { audit.appendSynchronous(input); } });
  vi.spyOn(store, "available").mockReturnValue(options.capability !== "disabled");
  const sessions = new InMemorySessionRepository(), secrets = new InMemoryEnvSecretValueRepository();
  const user = { id: "compose-save-user", email: "compose-save@example.test", emailNormalized: "compose-save@example.test", passwordHash: "unused-fixture", role: options.role ?? "operator", status: "active" as const, createdAt: new Date(), updatedAt: new Date() };
  await sessions.create({ userId: user.id, tokenHash: hashSessionToken("compose-save-session"), expiresAt: new Date("2027-01-01T00:00:00Z") });
  const apiOptions = { imagePolicy: policy, env: { NODE_ENV: "test", DEPLOYLITE_SECRET_KEY: "compose_save_fixture_key_1234567890" }, corsOrigin: false as const,
    authConfig: { cookieName: "compose_save_session", cookieSecure: false }, auth: { users: new InMemoryAuthUserRepository([user]), sessions, audit },
    state: { projects, envSecretValues: secrets, deployments: shared.deployments, executionCompletion: shared.completion, controlDeletes: shared.controls, controlRedeploy: shared.controls,
      composeRevisionSaves: options.capability === "missing" ? undefined : store,
      controlGrants: { listForActor: async (actorId: string) => (options.permission === "deploy-only" ? ["project.deploy" as const] : ["project.update" as const, "project.deploy" as const]).map((action) => ({ id: "save-grant-" + action, actorId, action, scope: { kind: "project" as const, projectId: options.permission === "foreign" ? "foreign-project" : project.id } })) } } };
  const app = await buildApiApp(apiOptions); apps.push(app); audit.inputs.length = 0; audit.events.length = 0;
  const save = vi.spyOn(store, "save"), list = vi.spyOn(store, "listResources"), projectRead = vi.spyOn(projects, "findById"), projectSave = vi.spyOn(projects, "save"), decrypt = vi.spyOn(secrets, "listEncryptedByProject");
  const headers = options.cookie === false ? {} : { cookie: "compose_save_session=compose-save-session" };
  return { store, shared, audit, save, list, projectRead, projectSave, decrypt,
    post: (body = payload(), key: string | null = "save-key") => app.inject({ method: "POST", url: "/api/v1/projects/project-1/compose", payload: body, headers: { ...headers, ...(key === null ? {} : { "x-control-idempotency-key": key }) } }),
    get: (suffix = "") => app.inject({ method: "GET", url: "/api/v1/projects/project-1/compose" + suffix, headers }) };
}
async function firstRevision(f: Awaited<ReturnType<typeof fixture>>): Promise<ComposeRevisionV1> { const response = await f.post(); expect(response.statusCode).toBe(201); return response.json().data.revision; }
describe("actual API shared Compose save and logical resource collection", () => {
  it("saves server-owned revision metadata and atomically completes the existing command ledger", async () => {
    const f = await fixture(), response = await f.post(); expect(response.statusCode).toBe(201);
    const data = response.json().data; expect(data).toMatchObject({ idempotent: false, revision: { projectId: "project-1", createdBy: "compose-save-user", number: 1, preview: { executionAllowed: false } } });
    expect(data.revision.id).toBe(data.commandId); expect(data.revision.composeId).toBe(data.commandId); expect(f.shared.completion.commands.size).toBe(1);
    expect([...f.shared.completion.commands.values()][0]).toMatchObject({ id: data.commandId, action: "project.update", status: "completed", result: { operation: "compose.revision.save", revisionId: data.revision.id } });
    expect(f.audit.inputs.filter((event) => event.action === "compose.revision.saved")).toHaveLength(1); expect(JSON.stringify(f.audit.inputs)).not.toContain("APP_TOKEN");
    expect(f.projectSave).not.toHaveBeenCalled(); expect(f.decrypt).not.toHaveBeenCalled();
  });
  it("returns one stable receipt/revision on an identical HTTP retry without a second audit", async () => {
    const f = await fixture(), first = await f.post(), retry = await f.post(); expect(first.statusCode).toBe(201); expect(retry.statusCode).toBe(200);
    expect(retry.json().data).toEqual({ ...first.json().data, idempotent: true }); expect(f.shared.completion.commands.size).toBe(1); expect(f.audit.inputs.filter((event) => event.action === "compose.revision.saved")).toHaveLength(1);
  });
  it("appends a second revision through the owned Compose/latest binding and exposes actual detail/history", async () => {
    const f = await fixture(), first = await firstRevision(f);
    const next = await f.post(payload({ composeId: first.composeId, expectedRevisionId: first.id }), "save-key-2"); expect(next.statusCode).toBe(201); expect(next.json().data.revision.number).toBe(2);
    const detail = await f.get(`/${first.composeId}/revisions/${first.id}`); expect(detail.statusCode).toBe(200); expect(detail.json().data.revision.id).toBe(first.id);
    const history = await f.get(`/${first.composeId}/revisions`); expect(history.statusCode).toBe(200); expect(history.json().data.total).toBe(2);
  });
  it.each([["read-only", "both"], ["auditor", "both"], ["operator", "deploy-only"], ["operator", "foreign"]] as const)("requires current role and exact project.update scope before reads/save for %s/%s", async (role, permission) => {
    const f = await fixture({ role, permission }); expect((await f.post()).statusCode).toBe(403); expect(f.projectRead).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled(); expect(f.store.available).not.toHaveBeenCalled();
  });
  it("requires a session before storage/project lookup", async () => { const f = await fixture({ cookie: false }); expect((await f.post()).statusCode).toBe(401); expect(f.projectRead).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled(); });
  it.each(["missing", "disabled"] as const)("fails closed on %s write storage without an automatic memory fallback", async (capability) => { const f = await fixture({ capability }); expect((await f.post()).statusCode).toBe(503); expect(f.save).not.toHaveBeenCalled(); });
  it.each([null, "invalid key"])("rejects missing/invalid idempotency header before save %#", async (key) => { const f = await fixture(); expect((await f.post(payload(), key)).statusCode).toBe(400); expect(f.save).not.toHaveBeenCalled(); });
  it("rejects stale preview digest without command/revision publication", async () => { const f = await fixture(); const response = await f.post(payload({ expectedPreviewDigest: "b".repeat(64) })); expect(response.statusCode).toBe(409); expect(f.save).not.toHaveBeenCalled(); expect(f.shared.completion.commands.size).toBe(0); });
  it("rejects literal source and forbidden actor metadata with fixed safe errors", async () => {
    const f = await fixture();
    for (const body of [payload({ document: JSON.stringify({ services: { web: { image, environment: { TOKEN: "fixture_literal_secret" } } } }) }), payload({ createdBy: "fixture_literal_secret" })]) {
      const response = await f.post(body); expect(response.statusCode).toBe(400); expect(response.body + JSON.stringify(f.audit.inputs)).not.toContain("fixture_literal_secret");
    }
    expect(f.save).not.toHaveBeenCalled(); expect(f.shared.completion.commands.size).toBe(0);
  });
  it("rejects a competing stale update without a second append or command reservation", async () => {
    const f = await fixture(), first = await firstRevision(f), body = payload({ composeId: first.composeId, expectedRevisionId: first.id });
    expect((await f.post(body, "next-key")).statusCode).toBe(201); expect((await f.post(body, "stale-key")).statusCode).toBe(409); expect(f.shared.completion.commands.size).toBe(2);
  });
  it("does not expose a storage/audit exception or publish an unaudited revision", async () => {
    const f = await fixture(); vi.spyOn(f.audit, "appendSynchronous").mockImplementation(() => { throw new Error("fixture_literal_secret"); });
    const response = await f.post(); expect(response.statusCode).toBe(503); expect(response.body).not.toContain("fixture_literal_secret"); expect(f.shared.completion.commands.size).toBe(0);
  });
  it("lists only safe owned resource metadata with real saved identity", async () => {
    const f = await fixture(), first = await firstRevision(f), response = await f.get(); expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ total: 1, resources: [{ id: first.composeId, projectId: "project-1", latestRevisionId: first.id, latestNumber: 1, serviceNames: ["web"] }] });
    expect(response.body).not.toContain(image); expect(response.body).not.toContain("APP_TOKEN"); expect(response.body).not.toContain("canonicalDocument");
  });
  it.each(["?limit=0", "?offset=-1", "?source=fixture_literal_secret"])("rejects invalid collection queries without data/source reflection %s", async (query) => {
    const f = await fixture(), response = await f.get(query); expect(response.statusCode).toBe(400); expect(response.body).not.toContain("fixture_literal_secret"); expect(f.list).not.toHaveBeenCalled();
  });
});
