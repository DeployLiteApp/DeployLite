import { afterEach, describe, expect, it, vi } from "vitest";
import { hashSessionToken } from "@deploylite/db";
import { InMemoryEnvSecretValueRepository, type ProjectRepository } from "@deploylite/domain";
import type { Project, CanonicalRole } from "@deploylite/contracts";
import { buildApiApp, InMemoryAuditRepository, InMemoryAuthUserRepository, InMemorySessionRepository } from "./app.js";
const apps: Awaited<ReturnType<typeof buildApiApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); vi.restoreAllMocks(); });
const image = `registry.example.com/team/app@sha256:${"a".repeat(64)}`;
const yaml = `services:
  web:
    image: ${image}
    environment: {TOKEN: '\${APP_TOKEN}'}
    volumes: [{type: volume, source: data, target: /data}]
volumes: {data: {}}
`;
const json = JSON.stringify({ services: { web: { image, environment: { TOKEN: "${APP_TOKEN}" }, volumes: [{ type: "volume", source: "data", target: "/data" }] } }, volumes: { data: {} } });
async function fixture(role: CanonicalRole = "operator", scope = "project-1") {
  const project: Project = { id: "project-1", name: "YAML preview", repoUrl: "https://github.com/DeployLiteApp/DeployLite", defaultBranch: "main", buildCommand: null, runCommand: null, port: null, description: null, imageTag: null };
  const projects: ProjectRepository = { save: async (item) => item, findById: async (id) => id === project.id ? project : null, list: async () => [project], remove: async () => false };
  const audit = new InMemoryAuditRepository(), sessions = new InMemorySessionRepository(), secrets = new InMemoryEnvSecretValueRepository();
  const user = { id: "yaml-user", email: "yaml@example.test", emailNormalized: "yaml@example.test", passwordHash: "unused-fixture-hash", role, status: "active" as const, createdAt: new Date(), updatedAt: new Date() };
  await sessions.create({ userId: user.id, tokenHash: hashSessionToken("yaml-fixture-token"), expiresAt: new Date("2027-01-01T00:00:00Z") });
  const app = await buildApiApp({ env: { NODE_ENV: "test", DEPLOYLITE_SECRET_KEY: "yaml_fixture_env_secret_key_1234567890" }, corsOrigin: false, authConfig: { cookieName: "yaml_session", cookieSecure: false }, auth: { users: new InMemoryAuthUserRepository([user]), sessions, audit },
    state: { projects, envSecretValues: secrets, controlGrants: { listForActor: async (actorId) => [{ id: "yaml-grant", actorId, action: "project.deploy", scope: { kind: "project", projectId: scope } }] } } });
  apps.push(app); audit.inputs.length = 0; audit.events.length = 0;
  return { audit, save: vi.spyOn(projects, "save"), secrets: vi.spyOn(secrets, "listEncryptedByProject"), post: (document = yaml) => app.inject({ method: "POST", url: "/api/v1/projects/project-1/compose/preview", headers: { cookie: "yaml_session=yaml-fixture-token" }, payload: { document } }) };
}
describe("YAML preview through the actual API route", () => {
  it("returns the same canonical plan as JSON without persisting source or resolving secrets", async () => {
    const f = await fixture(); const a = await f.post(yaml), b = await f.post(json);
    expect(a.statusCode).toBe(200); expect(b.statusCode).toBe(200); expect(a.json().data.preview).toEqual(b.json().data.preview);
    expect(a.json().data.preview.executionAllowed).toBe(false); expect(f.save).not.toHaveBeenCalled(); expect(f.secrets).not.toHaveBeenCalled();
    expect(f.audit.inputs[0]).toMatchObject({ action: "compose.preview", metadata: { serviceCount: 1, networkCount: 1, volumeCount: 1, inputDigest: a.json().data.preview.configDigest } });
    expect(JSON.stringify(f.audit.inputs)).not.toContain("APP_TOKEN"); expect(JSON.stringify(f.audit.inputs)).not.toContain(image);
  });
  it.each(["services: !unknown fixture_inline_secret", yaml + "---\nservices: {}", `services: {web: {image: '${image}', image: '${image}'}}`])("rejects parse ambiguity and unsupported syntax with a source-safe code %#", async (document) => {
    const f = await fixture(); const response = await f.post(document);
    expect(response.statusCode).toBe(400); expect(response.json().error.code).toBe("COMPOSE_INVALID_DOCUMENT");
    expect(response.body + JSON.stringify(f.audit.inputs)).not.toContain("fixture_inline_secret"); expect(f.save).not.toHaveBeenCalled(); expect(f.secrets).not.toHaveBeenCalled();
  });
  it.each([["read-only", "project-1"], ["operator", "foreign-project"]] as const)("retains the role/scope boundary for %s/%s", async (role, project) => {
    const f = await fixture(role, project); expect((await f.post()).statusCode).toBe(403); expect(f.save).not.toHaveBeenCalled(); expect(f.secrets).not.toHaveBeenCalled();
  });
});
