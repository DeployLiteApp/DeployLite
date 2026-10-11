import { z } from "zod";
import { managedDatabaseProfileRequestSchema, managedDatabaseRuntimePreparationSchema, managedDatabaseRuntimeReceiptSchema,
  managedDatabaseHealthPreparationSchema, managedDatabaseStartPreparationSchema, managedDatabaseStopReceiptSchema,
  managedDatabaseStartReceiptSchema, type ManagedDatabaseHealthPreparationV1, type ManagedDatabaseStartPreparationV1,
  type ManagedDatabaseStartReceiptV1 } from "@deploylite/contracts";
import { requestManagedDatabaseJson, type TelemetryOptions } from "./managed-database-telemetry";
export type DatabaseClientOptions = Pick<TelemetryOptions, "apiBaseUrl" | "fetchImpl" | "signal">;
type Result<T> = ({kind: "ready"} & T) | {kind: "error"; message: string};
const unavailable = () => ({kind: "error" as const, message: "Database operation is unavailable."});
const text = z.string().min(1).max(256), digest = z.string().regex(/^[a-f0-9]{64}$/);
const base = managedDatabaseRuntimePreparationSchema.omit({environmentFingerprint: true});
const planSchema = base.extend({operation: z.literal("database.profile.preview"), executionAllowed: z.literal(false),
  image: z.string().max(512).regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/), containerPort: z.number().int().min(1).max(65535),
  credentialKeys: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/)).min(1).max(8), backupStrategy: z.enum(["engine-native", "volume-quiesced"]),
  volume: z.object({key: text, runtimeName: text, target: text}).strict(), network: z.object({key: text, runtimeName: text, internal: z.literal(true)}).strict(), policyVersion: text}).strict();
const connectionSchema = base.extend({availability: z.literal("planned"), exposure: z.literal("internal"), hostname: text, networkName: text,
  port: z.number().int().min(1).max(65535), databaseName: text, username: text, authenticationDatabase: z.literal("admin").nullable()}).strict();
export type PreparedDatabaseView = {preparation: z.infer<typeof managedDatabaseRuntimePreparationSchema>; connection: z.infer<typeof connectionSchema>};
const credentialsSchema = managedDatabaseProfileRequestSchema.extend({secretRefId: text, credentialKey: text, credentialsConfigured: z.literal(true), redacted: z.literal(true)}).strict();
const commandSchema = z.object({id: text, status: z.literal("completed"), action: z.literal("project.update"), scope: z.object({kind: z.literal("project"), projectId: text}).strict(),
  inputDigest: digest, idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), correlationId: text, expiresAt: z.string().datetime({offset: true})}).strict();
