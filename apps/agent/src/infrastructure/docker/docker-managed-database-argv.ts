import type { ImageReferencePolicyV1 } from "@deploylite/contracts";
import { createManagedDatabaseComposePreview, digestControlInput, validateManagedDatabaseNativeEnvironment } from "@deploylite/domain";
export type ManagedDatabaseDockerInput = Readonly<{
    request: unknown;
    profile: unknown;
    imagePolicy: ImageReferencePolicyV1;
    environment: unknown;
    environmentFingerprint: unknown;
    owner: string;
    commandId: string;
    limits: Readonly<{
        cpus: number;
        memoryBytes: number;
        pidsLimit: number;
    }>;
}>;
export function managedDatabaseContainerName(projectId: string, databaseId: string): string {
    return "dl-" + digestControlInput({ projectId, databaseId }).slice(0, 32) + "-database";
}
/** Pure argv preparation. Resource ownership, image identity and current project authority must be corroborated by the executor before running it. */
export function buildManagedDatabaseRunArgv(input: ManagedDatabaseDockerInput): readonly string[] {
    try {
        const native = validateManagedDatabaseNativeEnvironment(input.request, input.profile, input.imagePolicy, input.environment, input.environmentFingerprint);
        const preview = createManagedDatabaseComposePreview(input.request, input.profile, input.imagePolicy);
        const { plan } = native, { cpus, memoryBytes, pidsLimit } = input.limits;
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(input.owner) || !/^[A-Za-z0-9_-]{1,200}$/.test(input.commandId)
            || !Number.isFinite(cpus) || cpus < 0.1 || cpus > 2 || !Number.isSafeInteger(memoryBytes) || memoryBytes < 64 * 1024 * 1024 || memoryBytes > 4 * 1024 * 1024 * 1024
            || !Number.isSafeInteger(pidsLimit) || pidsLimit < 16 || pidsLimit > 1024)
            throw new Error();
        const targets = { postgres: ["/var/lib/postgresql/data", "/var/lib/postgresql"], mysql: ["/var/lib/mysql"], mariadb: ["/var/lib/mysql"], mongodb: ["/data/db"], redis: ["/data"] };
        if (!targets[plan.engine].includes(plan.volume.target))
            throw new Error();
        const user = { postgres: "postgres", mysql: "mysql", mariadb: "mysql", mongodb: "mongodb", redis: "redis" }[plan.engine];
        const sockets = plan.engine === "postgres" ? ["/var/run/postgresql"] : ["mysql", "mariadb"].includes(plan.engine) ? ["/var/run/mysqld"] : [];
        return Object.freeze(["docker", "run", "--detach", "--pull=never", "--name", managedDatabaseContainerName(plan.projectId, plan.databaseId),
            "--label", "com.deploylite.owner=" + input.owner, "--label", "com.deploylite.project=" + plan.projectId,
            "--label", "com.deploylite.compose.managed=v1", "--label", "com.deploylite.compose.service=" + plan.volume.key,
            "--label", "com.deploylite.compose.config-digest=" + preview.configDigest,
            "--label", "com.deploylite.compose.environment-digest=" + digestControlInput({ environmentFingerprint: native.environmentFingerprint }),
            "--label", "com.deploylite.database=" + plan.databaseId, "--label", "com.deploylite.database.engine=" + plan.engine,
            "--label", "com.deploylite.database.command=" + input.commandId, "--label", "com.deploylite.database.plan=" + plan.planDigest,
            "--label", "com.deploylite.database.environment=" + native.environmentFingerprint,
            "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user", user,
            "--cpus", String(cpus), "--memory", String(memoryBytes), "--pids-limit", String(pidsLimit), "--restart=no",
            "--network", plan.network.runtimeName, "--network-alias", plan.volume.key,
            "--mount", `type=volume,source=${plan.volume.runtimeName},target=${plan.volume.target}`,
            "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,mode=1777,size=67108864",
            ...(plan.engine === "mongodb" ? ["--tmpfs", "/data/configdb:rw,noexec,nosuid,nodev,mode=1777,size=8388608"] : []),
            ...sockets.flatMap(path => ["--tmpfs", `${path}:rw,noexec,nosuid,nodev,mode=1777,size=8388608`]),
            ...Object.keys(native.environment).sort().flatMap(key => ["--env", key]),
            "--health-cmd", native.healthCommand, "--health-interval=1s", "--health-timeout=3s", "--health-retries=60",
            plan.image, ...native.command]);
    }
    catch {
        throw new Error("Database Docker preparation is unavailable.");
    }
}
