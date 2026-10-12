import { expect, it, vi } from "vitest";
import { parseManagedDatabaseApiConfiguration, createConfiguredManagedDatabaseApi } from "./managed-database-runtime-configuration.js";
import { managedDatabaseNativeImagePolicy, parseManagedDatabaseRuntimeConfiguration, planManagedDatabaseProfile } from "@deploylite/domain";
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
function fixture() {
  const project = (id: string) => ({ id, name: "fixture", repoUrl: "https://example.test/repo", defaultBranch: "main", buildCommand: null, runCommand: null, port: null, description: null, imageTag: null });
  const controls = { resolve: vi.fn(), complete: vi.fn(), findProjectUpdateByIdempotency: vi.fn(), claimProjectUpdate: vi.fn(), validateProjectUpdateAuthority: vi.fn(), completeProjectUpdate: vi.fn() };
  const secrets = { find: vi.fn(async () => undefined), createIfAbsent: vi.fn(async () => { throw new Error("Unexpected credential creation"); }) };
  const parsed = { configuration: parseManagedDatabaseRuntimeConfiguration(JSON.stringify(configuration()))!, bindings: [{ projectId: "project-a", agentId: "agent-a" }, { projectId: "project-b", agentId: "agent-a" }] };
  const input = { parsed, controls, secrets, projects: { findById: vi.fn(async (id: string) => project(id)) },
    agent: { endpoint: "http://agent:4000", agentId: "agent-a", trustKey: "test-agent-key-" + "x".repeat(64) } };
  return { input, parsed, controls, secrets, project };
}
it("requires complete explicit native configuration and project bindings, leaving absence disabled", () => {
  const f = fixture(); expect(parseManagedDatabaseApiConfiguration(undefined, undefined)).toBeUndefined();
  const parsed = parseManagedDatabaseApiConfiguration(JSON.stringify(f.parsed.configuration), JSON.stringify(f.parsed.bindings))!;
  expect(parsed.bindings).toEqual(f.parsed.bindings); expect(Object.keys(parsed.configuration.profiles).sort()).toEqual([...engines].sort());
});
it("rejects malformed, incomplete, repeated, extra or private configuration before bootstrap", () => {
  const f = fixture(), config = JSON.stringify(f.parsed.configuration);
  for (const [raw, bindings] of [[undefined, "[]"], [config, undefined], ["{", "[]"], [config, "[]"], [config, " ".repeat(65537)],
    [config, JSON.stringify([f.parsed.bindings[0], f.parsed.bindings[0]])], [config, JSON.stringify([{ ...f.parsed.bindings[0], password: "private" }])]])
    expect(() => parseManagedDatabaseApiConfiguration(raw, bindings)).toThrow("Database API configuration is invalid.");
});
it("builds only explicit project execution maps with matching native plan policy and existing stores", async () => {
  const f = fixture(), result = await createConfiguredManagedDatabaseApi(f.input);
  expect([...result.executions.keys()]).toEqual(["project-a", "project-b"]); expect(result.credentials.store).toBe(f.secrets);
  expect(result.credentials.projectIds).toEqual(new Set(["project-a", "project-b"])); expect(result.imagePolicy).toEqual(managedDatabaseNativeImagePolicy());
  for (const engine of engines) {
    const profile = result.credentials.profiles.get(engine)!;
    expect(planManagedDatabaseProfile({ schemaVersion: 1, projectId: "project-a", databaseId: "orders", engine }, profile, result.imagePolicy).policyVersion).toBe("agent-compose-v1");
  }
  expect(result.executions.get("project-a")).toMatchObject({ controls: f.controls, agentId: "agent-a", deadlineMs: 60000, commandTtlMs: 60000 });
  expect(f.secrets.find).not.toHaveBeenCalled(); expect(f.secrets.createIfAbsent).not.toHaveBeenCalled(); expect(f.controls.claimProjectUpdate).not.toHaveBeenCalled();
});
it("refuses missing stores, unsupported control ports, invalid transport, foreign agents or projects", async () => {
  for (const stage of ["store", "control", "endpoint", "agent", "project"] as const) {
    const f = fixture();
    if (stage === "store") Object.assign(f.input, { secrets: undefined });
    if (stage === "control") Object.assign(f.input, { controls: {} });
    if (stage === "endpoint") f.input.agent.endpoint = "http://public.example.test:4000";
    if (stage === "agent") f.parsed.bindings[0]!.agentId = "foreign";
    if (stage === "project") f.input.projects.findById.mockResolvedValue(f.project("foreign"));
    await expect(createConfiguredManagedDatabaseApi(f.input)).rejects.toThrow("Database API configuration is invalid."); expect(f.secrets.createIfAbsent).not.toHaveBeenCalled();
  }
});
it("detaches approved metadata before untrusted project lookup can mutate supplied configuration", async () => {
  const f = fixture(); f.input.projects.findById.mockImplementation(async id => { f.parsed.configuration.profiles.postgres!.image = "mutated:latest"; return f.project(id); });
  const result = await createConfiguredManagedDatabaseApi(f.input); expect(result.credentials.profiles.get("postgres")!.image).toContain("@sha256:");
});
it("bounds stalled project lookup without runtime or credential effects", async () => {
  const f = fixture(); f.parsed.configuration.limits.deadlineMs = 10; f.input.projects.findById.mockImplementation(() => new Promise(() => {}));
  await expect(createConfiguredManagedDatabaseApi(f.input)).rejects.toThrow("Database API configuration is invalid."); expect(f.secrets.createIfAbsent).not.toHaveBeenCalled();
});
it("rejects invalid native environment before opening the configured database pool", async () => {
  const { buildApiApp } = await import("./app.js");
  const pool = vi.fn(() => { throw new Error("Unexpected pool creation"); });
  const result = await buildApiApp({ env: { NODE_ENV: "test", DATABASE_URL: "postgres://fixture:fixture@invalid/bootstrap",
    DEPLOYLITE_MANAGED_DATABASE_RUNTIME: "{", DEPLOYLITE_MANAGED_DATABASE_PROJECT_AGENTS_JSON: '[{"projectId":"project-a","agentId":"agent-a"}]' }, db: { createPool: pool } })
    .then(async app => { await app.close(); return "accepted"; }, error => (error as Error).message);
  expect(result).toBe("Database API configuration is invalid."); expect(pool).not.toHaveBeenCalled();
});
it("rejects environment bootstrap combined with injected native maps before repository creation", async () => {
  const { buildApiApp } = await import("./app.js"), f = fixture(), pool = vi.fn(() => { throw new Error("Unexpected pool creation"); });
  const result = await buildApiApp({ env: { NODE_ENV: "test", DATABASE_URL: "postgres://fixture:fixture@invalid/bootstrap",
    DEPLOYLITE_MANAGED_DATABASE_RUNTIME: JSON.stringify(f.parsed.configuration), DEPLOYLITE_MANAGED_DATABASE_PROJECT_AGENTS_JSON: JSON.stringify(f.parsed.bindings) },
    managedDatabaseRuntimeExecutions: new Map(), db: { createPool: pool } }).then(async app => { await app.close(); return "accepted"; }, error => (error as Error).message);
  expect(result).toBe("Database API configuration cannot be combined with injected native maps."); expect(pool).not.toHaveBeenCalled();
});