async function request<T>(input: {projectId: string; databaseId: string}, suffix: string, body: unknown, options: DatabaseClientOptions, schema: z.ZodType<T>, key?: string): Promise<T> {
  const envelope = z.object({data: z.unknown(), error: z.null(), requestId: text}).strict();
  return schema.parse(envelope.parse(await requestManagedDatabaseJson(`/api/v1/projects/${encodeURIComponent(input.projectId)}/databases/${encodeURIComponent(input.databaseId)}/${suffix}`, body, options, key)).data);
}
function validKey(key: string) { if (!/^[A-Za-z0-9_-]{1,200}$/.test(key)) throw new Error("unavailable"); }
function commandMatches(command: z.infer<typeof commandSchema>, receipt: {commandId: string; inputDigest: string; projectId: string; correlationId: string; observedAt: number}, key: string) {
  if (!Number.isSafeInteger(receipt.observedAt) || receipt.observedAt < 0 || command.id !== receipt.commandId || command.inputDigest !== receipt.inputDigest || command.scope.projectId !== receipt.projectId
    || command.correlationId !== receipt.correlationId || command.idempotencyKey !== key) throw new Error("unavailable");
}
export async function prepareManagedDatabase(raw: unknown, supplied: DatabaseClientOptions): Promise<Result<PreparedDatabaseView>> {
  try {
    const input = managedDatabaseProfileRequestSchema.parse(structuredClone(raw)), {projectId: _project, databaseId: _database, ...body} = input;
    const options = {...supplied, signal: supplied.signal ? AbortSignal.any([supplied.signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000)};
    const {credentials} = await request(input, "credentials", body, options, z.object({credentials: credentialsSchema}).strict());
    if (["projectId", "databaseId", "engine"].some(key => credentials[key as keyof typeof input] !== input[key as keyof typeof input])) throw new Error("unavailable");
    const value = await request(input, "runtime/preview", body, options, z.object({preparation: managedDatabaseRuntimePreparationSchema, plan: planSchema,
      connection: connectionSchema, credentialRef: z.object({secretRefId: text, redacted: z.literal(true)}).strict()}).strict());
    const {preparation, plan, connection} = value;
    if (["projectId", "databaseId", "engine"].some(key => preparation[key as keyof typeof input] !== input[key as keyof typeof input])
      || ["projectId", "databaseId", "engine", "profileId", "planDigest"].some(key => plan[key as keyof typeof plan] !== preparation[key as keyof typeof preparation] || connection[key as keyof typeof connection] !== preparation[key as keyof typeof preparation])
      || value.credentialRef.secretRefId !== credentials.secretRefId || connection.port !== plan.containerPort || connection.hostname !== plan.volume.key
      || plan.volume.key !== `db-${input.databaseId}` || plan.network.key !== plan.volume.key || connection.networkName !== plan.network.runtimeName
      || connection.databaseName !== (input.engine === "redis" ? "0" : input.databaseId) || connection.authenticationDatabase !== (input.engine === "mongodb" ? "admin" : null)
      || plan.containerPort !== {postgres: 5432, mysql: 3306, mariadb: 3306, mongodb: 27017, redis: 6379}[input.engine]
      || plan.backupStrategy !== (input.engine === "redis" ? "volume-quiesced" : "engine-native")) throw new Error("unavailable");
    return {kind: "ready", preparation, connection};
  } catch { return unavailable(); }
}
export async function applyManagedDatabase(raw: unknown, options: DatabaseClientOptions, key: string): Promise<Result<{preparation: ManagedDatabaseHealthPreparationV1}>> {
  try {
    validKey(key); const preparation = managedDatabaseRuntimePreparationSchema.parse(structuredClone(raw));
    const {projectId: _project, databaseId: _database, ...body} = preparation;
    const value = await request(preparation, "runtime/apply", body, options, z.object({command: commandSchema, receipt: managedDatabaseRuntimeReceiptSchema,
      applied: z.literal(true), idempotent: z.boolean(), originalReplayFingerprint: digest}).strict(), key);
    commandMatches(value.command, value.receipt, key);
    return {kind: "ready", preparation: managedDatabaseHealthPreparationSchema.parse({...preparation, originalReceipt: value.receipt, originalReplayFingerprint: value.originalReplayFingerprint})};
  } catch { return unavailable(); }
}
export async function stopManagedDatabase(raw: unknown, options: DatabaseClientOptions, key: string): Promise<Result<{preparation: ManagedDatabaseStartPreparationV1}>> {
  try {
    validKey(key); const preparation = managedDatabaseHealthPreparationSchema.parse(structuredClone(raw));
    const {projectId: _project, databaseId: _database, ...body} = preparation;
    const value = await request(preparation, "runtime/stop", body, options, z.object({command: commandSchema, receipt: managedDatabaseStopReceiptSchema,
      stopped: z.literal(true), idempotent: z.boolean(), originalStopReplayFingerprint: digest}).strict(), key);
    commandMatches(value.command, value.receipt, key);
    return {kind: "ready", preparation: managedDatabaseStartPreparationSchema.parse({...preparation, originalStopReceipt: value.receipt, originalStopReplayFingerprint: value.originalStopReplayFingerprint})};
  } catch { return unavailable(); }
}
export async function startManagedDatabase(raw: unknown, options: DatabaseClientOptions, key: string): Promise<Result<{receipt: ManagedDatabaseStartReceiptV1}>> {
  try {
    validKey(key); const preparation = managedDatabaseStartPreparationSchema.parse(structuredClone(raw));
    const {projectId: _project, databaseId: _database, ...body} = preparation;
    const value = await request(preparation, "runtime/start", body, options, z.object({command: commandSchema, receipt: managedDatabaseStartReceiptSchema,
      ready: z.literal(true), idempotent: z.boolean()}).strict(), key);
    commandMatches(value.command, value.receipt, key);
    const original = preparation.originalReceipt, stopped = preparation.originalStopReceipt, receipt = value.receipt;
    if (receipt.originalCommandId !== original.commandId || receipt.originalStopCommandId !== stopped.commandId || receipt.profileId !== preparation.profileId
      || receipt.observedAt < stopped.observedAt || ["projectId", "databaseId", "engine", "planDigest", "environmentFingerprint", "agentId", "containerId", "imageId", "networkName", "networkId", "volumeName", "volumeCreatedAt"].some(key => receipt[key as keyof typeof receipt] !== original[key as keyof typeof original])) throw new Error("unavailable");
    return {kind: "ready", receipt};
  } catch { return unavailable(); }
}
