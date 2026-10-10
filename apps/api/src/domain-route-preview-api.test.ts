import Fastify, { type preHandlerAsyncHookHandler } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDomainRoutePreviewRoute } from "./domain-route-preview-route.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.restoreAllMocks(); });

const hash = "a".repeat(64);
const deployment = {
  id: "deployment-1", projectId: "project-1", agentId: "agent-1", status: "succeeded", commitSha: "abcdef1",
  startedAt: "2026-10-09T00:00:00.000Z", finishedAt: "2026-10-09T00:01:00.000Z", snapshotHash: hash, snapshotOriginId: "deployment-1",
  executionReceipt: {
    schemaVersion: 1, candidateId: "deployment-1:candidate:command-1", deploymentId: "deployment-1", projectId: "project-1",
    snapshotOriginId: "deployment-1", snapshotHash: hash, effectiveImageDigest: `sha256:${"b".repeat(64)}`,
    runtimeHost: "agent-1", container: "deploylite-active-1", containerId: "container-1", hostPort: 43000,
    containerPort: 3000, network: "deploylite"
  }
};
const p1Owner = { schemaVersion: 1, projectId: "project-1", deploymentId: null, domain: "app.example.com" };

async function fixture(options: { authenticated?: boolean; grantAction?: string; claims?: unknown[]; available?: boolean; target?: unknown; auditFails?: boolean } = {}) {
  const auditInputs: unknown[] = [];
  const reader = { available: vi.fn(() => options.available ?? true), listClaims: vi.fn(async () => options.claims ?? [p1Owner]) };
  const projectRepo = { findById: vi.fn(async (id: string) => id === "project-1" ? { id, name: "project", repoUrl: "https://github.com/a/b", defaultBranch: "main",
    buildCommand: null, runCommand: null, port: null, description: null, imageTag: null } : null) };
  const deploymentRepo = { findById: vi.fn(async (id: string) => id === "deployment-1" ? options.target ?? deployment : null) };
  const grants = { listForActor: vi.fn(async (actorId: string) => [{ id: "grant-1", actorId, action: options.grantAction ?? "project.deploy",
    scope: { kind: "project", projectId: "project-1" } }]) };
  const audit = { append: vi.fn(async (event: unknown) => { if (options.auditFails) throw new Error("audit unavailable"); auditInputs.push(event); return event; }) };
  const requireAuth: preHandlerAsyncHookHandler = async (request, reply) => {
    if (options.authenticated === false) return void reply.code(401).send({ data: null, error: { code: "UNAUTHENTICATED" }, requestId: "request-1" });
    const authenticated = request as unknown as { auth: unknown; correlationContext: unknown };
    authenticated.auth = { user: { id: "actor-1", role: "operator" } };
    authenticated.correlationContext = { requestId: "request-1", correlationId: "correlation-1" };
  };
  const app = Fastify() as any;
  registerDomainRoutePreviewRoute(app, { prefix: "/api/v1", projects: projectRepo as never, deployments: deploymentRepo as never,
    domainRouteClaims: reader as never, grants: grants as never, audit: audit as never, requireAuth,
    requireRole: (async () => {}) as preHandlerAsyncHookHandler,
    ok: (_request: unknown, data: unknown) => ({ data, error: null, requestId: "request-1" }),
    error: (_request: unknown, code: string, message: string) => ({ data: null, error: { code, message, correlationId: "correlation-1" }, requestId: "request-1" })
  } as never);
  apps.push(app);
  return { app, reader, projectRepo, deploymentRepo, grants, auditInputs,
    post: (payload: Record<string, unknown> = { domain: " APP.EXAMPLE.COM ", deploymentId: "deployment-1" }, projectId = "project-1") =>
      app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/domains/preview`, payload }) };
}

describe("project-scoped domain route preview API", () => {
  it("previews attachment to a P1 domain using a successful deployment with trusted execution evidence", async () => {
    const f = await fixture();
    const response = await f.post();
    expect(response.statusCode).toBe(200);
    expect(response.json().data.plan).toEqual({
      action: "attach",
      route: { schemaVersion: 1, projectId: "project-1", deploymentId: "deployment-1", domain: "app.example.com" },
      previousDeploymentId: null
    });
    expect(f.reader.listClaims).toHaveBeenCalledOnce();
    expect(f.deploymentRepo.findById).toHaveBeenCalledWith("deployment-1");
    expect(f.auditInputs).toEqual([expect.objectContaining({ action: "domain.route.preview", targetId: "project-1" })]);
  });

  it("requires project.deploy permission before reading route claims or deployments", async () => {
    const f = await fixture({ grantAction: "project.update" });
    const response = await f.post();
    expect(response.statusCode).toBe(403);
    expect(f.reader.listClaims).not.toHaveBeenCalled();
    expect(f.deploymentRepo.findById).not.toHaveBeenCalled();
  });

  it("rejects wildcard host input before reading the project route state", async () => {
    const f = await fixture();
    const response = await f.post({ domain: "*.example.com", deploymentId: "deployment-1" });
    expect(response.statusCode).toBe(400);
    expect(f.reader.listClaims).not.toHaveBeenCalled();
    expect(f.deploymentRepo.findById).not.toHaveBeenCalled();
  });

  it("fails closed on a global hostname ownership conflict", async () => {
    const f = await fixture({ claims: [{ ...p1Owner, projectId: "project-2" }] });
    const response = await f.post();
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("DOMAIN_ROUTE_CONFLICT");
  });

  it("requires the deployment target to belong to the project and have a trusted receipt", async () => {
    const foreign = { ...deployment, projectId: "project-2", executionReceipt: { ...deployment.executionReceipt, projectId: "project-2" } };
    const f = await fixture({ target: foreign });
    const response = await f.post();
    expect(response.statusCode).toBe(409);
    expect(f.reader.listClaims).not.toHaveBeenCalled();
  });

  it("requires a completed successful deployment with a matching snapshot receipt", async () => {
    const f = await fixture({ target: { ...deployment, status: "running", finishedAt: null } });
    const response = await f.post();
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("DOMAIN_ROUTE_TARGET_UNVERIFIED");
    expect(f.reader.listClaims).not.toHaveBeenCalled();
  });

  it("rejects a trusted-looking receipt that belongs to a different snapshot", async () => {
    const f = await fixture({ target: { ...deployment, executionReceipt: { ...deployment.executionReceipt, snapshotHash: "c".repeat(64) } } });
    const response = await f.post();
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("DOMAIN_ROUTE_TARGET_UNVERIFIED");
    expect(f.reader.listClaims).not.toHaveBeenCalled();
  });

  it("fails closed when persisted claim storage is unavailable", async () => {
    const f = await fixture({ available: false });
    const response = await f.post();
    expect(response.statusCode).toBe(503);
    expect(f.reader.listClaims).not.toHaveBeenCalled();
  });

  it("fails closed when an existing stored route claim is malformed", async () => {
    const f = await fixture({ claims: [{ ...p1Owner, domain: "bad..example.com" }] });
    const response = await f.post();
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("DOMAIN_ROUTE_UNAVAILABLE");
  });

  it("does not return a preview if its audit event cannot be persisted", async () => {
    const f = await fixture({ auditFails: true });
    const response = await f.post();
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("DOMAIN_ROUTE_UNAVAILABLE");
  });
});
