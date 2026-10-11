import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MANAGED_DATABASE_RUNTIME_CAPABILITY } from "@deploylite/contracts";

const harness = vi.hoisted(() => ({
  pool: vi.fn(() => ({ end: vi.fn(async () => {}) })),
  closePool: vi.fn(async () => {}),
  startServer: vi.fn(async (_options: unknown) => ({ close: vi.fn(async () => {}) })),
  run: vi.fn(async () => { throw new Error("Unexpected Docker access"); })
}));
vi.mock("@deploylite/db", () => ({
  createDbPool: harness.pool,
  createDbClient: () => ({}),
  closeDbPool: harness.closePool,
  DbAgentReplayStore: class {
    readonly durable = true;
    lookup = vi.fn(async () => null);
    lookupByFingerprintDigest = vi.fn(async () => null);
    constructor(..._args: unknown[]) {}
  },
  DbControlCommandRepository: class { validateProjectUpdateAuthority=vi.fn(async()=>{});validateConfirmedProjectUpdateAuthority=vi.fn(async()=>{});constructor(..._args: unknown[]) {} },
  DbEnvSecretValueRepository: class { constructor(..._args: unknown[]) {} }
}));
vi.mock("./server.js", () => ({ startAgentServer: harness.startServer }));
vi.mock("./deployment-dispatcher.js", () => ({
  DigestDeploymentDispatcher: class {
    available() { return true; }
    async dispatch() { throw new Error("Unexpected deployment"); }
  }
}));
vi.mock("./infrastructure/docker/docker-process-runner.js", () => ({
  DockerProcessRunner: class { run = harness.run; }
}));
import { startAgentRuntime } from "./index.js";
import type { AgentServerOptions } from "./server.js";

const engines = ["postgres", "mysql", "mariadb", "mongodb", "redis"] as const;
function configuration() {
  const paths = { postgres: "/var/lib/postgresql", mysql: "/var/lib/mysql", mariadb: "/var/lib/mysql", mongodb: "/data/db", redis: "/data" };
  const ports = { postgres: 5432, mysql: 3306, mariadb: 3306, mongodb: 27017, redis: 6379 };
  const profiles = Object.fromEntries(engines.map(engine => [engine, {
    schemaVersion: 1, profileId: `operator-${engine}`, engine,
    image: `docker.io/library/${engine}@sha256:${"a".repeat(64)}`,
    dataPath: paths[engine], containerPort: ports[engine],
    credentialKeys: ["DATABASE_PASSWORD"],
    backupStrategy: engine === "redis" ? "volume-quiesced" : "engine-native"
  }]));
  return { profiles, limits: { deadlineMs: 60000, maxOutputBytes: 131072, maxContainers: 64,
    pollIntervalMs: 100, cpus: 1, memoryBytes: 536870912, pidsLimit: 256 } };
}
function environment(raw?: string): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", DATABASE_URL: "postgres://fixture:fixture@invalid/bootstrap-test",
    DEPLOYLITE_AGENT_ID: "agent-a", DEPLOYLITE_AGENT_TRUST_KEY: "test-agent-key-" + "x".repeat(64),
    ...(raw === undefined ? {} : { DEPLOYLITE_MANAGED_DATABASE_RUNTIME: raw }) };
}
function receiver() {
  return (harness.startServer.mock.calls.at(-1)![0] as AgentServerOptions).receiver;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process, "once").mockImplementation(() => process);
});
afterEach(() => vi.restoreAllMocks());

