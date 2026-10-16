import {z} from "zod";
import {backupRetentionPreviewRequestSchema, managedDatabaseProfileRequestSchema} from "@deploylite/contracts";
import type {ManagedDatabaseBackupClientOptions} from "./managed-database-backup";
import {requestManagedDatabaseJson} from "./managed-database-telemetry";
const identity = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), digest = z.string().regex(/^[a-f0-9]{64}$/);
const ids = z.array(identity).max(10000);
const planSchema = z.object({schemaVersion: z.literal(1), operation: z.literal("backup.retention.preview"), executionAllowed: z.literal(false),
  projectId: identity, volumeKey: identity, destinationId: identity, keepNewest: backupRetentionPreviewRequestSchema.shape.keepNewest,
  protectedArchiveIds: ids, retainedArchiveIds: ids, deletionCandidates: z.array(z.object({archiveId: identity, archiveSha256: digest,
    manifestSha256: digest, createdAtMs: z.number().int().safe().nonnegative()}).strict()).max(10000), inventoryDigest: digest, planDigest: digest}).strict();
const scopeSchema = managedDatabaseProfileRequestSchema.pick({projectId: true, databaseId: true}).strict();
const envelope = z.object({data: z.object({plan: planSchema}).strict(), error: z.null(), requestId: z.string().min(1).max(256)}).strict();
export type ManagedDatabaseRetentionPlan = z.infer<typeof planSchema>;
/** Explicit authenticated effect-free preview; never construct inventory/protections from browser history. */
export async function previewManagedDatabaseRetention(rawScope: unknown, supplied: ManagedDatabaseBackupClientOptions, rawInput: unknown): Promise<
  {kind: "ready"; plan: ManagedDatabaseRetentionPlan} | {kind: "error"; message: string}> {
  try {
    const scope = scopeSchema.parse(structuredClone(rawScope)), input = backupRetentionPreviewRequestSchema.parse(structuredClone(rawInput));
    const options = {...supplied}, actorId = identity.parse(options.actorId), fetchImpl = options.fetchImpl ?? fetch;
    if (input.volumeKey !== "db-" + scope.databaseId || options.signal?.aborted) throw new Error("unavailable");
    const plan = envelope.parse(await requestManagedDatabaseJson(`/api/v1/projects/${encodeURIComponent(scope.projectId)}/backups/retention/preview`, input,
      {...options, fetchImpl: (url, init) => {const headers = new Headers(init?.headers); headers.set("x-deploylite-expected-actor-id", actorId); return fetchImpl(url, {...init, headers});}})).data.plan;
    const retained = new Set(plan.retainedArchiveIds), protectedIds = new Set(plan.protectedArchiveIds), candidates = new Set(plan.deletionCandidates.map(row => row.archiveId));
    if (plan.projectId !== scope.projectId || plan.volumeKey !== input.volumeKey || plan.destinationId !== input.destinationId || plan.keepNewest !== input.keepNewest
      || (input.expectedInventoryDigest !== undefined && plan.inventoryDigest !== input.expectedInventoryDigest)
      || retained.size < Math.min(input.keepNewest, retained.size + candidates.size) || retained.size > input.keepNewest + protectedIds.size
      || retained.size !== plan.retainedArchiveIds.length || protectedIds.size !== plan.protectedArchiveIds.length || candidates.size !== plan.deletionCandidates.length
      || [...protectedIds].some(id => !retained.has(id)) || [...candidates].some(id => retained.has(id) || protectedIds.has(id))
      || plan.deletionCandidates.some(row => row.createdAtMs > Date.now()) || options.signal?.aborted) throw new Error("unavailable");
    return {kind: "ready", plan};
  } catch {return {kind: "error", message: "Retention preview is unavailable."};}
}
