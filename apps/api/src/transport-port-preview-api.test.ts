import Fastify, { type preHandlerAsyncHookHandler } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTransportPortPreviewRoute } from "./transport-port-preview-route.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.restoreAllMocks(); });

const hash = "a".repeat(64);
const deployment = {
  id: "deployment-1", projectId: "project-1", agentId: "agent-1", status: "succeeded", commitSha: "abcdef1",
  startedAt: "2026-10-09T00:00:00.000Z", finishedAt: "2026-10-09T00:01:00.000Z", snapshotHash: hash, snapshotOriginId: "deployment-1",
  executionReceipt: {
    schemaVersion: 1, candidateId: "deployment-1:candidate:command-1", deploymentId: "deployment-1", projectId: "project-1",
    snapshotOriginId: "deployment-1", snapshotHash: hash, effectiveImageDigest: "sha256:" + "b".repeat(64),
    runtimeHost: "agent-1", container: "deploylite-active-1", containerId: "container-1", hostPort: 43000,
    containerPort: 3000, network: "deploylite"
  }
};
const sameProjectOwner = { schemaVersion: 1, projectId: "project-1", deploymentId: null, protocol: "tcp", publishedPort: 30_000, targetPort: 25_565 };

async function fixture(options: { authenticated?: boolean; grantAction?: string; claims?: unknown[]; available?: boolean; target?: unknown; auditFails?: boolean } = {}) {
  const auditInputs: unknown[] = [];
  const claims = { available: vi.fn(() => options.available ?? true), listClaims: vi.fn(async () => options.claims ?? [sameProjectOwner]) };
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
  registerTransportPortPreviewRoute(app, { prefix: "/api/v1", projects: projectRepo as never, deployments: deploymentRepo as never,
    claims: claims as never, grants: grants as never, audit: audit as never, requireAuth,
    requireRole: (async () => {}) as preHandlerAsyncHookHandler,
    ok: (_request: unknown, data: unknown) => ({ data, error: null, requestId: "request-1" }),
    error: (_request: unknown, code: string, message: string) => ({ data: null, error: { code, message, correlationId: "correlation-1" }, requestId: "request-1" })
  } as never);
  apps.push(app);
  return { app, claims, deploymentRepo, auditInputs,
    post: (payload: Record<string, unknown> = { protocol: "tcp", publishedPort: 30_000, targetPort: 25_565, deploymentId: "deployment-1" }, projectId = "project-1") =>
      app.inject({ method: "POST", url: "/api/v1/projects/" + projectId + "/transport-ports/preview", payload }) };
}

describe("project-scoped transport port preview API", () => {
  it("previews attaching a TCP port claim to a deployment with trusted execution evidence", async () => {
    const f = await fixture();
    const response = await f.post();
    expect(response.statusCode).toBe(200);
    expect(response.json().data.plan).toEqual({ action: "attach", route: {
      schemaVersion: 1, projectId: "project-1", deploymentId: "deployment-1", protocol: "tcp", publishedPort: 30_000, targetPort: 25_565
    }, previous: null });
    expect(f.claims.listClaims).toHaveBeenCalledOnce();
    expect(f.deploymentRepo.findById).toHaveBeenCalledWith("deployment-1");
    expect(f.auditInputs).toEqual([expect.objectContaining({ action: "transport.port.preview", targetId: "project-1" })]);
  });

  it("requires project.deploy permission before reading port claims or deployments", async () => {
    const f = await fixture({ grantAction: "project.update" });
    const response = await f.post();
    expect(response.statusCode).toBe(403);
    expect(f.claims.listClaims).not.toHaveBeenCalled();
    expect(f.deploymentRepo.findById).not.toHaveBeenCalled();
  });

  it("rejects invalid transport input before reading deployment state", async () => {
    const f = await fixture();
    const response = await f.post({ protocol: "sctp", publishedPort: 0, targetPort: 25_565, deploymentId: "deployment-1" });
    expect(response.statusCode).toBe(400);
    expect(f.claims.listClaims).not.toHaveBeenCalled();
    expect(f.deploymentRepo.findById).not.toHaveBeenCalled();
  });

  it("fails closed on a globally occupied same-protocol port", async () => {
    const f = await fixture({ claims: [{ ...sameProjectOwner, projectId: "project-2" }] });
    const response = await f.post();
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("TRANSPORT_PORT_CONFLICT");
  });

  it("allows a UDP claim on the same numeric published port as TCP", async () => {
    const f = await fixture({ claims: [{ ...sameProjectOwner, protocol: "tcp", projectId: "project-2" }] });
    const response = await f.post({ protocol: "udp", publishedPort: 30_000, targetPort: 19_132, deploymentId: "deployment-1" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.plan.action).toBe("create");
  });

  it("requires the deployment target to belong to the project and have a matching trusted receipt", async () => {
    const foreign = { ...deployment, projectId: "project-2", executionReceipt: { ...deployment.executionReceipt, projectId: "project-2" } };
    const f = await fixture({ target: foreign });
    const response = await f.post();
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("TRANSPORT_PORT_TARGET_CONFLICT");
    expect(f.claims.listClaims).not.toHaveBeenCalled();
  });

  it("requires a completed successful deployment with its matching snapshot receipt", async () => {
    const f = await fixture({ target: { ...deployment, status: "running", finishedAt: null } });
    const response = await f.post();
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("TRANSPORT_PORT_TARGET_UNVERIFIED");
    expect(f.claims.listClaims).not.toHaveBeenCalled();
  });

  it("fails closed when persistent port claims are unavailable or malformed", async () => {
    const unavailable = await fixture({ available: false });
    expect((await unavailable.post()).statusCode).toBe(503);
    expect(unavailable.claims.listClaims).not.toHaveBeenCalled();
    const malformed = await fixture({ claims: [{ ...sameProjectOwner, protocol: "sctp" }] });
    expect((await malformed.post()).statusCode).toBe(503);
  });

  it("does not return a preview when its audit event cannot be persisted", async () => {
    const f = await fixture({ auditFails: true });
    const response = await f.post();
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("TRANSPORT_PORT_UNAVAILABLE");
  });
});
