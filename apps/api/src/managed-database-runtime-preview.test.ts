import { buildApiApp } from "./app.js";
import Fastify, { type FastifyReply } from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { createEnvSecretCipher } from "@deploylite/config";
import { managedDatabaseRuntimePreparationSchema, type ApprovedManagedDatabaseProfileV1, type ManagedDatabaseEngineV1 } from "@deploylite/contracts";
import { ensureManagedDatabaseCredentials, type EncryptedEnvSecretValueRecord, type EnvSecretValueInput } from "@deploylite/domain";
import { registerManagedDatabaseRuntimePreviewRoute } from "./managed-database-runtime-preview.js";
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function fixture(settings: { engine?: ManagedDatabaseEngineV1; allowed?: boolean; anonymous?: boolean; deadlineMs?: number } = {}) {
  const app = Fastify(); apps.push(app);
  const engine = settings.engine ?? "postgres", rows = new Map<string, EncryptedEnvSecretValueRecord>();
  const profiles = new Map<ManagedDatabaseEngineV1, ApprovedManagedDatabaseProfileV1>();
  const paths = { postgres: "/var/lib/postgresql", mysql: "/var/lib/mysql", mariadb: "/var/lib/mysql", mongodb: "/data/db", redis: "/data" };
  const ports = { postgres: 5432, mysql: 3306, mariadb: 3306, mongodb: 27017, redis: 6379 };
  for (const value of ["postgres", "mysql", "mariadb", "mongodb", "redis"] as const) profiles.set(value, {
    schemaVersion: 1, profileId: `profile-${value}`, engine: value, image: `registry.example.com/${value}@sha256:${"a".repeat(64)}`,
    dataPath: paths[value], containerPort: ports[value], credentialKeys: ["DATABASE_PASSWORD"], backupStrategy: value === "redis" ? "volume-quiesced" : "engine-native"
  });
  const cipher = createEnvSecretCipher(Buffer.alloc(32, 14));
  const secrets = { find: vi.fn(async (project: string, key: string) => rows.get(project + key)), createIfAbsent: vi.fn(async (record: EnvSecretValueInput) => {
    const row = { ...record, id: "secret-a", valuePresent: true, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
    rows.set(record.projectId + record.key, row); return row;
  }) };
  const imagePolicy = { policyVersion: "images-1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true };
  await ensureManagedDatabaseCredentials({ schemaVersion: 1, projectId: "project-a", databaseId: "orders", engine }, profiles.get(engine), {
    imagePolicy, cipher, secrets, authorize: async () => true, entropy: () => Buffer.alloc(32, 19)
  });
  secrets.find.mockClear(); secrets.createIfAbsent.mockClear();
  const audit = vi.fn(async () => ({} as never));
  const grants = vi.fn(async () => settings.allowed === false ? [] : [{ id: "grant-a", actorId: "actor-a", action: "project.update" as const, scope: { kind: "project" as const, projectId: "project-a" } }]);
  const projects = vi.fn(async (id: string) => ({ id, name: "fixture", repoUrl: "https://example.test/repo", defaultBranch: "main", buildCommand: null, runCommand: null, port: null, description: null, imageTag: null }));
  const configuration = { profiles, deadlineMs: settings.deadlineMs ?? 1000 };
  const options = { prefix: "/api/v1", configuration, secrets, cipher, imagePolicy, projects: { findById: projects }, grants: { listForActor: grants }, audit: { append: audit },
    requireAuth: async (request: unknown, reply: FastifyReply) => { if (settings.anonymous) return reply.code(401).send({ error: "unauthenticated" });
      Object.assign(request as object, { auth: { user: { id: "actor-a", role: "operator" } }, correlationContext: { requestId: "request-a", correlationId: "correlation-a" } }); },
    requireRole: async () => {}, ok: (_request: unknown, data: unknown) => ({ data }), error: (_request: unknown, code: string) => ({ error: { code } }) };
  registerManagedDatabaseRuntimePreviewRoute(app, options);
  const post = (payload: unknown = { schemaVersion: 1, engine }, project = "project-a") => app.inject({ method: "POST", url: `/api/v1/projects/${project}/databases/orders/runtime/preview`, payload: payload as Record<string, unknown> });
  return { app, rows, secrets, profiles, cipher, audit, grants, projects, configuration, options, post };
}
it.each(["postgres", "mysql", "mariadb", "mongodb", "redis"] as const)("previews %s native deployment without exposing or creating secret values", async engine => {
  const f = await fixture({ engine }), response = await f.post();
  expect(response.statusCode).toBe(200);
  const data = response.json().data;
  expect(managedDatabaseRuntimePreparationSchema.parse(data.preparation)).toMatchObject({ projectId: "project-a", databaseId: "orders", engine });
  expect(data.plan).toMatchObject({ executionAllowed: false, engine, projectId: "project-a" });
  expect(data.credentialRef).toEqual({ secretRefId: "secret-a", redacted: true });
  expect(response.body).not.toContain("13".repeat(32));
  expect(response.body).not.toContain([...f.rows.values()][0]!.encryptedValue.toString("base64"));
  expect(f.secrets.createIfAbsent).not.toHaveBeenCalled();
  expect(f.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "database.runtime.previewed", correlationId: "correlation-a", targetId: "project-a" }));
});
it("denies unauthenticated or foreign-scope access before project/credential reads", async () => {
  for (const settings of [{ anonymous: true }, { allowed: false }]) {
    const f = await fixture(settings); expect((await f.post()).statusCode).toBe(settings.anonymous ? 401 : 403);
    expect(f.projects).not.toHaveBeenCalled(); expect(f.secrets.find).not.toHaveBeenCalled();
  }
  const f = await fixture(); expect((await f.post(undefined, "foreign")).statusCode).toBe(403); expect(f.secrets.find).not.toHaveBeenCalled();
});
it("rejects caller-supplied images, secrets, exposure or execution fields before reading credentials", async () => {
  const f = await fixture();
  for (const extra of [{ image: "image:latest" }, { password: "private" }, { publishedPort: 5432 }, { execute: true }]) {
    expect((await f.post({ schemaVersion: 1, engine: "postgres", ...extra })).statusCode).toBe(400);
  }
  expect(f.secrets.find).not.toHaveBeenCalled();
});
it("refuses missing or foreign encrypted credentials without generating replacements", async () => {
  const f = await fixture(); f.rows.clear(); expect((await f.post()).statusCode).toBe(503);
  expect(f.secrets.createIfAbsent).not.toHaveBeenCalled();
  const foreign = await fixture(); const original = [...foreign.rows.values()][0]!;
  foreign.secrets.find.mockResolvedValue({ ...original, projectId: "foreign" }); expect((await foreign.post()).statusCode).toBe(503);
});
it("withholds preview on failed audit and does not reflect private errors", async () => {
  const f = await fixture(); f.audit.mockRejectedValue(new Error("private-audit-password"));
  const response = await f.post(); expect(response.statusCode).toBe(503); expect(response.body).not.toContain("private-audit-password");
});
it("fences grant revocation after secret read and profile changes during audit", async () => {
  const revoked = await fixture(), original = [...revoked.rows.values()][0]!;
  revoked.secrets.find.mockImplementation(async () => { revoked.grants.mockResolvedValue([]); return original; });
  expect((await revoked.post()).statusCode).toBe(503); expect(revoked.audit).not.toHaveBeenCalled();
  const changed = await fixture(); changed.audit.mockImplementation(async () => { changed.profiles.delete("postgres"); return {} as never; });
  expect((await changed.post()).statusCode).toBe(503);
});
it("bounds stalled reads/audit and refuses invalid configured deadlines", async () => {
  for (const stage of ["grants", "secrets", "audit"] as const) {
    const f = await fixture({ deadlineMs: 10 });
    if (stage === "grants") f.grants.mockImplementation(() => new Promise(() => {}));
    if (stage === "secrets") f.secrets.find.mockImplementation(() => new Promise(() => {}));
    if (stage === "audit") f.audit.mockImplementation(() => new Promise(() => {}));
    expect((await f.post()).statusCode).toBe(503);
  }
  const invalid = await fixture({ deadlineMs: 0 }); expect((await invalid.post()).statusCode).toBe(503); expect(invalid.secrets.find).not.toHaveBeenCalled();
});

