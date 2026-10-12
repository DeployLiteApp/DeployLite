import { expect, it } from "vitest";
import { planManagedDatabaseProfile } from "./managed-database-profile.js";
import { createManagedDatabaseComposePreview } from "./managed-database-compose-preview.js";
const policy = { policyVersion: "images-1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true };
it.each(["postgres", "mysql", "mariadb", "mongodb", "redis"] as const)("reuses existing scoped Compose resources for %s inspection and backups", engine => {
    const request = { schemaVersion: 1, projectId: "project-a", databaseId: "orders", engine };
    const profile = { schemaVersion: 1, profileId: "profile-" + engine, engine, image: `registry.example.com/${engine}@sha256:${"a".repeat(64)}`, dataPath: "/data",
        containerPort: ({ postgres: 5432, mysql: 3306, mariadb: 3306, mongodb: 27017, redis: 6379 })[engine], credentialKeys: ["DATABASE_PASSWORD"], backupStrategy: engine === "redis" ? "volume-quiesced" : "engine-native" };
    const plan = planManagedDatabaseProfile(request, profile, policy);
    const preview = createManagedDatabaseComposePreview(request, profile, policy);
    expect(preview?.projectId).toBe(request.projectId);
    expect(preview?.services).toHaveLength(1);
    expect(preview?.services[0]).toMatchObject({ name: plan.volume.key, image: plan.image, networks: [plan.network.key], volumes: [{ source: plan.volume.key, target: plan.volume.target, readOnly: false }] });
    expect(preview?.networks[0]).toMatchObject({ runtimeName: plan.network.runtimeName, internal: true });
    expect(preview?.volumes[0]).toMatchObject({ runtimeName: plan.volume.runtimeName });
    expect(preview?.services[0]?.secretRefs).toEqual([]);
    expect(preview?.configDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(preview?.executionAllowed).toBe(false);
});
