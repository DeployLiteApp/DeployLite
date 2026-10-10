import { z } from "zod";
export const managedDatabaseEngineSchema = z.enum(["postgres", "mysql", "mariadb", "mongodb", "redis"]);
const identity = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const databaseKey = z.string().regex(/^[a-z][a-z0-9_-]{0,59}$/)
  .refine(value => !["constructor", "prototype", "__proto__"].includes(value));
export const managedDatabaseProfileRequestSchema = z.object({
  schemaVersion: z.literal(1), projectId: identity, databaseId: databaseKey, engine: managedDatabaseEngineSchema
}).strict();
/** Approved server metadata, never a caller-controlled image/mount/credential value. */
export const approvedManagedDatabaseProfileSchema = z.object({
  schemaVersion: z.literal(1), profileId: identity, engine: managedDatabaseEngineSchema,
  image: z.string().min(1).max(512),
  dataPath: z.string().max(256).regex(/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/)
    .refine(value => !value.split("/").some(part => part === "." || part === "..") && !/^\/(?:proc|sys|dev)(?:\/|$)/.test(value)),
  containerPort: z.number().int().min(1).max(65535),
  credentialKeys: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/)).min(1).max(8)
    .refine(keys => new Set(keys).size === keys.length),
  backupStrategy: z.enum(["engine-native", "volume-quiesced"])
}).strict();
export type ManagedDatabaseEngineV1 = z.infer<typeof managedDatabaseEngineSchema>;
export type ApprovedManagedDatabaseProfileV1 = z.infer<typeof approvedManagedDatabaseProfileSchema>;

/** Private encrypted payload grammar; never a request, receipt or response payload. */
export const managedDatabaseCredentialBundleSchema = z.object({
  schemaVersion:z.literal(1),projectId:identity,databaseId:databaseKey,engine:managedDatabaseEngineSchema,profileId:identity,
  planDigest:z.string().regex(/^[a-f0-9]{64}$/),credentials:z.record(z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/),z.string().regex(/^[a-f0-9]{64}$/))
}).strict();
