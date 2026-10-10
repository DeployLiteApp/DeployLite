import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildManagedDatabaseStorageInitializationArgv } from "./docker-managed-database-storage-argv.js";
const engines = ["postgres", "mysql", "mariadb", "mongodb", "redis"] as const;
const policy = { policyVersion: "images-1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true };
function fixture(engine: typeof engines[number]) {
    const paths = { postgres: "/var/lib/postgresql/data", mysql: "/var/lib/mysql", mariadb: "/var/lib/mysql", mongodb: "/data/db", redis: "/data" };
    return { request: { schemaVersion: 1, projectId: "project-a", databaseId: "orders", engine },
        profile: { schemaVersion: 1, profileId: "profile-" + engine, engine, image: `registry.example.com/${engine}@sha256:${"a".repeat(64)}`, dataPath: paths[engine], containerPort: ({ postgres: 5432, mysql: 3306, mariadb: 3306, mongodb: 27017, redis: 6379 })[engine], credentialKeys: ["DATABASE_PASSWORD"], backupStrategy: engine === "redis" ? "volume-quiesced" : "engine-native" },
        imagePolicy: policy, owner: "deploylite", commandId: "command-a", limits: { cpus: 0.1, memoryBytes: 67108864, pidsLimit: 16 } };
}
it.each(engines)("prepares empty %s storage for its native user without network or credentials", engine => {
    const f = fixture(engine), argv = buildManagedDatabaseStorageInitializationArgv(f);
    expect(argv.slice(0, 3)).toEqual(["docker", "create", "--pull=never"]);
    expect(argv).toContain("--read-only");
    expect(argv).toContain("--cap-drop=ALL");
    expect(argv).toContain("--cap-add=CHOWN");
    expect(argv[argv.indexOf("--user") + 1]).toBe("0:0");
    expect(argv[argv.indexOf("--network") + 1]).toBe("none");
    expect(argv).not.toContain("--env");
    expect(argv).not.toContain("--publish");
    expect(argv).not.toContain("--privileged");
    expect(argv).not.toContain("--rm");
    expect(argv[argv.indexOf("--mount") + 1]).toMatch(/^type=volume,source=dl-[a-f0-9]{32}-vol-db-orders,target=\//);
    expect(argv[argv.indexOf("--mount") + 1]).toContain("target=" + f.profile.dataPath);
    expect(argv[argv.indexOf("--entrypoint") + 1]).toBe("/bin/sh");
    expect(argv.slice(-3, -1)).toEqual([f.profile.image, "-ec"]);
    const script = argv.at(-1)!;
    expect(script).toContain('contents="$(ls -A "$data")" && test -z "$contents"');
    expect(script).toContain('test "$(stat -c %u "$data")" = 0');
    expect(script).toContain('chmod 0700 "$data"');
    expect(script).toContain('chown ' + ({ postgres: "postgres:postgres", mysql: "mysql:mysql", mariadb: "mysql:mysql", mongodb: "mongodb:mongodb", redis: "redis:redis" })[engine] + ' "$data"');
    expect(script).not.toContain("chown -R");
    expect(script).not.toContain("rm ");
    expect(Object.isFrozen(argv)).toBe(true);
    if (engine === "mongodb")
        expect(argv).toContain("/data/configdb:rw,noexec,nosuid,nodev,mode=1777,size=8388608");
});
it("binds helper identity to original command and rejects non-native paths/unbounded metadata", () => {
    const f = fixture("postgres"), one = buildManagedDatabaseStorageInitializationArgv(f), two = buildManagedDatabaseStorageInitializationArgv({ ...f, commandId: "command-b" });
    expect(one[one.indexOf("--name") + 1]).not.toBe(two[two.indexOf("--name") + 1]);
    expect(one).toContain("com.deploylite.database.command=command-a");
    for (const patch of [{ profile: { ...f.profile, dataPath: "/unrelated" } }, { owner: "unsafe owner" }, { commandId: "../foreign" }, { limits: { ...f.limits, memoryBytes: 0 } }, { limits: { ...f.limits, cpus: 3 } }, { limits: { ...f.limits, pidsLimit: 0 } }])
        expect(() => buildManagedDatabaseStorageInitializationArgv({ ...f, ...patch })).toThrow("Database storage preparation is unavailable");
});
it("never changes permissions when the empty-directory read fails", () => {
    const root = mkdtempSync(join(tmpdir(), "deploylite-storage-guard-")), bin = join(root, "bin"), data = join(root, "data"), changed = join(root, "changed");
    try {
        mkdirSync(bin);
        mkdirSync(data);
        for (const [name, body] of Object.entries({ stat: "printf 0", ls: "exit 42", chmod: 'touch "' + changed + '"', chown: 'touch "' + changed + '"' }))
            writeFileSync(join(bin, name), "#!/bin/sh\n" + body + "\n", { mode: 0o700 });
        const script = buildManagedDatabaseStorageInitializationArgv(fixture("postgres")).at(-1)!.replace("data='/var/lib/postgresql/data'", "data='" + data + "'");
        expect(() => execFileSync("/bin/sh", ["-ec", script], { env: { PATH: bin + ":/usr/bin:/bin" }, stdio: "pipe" })).toThrow();
        expect(existsSync(changed)).toBe(false);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});

it("binds the initializer to the existing global Compose consumer proof",()=>{
 const argv=buildManagedDatabaseStorageInitializationArgv(fixture("postgres"));
 expect(argv).toContain("com.deploylite.compose.managed=v1");expect(argv).toContain("com.deploylite.compose.service=db-orders");
 expect(argv.filter(v=>v.startsWith("com.deploylite.compose.config-digest="))).toHaveLength(1);
});

it("prevents Docker copy-up from changing the proven fresh volume before permission checks",()=>{
 const argv=buildManagedDatabaseStorageInitializationArgv(fixture("postgres"));expect(argv[argv.indexOf("--mount")+1]).toContain(",volume-nocopy");
});
