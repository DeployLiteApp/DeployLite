import { expect, it } from "vitest";
import { createEnvSecretCipher } from "@deploylite/config";
import type { ManagedDatabaseEngineV1 } from "@deploylite/contracts";
import type { EncryptedEnvSecretValueRecord, EnvSecretValueInput } from "./index.js";
import { ensureManagedDatabaseCredentials } from "./managed-database-credentials.js";
import { materializeManagedDatabaseRuntime } from "./managed-database-runtime-spec.js";
const imagePolicy = { policyVersion: "images-1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true };
async function fixture(engine: ManagedDatabaseEngineV1, root = false) {
    const input = { schemaVersion: 1, projectId: "project-a", databaseId: "orders", engine };
    const profile = { schemaVersion: 1, profileId: "profile-" + engine, engine, image: `registry.example.com/${engine}@sha256:${"a".repeat(64)}`, dataPath: "/database/data",
        containerPort: ({ postgres: 5432, mysql: 3306, mariadb: 3306, mongodb: 27017, redis: 6379 })[engine], credentialKeys: root ? ["DATABASE_PASSWORD", "DATABASE_ROOT_PASSWORD"] : ["DATABASE_PASSWORD"], backupStrategy: engine === "redis" ? "volume-quiesced" : "engine-native" };
    const cipher = createEnvSecretCipher(Buffer.alloc(32, 18));
    let row: EncryptedEnvSecretValueRecord | undefined;
    const secrets = { find: async () => row, createIfAbsent: async (record: EnvSecretValueInput) => row ??= { ...record, id: "secret-1", valuePresent: true, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } };
    await ensureManagedDatabaseCredentials(input, profile, { imagePolicy, cipher, secrets, authorize: async () => true, entropy: () => Buffer.alloc(32, 9) });
    return { input, profile, ports: { imagePolicy, cipher, credentials: row! } };
}
it.each(["postgres", "mysql", "mariadb", "mongodb", "redis"] as const)("materializes native %s configuration from its scoped encrypted bundle", async (engine) => {
    const f = await fixture(engine);
    const spec = materializeManagedDatabaseRuntime(f.input, f.profile, f.ports);
    expect(spec.plan.engine).toBe(engine);
    expect(spec.plan.executionAllowed).toBe(false);
    expect(spec.environmentFingerprint).toMatch(/^[a-f0-9]{32}$/);
    expect(spec.healthCommand).toBeTruthy();
    const keys = { postgres: "POSTGRES_PASSWORD", mysql: "MYSQL_ROOT_PASSWORD", mariadb: "MARIADB_ROOT_PASSWORD", mongodb: "MONGO_INITDB_ROOT_PASSWORD", redis: "REDIS_PASSWORD" };
    expect(spec.environment[keys[engine]]).toBe("09".repeat(32));
    expect(JSON.stringify(spec)).not.toContain("09".repeat(32));
    expect(Object.keys(spec)).not.toContain("environment");
    expect(Object.isFrozen(spec.environment)).toBe(true);
    expect(spec.databaseName).toBe(engine === "redis" ? "0" : "orders");
    if (engine === "redis")
        expect(spec.command.join(" ")).toContain('$REDIS_PASSWORD');
    else
        expect(spec.command).toEqual([]);
});
it.each(["mysql", "mariadb"] as const)("separates %s application and root credentials when configured", async (engine) => {
    const f = await fixture(engine, true);
    const spec = materializeManagedDatabaseRuntime(f.input, f.profile, f.ports);
    const prefix = engine === "mysql" ? "MYSQL" : "MARIADB";
    expect(spec.environment[prefix + "_USER"]).toMatch(/^dl_[a-f0-9]{12}$/);
    expect(spec.environment[prefix + "_PASSWORD"]).toBeTruthy();
    expect(spec.environment[prefix + "_ROOT_PASSWORD"]).toBeTruthy();
    expect(spec.username).not.toBe("root");
});
it("refuses foreign, tampered and stale encrypted credential evidence", async () => {
    const f = await fixture("postgres");
    for (const credentials of [{ ...f.ports.credentials, projectId: "foreign" }, { ...f.ports.credentials, valueFingerprint: "0".repeat(32) },
        { ...f.ports.credentials, encryptedValue: Buffer.from("malformed") }])
        expect(() => materializeManagedDatabaseRuntime(f.input, f.profile, { ...f.ports, credentials })).toThrow("runtime configuration is unavailable");
    expect(() => materializeManagedDatabaseRuntime(f.input, { ...f.profile, profileId: "changed" }, f.ports)).toThrow("runtime configuration is unavailable");
});
