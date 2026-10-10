import { expect, it } from "vitest";
import { digestControlInput } from "./control-plane.js";
import { validateManagedDatabaseNativeEnvironment } from "./managed-database-runtime-spec.js";
const policy = { policyVersion: "images-1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true };
const password = "a".repeat(64), root = "b".repeat(64), fingerprint = "c".repeat(32);
const username = "dl_" + digestControlInput({ projectId: "project-a", databaseId: "orders" }).slice(0, 12);
const engines = ["postgres", "mysql", "mariadb", "mongodb", "redis"] as const;
function fixture(engine: typeof engines[number], separateRoot = false) {
    const input = { schemaVersion: 1, projectId: "project-a", databaseId: "orders", engine };
    const profile = { schemaVersion: 1, profileId: "profile-" + engine, engine, image: `registry.example.com/${engine}@sha256:${"d".repeat(64)}`,
        dataPath: "/data", containerPort: ({ postgres: 5432, mysql: 3306, mariadb: 3306, mongodb: 27017, redis: 6379 })[engine],
        credentialKeys: separateRoot ? ["DATABASE_PASSWORD", "DATABASE_ROOT_PASSWORD"] : ["DATABASE_PASSWORD"], backupStrategy: engine === "redis" ? "volume-quiesced" : "engine-native" };
    const environment: Record<string, string> = engine === "postgres" ? { POSTGRES_DB: "orders", POSTGRES_USER: username, POSTGRES_PASSWORD: password }
        : engine === "mongodb" ? { MONGO_INITDB_ROOT_USERNAME: username, MONGO_INITDB_ROOT_PASSWORD: password, MONGO_INITDB_DATABASE: "orders" }
            : engine === "redis" ? { REDIS_PASSWORD: password }
                : engine === "mysql" ? { MYSQL_DATABASE: "orders", MYSQL_ROOT_PASSWORD: separateRoot ? root : password, ...(separateRoot ? { MYSQL_USER: username, MYSQL_PASSWORD: password } : {}) }
                    : { MARIADB_DATABASE: "orders", MARIADB_ROOT_PASSWORD: separateRoot ? root : password, ...(separateRoot ? { MARIADB_USER: username, MARIADB_PASSWORD: password } : {}) };
    return { input, profile, environment };
}
it.each(engines)("validates the scoped native %s environment opened by the existing envelope", engine => {
    const f = fixture(engine);
    const result = validateManagedDatabaseNativeEnvironment(f.input, f.profile, policy, f.environment, fingerprint);
    expect(result?.plan.engine).toBe(engine);
    expect(result?.environment).toEqual(f.environment);
    expect(result?.environmentFingerprint).toBe(fingerprint);
    expect(JSON.stringify(result)).not.toContain(password);
    expect(Object.isFrozen(result?.environment)).toBe(true);
});
it.each(engines)("rejects foreign identities, extra environment and invalid %s password shapes", engine => {
    const f = fixture(engine);
    const passwordKey = Object.keys(f.environment).find(key => key.endsWith("PASSWORD"))!;
    for (const environment of [{ ...f.environment, UNAPPROVED: "foreign" }, { ...f.environment, [passwordKey]: "weak-password" },
        Object.fromEntries(Object.entries(f.environment).map(([key, value]) => [key, key.endsWith("DATABASE") || key.endsWith("_DB") || key.endsWith("USERNAME") || key.endsWith("_USER") ? "foreign" : value]))]) {
        if (JSON.stringify(environment) !== JSON.stringify(f.environment))
            expect(() => validateManagedDatabaseNativeEnvironment(f.input, f.profile, policy, environment, fingerprint)).toThrow("runtime configuration is unavailable");
    }
    expect(() => validateManagedDatabaseNativeEnvironment(f.input, f.profile, policy, f.environment, "invalid")).toThrow("runtime configuration is unavailable");
});
it.each(["mysql", "mariadb"] as const)("requires both approved %s root and application credentials without dropping either", engine => {
    const f = fixture(engine, true);
    const result = validateManagedDatabaseNativeEnvironment(f.input, f.profile, policy, f.environment, fingerprint);
    expect(result?.username).toBe(username);
    expect(result?.environment).toEqual(f.environment);
    const key = engine === "mysql" ? "MYSQL_PASSWORD" : "MARIADB_PASSWORD";
    const { [key]: _, ...missing } = f.environment;
    expect(() => validateManagedDatabaseNativeEnvironment(f.input, f.profile, policy, missing, fingerprint)).toThrow("runtime configuration is unavailable");
});
it.each(engines)("requires the final PID1 daemon before reporting %s health", engine => {
    const f = fixture(engine);
    const result = validateManagedDatabaseNativeEnvironment(f.input, f.profile, policy, f.environment, fingerprint);
    expect(result?.healthCommand).toContain("/proc/1/comm");
});
