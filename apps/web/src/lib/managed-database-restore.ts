import {z} from "zod";
import {managedDatabaseRestoreSelectionSchema, managedDatabaseRestoreReceiptSchema, type ManagedDatabaseRestoreReceiptV1} from "@deploylite/contracts";
import {requestManagedDatabaseJson} from "./managed-database-telemetry";
import type {ManagedDatabaseBackupClientOptions} from "./managed-database-backup";
const identity = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), text = z.string().min(1).max(256), digest = z.string().regex(/^[a-f0-9]{64}$/);
const commandSchema = z.object({id: text, status: z.literal("pending_confirmation"), action: z.literal("project.update"),
  scope: z.object({kind: z.literal("project"), projectId: identity}).strict(), inputDigest: digest, idempotencyKey: identity,
  correlationId: text, expiresAt: z.string().datetime({offset: true})}).strict();
const confirmationSchema = z.object({id: identity, classification: z.literal("destructive"),
  expiresAt: z.string().datetime({offset: true}), consumedAt: z.null()}).strict();
export const preparedManagedDatabaseRestoreSchema = z.object({selection: managedDatabaseRestoreSelectionSchema,
  idempotencyKey: identity, command: commandSchema, confirmation: confirmationSchema}).strict();
export type PreparedManagedDatabaseRestore = z.infer<typeof preparedManagedDatabaseRestoreSchema>;
type Result<T> = ({kind: "ready"} & T) | {kind: "error"; message: string};
const envelope = z.object({data: z.unknown(), error: z.null(), requestId: text}).strict();
const unavailable = () => ({kind: "error" as const, message: "Restore could not be confirmed."});
function optionsFor(supplied: ManagedDatabaseBackupClientOptions) {
  const options = {...supplied}, actor = identity.parse(options.actorId), sourceFetch = options.fetchImpl ?? fetch;
  return {...options, fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers); headers.set("x-deploylite-expected-actor-id", actor);
    return sourceFetch(input, {...init, headers});
  }};
}
function validatePrepared(raw: unknown): PreparedManagedDatabaseRestore {
  const prepared = preparedManagedDatabaseRestoreSchema.parse(structuredClone(raw)), {selection, command, confirmation} = prepared;
  if (command.scope.projectId !== selection.projectId || command.idempotencyKey !== prepared.idempotencyKey
    || command.id === selection.originalReceipt.commandId || Date.parse(confirmation.expiresAt) > Date.parse(command.expiresAt)) throw new Error("unavailable");
  return prepared;
}
/** Read the original server-owned approval using public selectors; no apply or automatic retry. */
export async function prepareManagedDatabaseRestore(raw: unknown, supplied: ManagedDatabaseBackupClientOptions, rawKey: string): Promise<Result<{prepared: PreparedManagedDatabaseRestore}>> {
  try {
    const selection = managedDatabaseRestoreSelectionSchema.parse(structuredClone(raw)), key = identity.parse(rawKey), options = optionsFor(supplied);
    const {projectId, databaseId, ...body} = selection;
    const data = z.object({command: commandSchema, confirmation: confirmationSchema, idempotent: z.boolean()}).strict().parse(envelope.parse(
      await requestManagedDatabaseJson(`/api/v1/projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/runtime/restore/prepare`, body, options, key)).data);
    const prepared = validatePrepared({selection, idempotencyKey: key, command: data.command, confirmation: data.confirmation});
    if (Date.parse(prepared.confirmation.expiresAt) <= Date.now() || options.signal?.aborted) throw new Error("unavailable");
    return {kind: "ready", prepared};
  } catch {return unavailable();}
}
/** Explicit original nonce/key only. Expiry is decided by the server's original cache and confirmation fences. */
export async function applyManagedDatabaseRestore(raw: unknown, supplied: ManagedDatabaseBackupClientOptions): Promise<Result<{receipt: ManagedDatabaseRestoreReceiptV1; idempotent: boolean}>> {
  try {
    const prepared = validatePrepared(raw), options = optionsFor(supplied), {selection, command, confirmation, idempotencyKey} = prepared;
    const {projectId, databaseId, ...source} = selection;
    const data = z.object({command: commandSchema.extend({status: z.literal("completed")}), receipt: managedDatabaseRestoreReceiptSchema,
      restored: z.literal(true), idempotent: z.boolean()}).strict().parse(envelope.parse(await requestManagedDatabaseJson(
        `/api/v1/projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/runtime/restore/apply`,
        {...source, confirmationId: confirmation.id}, options, idempotencyKey)).data);
    const receipt = data.receipt, original = selection.originalReceipt;
    if (Object.keys(command).some(key => key !== "status" && JSON.stringify(data.command[key as keyof typeof command]) !== JSON.stringify(command[key as keyof typeof command]))
      || receipt.commandId !== command.id || receipt.inputDigest !== command.inputDigest || receipt.correlationId !== command.correlationId
      || receipt.confirmationId !== confirmation.id || receipt.originalCommandId !== original.commandId || receipt.profileId !== selection.profileId
      || receipt.archiveId !== selection.archiveId || receipt.archiveSha256 !== selection.expectedArchiveSha256 || receipt.manifestSha256 !== selection.expectedManifestSha256
      || receipt.archiveBytes > selection.maxBytes || receipt.observedAt < original.observedAt || receipt.observedAt > Date.now()
      || receipt.observedAt >= Date.parse(command.expiresAt) || options.signal?.aborted) throw new Error("unavailable");
    for (const key of ["schemaVersion", "projectId", "databaseId", "engine", "planDigest", "environmentFingerprint", "agentId", "containerId", "imageId", "volumeName", "networkName", "networkId", "volumeCreatedAt"] as const) {
      if (receipt[key] !== original[key]) throw new Error("unavailable");
    }
    return {kind: "ready", receipt, idempotent: data.idempotent};
  } catch {return unavailable();}
}
