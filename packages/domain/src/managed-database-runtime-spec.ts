import type { ImageReferencePolicyV1, ManagedDatabaseEngineV1 } from "@deploylite/contracts";
import type { EnvSecretCipher } from "@deploylite/config";
import type { EncryptedEnvSecretValueRecord } from "./index.js";
import { digestControlInput } from "./control-plane.js";
import { planManagedDatabaseProfile } from "./managed-database-profile.js";
import { readManagedDatabaseCredentialBundle } from "./managed-database-credentials.js";
const health: Record<ManagedDatabaseEngineV1, string> = {
    postgres: '[ "$(cat /proc/1/comm)" = postgres ] && PGPASSWORD="$POSTGRES_PASSWORD" psql --host 127.0.0.1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --no-password --command "SELECT 1" >/dev/null',
    mysql: '[ "$(cat /proc/1/comm)" = mysqld ] && MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql --host 127.0.0.1 --user root --execute "SELECT 1" >/dev/null',
    mariadb: '[ "$(cat /proc/1/comm)" = mariadbd ] && MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb --host 127.0.0.1 --user root --execute "SELECT 1" >/dev/null',
    mongodb: '[ "$(cat /proc/1/comm)" = mongod ] && mongosh --quiet --host 127.0.0.1 --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval "quit(db.adminCommand({ping:1}).ok === 1 ? 0 : 1)" >/dev/null',
    redis: '[ "$(cat /proc/1/comm)" = redis-server ] && REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --no-auth-warning -h 127.0.0.1 ping | grep -qx PONG'
};
export type ManagedDatabaseRuntimeSpec = Readonly<{
    plan: ReturnType<typeof planManagedDatabaseProfile>;
    databaseName: string;
    username: string;
    environmentFingerprint: string;
    healthCommand: string;
    command: readonly string[];
    runAsUser: "redis" | null;
    environment: Readonly<Record<string, string>>;
}>;
export type ManagedDatabaseRuntimeMaterializationPorts = Readonly<{
    imagePolicy: ImageReferencePolicyV1;
    cipher: EnvSecretCipher;
    credentials: EncryptedEnvSecretValueRecord;
}>;
export class ManagedDatabaseRuntimeConfigurationError extends Error {
    constructor() { super("Managed database runtime configuration is unavailable."); this.name = "ManagedDatabaseRuntimeConfigurationError"; }
}
type NativeConfiguration = Omit<ManagedDatabaseRuntimeSpec, "environmentFingerprint">;
function nativeConfiguration(plan: ReturnType<typeof planManagedDatabaseProfile>, credentials: Readonly<Record<string, string>>): NativeConfiguration {
    const password = credentials.DATABASE_PASSWORD;
    if (!password || Object.values(credentials).some(value => !/^([a-f0-9]{64})$/.test(value))
        || JSON.stringify(Object.keys(credentials).sort()) !== JSON.stringify(plan.credentialKeys)
        || Object.keys(credentials).some(key => key !== "DATABASE_PASSWORD" && (key !== "DATABASE_ROOT_PASSWORD" || !["mysql", "mariadb"].includes(plan.engine))))
        throw new ManagedDatabaseRuntimeConfigurationError();
    const root = credentials.DATABASE_ROOT_PASSWORD;
    const user = "dl_" + digestControlInput({ projectId: plan.projectId, databaseId: plan.databaseId }).slice(0, 12);
    const databaseName = plan.engine === "redis" ? "0" : plan.databaseId;
    let username = user, environment: Record<string, string>;
    switch (plan.engine) {
        case "postgres":
            environment = { POSTGRES_DB: databaseName, POSTGRES_USER: user, POSTGRES_PASSWORD: password };
            break;
        case "mysql":
        case "mariadb": {
            const prefix = plan.engine === "mysql" ? "MYSQL" : "MARIADB";
            environment = { [prefix + "_DATABASE"]: databaseName, [prefix + "_ROOT_PASSWORD"]: root ?? password };
            if (root) {
                environment[prefix + "_USER"] = user;
                environment[prefix + "_PASSWORD"] = password;
            }
            else
                username = "root";
            break;
        }
        case "mongodb":
            environment = { MONGO_INITDB_ROOT_USERNAME: user, MONGO_INITDB_ROOT_PASSWORD: password, MONGO_INITDB_DATABASE: databaseName };
            break;
        case "redis":
            username = "default";
            environment = { REDIS_PASSWORD: password };
            break;
    }
    return { plan, databaseName, username, environment: Object.freeze(environment), healthCommand: health[plan.engine],
        command: Object.freeze(plan.engine === "redis" ? ["sh", "-c", 'exec redis-server --appendonly yes --requirepass "$REDIS_PASSWORD"'] : []), runAsUser: plan.engine === "redis" ? "redis" : null };
}
function privateProjection(native: NativeConfiguration, environmentFingerprint: string): ManagedDatabaseRuntimeSpec {
    return Object.freeze(Object.defineProperty({ ...native, environmentFingerprint }, "environment", { enumerable: false }));
}
/** Pure private materialization. Plaintext must travel only in the existing sealed agent envelope. */
export function materializeManagedDatabaseRuntime(raw: unknown, profile: unknown, ports: ManagedDatabaseRuntimeMaterializationPorts): ManagedDatabaseRuntimeSpec {
    try {
        const plan = planManagedDatabaseProfile(raw, profile, ports.imagePolicy);
        const bundle = readManagedDatabaseCredentialBundle(plan, ports.credentials, ports.cipher);
        const native = nativeConfiguration(plan, bundle.credentials);
        return privateProjection(native, ports.cipher.fingerprint(JSON.stringify(native.environment)));
    }
    catch {
        throw new ManagedDatabaseRuntimeConfigurationError();
    }
}
/** Validate an authenticated opened envelope against the agent's approved profile. The opaque keyed fingerprint is bound by that envelope's existing command AAD. */
export function validateManagedDatabaseNativeEnvironment(raw: unknown, profile: unknown, policy: ImageReferencePolicyV1, environment: unknown, environmentFingerprint: unknown): ManagedDatabaseRuntimeSpec {
    try {
        const plan = planManagedDatabaseProfile(raw, profile, policy);
        if (!environment || typeof environment !== "object" || Array.isArray(environment) || typeof environmentFingerprint !== "string"
            || !/^[a-f0-9]{32}$/.test(environmentFingerprint))
            throw new ManagedDatabaseRuntimeConfigurationError();
        const entries = Object.entries(environment);
        if (entries.some(([, value]) => typeof value !== "string"))
            throw new ManagedDatabaseRuntimeConfigurationError();
        const supplied = Object.fromEntries(entries) as Record<string, string>;
        const passwordKey = { postgres: "POSTGRES_PASSWORD", mysql: "MYSQL_ROOT_PASSWORD", mariadb: "MARIADB_ROOT_PASSWORD", mongodb: "MONGO_INITDB_ROOT_PASSWORD", redis: "REDIS_PASSWORD" }[plan.engine];
        const credentials: Record<string, string> = { DATABASE_PASSWORD: supplied[passwordKey]! };
        if (plan.credentialKeys.includes("DATABASE_ROOT_PASSWORD")) {
            const prefix = plan.engine === "mysql" ? "MYSQL" : "MARIADB";
            credentials.DATABASE_PASSWORD = supplied[prefix + "_PASSWORD"]!;
            credentials.DATABASE_ROOT_PASSWORD = supplied[prefix + "_ROOT_PASSWORD"]!;
        }
        const native = nativeConfiguration(plan, credentials);
        const canonical = (value: Readonly<Record<string, string>>) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
        if (canonical(native.environment) !== canonical(supplied))
            throw new ManagedDatabaseRuntimeConfigurationError();
        return privateProjection(native, environmentFingerprint);
    }
    catch {
        throw new ManagedDatabaseRuntimeConfigurationError();
    }
}
