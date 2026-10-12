import { expect, it } from "vitest";
import { digestControlInput } from "@deploylite/domain";
import { buildManagedDatabaseRunArgv } from "./docker-managed-database-argv.js";
const policy = { policyVersion: "images-1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true };
const password = "a".repeat(64), fingerprint = "b".repeat(32);
const username = "dl_" + digestControlInput({ projectId: "project-a", databaseId: "orders" }).slice(0, 12);
const engines = ["postgres", "mysql", "mariadb", "mongodb", "redis"] as const;
function fixture(engine: typeof engines[number]) {
    const request = { schemaVersion: 1, projectId: "project-a", databaseId: "orders", engine };
    const profile = { schemaVersion: 1, profileId: "profile-" + engine, engine, image: `registry.example.com/${engine}@sha256:${"d".repeat(64)}`,
        dataPath: ({ postgres: "/var/lib/postgresql/data", mysql: "/var/lib/mysql", mariadb: "/var/lib/mysql", mongodb: "/data/db", redis: "/data" })[engine], containerPort: ({ postgres: 5432, mysql: 3306, mariadb: 3306, mongodb: 27017, redis: 6379 })[engine], credentialKeys: ["DATABASE_PASSWORD"], backupStrategy: engine === "redis" ? "volume-quiesced" : "engine-native" };
    const environment = engine === "postgres" ? { POSTGRES_DB: "orders", POSTGRES_USER: username, POSTGRES_PASSWORD: password }
        : engine === "mongodb" ? { MONGO_INITDB_ROOT_USERNAME: username, MONGO_INITDB_ROOT_PASSWORD: password, MONGO_INITDB_DATABASE: "orders" }
            : engine === "redis" ? { REDIS_PASSWORD: password } : engine === "mysql" ? { MYSQL_DATABASE: "orders", MYSQL_ROOT_PASSWORD: password }
                : { MARIADB_DATABASE: "orders", MARIADB_ROOT_PASSWORD: password };
    return { request, profile, environment, imagePolicy: policy, environmentFingerprint: fingerprint, owner: "deploylite", commandId: "command-a", limits: { cpus: 1, memoryBytes: 536870912, pidsLimit: 256 } };
}
it.each(engines)("prepares persistent internal %s startup without plaintext argv or host publication", engine => {
    const f = fixture(engine);
    const argv = buildManagedDatabaseRunArgv(f);
    expect(argv.slice(0, 3)).toEqual(["docker", "run", "--detach"]);
    expect(argv).toContain("--mount");
    expect(argv).toContain("--network-alias");
    expect(argv[argv.indexOf("--mount") + 1]).toMatch(/^type=volume,source=dl-[a-f0-9]{32}-vol-db-orders,target=\//);
    expect(argv[argv.indexOf("--mount") + 1]).toContain("target=" + f.profile.dataPath);
    expect(argv).not.toContain("--publish");
    expect(argv).not.toContain("--privileged");
    expect(argv).not.toContain("--cap-add");
    expect(argv).toContain("--read-only");
    expect(argv).toContain("--cap-drop=ALL");
    expect(argv).toContain("--security-opt=no-new-privileges");
    expect(argv[argv.indexOf("--user") + 1]).toBe(({ postgres: "postgres", mysql: "mysql", mariadb: "mysql", mongodb: "mongodb", redis: "redis" })[engine]);
    expect(argv[argv.indexOf("--health-cmd") + 1]).toContain("/proc/1/comm");
    expect(argv.filter((_, index) => argv[index - 1] === "--env")).toEqual(Object.keys(f.environment).sort());
    expect(argv.join(" ")).not.toContain(password);
    expect(Object.isFrozen(argv)).toBe(true);
    if (engine === "redis")
        expect(argv.slice(-3)).toEqual(["sh", "-c", 'exec redis-server --appendonly yes --requirepass "$REDIS_PASSWORD"']);
    else
        expect(argv.at(-1)).toBe(f.profile.image);
});
it("rejects unsafe execution metadata and unbounded resources before producing argv", () => {
    const f = fixture("postgres");
    for (const patch of [{ owner: "unsafe owner" }, { commandId: "../foreign" }, { limits: { ...f.limits, cpus: NaN } },
        { limits: { ...f.limits, memoryBytes: 0 } }, { limits: { ...f.limits, pidsLimit: 0 } }, { environment: { ...f.environment, DOCKER_HOST: "foreign" } }])
        expect(() => buildManagedDatabaseRunArgv({ ...f, ...patch })).toThrow("Database Docker preparation is unavailable");
});
it.each(engines)("rejects a %s profile mounting outside its native data path", engine => {
    const f = fixture(engine);
    expect(() => buildManagedDatabaseRunArgv({ ...f, profile: { ...f.profile, dataPath: "/unrelated/path" } })).toThrow("Database Docker preparation is unavailable");
});
it("covers the unused standalone MongoDB image config volume with explicit tmpfs", () => {
    expect(buildManagedDatabaseRunArgv(fixture("mongodb"))).toContain("/data/configdb:rw,noexec,nosuid,nodev,mode=1777,size=8388608");
});
