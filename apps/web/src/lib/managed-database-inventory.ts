import { z } from "zod";
import { managedDatabaseProfileRequestSchema, managedDatabaseRuntimePreparationSchema, managedDatabaseHealthPreparationSchema,
  managedDatabaseStartPreparationSchema, type ManagedDatabaseHealthPreparationV1, type ManagedDatabaseStartPreparationV1 } from "@deploylite/contracts";
import { managedDatabaseConnectionSchema, type DatabaseClientOptions, type PreparedDatabaseView } from "./managed-database-lifecycle";
import { requestManagedDatabaseJson } from "./managed-database-telemetry";
export type ManagedDatabaseInventoryEntry = PreparedDatabaseView & {source: ManagedDatabaseHealthPreparationV1 | null; startPreparation: ManagedDatabaseStartPreparationV1 | null};
export type ManagedDatabaseInventoryResult = {kind: "ready"; databases: ManagedDatabaseInventoryEntry[]} | {kind: "error"; message: string};
const entrySchema = z.object({preparation: managedDatabaseRuntimePreparationSchema, connection: managedDatabaseConnectionSchema,
  source: managedDatabaseHealthPreparationSchema.nullable(), startPreparation: managedDatabaseStartPreparationSchema.nullable()}).strict();
const envelope = z.object({data: z.object({databases: z.array(entrySchema)}).strict(), error: z.null(), requestId: z.string().min(1).max(256)}).strict();
const unavailable = () => ({kind: "error" as const, message: "Database inventory is unavailable."});
const ports = {postgres: 5432, mysql: 3306, mariadb: 3306, mongodb: 27017, redis: 6379} as const;
/** Only original public metadata is recovered; every current state still requires fresh telemetry. */
export async function readManagedDatabaseInventory(projectId: string, supplied: DatabaseClientOptions): Promise<ManagedDatabaseInventoryResult> {
  try {
    managedDatabaseProfileRequestSchema.shape.projectId.parse(projectId);
    const options = {...supplied}, identities = new Set<string>();
    const {data} = envelope.parse(await requestManagedDatabaseJson(`/api/v1/projects/${encodeURIComponent(projectId)}/databases`, undefined, options, undefined, "GET"));
    for (const entry of data.databases) {
      const {preparation: base, connection, source, startPreparation} = entry;
      const shared = ["schemaVersion", "projectId", "databaseId", "engine", "profileId", "planDigest"] as const;
      if (base.projectId !== projectId || identities.has(base.databaseId) || shared.some(key => connection[key] !== base[key])
        || connection.hostname !== `db-${base.databaseId}` || connection.port !== ports[base.engine]
        || connection.databaseName !== (base.engine === "redis" ? "0" : base.databaseId)
        || connection.authenticationDatabase !== (base.engine === "mongodb" ? "admin" : null)
        || !new RegExp(`^dl-[a-f0-9]{32}-net-db-${base.databaseId}$`).test(connection.networkName)) return unavailable();
      const username = base.engine === "redis" ? /^default$/ : ["mysql", "mariadb"].includes(base.engine) ? /^(?:root|dl_[a-f0-9]{12})$/ : /^dl_[a-f0-9]{12}$/;
      if (!username.test(connection.username)) return unavailable();
      if (source && (shared.some(key => source[key] !== base[key]) || source.environmentFingerprint !== base.environmentFingerprint
        || source.originalReceipt.networkName !== connection.networkName || !Number.isSafeInteger(source.originalReceipt.observedAt))) return unavailable();
      if (startPreparation && (!source || shared.some(key => startPreparation[key] !== base[key])
        || startPreparation.environmentFingerprint !== base.environmentFingerprint || startPreparation.originalReplayFingerprint !== source.originalReplayFingerprint
        || JSON.stringify(startPreparation.originalReceipt) !== JSON.stringify(source.originalReceipt)
        || !Number.isSafeInteger(startPreparation.originalStopReceipt.observedAt))) return unavailable();
      identities.add(base.databaseId);
    }
    if (options.signal?.aborted) return unavailable();
    return {kind: "ready", databases: data.databases};
  } catch {return unavailable();}
}
