import type { ImageReferencePolicyV1 } from "@deploylite/contracts";
import { createManagedDatabaseComposePreview, digestControlInput, planManagedDatabaseProfile } from "@deploylite/domain";
export type ManagedDatabaseStorageInitializationInput = Readonly<{
    request: unknown;
    profile: unknown;
    imagePolicy: ImageReferencePolicyV1;
    owner: string;
    commandId: string;
    limits: Readonly<{
        cpus: number;
        memoryBytes: number;
        pidsLimit: number;
    }>;
}>;
/** Pure preparation only: the executor must prove the original fresh volume, pinned image and no consumers, and fence each effect with current authority. */
export function buildManagedDatabaseStorageInitializationArgv(input: ManagedDatabaseStorageInitializationInput): readonly string[] {
    try {
        const plan = planManagedDatabaseProfile(input.request, input.profile, input.imagePolicy), { cpus, memoryBytes, pidsLimit } = input.limits;
        const paths = { postgres: ["/var/lib/postgresql/data", "/var/lib/postgresql"], mysql: ["/var/lib/mysql"], mariadb: ["/var/lib/mysql"], mongodb: ["/data/db"], redis: ["/data"] };
        if (!paths[plan.engine].includes(plan.volume.target) || !/^[A-Za-z0-9_-]{1,200}$/.test(input.owner) || !/^[A-Za-z0-9_-]{1,200}$/.test(input.commandId)
            || !Number.isFinite(cpus) || cpus < 0.1 || cpus > 2 || !Number.isSafeInteger(memoryBytes) || memoryBytes < 67108864 || memoryBytes > 4294967296
            || !Number.isSafeInteger(pidsLimit) || pidsLimit < 16 || pidsLimit > 1024)
            throw new Error();
        const preview=createManagedDatabaseComposePreview(input.request,input.profile,input.imagePolicy);
        const user = { postgres: "postgres", mysql: "mysql", mariadb: "mysql", mongodb: "mongodb", redis: "redis" }[plan.engine];
        const name = "dl-" + digestControlInput({ projectId: plan.projectId, databaseId: plan.databaseId, commandId: input.commandId }).slice(0, 32) + "-database-init";
        const script = `data='${plan.volume.target}'; test -d "$data" && test ! -L "$data" && test "$(stat -c %u "$data")" = 0 && contents="$(ls -A "$data")" && test -z "$contents" && chmod 0700 "$data" && chown ${user}:${user} "$data"`;
        return Object.freeze(["docker", "create", "--pull=never", "--name", name,
            "--label", "com.deploylite.owner=" + input.owner, "--label", "com.deploylite.project=" + plan.projectId,
            "--label", "com.deploylite.database=" + plan.databaseId, "--label", "com.deploylite.database.engine=" + plan.engine,
            "--label", "com.deploylite.database.command=" + input.commandId, "--label", "com.deploylite.database.plan=" + plan.planDigest,
            "--label", "com.deploylite.database.storage-init=v1",
            "--label","com.deploylite.compose.managed=v1","--label","com.deploylite.compose.service="+plan.volume.key,
            "--label","com.deploylite.compose.config-digest="+preview.configDigest,
            "--read-only", "--cap-drop=ALL", "--cap-add=CHOWN", "--security-opt=no-new-privileges", "--user", "0:0",
            "--cpus", String(cpus), "--memory", String(memoryBytes), "--pids-limit", String(pidsLimit), "--restart=no", "--network", "none",
            "--mount", `type=volume,source=${plan.volume.runtimeName},target=${plan.volume.target},volume-nocopy`,
            ...(plan.engine === "mongodb" ? ["--tmpfs", "/data/configdb:rw,noexec,nosuid,nodev,mode=1777,size=8388608"] : []),
            "--entrypoint", "/bin/sh", plan.image, "-ec", script]);
    }
    catch {
        throw new Error("Database storage preparation is unavailable.");
    }
}