it("activates the native runtime capability only from complete explicit configuration", async () => {
  const runtime = await startAgentRuntime(environment(JSON.stringify(configuration())));
  expect(receiver().capabilities).toContain(MANAGED_DATABASE_RUNTIME_CAPABILITY);
  expect(receiver().hasDurableReplayStore()).toBe(true);
  expect(harness.run).not.toHaveBeenCalled();
  await runtime.close();
  expect(harness.closePool).toHaveBeenCalledOnce();
});
it("leaves native execution unavailable when configuration is absent", async () => {
  const runtime = await startAgentRuntime(environment());
  expect(receiver().capabilities).not.toContain(MANAGED_DATABASE_RUNTIME_CAPABILITY);
  expect(harness.run).not.toHaveBeenCalled();
  await runtime.close();
});
it("rejects malformed, empty, oversized or secret-bearing configuration before pool/server creation", async () => {
  for (const raw of ["", "null", "{", " ".repeat(65537), JSON.stringify({ ...configuration(), password: "must-never-be-reported" })]) {
    await expect(startAgentRuntime(environment(raw))).rejects.toThrow("Database runtime configuration is invalid.");
  }
  expect(harness.pool).not.toHaveBeenCalled();
  expect(harness.startServer).not.toHaveBeenCalled();
  expect(harness.run).not.toHaveBeenCalled();
});
it("refuses incomplete or mismatched profiles before pool/server creation", async () => {
  const value = configuration();
  const { redis: _, ...missing } = value.profiles;
  for (const profiles of [missing, { ...value.profiles, redis: { ...value.profiles.redis!, engine: "postgres" } }, { ...value.profiles, extra: value.profiles.postgres }]) {
    await expect(startAgentRuntime(environment(JSON.stringify({ ...value, profiles })))).rejects.toThrow("Database runtime configuration is invalid.");
  }
  expect(harness.pool).not.toHaveBeenCalled();
  expect(harness.startServer).not.toHaveBeenCalled();
});
it("refuses invalid or missing explicit process/deadline limits before resources", async () => {
  const value = configuration();
  for (const limits of [{}, { ...value.limits, deadlineMs: 60001 }, { ...value.limits, cpus: 0 },
    { ...value.limits, pidsLimit: 0 }, { ...value.limits, maxContainers: 0 }, { ...value.limits, pollIntervalMs: 1001 },
    { ...value.limits, memoryBytes: 0 }, { ...value.limits, maxOutputBytes: 1048577 }, { ...value.limits, privileged: true }]) {
    await expect(startAgentRuntime(environment(JSON.stringify({ ...value, limits })))).rejects.toThrow("Database runtime configuration is invalid.");
  }
  expect(harness.pool).not.toHaveBeenCalled();
  expect(harness.run).not.toHaveBeenCalled();
});
it("refuses tagged, foreign-host, invalid storage or credential profiles before resources", async () => {
  const value = configuration();
  for (const patch of [{ image: "docker.io/library/postgres:latest" }, { image: `foreign.example/postgres@sha256:${"a".repeat(64)}` },
    { dataPath: "/private" }, { credentialKeys: ["UNAPPROVED"] }, { containerPort: 1234 }]) {
    const profiles = { ...value.profiles, postgres: { ...value.profiles.postgres!, ...patch } };
    await expect(startAgentRuntime(environment(JSON.stringify({ ...value, profiles })))).rejects.toThrow("Database runtime configuration is invalid.");
  }
  expect(harness.pool).not.toHaveBeenCalled();
  expect(harness.startServer).not.toHaveBeenCalled();
  expect(harness.run).not.toHaveBeenCalled();
});

it("advertises native stop only for explicit stop configuration and durable original lookup",async()=>{
    const f=configuration(),pending=startAgentRuntime(environment(JSON.stringify({...f,limits:{...f.limits,stopGraceSeconds:10}})));
    await expect(pending).resolves.toHaveProperty("close");const runtime=await pending;
    expect(receiver().capabilities).toContain("database.runtime.stop.v1");expect(harness.run).not.toHaveBeenCalled();await runtime.close();
    const disabled=await startAgentRuntime(environment(JSON.stringify(f)));expect(receiver().capabilities).not.toContain("database.runtime.stop.v1");await disabled.close();
});
it("advertises readonly health only with explicit native configuration and durable source proof",async()=>{const runtime=await startAgentRuntime(environment(JSON.stringify(configuration())));expect(receiver().capabilities).toContain("database.runtime.health.v1");expect(harness.run).not.toHaveBeenCalled();await runtime.close();const disabled=await startAgentRuntime(environment());expect(receiver().capabilities).not.toContain("database.runtime.health.v1");await disabled.close();});
it("advertises readonly metrics only with explicit native configuration and durable source proof",async()=>{const runtime=await startAgentRuntime(environment(JSON.stringify(configuration())));expect(receiver().capabilities).toContain("database.runtime.metrics.v1");expect(harness.run).not.toHaveBeenCalled();await runtime.close();const disabled=await startAgentRuntime(environment());expect(receiver().capabilities).not.toContain("database.runtime.metrics.v1");await disabled.close();});
it("advertises readonly retained logs only with explicit native configuration and durable source proof", async () => {
  const runtime = await startAgentRuntime(environment(JSON.stringify(configuration())));
  expect(receiver().capabilities).toContain("database.runtime.logs.v1"); expect(harness.run).not.toHaveBeenCalled(); await runtime.close();
  const disabled = await startAgentRuntime(environment()); expect(receiver().capabilities).not.toContain("database.runtime.logs.v1"); await disabled.close();
});

it("offers confirmed deletion only with explicit bounded STOP configuration and durable authority readers",async()=>{
 const f=configuration(),enabled=await startAgentRuntime(environment(JSON.stringify({...f,limits:{...f.limits,stopGraceSeconds:10}})));expect(receiver().capabilities).toContain("database.runtime.delete.v1");expect(harness.run).not.toHaveBeenCalled();await enabled.close();
 const disabled=await startAgentRuntime(environment(JSON.stringify(f)));expect(receiver().capabilities).not.toContain("database.runtime.delete.v1");expect(harness.run).not.toHaveBeenCalled();await disabled.close();
});
