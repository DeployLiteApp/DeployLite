import type { ImageReferencePolicyV1, ManagedDatabaseEngineV1 } from "@deploylite/contracts";
import type { EnvSecretCipher } from "@deploylite/config";
import type { EncryptedEnvSecretValueRecord } from "./index.js";
import { digestControlInput } from "./control-plane.js";
import { planManagedDatabaseProfile } from "./managed-database-profile.js";
import { readManagedDatabaseCredentialBundle } from "./managed-database-credentials.js";
const health: Record<ManagedDatabaseEngineV1, string> = {
    postgres: 'PGPASSWORD="$POSTGRES_PASSWORD" psql --host 127.0.0.1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --no-password --command "SELECT 1" >/dev/null',
    mysql: 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql --host 127.0.0.1 --user root --execute "SELECT 1" >/dev/null',
    mariadb: 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb --host 127.0.0.1 --user root --execute "SELECT 1" >/dev/null',
    mongodb: 'mongosh --quiet --host 127.0.0.1 --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval "quit(db.adminCommand({ping:1}).ok === 1 ? 0 : 1)" >/dev/null',
    redis: 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --no-auth-warning --host 127.0.0.1 ping | grep -qx PONG'
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
/** Pure private materialization. The plaintext environment is deliberately non-enumerable and must travel only in the existing sealed agent envelope. */
export function materializeManagedDatabaseRuntime(raw: unknown, profile: unknown, ports: ManagedDatabaseRuntimeMaterializationPorts): ManagedDatabaseRuntimeSpec {
    try {
        const plan = planManagedDatabaseProfile(raw, profile, ports.imagePolicy);
        const bundle = readManagedDatabaseCredentialBundle(plan, ports.credentials, ports.cipher), password = bundle.credentials.DATABASE_PASSWORD;
        if (!password || Object.keys(bundle.credentials).some(key => key !== "DATABASE_PASSWORD" && (key !== "DATABASE_ROOT_PASSWORD" || !["mysql", "mariadb"].includes(plan.engine))))
            throw new ManagedDatabaseRuntimeConfigurationError();
        const root = bundle.credentials.DATABASE_ROOT_PASSWORD;
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
        const projection: ManagedDatabaseRuntimeSpec = { plan, databaseName, username, environment: Object.freeze(environment), environmentFingerprint: ports.cipher.fingerprint(JSON.stringify(environment)), healthCommand: health[plan.engine],
            command: plan.engine === "redis" ? ["sh", "-c", 'exec redis-server --appendonly yes --requirepass "$REDIS_PASSWORD"'] : [], runAsUser: plan.engine === "redis" ? "redis" : null };
        return Object.freeze(Object.defineProperty(projection, "environment", { enumerable: false }));
    }
    catch {
        throw new ManagedDatabaseRuntimeConfigurationError();
    }
}
