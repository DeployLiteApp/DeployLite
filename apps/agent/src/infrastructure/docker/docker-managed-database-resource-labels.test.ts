import { expect, it } from "vitest";
import { createManagedDatabaseComposePreview, digestControlInput } from "@deploylite/domain";
import { buildManagedDatabaseRunArgv } from "./docker-managed-database-argv.js";
it("labels native database storage for the existing global Compose ownership inspector", () => {
    const request = { schemaVersion: 1, projectId: "project-a", databaseId: "orders", engine: "postgres" };
    const profile = { schemaVersion: 1, profileId: "profile-a", engine: "postgres", image: `registry.example.com/postgres@sha256:${"a".repeat(64)}`, dataPath: "/var/lib/postgresql/data", containerPort: 5432, credentialKeys: ["DATABASE_PASSWORD"], backupStrategy: "engine-native" };
    const imagePolicy = { policyVersion: "images-1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true };
    const environmentFingerprint = "b".repeat(32), environment = { POSTGRES_DB: "orders", POSTGRES_USER: "dl_" + digestControlInput({ projectId: "project-a", databaseId: "orders" }).slice(0, 12), POSTGRES_PASSWORD: "c".repeat(64) };
    const preview = createManagedDatabaseComposePreview(request, profile, imagePolicy);
    const argv = buildManagedDatabaseRunArgv({ request, profile, imagePolicy, environment, environmentFingerprint, owner: "deploylite", commandId: "command-a", limits: { cpus: 1, memoryBytes: 536870912, pidsLimit: 256 } });
    for (const label of ["com.deploylite.compose.managed=v1", "com.deploylite.compose.service=db-orders", "com.deploylite.compose.config-digest=" + preview.configDigest,
        "com.deploylite.compose.environment-digest=" + digestControlInput({ environmentFingerprint })])
        expect(argv).toContain(label);
    expect(argv.join(" ")).not.toContain(environment.POSTGRES_PASSWORD);
});
