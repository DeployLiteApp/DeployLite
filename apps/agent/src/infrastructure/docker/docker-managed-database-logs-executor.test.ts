import {expect, it, vi} from "vitest";
import {InMemoryCapabilityRegistry, managedDatabaseRuntimeReceiptSchema, managedDatabaseLogsAgentQuerySchema} from "@deploylite/contracts";
import {planManagedDatabaseProfile, managedDatabaseRuntimeExecutionDigest} from "@deploylite/domain";
import {createManagedDatabaseLogsExecutor} from "./docker-managed-database-logs-executor.js";
import type {createManagedDatabaseLogsObserver} from "./docker-managed-database-log-observer.js";
const engines = ["postgres", "mysql", "mariadb", "mongodb", "redis"] as const;
function fixture(engine: typeof engines[number] = "postgres") {
  let now = 1000;
  const policy = {policyVersion: "images-1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true};
  const request = {schemaVersion: 1 as const, projectId: "project-a", databaseId: "orders", engine};
  const profile = {schemaVersion: 1, profileId: "profile-" + engine, engine, image: `registry.example.com/${engine}@sha256:${"a".repeat(64)}`,
    dataPath: {postgres: "/var/lib/postgresql", mysql: "/var/lib/mysql", mariadb: "/var/lib/mysql", mongodb: "/data/db", redis: "/data"}[engine],
    containerPort: {postgres: 5432, mysql: 3306, mariadb: 3306, mongodb: 27017, redis: 6379}[engine], credentialKeys: ["DATABASE_PASSWORD"],
    backupStrategy: engine === "redis" ? "volume-quiesced" : "engine-native"};
  const plan = planManagedDatabaseProfile(request, profile, policy), input = {...request, profileId: profile.profileId, planDigest: plan.planDigest, environmentFingerprint: "b".repeat(32)};
  const original = managedDatabaseRuntimeReceiptSchema.parse({...request, action: "database.runtime", agentId: "agent-a", commandId: "origin-a", inputDigest: managedDatabaseRuntimeExecutionDigest(input),
    planDigest: plan.planDigest, environmentFingerprint: input.environmentFingerprint, correlationId: "origin-correlation", containerId: "c".repeat(64), imageId: "sha256:" + "d".repeat(64),
    volumeName: plan.volume.runtimeName, networkName: plan.network.runtimeName, networkId: "e".repeat(64), volumeCreatedAt: "2026-10-10T00:00:00Z", observedAt: 1000,
    status: "ready", health: "passed", storage: "verified", idempotent: false, redacted: true});
  const query = managedDatabaseLogsAgentQuerySchema.parse({...input, originalReceipt: original, originalReplayFingerprint: "f".repeat(64), action: "database.runtime.logs", agentId: "agent-a",
    requiredCapabilities: ["database.runtime.logs.v1"], context: {requestId: "logs-request", correlationId: "logs-correlation"}, timeoutMs: 1000, selection: {tail: 100}});
  const view = {...request, containerId: original.containerId!, imageId: original.imageId!, uid: 1000, state: "running" as const, health: "healthy" as const,
    observedAt: 1000, redacted: true as const, logs: {stdout: "ready\n", stderr: "notice\n", redacted: true as const}, logsObservedAt: 1000};
  const observer = {observe: vi.fn<ReturnType<typeof createManagedDatabaseLogsObserver>["observe"]>(async () => view)}, authority = {assertValid: vi.fn(async () => {})};
  const options = {agentId: "agent-a", profiles: {[engine]: profile}, imagePolicy: policy, capabilities: new InMemoryCapabilityRegistry(["database.runtime.logs.v1"]),
    clock: {now: () => now}, observer, limits: {deadlineMs: 1000}};
  const call = () => createManagedDatabaseLogsExecutor(options).observe(query, authority, new AbortController().signal);
  return {request, profile, plan, input, original, query, view, observer, authority, options, call, setNow: (value: number) => {now = value;}};
}
it.each(engines)("observes original %s logs with explicit selection and no new command", async engine => {
  const f = fixture(engine);
  await expect(f.call()).resolves.toMatchObject({...f.request, action: "database.runtime.logs", originalCommandId: f.original.commandId, context: f.query.context,
    containerId: f.original.containerId, networkId: f.original.networkId, storage: "verified", logs: f.view.logs});
  expect(f.observer.observe).toHaveBeenCalledOnce(); expect(f.observer.observe.mock.calls[0]![2]).toEqual(f.query.selection);
});
it("preserves stopped retained logs without claiming a process UID", async () => {
  const f = fixture(); f.observer.observe.mockResolvedValue({...f.view, state: "stopped", health: "not-running", uid: null} as any);
  await expect(f.call()).resolves.toMatchObject({state: "stopped", health: "not-running", uid: null, logs: f.view.logs});
});
it("rejects capability, configured-plan and original-digest failures before observation", async () => {
  for (const mode of ["capability", "profile", "digest", "since"]) {
    const f = fixture();
    if (mode === "capability") f.options.capabilities.has = () => false;
    if (mode === "profile") f.options.profiles.postgres = {...f.profile, profileId: "changed"};
    if (mode === "digest") f.query.originalReceipt.inputDigest = "0".repeat(64);
    if (mode === "since") f.query.selection.since = "1970-01-01T00:00:01.001Z";
    await expect(f.call()).rejects.toThrow(); expect(f.observer.observe).not.toHaveBeenCalled();
  }
});
it("withholds foreign, private, root, stale and unsanitized observer output", async () => {
  for (const patch of [{containerId: "0".repeat(64)}, {uid: 0}, {observedAt: 999}, {password: "private"}, {logs: {...fixture().view.logs, stderr: "password=tiny"}}, {logsObservedAt: 999}]) {
    const f = fixture(); f.observer.observe.mockResolvedValue({...f.view, ...patch} as any);
    await expect(f.call()).rejects.toThrow(/^Database logs execution is unavailable\.$/);
  }
});
it("fences revoked authority and substituted observer before publishing logs", async () => {
  for (const mode of ["capability", "observer", "authority"]) {
    const f = fixture(); f.observer.observe.mockImplementation(async () => {
      if (mode === "capability") f.options.capabilities.has = () => false;
      if (mode === "observer") f.options.observer.observe = vi.fn(async () => f.view);
      if (mode === "authority") f.authority.assertValid.mockRejectedValue(new Error("private"));
      return f.view;
    });
    await expect(f.call()).rejects.toThrow();
  }
});
it("bounds hung ports and rejects invalid clocks or pre-aborted reads", async () => {
  const f = fixture(); f.options.limits.deadlineMs = 5; f.observer.observe.mockImplementation(() => new Promise(() => {})); await expect(f.call()).rejects.toThrow();
  for (const now of [-1, Number.NaN, Number.MAX_SAFE_INTEGER]) {
    const g = fixture(); g.setNow(now); await expect(g.call()).rejects.toThrow(); expect(g.observer.observe).not.toHaveBeenCalled();
  }
  const g = fixture(), controller = new AbortController(); controller.abort();
  await expect(createManagedDatabaseLogsExecutor(g.options).observe(g.query, g.authority, controller.signal)).rejects.toThrow(); expect(g.observer.observe).not.toHaveBeenCalled();
});
