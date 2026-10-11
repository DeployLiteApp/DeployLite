import { z } from "zod";
import { managedDatabaseHealthPreparationSchema, managedDatabaseHealthObservationSchema, managedDatabaseMetricsObservationSchema,
  managedDatabaseLogsObservationSchema, managedDatabaseLogsSelectionSchema, type ManagedDatabaseHealthPreparationV1,
  type ManagedDatabaseHealthObservationV1, type ManagedDatabaseMetricsObservationV1, type ManagedDatabaseLogsObservationV1 } from "@deploylite/contracts";
export type TelemetryOptions = Readonly<{ preparation: ManagedDatabaseHealthPreparationV1; apiBaseUrl: string | null; fetchImpl?: typeof fetch; signal?: AbortSignal }>;
export type TelemetryObservation = ManagedDatabaseHealthObservationV1 | ManagedDatabaseMetricsObservationV1 | ManagedDatabaseLogsObservationV1;
export type TelemetryResult = Readonly<{kind: "ready"; observation: TelemetryObservation}> | Readonly<{kind: "error"; message: string}>;
const unavailable = (): TelemetryResult => ({kind: "error", message: "Database observation is unavailable."});
const envelope = z.object({data: z.object({observation: z.unknown()}).strict(), error: z.null(), requestId: z.string().min(1)}).strict();
async function abortable<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  if (signal.aborted) throw new Error("cancelled");
  let cancel: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => { cancel = () => reject(new Error("cancelled")); signal.addEventListener("abort", cancel, {once: true}); });
  try { return await Promise.race([work(), aborted]); } finally { signal.removeEventListener("abort", cancel!); }
}
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const maximum = 2097152, declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maximum)) throw new Error("oversized");
  const reader = response.body?.getReader(); if (!reader) throw new Error("missing body");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const chunk = await abortable(signal, () => reader.read()); if (chunk.done) break;
      size += chunk.value.byteLength; if (size > maximum) throw new Error("oversized"); chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes));
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
/** Authenticated current reads consume public original evidence; no command or credential is created. */
export async function readManagedDatabaseTelemetry(operation: "health" | "metrics" | "logs", options: TelemetryOptions, rawSelection?: unknown): Promise<TelemetryResult> {
  try {
    if (!options.apiBaseUrl || !["health", "metrics", "logs"].includes(operation) || options.signal?.aborted) return unavailable();
    const preparation = managedDatabaseHealthPreparationSchema.parse(structuredClone(options.preparation));
    const selection = operation === "logs" ? managedDatabaseLogsSelectionSchema.parse(rawSelection) : undefined;
    if (selection?.since && Date.parse(selection.since) > Date.now()) return unavailable();
    const {projectId, databaseId, ...body} = preparation;
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000);
    const response = await abortable(signal, () => (options.fetchImpl ?? fetch)(new URL(`/api/v1/projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/runtime/${operation}`, options.apiBaseUrl!), {
      method: "POST", credentials: "include", redirect: "error", cache: "no-store", signal,
      headers: {"content-type": "application/json"}, body: JSON.stringify({...body, ...(selection ? {selection} : {})})
    }));
    if (!response.ok) return unavailable();
    const parsed = envelope.parse(await boundedJson(response, signal));
    const schema = operation === "health" ? managedDatabaseHealthObservationSchema : operation === "metrics" ? managedDatabaseMetricsObservationSchema : managedDatabaseLogsObservationSchema;
    const observation = schema.parse(parsed.data.observation), original = preparation.originalReceipt;
    const shared = ["projectId", "databaseId", "engine", "planDigest", "environmentFingerprint", "agentId", "containerId", "imageId", "networkId", "networkName", "volumeName", "volumeCreatedAt"] as const;
    if (signal.aborted || observation.action !== `database.runtime.${operation}` || observation.originalCommandId !== original.commandId
      || observation.profileId !== preparation.profileId || observation.context.requestId !== parsed.requestId || observation.observedAt < original.observedAt
      || shared.some(key => observation[key] !== original[key])) return unavailable();
    return {kind: "ready", observation};
  } catch { return unavailable(); }
}
