import { expect, it } from "vitest";
import { managedDatabaseNativeImagePolicy, parseManagedDatabaseRuntimeConfiguration, validateManagedDatabaseRuntimeProfiles } from "./managed-database-runtime-configuration.js";
import { planManagedDatabaseProfile } from "./managed-database-profile.js";
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
it("parses all five explicit native profiles and limits without runtime effects or defaults", () => {
  const supplied = configuration(), parsed = parseManagedDatabaseRuntimeConfiguration(JSON.stringify(supplied))!;
  expect(parsed).toEqual(supplied); expect(Object.keys(parsed.profiles).sort()).toEqual([...engines].sort());
  for (const engine of engines) expect(planManagedDatabaseProfile({ schemaVersion: 1, projectId: "project-a", databaseId: "orders", engine }, parsed.profiles[engine], managedDatabaseNativeImagePolicy()).policyVersion).toBe("agent-compose-v1");
});
it("keeps absence disabled and rejects malformed, oversized, extra or private configuration generically", () => {
  expect(parseManagedDatabaseRuntimeConfiguration(undefined)).toBeUndefined();
  for (const raw of ["", "null", "{", " ".repeat(65537), JSON.stringify({ ...configuration(), password: "private-secret" })]) {
    expect(() => parseManagedDatabaseRuntimeConfiguration(raw)).toThrow("Database runtime configuration is invalid.");
  }
});
it("shares identical native image policy without mutable cross-call state", () => {
  const first = managedDatabaseNativeImagePolicy(); expect(first).toEqual({ policyVersion: "agent-compose-v1", trustedHosts: ["docker.io", "ghcr.io", "registry.example.com"], allowTags: false, allowDigests: true });
  first.trustedHosts.push("foreign.test"); expect(managedDatabaseNativeImagePolicy().trustedHosts).not.toContain("foreign.test");
});
it("rejects missing, extra, mismatched or unsupported profiles before configuration is published", () => {
  const f = configuration(), { redis, ...missing } = f.profiles;
  for (const profiles of [missing, { ...f.profiles, extra: redis }, { ...f.profiles, postgres: { ...f.profiles.postgres, engine: "redis" } },
    { ...f.profiles, postgres: { ...f.profiles.postgres, dataPath: "/private" } }, { ...f.profiles, postgres: { ...f.profiles.postgres, credentialKeys: ["UNAPPROVED"] } }])
    expect(() => parseManagedDatabaseRuntimeConfiguration(JSON.stringify({ ...f, profiles }))).toThrow("Database runtime configuration is invalid.");
});
it("preserves immutable image, native port, engine backup and bounded limit validation", () => {
  const f = configuration();
  for (const patch of [{ image: "docker.io/library/postgres:latest" }, { containerPort: 1234 }, { backupStrategy: "volume-quiesced" }])
    expect(() => parseManagedDatabaseRuntimeConfiguration(JSON.stringify({ ...f, profiles: { ...f.profiles, postgres: { ...f.profiles.postgres, ...patch } } }))).toThrow();
  for (const patch of [{ deadlineMs: 0 }, { cpus: 3 }, { memoryBytes: 0 }, { pollIntervalMs: 1001 }, { pidsLimit: 1 }, { maxContainers: 129 }])
    expect(() => parseManagedDatabaseRuntimeConfiguration(JSON.stringify({ ...f, limits: { ...f.limits, ...patch } }))).toThrow();
});
it("validates injected native profiles under the existing caller policy and detaches arrays", () => {
  const f = configuration(), policy = { policyVersion: "images-1", trustedHosts: ["docker.io"], allowTags: false, allowDigests: true };
  const parsed = validateManagedDatabaseRuntimeProfiles(f.profiles, policy); expect(parsed.postgres.profileId).toBe(f.profiles.postgres!.profileId);
  parsed.postgres.credentialKeys.push("MUTATED"); expect(f.profiles.postgres!.credentialKeys).toEqual(["DATABASE_PASSWORD"]);
});

it("accepts only explicit bounded stop grace and never supplies a stop default",()=>{
    const f=configuration();expect(parseManagedDatabaseRuntimeConfiguration(JSON.stringify(f))!.limits).not.toHaveProperty("stopGraceSeconds");
    expect(()=>parseManagedDatabaseRuntimeConfiguration(JSON.stringify({...f,limits:{...f.limits,stopGraceSeconds:10}}))).not.toThrow();
    expect(parseManagedDatabaseRuntimeConfiguration(JSON.stringify({...f,limits:{...f.limits,stopGraceSeconds:10}}))!.limits).toHaveProperty("stopGraceSeconds",10);
    for(const grace of [0,31,1.5,"10",null])expect(()=>parseManagedDatabaseRuntimeConfiguration(JSON.stringify({...f,limits:{...f.limits,stopGraceSeconds:grace}}))).toThrow();
});
