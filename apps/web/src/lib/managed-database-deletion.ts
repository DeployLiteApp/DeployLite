import {z} from "zod";
import {managedDatabaseDeletePreparationSchema, managedDatabaseDeleteReceiptSchema,
  type ManagedDatabaseDeleteReceiptV1} from "@deploylite/contracts";
import {requestManagedDatabaseJson} from "./managed-database-telemetry";
import type {DatabaseClientOptions} from "./managed-database-lifecycle";
const text = z.string().min(1).max(256), identity = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const commandSchema = z.object({id:text, status:z.literal("pending_confirmation"), action:z.literal("project.update"),
  scope:z.object({kind:z.literal("project"), projectId:identity}).strict(), inputDigest:z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey:identity, correlationId:text, expiresAt:z.string().datetime({offset:true})}).strict();
const confirmationSchema = z.object({id:identity, classification:z.literal("destructive"), expiresAt:z.string().datetime({offset:true}), consumedAt:z.null()}).strict();
const preparedSchema = z.object({preparation:managedDatabaseDeletePreparationSchema, idempotencyKey:identity,
  command:commandSchema, confirmation:confirmationSchema}).strict();
export type PreparedManagedDatabaseDeletion = z.infer<typeof preparedSchema>;
type Result<T> = ({kind:"ready"} & T) | {kind:"error";message:string};
const unavailable = () => ({kind:"error" as const,message:"Database removal could not be confirmed."});
const envelope = z.object({data:z.unknown(), error:z.null(), requestId:text}).strict();
/** Public original proof only; neither preparation nor a retry may mint another approval. */
function validatePrepared(raw:unknown):PreparedManagedDatabaseDeletion {
  const prepared = preparedSchema.parse(structuredClone(raw)), {preparation,command,confirmation,idempotencyKey} = prepared;
  if (command.scope.projectId !== preparation.projectId || command.idempotencyKey !== idempotencyKey
    || command.id === preparation.originalReceipt.commandId || command.id === preparation.originalStopReceipt?.commandId
    || Date.parse(confirmation.expiresAt) > Date.parse(command.expiresAt)) throw new Error("unavailable");
  return prepared;
}
export async function prepareManagedDatabaseDeletion(raw:unknown, options:DatabaseClientOptions, key:string):Promise<Result<{prepared:PreparedManagedDatabaseDeletion}>> {
  try {
    identity.parse(key); const preparation = managedDatabaseDeletePreparationSchema.parse(structuredClone(raw));
    const {projectId,databaseId,...body} = preparation;
    const data = z.object({storagePolicy:z.literal("retain-original"), idempotent:z.boolean(), command:commandSchema, confirmation:confirmationSchema}).strict()
      .parse(envelope.parse(await requestManagedDatabaseJson(`/api/v1/projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/runtime/delete/prepare`,body,options,key)).data);
    const prepared = validatePrepared({preparation,idempotencyKey:key,command:data.command,confirmation:data.confirmation});
    if (Date.parse(prepared.confirmation.expiresAt) <= Date.now()) throw new Error("unavailable");
    return {kind:"ready",prepared};
  } catch {return unavailable();}
}
/** One explicit apply call; an uncertain outcome keeps the same original selector and key. */
export async function applyManagedDatabaseDeletion(raw:unknown, options:DatabaseClientOptions):Promise<Result<{receipt:ManagedDatabaseDeleteReceiptV1}>> {
  try {
    const prepared = validatePrepared(raw), {preparation,command,confirmation,idempotencyKey} = prepared;
    const {projectId,databaseId,...source} = preparation;
    const data = z.object({command:commandSchema.extend({status:z.literal("completed")}),receipt:managedDatabaseDeleteReceiptSchema,
      removed:z.literal(true),idempotent:z.boolean()}).strict().parse(envelope.parse(await requestManagedDatabaseJson(
        `/api/v1/projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/runtime/delete/apply`,
        {...source,confirmationId:confirmation.id},options,idempotencyKey)).data);
    const receipt = data.receipt, original = preparation.originalReceipt;
    if (Object.keys(command).some(key => key !== "status" && JSON.stringify(data.command[key as keyof typeof command]) !== JSON.stringify(command[key as keyof typeof command]))
      || receipt.commandId !== command.id || receipt.inputDigest !== command.inputDigest || receipt.correlationId !== command.correlationId
      || receipt.confirmationId !== confirmation.id || receipt.originalCommandId !== original.commandId
      || receipt.originalStopCommandId !== (preparation.originalStopReceipt?.commandId ?? null) || receipt.profileId !== preparation.profileId
      || !Number.isSafeInteger(receipt.observedAt) || receipt.observedAt < (preparation.originalStopReceipt?.observedAt ?? original.observedAt)) throw new Error("unavailable");
    for (const key of ["schemaVersion","projectId","databaseId","engine","planDigest","environmentFingerprint","agentId","containerId","imageId","volumeName","networkName","networkId","volumeCreatedAt"] as const) {
      if (receipt[key] !== original[key]) throw new Error("unavailable");
    }
    return {kind:"ready",receipt};
  } catch {return unavailable();}
}