it("registers the real API route and requires authentication before preparation", async () => {
  const app = await buildApiApp({ env: { NODE_ENV: "test", DEPLOYLITE_BCRYPT_COST: "10", DATABASE_URL: undefined,
    DEPLOYLITE_AGENT_URL: undefined, DEPLOYLITE_AGENT_TRUST_KEY: undefined } });
  try {
    const response = await app.inject({ method: "POST", url: "/api/v1/projects/project-a/databases/orders/runtime/preview", payload: { schemaVersion: 1, engine: "postgres" } });
    expect(response.statusCode).toBe(401);
  } finally { await app.close(); }
});
it("requires configured project admission before encrypted preview reads", async () => {
  const f = await fixture(); Object.assign(f.configuration, { projectIds: new Set(["foreign"]) });
  expect((await f.post()).statusCode).toBe(503); expect(f.secrets.find).not.toHaveBeenCalled();
});

it.each(["postgres", "mysql", "mariadb", "mongodb", "redis"] as const)("returns scoped %s internal connection details with encrypted preview", async engine => {
  const f = await fixture({ engine }), response = await f.post(), data = response.json().data;
  expect(response.statusCode).toBe(200);
  expect(data.connection).toMatchObject({ schemaVersion: 1, projectId: "project-a", databaseId: "orders", engine,
    profileId: data.preparation.profileId, planDigest: data.preparation.planDigest, availability: "planned", exposure: "internal",
    hostname: "db-orders", networkName: data.plan.network.runtimeName, port: data.plan.containerPort,
    databaseName: engine === "redis" ? "0" : "orders", authenticationDatabase: engine === "mongodb" ? "admin" : null });
  expect(data.connection.username).toMatch(engine === "redis" ? /^default$/ : ["mysql", "mariadb"].includes(engine) ? /^root$/ : /^dl_[a-f0-9]{12}$/);
  expect(data.connection).not.toHaveProperty("password");
  expect(data.connection).not.toHaveProperty("environment");
  expect(f.secrets.createIfAbsent).not.toHaveBeenCalled();
});
