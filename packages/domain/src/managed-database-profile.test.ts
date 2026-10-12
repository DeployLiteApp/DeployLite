import { describe, expect, it } from "vitest";
import { planManagedDatabaseProfile } from "./managed-database-profile.js";
const policy = {policyVersion: "images-1", trustedHosts: ["registry.example.com"], allowTags: true, allowDigests: true};
const image = `registry.example.com/database/approved@sha256:${"a".repeat(64)}`;
const request = {schemaVersion: 1, projectId: "project-a", databaseId: "orders", engine: "postgres"};
const profile = (engine: string) => ({schemaVersion: 1, profileId: "approved-1", engine, image,
  dataPath: "/database/data", containerPort: ({postgres:5432,mysql:3306,mariadb:3306,mongodb:27017,redis:6379} as Record<string,number>)[engine], credentialKeys: ["DATABASE_PASSWORD"], backupStrategy: engine === "redis" ? "volume-quiesced" : "engine-native"});
describe("managed database profile planning", () => {
  it.each(["postgres", "mysql", "mariadb", "mongodb", "redis"])("plans the approved %s engine without effects", engine => {
    const plan = planManagedDatabaseProfile({...request, engine}, profile(engine), policy);
    expect(plan).toMatchObject({schemaVersion: 1, projectId: request.projectId, engine, databaseId: "orders", image,
      executionAllowed: false, credentialKeys: ["DATABASE_PASSWORD"], containerPort: profile(engine).containerPort});
    expect(plan.volume.runtimeName).toMatch(/^dl-[a-f0-9]{32}-vol-db-orders$/);
    expect(plan.network.runtimeName).toMatch(/^dl-[a-f0-9]{32}-net-db-orders$/);
    expect(plan.planDigest).toMatch(/^[a-f0-9]{64}$/);
  });
  it("isolates two databases and projects deterministically", () => {
    const plan = planManagedDatabaseProfile(request, profile("postgres"), policy);
    const second = planManagedDatabaseProfile({...request, databaseId: "billing"}, profile("postgres"), policy);
    const foreign = planManagedDatabaseProfile({...request, projectId: "project-b"}, profile("postgres"), policy);
    expect(plan).toEqual(planManagedDatabaseProfile(request, profile("postgres"), policy));
    expect(plan.volume.runtimeName).not.toBe(second.volume.runtimeName);
    expect(plan.volume.runtimeName).not.toBe(foreign.volume.runtimeName);
  });
  it("binds profile, scope and image policy to the plan", () => {
    const plan = planManagedDatabaseProfile(request, profile("postgres"), policy);
    for (const candidate of [planManagedDatabaseProfile(request, {...profile("postgres"), profileId: "approved-2"}, policy),
      planManagedDatabaseProfile(request, {...profile("postgres"), image: image.replace(/a{64}$/, "b".repeat(64))}, policy),
      planManagedDatabaseProfile(request, profile("postgres"), {...policy, policyVersion: "images-2"})])
      expect(candidate.planDigest).not.toBe(plan.planDigest);
  });
  it("rejects mismatched profiles, mutable images and untrusted registries", () => {
    for (const p of [profile("mysql"), {...profile("postgres"), image: "registry.example.com/db:latest"},
      {...profile("postgres"), image: image.replace("registry.example.com", "foreign.example.com")}])
      expect(() => planManagedDatabaseProfile(request, p, policy)).toThrow("cannot be prepared safely");
  });
  it("rejects raw credentials, port publishing and unsupported engines", () => {
    for (const extra of [{password: "private-fixture"}, {publishedPort: 5432}, {engine: "sqlite"}])
      expect(() => planManagedDatabaseProfile({...request, ...extra}, profile("postgres"), policy)).toThrow("cannot be prepared safely");
  });
  it("rejects unsafe mounts and ambiguous credentials", () => {
    for (const p of [{...profile("postgres"), dataPath: "/proc/data"}, {...profile("postgres"), dataPath: "/data/../escape"},
      {...profile("postgres"), credentialKeys: ["DATABASE_PASSWORD", "DATABASE_PASSWORD"]},
      {...profile("postgres"), credentialKeys: ["raw-secret"]}])
      expect(() => planManagedDatabaseProfile(request, p, policy)).toThrow("cannot be prepared safely");
  });
});
