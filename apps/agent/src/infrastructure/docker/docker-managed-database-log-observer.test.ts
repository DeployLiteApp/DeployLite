import {expect, it, vi} from "vitest";
import {approvedManagedDatabaseProfileSchema} from "@deploylite/contracts";
import {planManagedDatabaseProfile} from "@deploylite/domain";
import {createManagedDatabaseLogsObserver} from "./docker-managed-database-log-observer.js";
import type {createManagedDatabaseHealthObserver} from "./docker-managed-database-health.js";

const id = "a".repeat(64), imageId = "sha256:" + "b".repeat(64);
function fixture(engine: "postgres" | "mysql" | "mariadb" | "mongodb" | "redis" = "postgres") {
  let now = 1000;
  const request = {schemaVersion: 1 as const, projectId: "project-a", databaseId: "orders", engine};
  const profile = approvedManagedDatabaseProfileSchema.parse({
    schemaVersion: 1, profileId: "approved", engine, image: "registry.example/" + engine + "@" + imageId,
    dataPath: {postgres: "/var/lib/postgresql/data", mysql: "/var/lib/mysql", mariadb: "/var/lib/mysql", mongodb: "/data/db", redis: "/data"}[engine],
    containerPort: {postgres: 5432, mysql: 3306, mariadb: 3306, mongodb: 27017, redis: 6379}[engine],
    credentialKeys: ["DATABASE_PASSWORD"], backupStrategy: engine === "redis" ? "volume-quiesced" : "engine-native"
  });
  const plan = planManagedDatabaseProfile(request, profile, {policyVersion: "approved", trustedHosts: ["registry.example"], allowTags: false, allowDigests: true});
  const input = {request, profile, commandId: "origin", imageId, containerId: id, environmentFingerprint: "c".repeat(32)};
  const original = {projectId: request.projectId, databaseId: request.databaseId, commandId: input.commandId, planDigest: plan.planDigest,
    volume: {name: plan.volume.runtimeName, createdAt: "2026-10-10T00:00:00Z"}, network: {name: plan.network.runtimeName, id: "d".repeat(64)}};
  const view: Awaited<ReturnType<ReturnType<typeof createManagedDatabaseHealthObserver>["observe"]>> = {
    schemaVersion: 1, projectId: request.projectId, databaseId: request.databaseId, engine, containerId: id, imageId,
    uid: 999, state: "running", health: "healthy", observedAt: 1000, redacted: true
  };
  const observe = vi.fn<ReturnType<typeof createManagedDatabaseHealthObserver>["observe"]>(async () => structuredClone(view));
  const logs = {stdout: "ready\n", stderr: "notice\n", redacted: true as const};
  const read = vi.fn(async () => structuredClone(logs));
  const authority = {assertValid: vi.fn(async () => {})};
  const options = {health: {observe}, logs: {read}, clock: {now: () => now}, limits: {deadlineMs: 5000, maxOutputBytes: 4096}};
  const selection = {tail: 100, since: "1970-01-01T00:00:00.500Z"};
  const call = (signal = new AbortController().signal) => createManagedDatabaseLogsObserver(options).observe(input, original, selection, authority, signal);
  return {input, original, view, observe, logs, selection, read, authority, options, call, setNow: (value: number) => {now = value;}};
}
for (const engine of ["postgres", "mysql", "mariadb", "mongodb", "redis"] as const) {
  it(`corroborates ${engine} original workload around a bounded redacted log batch`, async () => {
    const f = fixture(engine);
    await expect(f.call()).resolves.toEqual({...f.view, logs: f.logs, logsObservedAt: 1000});
    expect(f.observe).toHaveBeenCalledTimes(2);
    expect(f.read).toHaveBeenCalledWith(id, f.selection, expect.any(AbortSignal));
  });
}
it("reads retained logs from a corroborated stopped original workload", async () => {
  const f = fixture(); Object.assign(f.view, {state: "stopped", health: "not-running", uid: null});
  await expect(f.call()).resolves.toMatchObject({state: "stopped", logs: f.logs});
  expect(f.read).toHaveBeenCalledTimes(1); expect(f.observe).toHaveBeenCalledTimes(2);
});
it("rejects foreign/private/stale health before log access", async () => {
  for (const patch of [{password: "private"}, {projectId: "foreign"}, {containerId: "e".repeat(64)}, {observedAt: 999}, {uid: 0}]) {
    const f = fixture(); Object.assign(f.view, patch);
    await expect(f.call()).rejects.toThrow(); expect(f.read).not.toHaveBeenCalled();
  }
});
it("withholds logs when original workload state changes during the batch", async () => {
  const f = fixture(); f.read.mockImplementation(async () => {Object.assign(f.view, {state: "stopped", health: "not-running", uid: null}); return f.logs;});
  await expect(f.call()).rejects.toThrow();
});
it("rejects unsafe, private, unredacted or oversized port projections", async () => {
  for (const patch of [{password: "private"}, {redacted: false}, {stdout: "password=tiny"}, {stderr: "api_key=tiny"}, {stdout: "x".repeat(4097)}]) {
    const f = fixture(); Object.assign(f.logs, patch); await expect(f.call()).rejects.toThrow(/^Database logs are unavailable\.$/);
  }
});
it("denies selectors outside bounded tail and canonical UTC before ports", async () => {
  for (const patch of [{tail: -1}, {tail: 5001}, {since: "1m"}, {since: "1970-01-01T00:00:02.000Z"}, {password: "private"}]) {
    const f = fixture(); Object.assign(f.selection, patch); await expect(f.call()).rejects.toThrow();
    expect(f.observe).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
  }
});
it("withholds logs after authority revocation or reader replacement", async () => {
  for (const mode of ["authority", "reader"]) {
    const f = fixture(); f.read.mockImplementation(async () => {
      if (mode === "authority") f.authority.assertValid.mockRejectedValue(new Error("private"));
      else f.options.logs.read = vi.fn(async () => f.logs);
      return f.logs;
    });
    await expect(f.call()).rejects.toThrow();
  }
});
it("bounds stalled health/log ports and pre-aborted calls", async () => {
  for (const port of ["health", "logs"]) {
    const f = fixture(); f.options.limits.deadlineMs = 5;
    if (port === "health") f.observe.mockImplementation(() => new Promise(() => {}));
    else f.read.mockImplementation(() => new Promise(() => {}));
    await expect(f.call()).rejects.toThrow();
  }
  const f = fixture(), controller = new AbortController(); controller.abort();
  await expect(f.call(controller.signal)).rejects.toThrow(); expect(f.observe).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
});
