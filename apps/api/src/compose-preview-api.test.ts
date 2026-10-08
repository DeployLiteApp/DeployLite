import { afterEach, describe, expect, it, vi } from "vitest";
import { hashSessionToken } from "@deploylite/db";
import { InMemoryEnvSecretValueRepository, type ProjectRepository, type CanonicalRoleName } from "@deploylite/domain";
import { buildApiApp, InMemoryAuditRepository, InMemoryAuthUserRepository, InMemorySessionRepository } from "./app.js";

const apps: Awaited<ReturnType<typeof buildApiApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); vi.restoreAllMocks(); });
const image = `registry.example.com/team/app@sha256:${"a".repeat(64)}`;
const valid = { document: JSON.stringify({ services: { web: { image, volumes: [{ type: "volume", source: "data", target: "/data" }] } }, volumes: { data: {} } }) };
async function fixture(role: CanonicalRoleName = "operator", scopeProject = "project-1", action = "project.deploy") {
  const items = new Map<string, import("@deploylite/contracts").Project>();
  const projects: ProjectRepository = { save: async (project) => { items.set(project.id, project); return project; }, findById: async (id) => items.get(id) ?? null, list: async () => [...items.values()], remove: async (id) => items.delete(id) };
  await projects.save({ id: "project-1", name: "Preview", repoUrl: "https://github.com/DeployLiteApp/DeployLite", defaultBranch: "main", buildCommand: null, runCommand: null, port: null, description: null, imageTag: null });
  const secretValues = new InMemoryEnvSecretValueRepository(), audit = new InMemoryAuditRepository(), sessions = new InMemorySessionRepository();
  const user = { id: "compose-user", email: "compose@example.test", emailNormalized: "compose@example.test", passwordHash: "unused-fixture-hash", role, status: "active" as const, createdAt: new Date(), updatedAt: new Date() };
  await sessions.create({ userId: user.id, tokenHash: hashSessionToken("compose-fixture-token"), expiresAt: new Date("2027-01-01T00:00:00Z") });
  const app = await buildApiApp({
    env: { NODE_ENV: "test", DEPLOYLITE_SECRET_KEY: "compose_fixture_env_secret_key_1234567890" }, corsOrigin: false,
    authConfig: { cookieName: "compose_session", cookieSecure: false },
    auth: { users: new InMemoryAuthUserRepository([user]), sessions, audit },
    state: { projects, envSecretValues: secretValues, controlGrants: { listForActor: async (actorId) => [{ id: "compose-grant", actorId, action: action as "project.deploy", scope: { kind: "project", projectId: scopeProject } }] } }
  });
  apps.push(app); audit.inputs.length = 0; audit.events.length = 0;
  const save = vi.spyOn(projects, "save"), remove = vi.spyOn(projects, "remove"), decryptRead = vi.spyOn(secretValues, "listEncryptedByProject");
  const post = (payload: unknown = valid, project = "project-1", authenticated = true) => app.inject({ method: "POST", url: `/api/v1/projects/${project}/compose/preview`, headers: authenticated ? { cookie: "compose_session=compose-fixture-token" } : {}, payload: payload as Record<string, unknown> });
  return { app, post, audit, save, remove, decryptRead };
}

describe("project-scoped Compose preview API", () => {
  it("returns an owned canonical plan with audit correlation and no runtime or secret materialization", async () => {
    const f = await fixture(), response = await f.post(), result = response.json();
    expect(response.statusCode).toBe(200);
    expect(result.data.preview).toMatchObject({ projectId: "project-1", status: "preview", executionAllowed: false, services: [{ name: "web" }], volumes: [{ key: "data", projectId: "project-1" }] });
    expect(f.save).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled(); expect(f.decryptRead).not.toHaveBeenCalled();
    expect(f.audit.inputs).toEqual([expect.objectContaining({ action: "compose.preview", targetType: "project", targetId: "project-1", requestId: result.requestId, correlationId: response.headers["x-correlation-id"], metadata: expect.objectContaining({ projectId: "project-1", serviceCount: 1, volumeCount: 1, inputDigest: result.data.preview.configDigest }) })]);
    expect(JSON.stringify(f.audit.inputs)).not.toContain(image);
  });

  it("requires a session before parsing source", async () => {
    const f = await fixture(), response = await f.post(valid, "project-1", false);
    expect(response.statusCode).toBe(401); expect(response.json().error.code).toBe("UNAUTHENTICATED");
  });
  it.each(["read-only", "auditor"] as const)("denies %s even with a grant", async (role) => {
    const f = await fixture(role); expect((await f.post()).statusCode).toBe(403);
  });
  it.each(["other-project", "project.update"])("rejects mismatched scope/action %s", async (mismatch) => {
    const f = await fixture("operator", mismatch === "other-project" ? mismatch : "project-1", mismatch === "project.update" ? mismatch : "project.deploy");
    const response = await f.post(); expect(response.statusCode).toBe(403);
    expect(f.audit.inputs).toEqual([expect.objectContaining({ action: "compose.preview.denied" })]);
  });
  it("returns 404 only after project authorization for a missing project", async () => {
    const f = await fixture("operator", "missing"); expect((await f.post(valid, "missing")).statusCode).toBe(404);
  });
  it.each([
    { document: "{fixture_inline_secret" },
    { document: JSON.stringify({ services: { web: { image, environment: { API_KEY: "fixture_inline_secret" } } } }) },
    { document: JSON.stringify({ services: { web: { image, labels: { fixture_inline_secret: "raw" } } } }) },
    { ...valid, execute: true }
  ])("rejects unsafe source/body without echoing secrets or persisting source", async (body) => {
    const f = await fixture(), response = await f.post(body);
    expect(response.statusCode).toBe(400);
    expect(response.body + JSON.stringify(f.audit.inputs)).not.toContain("fixture_inline_secret");
    expect(response.json().data).toBeNull(); expect(f.save).not.toHaveBeenCalled(); expect(f.decryptRead).not.toHaveBeenCalled();
  });
  it("does not publish success when the required audit write fails", async () => {
    const f = await fixture(); vi.spyOn(f.audit, "append").mockRejectedValueOnce(new Error("fixture_internal_error"));
    const response = await f.post(); expect(response.statusCode).toBe(500); expect(response.json().data).toBeNull();
    expect(response.body).not.toContain("fixture_internal_error");
  });
});