it("withholds operator stop maps without explicit trusted stop grace", async () => {
  const f = fixture(), result = await createConfiguredManagedDatabaseApi(f.input);
  expect(result).toHaveProperty("stopExecutions", new Map());
});
it("composes stop and original cache transports only for explicit approved projects", async () => {
  const f = fixture(); f.parsed.configuration.limits.stopGraceSeconds = 10;
  Object.assign(f.controls, { findProjectUpdateById: vi.fn(async () => null) });
  const result = await createConfiguredManagedDatabaseApi(f.input);
  expect(result).toHaveProperty("stopExecutions", expect.any(Map));
  expect([...result.stopExecutions.keys()]).toEqual(["project-a", "project-b"]);
  expect(result.stopExecutions.get("project-a")).toMatchObject({ controls: f.controls, agentId: "agent-a", deadlineMs: 60000 });
  expect(result.stopExecutions.get("project-a")!.transport.available()).toBe(true);
  expect(f.secrets.find).not.toHaveBeenCalled(); expect(f.controls.claimProjectUpdate).not.toHaveBeenCalled();
});
it("rejects explicit stop activation without the original command reader", async () => {
  const f = fixture(); f.parsed.configuration.limits.stopGraceSeconds = 10;
  await expect(createConfiguredManagedDatabaseApi(f.input)).rejects.toThrow("Database API configuration is invalid.");
  expect(f.controls.claimProjectUpdate).not.toHaveBeenCalled();
});

