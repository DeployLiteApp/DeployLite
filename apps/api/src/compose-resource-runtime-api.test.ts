import { afterEach, describe, expect, it, vi } from "vitest";
import { hashSessionToken } from "@deploylite/db";
import { type Project } from "@deploylite/contracts";
import { createComposePreview, type ControlGrant, type ControlGrantRepository, type ProjectRepository, type ProjectUpdateControlRepository } from "@deploylite/domain";
import { buildApiApp, InMemoryAuditRepository, InMemoryAuthUserRepository, InMemorySessionRepository, type BuildApiAppOptions } from "./app.js";

const apps: Awaited<ReturnType<typeof buildApiApp>>[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); await Promise.all(apps.splice(0).map(app => app.close())); });
const trustKey = "compose_network_runtime_test_key_123";
const policy = { policyVersion: "runtime-test", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true };
const image = `registry.example.com/app@sha256:${"a".repeat(64)}`;
const document = JSON.stringify({ services: { app: { image, networks: ["backend"] } }, networks: { backend: {} } });
const projectsData: Project[] = ["project-one", "project-two"].map(id => ({ id, name: id, repoUrl: "https://github.com/DeployLiteApp/DeployLite",
  defaultBranch: "main", buildCommand: null, runCommand: null, port: null, description: null, imageTag: null }));

describe("API startup Compose resource project allowlist", () => {
  it("refuses to enable volume recreation in production", async () => {
    const binding = { projectId: "project-one", agentId: "agent-one" };
    await expect(buildApiApp({ env: { NODE_ENV: "production" }, composeResourceProjectAgents: [binding], composeVolumeAttachmentProjectAgents: [binding] }))
      .rejects.toThrow(/restricted to non-production environments/);
  });

  it("routes only explicitly bound projects to the configured agent", async () => {
    const projectsMap = new Map(projectsData.map(value => [value.id, value]));
    const projects: ProjectRepository = { save: async value => { projectsMap.set(value.id, value); return value; }, findById: async id => projectsMap.get(id) ?? null,
      list: async () => [...projectsMap.values()], remove: async id => projectsMap.delete(id) };
    const grants: ControlGrant[] = projectsData.flatMap(project => [
      { id: `deploy-${project.id}`, actorId: "runtime-operator", action: "project.deploy" as const, scope: { kind: "project" as const, projectId: project.id } },
      { id: `update-${project.id}`, actorId: "runtime-operator", action: "project.update" as const, scope: { kind: "project" as const, projectId: project.id } }
    ]);
    const controlGrants: ControlGrantRepository = { listForActor: async () => structuredClone(grants) };
    const controls = {
      resolve: async () => { throw new Error("not used by read-only inspection"); }, complete: async () => { throw new Error("not used by read-only inspection"); },
      findProjectUpdateByIdempotency: async () => null, claimProjectUpdate: async () => { throw new Error("not used by read-only inspection"); },
      validateProjectUpdateAuthority: async () => { throw new Error("not used by read-only inspection"); }, completeProjectUpdate: async () => { throw new Error("not used by read-only inspection"); }
    } as unknown as ProjectUpdateControlRepository;
    const audit = new InMemoryAuditRepository(), sessions = new InMemorySessionRepository();
    const user = { id: "runtime-operator", email: "runtime@example.test", emailNormalized: "runtime@example.test", passwordHash: "unused-runtime-fixture",
      role: "operator" as const, status: "active" as const, createdAt: new Date(), updatedAt: new Date() };
    await sessions.create({ userId: user.id, tokenHash: hashSessionToken("compose-runtime-test-session"), expiresAt: new Date("2027-01-01T00:00:00Z") });
    const fetch = vi.fn(async () => new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const options = {
      env: { NODE_ENV: "test", DEPLOYLITE_SECRET_KEY: "compose_runtime_fixture_secret_key_1234567890", DEPLOYLITE_AGENT_URL: "https://agent.test",
        DEPLOYLITE_AGENT_ID: "agent-one", DEPLOYLITE_AGENT_TRUST_KEY: trustKey,
        DEPLOYLITE_COMPOSE_RESOURCE_PROJECT_AGENTS_JSON: JSON.stringify([{ projectId: "project-one", agentId: "agent-one" }]) },
      corsOrigin: false, imagePolicy: policy, authConfig: { cookieName: "runtime_session", cookieSecure: false },
      auth: { users: new InMemoryAuthUserRepository([user]), sessions, audit }, state: { projects, controlGrants, controlDeletes: controls }
    } as unknown as BuildApiAppOptions;
    const app = await buildApiApp(options); apps.push(app);
    const inspect = (projectId: string) => app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/compose/resources/inspect`,
      headers: { cookie: "runtime_session=compose-runtime-test-session" }, payload: { document, kind: "network", key: "backend",
        expectedConfigDigest: createComposePreview(document, projectId, policy).configDigest } });

    const excluded = await inspect("project-two");
    expect(excluded.statusCode).toBe(503);
    expect(excluded.json().error.code).toBe("COMPOSE_INSPECTION_UNSUPPORTED");
    expect(fetch).not.toHaveBeenCalled();

    const configured = await inspect("project-one");
    expect(configured.statusCode).toBe(503);
    expect(configured.json().error.code).toBe("COMPOSE_INSPECTION_FAILED");
    expect(fetch).toHaveBeenCalledOnce();

    const apply = (projectId: string) => app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/compose/attachments/apply`,
      headers: { cookie: "runtime_session=compose-runtime-test-session", "idempotency-key": "runtime-attachment" },
      payload: { document, kind: "network", key: "backend", service: "app", action: "attach",
        expectedConfigDigest: createComposePreview(document, projectId, policy).configDigest,
        expectedStateDigest: "b".repeat(64), expectedContainerId: "c".repeat(64) } });

    const excludedApply = await apply("project-two");
    expect(excludedApply.statusCode).toBe(503);
    expect(excludedApply.json().error.code).toBe("COMPOSE_ATTACHMENT_UNSUPPORTED");
    expect(fetch).toHaveBeenCalledOnce();

    const configuredApply = await apply("project-one");
    expect(configuredApply.statusCode).toBe(503);
    expect(configuredApply.json().error.code).toBe("COMPOSE_INSPECTION_FAILED");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
