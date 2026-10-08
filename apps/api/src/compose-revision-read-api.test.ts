import { afterEach, describe, expect, it, vi } from "vitest";
import { hashSessionToken } from "@deploylite/db";
import { createComposePreview, createComposeRevision, InMemoryComposeRevisionRepository, InMemoryEnvSecretValueRepository, type ProjectRepository } from "@deploylite/domain";
import type { CanonicalRole, Project } from "@deploylite/contracts";
import { buildApiApp, InMemoryAuditRepository, InMemoryAuthUserRepository, InMemorySessionRepository } from "./app.js";

const apps: Awaited<ReturnType<typeof buildApiApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); vi.restoreAllMocks(); });
const image = `registry.example.com/team/app@sha256:${"a".repeat(64)}`;
const policy = { policyVersion: "revision-read-fixture", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true };
const document = JSON.stringify({ services: { web: { image, environment: { TOKEN: "${APP_TOKEN}" } } } });
const preview = createComposePreview(document, "project-1", policy);
async function fixture(options: { role?: CanonicalRole; grantProject?: string; capability?: "missing" | "disabled" | "enabled"; projectPresent?: boolean; cookie?: boolean } = {}) {
  const project: Project = { id: "project-1", name: "Revision history", repoUrl: "https://github.com/DeployLiteApp/DeployLite", defaultBranch: "main", buildCommand: null, runCommand: null, port: null, description: null, imageTag: null };
  const projects: ProjectRepository = { save: async (item) => item, findById: async (id) => options.projectPresent !== false && id === project.id ? project : null, list: async () => [project], remove: async () => false };
  const store = new InMemoryComposeRevisionRepository();
  for (let number = 1; number <= 3; number++) await store.appendRevision(createComposeRevision({ document, projectId: project.id, composeId: "compose-1", revisionId: `revision-${number}`, revisionNumber: number, createdBy: "actor-1", createdAt: "2026-10-08T00:00:00Z", expectedPreviewDigest: preview.configDigest }, policy), number === 1 ? null : `revision-${number - 1}`);
  const reader = { available: vi.fn(() => options.capability !== "disabled"), listRevisions: vi.fn(store.listRevisions.bind(store)), findRevision: vi.fn(store.findRevision.bind(store)) };
  const audit = new InMemoryAuditRepository(), sessions = new InMemorySessionRepository(), secrets = new InMemoryEnvSecretValueRepository();
  const user = { id: "revision-read-user", email: "revision-read@example.test", emailNormalized: "revision-read@example.test", passwordHash: "unused-fixture-hash", role: options.role ?? "operator", status: "active" as const, createdAt: new Date(), updatedAt: new Date() };
  await sessions.create({ userId: user.id, tokenHash: hashSessionToken("revision-read-fixture-token"), expiresAt: new Date("2027-01-01T00:00:00Z") });
  const apiOptions = { env: { NODE_ENV: "test", DEPLOYLITE_SECRET_KEY: "revision_read_fixture_key_1234567890" }, corsOrigin: false as const, authConfig: { cookieName: "revision_read_session", cookieSecure: false }, auth: { users: new InMemoryAuthUserRepository([user]), sessions, audit }, state: { projects, envSecretValues: secrets, composeRevisionReads: options.capability === "missing" ? undefined : reader, controlGrants: { listForActor: async (actorId: string) => [{ id: "revision-read-grant", actorId, action: "project.deploy" as const, scope: { kind: "project" as const, projectId: options.grantProject ?? project.id } }] } } };
  const app = await buildApiApp(apiOptions); apps.push(app); audit.inputs.length = 0; audit.events.length = 0;
  const projectRead = vi.spyOn(projects, "findById"), projectSave = vi.spyOn(projects, "save"), decrypt = vi.spyOn(secrets, "listEncryptedByProject"), append = vi.spyOn(store, "appendRevision");
  return { reader, audit, projectRead, projectSave, decrypt, append, get: (path = "", query = "") => app.inject({ method: "GET", url: "/api/v1/projects/project-1/compose/compose-1/revisions" + path + query, headers: options.cookie === false ? {} : { cookie: "revision_read_session=revision-read-fixture-token" } }) };
}
describe("bounded project-owned revision reads through the actual API", () => {
  it("returns a paged metadata summary without canonical source, images or references", async () => {
    const f = await fixture(); const response = await f.get("", "?limit=1&offset=1");
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ total: 3, limit: 1, offset: 1, revisions: [{ id: "revision-2", number: 2, configDigest: preview.configDigest, executionAllowed: false }] });
    expect(response.json().data.revisions).toHaveLength(1);
    expect(response.body).not.toContain("canonicalDocument"); expect(response.body).not.toContain(image); expect(response.body).not.toContain("APP_TOKEN");
    expect(f.reader.listRevisions).toHaveBeenCalledWith("project-1", "compose-1", { limit: 1, offset: 1 });
    expect(f.audit.inputs.at(-1)).toMatchObject({ action: "compose.revisions.read", targetType: "project", targetId: "project-1" });
    expect(f.projectSave).not.toHaveBeenCalled(); expect(f.decrypt).not.toHaveBeenCalled(); expect(f.append).not.toHaveBeenCalled();
  });
  it("returns one validated immutable revision under the exact project/Compose scope", async () => {
    const f = await fixture(); const response = await f.get("/revision-2");
    expect(response.statusCode).toBe(200); expect(response.json().data.revision).toMatchObject({ id: "revision-2", projectId: "project-1", composeId: "compose-1", number: 2, preview: { executionAllowed: false, configDigest: preview.configDigest } });
    expect(f.reader.findRevision).toHaveBeenCalledWith("project-1", "revision-2"); expect(f.append).not.toHaveBeenCalled(); expect(f.decrypt).not.toHaveBeenCalled();
    expect(JSON.stringify(f.audit.inputs)).not.toContain(image); expect(JSON.stringify(f.audit.inputs)).not.toContain("APP_TOKEN");
  });
  it.each([["read-only", "project-1"], ["auditor", "project-1"], ["operator", "foreign-project"]] as const)("checks existing preview role/scope before any storage/project read for %s/%s", async (role, grantProject) => {
    const f = await fixture({ role, grantProject }); expect((await f.get()).statusCode).toBe(403);
    expect(f.projectRead).not.toHaveBeenCalled(); expect(f.reader.available).not.toHaveBeenCalled(); expect(f.reader.listRevisions).not.toHaveBeenCalled(); expect(f.reader.findRevision).not.toHaveBeenCalled();
  });
  it("rejects a missing session before storage/project reads", async () => {
    const f = await fixture({ cookie: false }); expect((await f.get()).statusCode).toBe(401); expect(f.projectRead).not.toHaveBeenCalled(); expect(f.reader.listRevisions).not.toHaveBeenCalled();
  });
  it.each(["missing", "disabled"] as const)("fails closed for %s storage capability", async (capability) => {
    const f = await fixture({ capability }); const response = await f.get(); expect(response.statusCode).toBe(503); expect(response.json().error.code).toBe("COMPOSE_REVISION_READ_UNAVAILABLE"); expect(f.reader.listRevisions).not.toHaveBeenCalled();
  });
  it("returns an owned-project 404 before querying revisions", async () => {
    const f = await fixture({ projectPresent: false }); expect((await f.get()).statusCode).toBe(404); expect(f.projectRead).toHaveBeenCalledWith("project-1"); expect(f.reader.listRevisions).not.toHaveBeenCalled();
  });
  it.each(["?limit=0", "?limit=101", "?limit=1.5", "?offset=-1", "?offset=1000001", "?source=fixture_literal_secret", "?limit=1&limit=2"])("rejects invalid/ambiguous pagination before storage reads %s", async (query) => {
    const f = await fixture(); const response = await f.get("", query); expect(response.statusCode).toBe(400); expect(response.body).not.toContain("fixture_literal_secret"); expect(f.reader.listRevisions).not.toHaveBeenCalled();
  });
  it("returns a missing or foreign Compose association as a source-safe404", async () => {
    const f = await fixture(); f.reader.findRevision.mockResolvedValue(createComposeRevision({ document, projectId: "project-1", composeId: "another-compose", revisionId: "revision-foreign", revisionNumber: 1, createdBy: "actor-1", createdAt: "2026-10-08T00:00:00Z", expectedPreviewDigest: preview.configDigest }, policy));
    const response = await f.get("/revision-foreign"); expect(response.statusCode).toBe(404); expect(f.reader.findRevision).toHaveBeenCalledWith("project-1", "revision-foreign"); expect(response.body).not.toContain("another-compose");
  });
  it("fails closed on corrupt/foreign page data without reflecting source", async () => {
    const f = await fixture(); const page = await f.reader.listRevisions("project-1", "compose-1", { limit: 20, offset: 0 }); f.reader.listRevisions.mockClear(); page.revisions[0]!.projectId = "foreign-project"; f.reader.listRevisions.mockResolvedValue(page);
    const response = await f.get(); expect(response.statusCode).toBe(503); expect(response.body).not.toContain("foreign-project"); expect(response.body).not.toContain(image);
  });
  it.each(["canonical-image", "preview-image", "reference-key", "reference-id", "tag-image"] as const)("rejects corrupt stored %s on detail and history reads without reflecting credentials", async (field) => {
    for (const path of ["/revision-2", ""]) {
      const f = await fixture(); const raw = (await f.reader.findRevision("project-1", "revision-2"))!;
      const credentialImage = `fixture_user:fixture_literal_secret@registry.example.com/team/app@sha256:${"a".repeat(64)}`;
      if (field === "canonical-image") {
        const canonical = JSON.parse(raw.preview.canonicalDocument) as { services: Record<string, { image: string }> };
        canonical.services.web!.image = credentialImage; raw.preview.canonicalDocument = JSON.stringify(canonical);
      } else if (field === "preview-image") raw.preview.services[0]!.image = credentialImage;
      else if (field === "tag-image") raw.preview.services[0]!.image = "registry.example.com/team/app:fixture_literal_secret";
      else if (field === "reference-key") raw.preview.services[0]!.secretRefs[0]!.key = "fixture_literal_secret";
      else raw.preview.services[0]!.secretRefs[0]!.secretRefId = "fixture_literal_secret";
      f.reader.findRevision.mockResolvedValue(raw);
      f.reader.listRevisions.mockResolvedValue({ revisions: [raw], total: 1, limit: 20, offset: 0 });
      const response = await f.get(path); expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe("COMPOSE_REVISION_READ_UNAVAILABLE");
      expect(response.body + JSON.stringify(f.audit.inputs)).not.toContain("fixture_literal_secret");
      expect(f.append).not.toHaveBeenCalled(); expect(f.decrypt).not.toHaveBeenCalled();
    }
  });
  it("does not echo a storage exception's source excerpt", async () => {
    const f = await fixture(); f.reader.listRevisions.mockRejectedValue(new Error("fixture_literal_secret")); const response = await f.get(); expect(response.statusCode).toBe(503); expect(response.body + JSON.stringify(f.audit.inputs)).not.toContain("fixture_literal_secret");
  });
  it("blocks a successful read response when the safe audit fails", async () => {
    const f = await fixture(); vi.spyOn(f.audit, "append").mockRejectedValue(new Error("fixture_literal_secret")); const response = await f.get(); expect(response.statusCode).toBe(500); expect(response.body).not.toContain("fixture_literal_secret"); expect(response.json().data).toBeNull();
  });
});