it("withholds operator start maps without an original command reader, preserving apply-only composition",async()=>{
  const f=fixture(),result=await createConfiguredManagedDatabaseApi(f.input);
  expect(result).toHaveProperty("startExecutions",new Map());expect([...result.executions.keys()]).toEqual(["project-a","project-b"]);
});
it("composes start with both historical signed readers even when new stop execution is disabled",async()=>{
  const f=fixture();Object.assign(f.controls,{findProjectUpdateById:vi.fn(async()=>null)});
  const result=await createConfiguredManagedDatabaseApi(f.input);expect(result).toHaveProperty("startExecutions",expect.any(Map));
  const starts=(result as typeof result & {startExecutions:Map<string,import("./managed-database-start.js").ManagedDatabaseStartAccess>}).startExecutions;
  expect([...starts.keys()]).toEqual(["project-a","project-b"]);const scope=starts.get("project-a")!;
  expect(scope).toMatchObject({controls:f.controls,agentId:"agent-a",deadlineMs:60000});
  expect(scope.transport.available()).toBe(true);expect(scope.originalTransport.available()).toBe(true);expect(scope.originalStopTransport.available()).toBe(true);
  expect(result.stopExecutions.size).toBe(0);expect(f.secrets.find).not.toHaveBeenCalled();expect(f.controls.claimProjectUpdate).not.toHaveBeenCalled();
});
it("withholds readonly health without original-control reader and composes it without new STOP configuration",async()=>{const f=fixture(),disabled=await createConfiguredManagedDatabaseApi(f.input);expect(disabled).toHaveProperty("healthExecutions",new Map());Object.assign(f.controls,{findProjectUpdateById:vi.fn(async()=>null)});const configured=await createConfiguredManagedDatabaseApi(f.input);expect(configured).toHaveProperty("healthExecutions",expect.any(Map));const maps=(configured as typeof configured & {healthExecutions:Map<string,import("./managed-database-health.js").ManagedDatabaseHealthAccess>}).healthExecutions;expect([...maps.keys()]).toEqual(["project-a","project-b"]);expect(maps.get("project-a")!.transport.available()).toBe(true);expect(maps.get("project-a")!.originalTransport.available()).toBe(true);expect(configured.stopExecutions.size).toBe(0);expect(f.secrets.find).not.toHaveBeenCalled();expect(f.controls.claimProjectUpdate).not.toHaveBeenCalled();});
it("withholds metrics without original-control reader and composes it without new STOP configuration",async()=>{const f=fixture(),disabled=await createConfiguredManagedDatabaseApi(f.input);expect(disabled).toHaveProperty("metricsExecutions",new Map());Object.assign(f.controls,{findProjectUpdateById:vi.fn(async()=>null)});const configured=await createConfiguredManagedDatabaseApi(f.input);expect(configured).toHaveProperty("metricsExecutions",expect.any(Map));const maps=(configured as typeof configured & {metricsExecutions:Map<string,import("./managed-database-metrics.js").ManagedDatabaseMetricsAccess>}).metricsExecutions;expect([...maps.keys()]).toEqual(["project-a","project-b"]);expect(maps.get("project-a")!.transport.available()).toBe(true);expect(maps.get("project-a")!.originalTransport.available()).toBe(true);expect(configured.stopExecutions.size).toBe(0);expect(f.secrets.find).not.toHaveBeenCalled();expect(f.controls.claimProjectUpdate).not.toHaveBeenCalled();});
it("rejects native environment combined with injected metrics maps before repository creation",async()=>{const {buildApiApp}=await import("./app.js"),f=fixture(),pool=vi.fn(()=>{throw new Error("Unexpected pool creation");});const options={env:{NODE_ENV:"test",DATABASE_URL:"postgres://fixture:fixture@invalid/bootstrap",DEPLOYLITE_MANAGED_DATABASE_RUNTIME:JSON.stringify(f.parsed.configuration),DEPLOYLITE_MANAGED_DATABASE_PROJECT_AGENTS_JSON:JSON.stringify(f.parsed.bindings)},managedDatabaseMetricsExecutions:new Map(),db:{createPool:pool}};const result=await buildApiApp(options as Parameters<typeof buildApiApp>[0]).then(async app=>{await app.close();return "accepted";},error=>(error as Error).message);expect(result).toBe("Database API configuration cannot be combined with injected native maps.");expect(pool).not.toHaveBeenCalled();});
it("withholds logs without original-control reader and composes retained reads without STOP activation", async () => {
  const f = fixture(), disabled = await createConfiguredManagedDatabaseApi(f.input);
  expect(disabled).toHaveProperty("logsExecutions", new Map());
  Object.assign(f.controls, {findProjectUpdateById: vi.fn(async () => null)});
  const configured = await createConfiguredManagedDatabaseApi(f.input);
  const maps = (configured as typeof configured & {logsExecutions: Map<string, import("./managed-database-logs.js").ManagedDatabaseLogsAccess>}).logsExecutions;
  expect([...maps.keys()]).toEqual(["project-a", "project-b"]);
  expect(maps.get("project-a")!.transport.available()).toBe(true); expect(maps.get("project-a")!.originalTransport.available()).toBe(true);
  expect(configured.stopExecutions.size).toBe(0); expect(f.secrets.find).not.toHaveBeenCalled(); expect(f.controls.claimProjectUpdate).not.toHaveBeenCalled();
});
it("rejects native environment mixed with injected logs maps before repositories", async () => {
  const {buildApiApp} = await import("./app.js"), f = fixture(), pool = vi.fn(() => {throw new Error("Unexpected pool creation");});
  const options = {env: {NODE_ENV: "test", DATABASE_URL: "postgres://fixture:fixture@invalid/bootstrap", DEPLOYLITE_MANAGED_DATABASE_RUNTIME: JSON.stringify(f.parsed.configuration),
    DEPLOYLITE_MANAGED_DATABASE_PROJECT_AGENTS_JSON: JSON.stringify(f.parsed.bindings)}, managedDatabaseLogsExecutions: new Map(), db: {createPool: pool}};
  const result = await buildApiApp(options as Parameters<typeof buildApiApp>[0]).then(async app => {await app.close(); return "accepted";}, error => (error as Error).message);
  expect(result).toBe("Database API configuration cannot be combined with injected native maps."); expect(pool).not.toHaveBeenCalled();
});
