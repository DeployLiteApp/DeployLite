import { isIP } from "node:net";
import { sealAgentSecretEnvelope, signAgentTransport, validateAgentTransportKey } from "@deploylite/config";
import { agentCapabilityHandshakeSchema, MANAGED_DATABASE_RUNTIME_CAPABILITY, MANAGED_DATABASE_RUNTIME_PATH,
  MANAGED_DATABASE_RUNTIME_RECEIPT_PATH, managedDatabaseRuntimeAgentCommandSchema, managedDatabaseRuntimeCachedReceiptSchema,
  managedDatabaseRuntimePreparationSchema, managedDatabaseRuntimeReceiptQuerySchema, managedDatabaseRuntimeReceiptSchema,
  projectControlAuthoritySchema, TransportError, type ProjectControlAuthorityV1,
  type ManagedDatabaseRuntimeReceiptQueryV1, type ManagedDatabaseRuntimeReceiptV1 } from "@deploylite/contracts";
import { awaitAbortable, composeRuntimeResourceName, managedDatabaseRuntimeExecutionDigest, type ControlCommand } from "@deploylite/domain";
import { markAgentPreDispatchRejection } from "./agent-transport.js";

export type PreparedManagedDatabaseRuntime = Readonly<{
  command: ControlCommand;
  input: ReturnType<typeof managedDatabaseRuntimePreparationSchema.parse>;
  agentId: string;
}>;
type Context = Readonly<{ requestId: string; correlationId: string; signal?: AbortSignal }>;
export type ManagedDatabaseRuntimeAgentTransport = Readonly<{
  available(): boolean;
  dispatch(prepared: PreparedManagedDatabaseRuntime, authority: ProjectControlAuthorityV1,
    environment: Readonly<Record<string, string>>, context: Context): Promise<ManagedDatabaseRuntimeReceiptV1>;
  readReceipt(prepared: PreparedManagedDatabaseRuntime, authority: ProjectControlAuthorityV1, context: Context): Promise<ManagedDatabaseRuntimeReceiptV1 | null>;
}>;
type Options = Readonly<{ endpoint: string; agentId: string; trustKey: string; fetch?: typeof fetch; timeoutMs?: number; allowInsecureInternal?: boolean }>;
function fail(): never { throw new TransportError("Database agent transport is unavailable."); }
export function managedDatabaseRuntimeReceiptMatches(query: ManagedDatabaseRuntimeReceiptQueryV1, receipt: ManagedDatabaseRuntimeReceiptV1): boolean {
  return receipt.agentId === query.agentId && receipt.commandId === query.commandId && receipt.projectId === query.projectId
    && receipt.databaseId === query.databaseId && receipt.engine === query.engine && receipt.inputDigest === query.inputDigest
    && receipt.planDigest === query.planDigest && receipt.environmentFingerprint === query.environmentFingerprint
    && receipt.correlationId === query.context.correlationId
    && receipt.volumeName === composeRuntimeResourceName(query.projectId, "volume", `db-${query.databaseId}`)
    && receipt.networkName === composeRuntimeResourceName(query.projectId, "network", `db-${query.databaseId}`);
}
/** Uses the existing project authority, secret envelope and durable cache protocol; never discovers an endpoint. */
export class AuthenticatedManagedDatabaseRuntimeTransport implements ManagedDatabaseRuntimeAgentTransport {
  readonly #options: Options;
  readonly #fetch: typeof fetch;
  constructor(options: Options) { this.#options = { ...options }; this.#fetch = options.fetch ?? globalThis.fetch; }
  available(): boolean {
    try {
      const url = new URL(this.#options.endpoint), host = url.hostname;
      validateAgentTransportKey(this.#options.trustKey);
      const octets = host.split(".").map(Number);
      const internal = host === "localhost" || host === "agent" || host === "[::1]"
        || (isIP(host) === 4 && (octets[0] === 127 || octets[0] === 10
          || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31)));
      const timeout = this.#options.timeoutMs ?? 30000;
      return !url.username && !url.password && !url.hash && !url.search && /^[A-Za-z0-9_-]{1,200}$/.test(this.#options.agentId)
        && Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 60000
        && (url.protocol === "https:" || (url.protocol === "http:" && this.#options.allowInsecureInternal === true && internal));
    } catch { return false; }
  }
  private query(prepared: PreparedManagedDatabaseRuntime, rawAuthority: ProjectControlAuthorityV1, context: Context) {
    const input = managedDatabaseRuntimePreparationSchema.parse(structuredClone(prepared.input));
    const authority = projectControlAuthoritySchema.parse(structuredClone(rawAuthority)), command = prepared.command;
    if (!this.available() || prepared.agentId !== this.#options.agentId || command.action !== "project.update"
      || command.scope.kind !== "project" || command.scope.projectId !== input.projectId
      || command.inputDigest !== managedDatabaseRuntimeExecutionDigest(input) || command.correlationId !== context.correlationId) fail();
    return managedDatabaseRuntimeReceiptQuerySchema.parse({ ...input, action: "database.runtime", operation: "database.runtime.apply",
      agentId: prepared.agentId, commandId: command.id, idempotencyKey: command.idempotencyKey, inputDigest: command.inputDigest,
      requiredCapabilities: [MANAGED_DATABASE_RUNTIME_CAPABILITY], authority, lease: authority.projectLease,
      context: { requestId: context.requestId, correlationId: context.correlationId }, timeoutMs: this.#options.timeoutMs ?? 30000 });
  }
  private async handshake(signal: AbortSignal, requireExecution = true) {
    const signature = signAgentTransport("GET /capabilities", this.#options.trustKey);
    const response = await awaitAbortable(() => this.#fetch(`${this.#options.endpoint.replace(/\/$/, "")}/capabilities`, {
      headers: { "x-deploylite-signature": signature }, redirect: "error", signal
    }), signal);
    if (!response.ok || response.headers.get("x-deploylite-request-signature") !== signature) fail();
    const handshake = agentCapabilityHandshakeSchema.parse(await awaitAbortable(() => response.json(), signal));
    if (handshake.agentId !== this.#options.agentId || (requireExecution && !handshake.capabilities.includes(MANAGED_DATABASE_RUNTIME_CAPABILITY))
      || !handshake.protocolVersions.includes(1)) fail();
  }
  private async post(path: string, body: unknown, cache: boolean, signal: AbortSignal) {
    const payload = JSON.stringify(body);
    const response = await awaitAbortable(() => this.#fetch(this.#options.endpoint.replace(/\/$/, "") + path, {
      method: "POST", headers: { "content-type": "application/json",
        "x-deploylite-signature": signAgentTransport(cache ? `POST ${path}\n${payload}` : payload, this.#options.trustKey) },
      body: payload, redirect: "error", signal
    }), signal);
    if (!response.ok) fail();
    return await awaitAbortable(() => response.json(), signal);
  }
  private async operate<T>(parent: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController(), cancel = () => controller.abort();
    parent?.addEventListener("abort", cancel, { once: true }); if (parent?.aborted) cancel();
    const timer = setTimeout(cancel, this.#options.timeoutMs ?? 30000);
    try { return await awaitAbortable(() => work(controller.signal), controller.signal); }
    finally { clearTimeout(timer); parent?.removeEventListener("abort", cancel); }
  }
  async dispatch(prepared: PreparedManagedDatabaseRuntime, authority: ProjectControlAuthorityV1, environment: Readonly<Record<string, string>>, context: Context) {
    let posted = false;
    try {
      const query = this.query(prepared, authority, context);
      const body = managedDatabaseRuntimeAgentCommandSchema.parse({ ...query, cancellationRequested: false,
        sealedEnvironment: sealAgentSecretEnvelope(environment, this.#options.trustKey, {
          agentId: query.agentId, commandId: query.commandId, inputDigest: query.inputDigest, projectId: query.projectId
        }) });
      return await this.operate(context.signal, async signal => {
        await this.handshake(signal); posted = true;
        const receipt = managedDatabaseRuntimeReceiptSchema.parse(await this.post(MANAGED_DATABASE_RUNTIME_PATH, body, false, signal));
        if (!managedDatabaseRuntimeReceiptMatches(query, receipt)) fail();
        return receipt;
      });
    } catch {
      const error = new TransportError("Database agent transport is unavailable.");
      throw posted ? error : markAgentPreDispatchRejection(error);
    }
  }
  async readReceipt(prepared: PreparedManagedDatabaseRuntime, authority: ProjectControlAuthorityV1, context: Context) {
    try {
      const query = this.query(prepared, authority, context);
      return await this.operate(context.signal, async signal => {
        await this.handshake(signal, false);
        const cached = managedDatabaseRuntimeCachedReceiptSchema.parse(await this.post(MANAGED_DATABASE_RUNTIME_RECEIPT_PATH, query, true, signal));
        if (cached.agentId !== query.agentId || cached.commandId !== query.commandId || cached.correlationId !== query.context.correlationId
          || (cached.receipt && !managedDatabaseRuntimeReceiptMatches(query, cached.receipt))) fail();
        return cached.receipt;
      });
    } catch { return fail(); }
  }
}
