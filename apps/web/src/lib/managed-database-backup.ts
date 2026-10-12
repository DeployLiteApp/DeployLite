import {z} from "zod";
import {managedDatabaseBackupPreparationSchema, managedDatabaseBackupReceiptSchema, managedDatabaseProfileRequestSchema} from "@deploylite/contracts";
import type {DatabaseClientOptions} from "./managed-database-lifecycle";
import {requestManagedDatabaseJson} from "./managed-database-telemetry";
const identity = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), text = z.string().min(1).max(256), digest = z.string().regex(/^[a-f0-9]{64}$/);
const scopeSchema = managedDatabaseProfileRequestSchema.pick({projectId: true, databaseId: true}).strict();
const envelope = z.object({data: z.unknown(), error: z.null(), requestId: text}).strict();
const recordSchema = z.object({schemaVersion: z.literal(1), receipt: managedDatabaseBackupReceiptSchema,
  createdAtMs: z.number().int().safe().nonnegative()}).strict();
const viewSchema = z.object({destinations: z.array(z.object({destinationId: identity, maxBytes: z.number().int().safe().positive()}).strict()).max(10000),
  backups: z.array(recordSchema).max(10000)}).strict();
const commandSchema = z.object({id: text, status: z.literal("completed"), action: z.literal("project.update"),
  scope: z.object({kind: z.literal("project"), projectId: identity}).strict(), inputDigest: digest, idempotencyKey: identity,
  correlationId: text, expiresAt: z.string().datetime({offset: true})}).strict();
const outcomeSchema = z.object({command: commandSchema, receipt: managedDatabaseBackupReceiptSchema, inventory: recordSchema,
  originalBackupReplayFingerprint: digest, backupCreated: z.literal(true), idempotent: z.boolean()}).strict();
export type ManagedDatabaseBackupClientOptions = DatabaseClientOptions & {actorId: string};
export type ManagedDatabaseBackupView = z.infer<typeof viewSchema>;
export type ManagedDatabaseBackupOutcome = z.infer<typeof outcomeSchema>;
type Result<T> = ({kind: "ready"} & T) | {kind: "error"; message: string};
function optionsFor(supplied: ManagedDatabaseBackupClientOptions): DatabaseClientOptions {
  const options = {...supplied}, actorId = identity.parse(options.actorId), sourceFetch = options.fetchImpl ?? fetch;
  return {...options, fetchImpl: (input, init) => {
    const headers = new Headers(init?.headers); headers.set("x-deploylite-expected-actor-id", actorId);
    return sourceFetch(input, {...init, headers});
  }};
}
/** Public metadata only; history never implies readiness or permission to restore. */
export async function readManagedDatabaseBackups(rawScope: unknown, supplied: ManagedDatabaseBackupClientOptions, rawDestinationId?: string): Promise<Result<ManagedDatabaseBackupView>> {
  try {
    const scope = scopeSchema.parse(structuredClone(rawScope)), destinationId = rawDestinationId === undefined ? undefined : identity.parse(rawDestinationId);
    const options = optionsFor(supplied), query = destinationId ? "?destinationId=" + encodeURIComponent(destinationId) : "";
    const view = viewSchema.parse(envelope.parse(await requestManagedDatabaseJson(
      `/api/v1/projects/${encodeURIComponent(scope.projectId)}/databases/${encodeURIComponent(scope.databaseId)}/backups${query}`,
      undefined, options, undefined, "GET")).data);
    const destinations = new Set(view.destinations.map(value => value.destinationId)), archives = new Set<string>(), commands = new Set<string>();
    if (destinations.size !== view.destinations.length || !destinations.size || (destinationId && !destinations.has(destinationId))
      || (!destinationId && view.backups.length)) throw new Error("unavailable");
    for (const row of view.backups) {
      const receipt = row.receipt;
      if (receipt.projectId !== scope.projectId || receipt.databaseId !== scope.databaseId || receipt.volumeKey !== "db-" + scope.databaseId
        || receipt.destinationId !== destinationId || row.createdAtMs < receipt.observedAt || row.createdAtMs > Date.now()
        || archives.has(receipt.archiveId) || commands.has(receipt.commandId)) throw new Error("unavailable");
      archives.add(receipt.archiveId); commands.add(receipt.commandId);
    }
    if (options.signal?.aborted) throw new Error("unavailable");
    return {kind: "ready", ...view};
  } catch {return {kind: "error", message: "Backups are unavailable."};}
}
/** One explicit request with the caller's original actor/source/key; never retry or mint another key here. */
export async function backupManagedDatabase(rawPreparation: unknown, supplied: ManagedDatabaseBackupClientOptions, rawKey: string): Promise<Result<ManagedDatabaseBackupOutcome>> {
  try {
    const preparation = managedDatabaseBackupPreparationSchema.parse(structuredClone(rawPreparation)), key = identity.parse(rawKey), options = optionsFor(supplied);
    const {projectId, databaseId, ...body} = preparation;
    const data = outcomeSchema.parse(envelope.parse(await requestManagedDatabaseJson(
      `/api/v1/projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/runtime/backup`, body, options, key)).data);
    const {command, receipt, inventory} = data, original = preparation.originalReceipt;
    if (command.idempotencyKey !== key || command.scope.projectId !== projectId || command.id !== receipt.commandId
      || command.inputDigest !== receipt.inputDigest || command.correlationId !== receipt.correlationId || receipt.commandId === original.commandId
      || receipt.originalCommandId !== original.commandId || receipt.profileId !== preparation.profileId || receipt.destinationId !== preparation.destinationId
      || receipt.archiveBytes > preparation.maxBytes || !Number.isSafeInteger(receipt.observedAt) || receipt.observedAt < original.observedAt
      || receipt.observedAt > Date.now() || receipt.observedAt >= Date.parse(command.expiresAt)
      || inventory.createdAtMs < receipt.observedAt || inventory.createdAtMs > Date.now()) throw new Error("unavailable");
    for (const field of ["schemaVersion", "projectId", "databaseId", "engine", "planDigest", "environmentFingerprint", "agentId", "containerId",
      "imageId", "volumeName", "networkName", "networkId", "volumeCreatedAt"] as const) {
      if (receipt[field] !== original[field]) throw new Error("unavailable");
    }
    const canonical = (value: typeof receipt) => ({...value, status: "created", idempotent: false});
    if (JSON.stringify(canonical(inventory.receipt)) !== JSON.stringify(canonical(receipt)) || options.signal?.aborted) throw new Error("unavailable");
    return {kind: "ready", ...data};
  } catch {return {kind: "error", message: "Backup could not be confirmed."};}
}
