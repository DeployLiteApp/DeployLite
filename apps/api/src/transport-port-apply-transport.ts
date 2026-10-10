import { signAgentTransport, validateAgentTransportKey } from "@deploylite/config";
import { agentCapabilityHandshakeSchema, projectControlAuthoritySchema, TRANSPORT_PORT_APPLY_CAPABILITY, TRANSPORT_PORT_TRANSFER_CAPABILITY, TRANSPORT_PORT_APPLY_PATH,
  TRANSPORT_PORT_APPLY_RECEIPT_PATH, transportPortApplyAgentCommandSchema, transportPortApplyCachedReceiptSchema,
  transportPortApplyReceiptQuerySchema, transportPortApplyReceiptSchema, type ProjectControlAuthorityV1,
  type TransportPortApplyReceiptQueryV1, type TransportPortApplyReceiptV1 } from "@deploylite/contracts";
import { awaitAbortable, type PreparedTransportPortApplyCommand } from "@deploylite/domain";
import { TransportError } from "@deploylite/contracts";
import { markAgentPreDispatchRejection } from "./agent-transport.js";

export type TransportPortApplyAgentTransport = Readonly<{
  available(): boolean;
  dispatchTransportPortApply(prepared: PreparedTransportPortApplyCommand, authority: ProjectControlAuthorityV1,
    context: Readonly<{ requestId: string; correlationId: string; signal?: AbortSignal }>): Promise<TransportPortApplyReceiptV1>;
  readTransportPortApplyReceipt(prepared: PreparedTransportPortApplyCommand, authority: ProjectControlAuthorityV1,
    context: Readonly<{ requestId: string; correlationId: string; signal?: AbortSignal }>): Promise<TransportPortApplyReceiptV1 | null>;
}>;

type Options = Readonly<{ endpoint: string; trustKey: string; agentId: string; allowInsecureInternal?: boolean; fetch?: typeof globalThis.fetch; timeoutMs?: number }>;
function matches(command: TransportPortApplyReceiptQueryV1, receipt: TransportPortApplyReceiptV1): boolean {
  return receipt.agentId === command.agentId && receipt.commandId === command.commandId && receipt.projectId === command.projectId
    && receipt.inputDigest === command.inputDigest && receipt.correlationId === command.context.correlationId
    && receipt.protocol === command.route.protocol && receipt.publishedPort === command.route.publishedPort
    && receipt.targetPort === command.route.targetPort && receipt.deploymentId === command.route.deploymentId
    && receipt.operation === command.operation && receipt.rollbackRevisionId === command.rollbackRevisionId
    && (command.portTransfer === undefined ? receipt.portTransfer === undefined
      : receipt.state === "failed" ? receipt.portTransfer === undefined
        : receipt.portTransfer?.sourceDeploymentId === command.portTransfer.sourceDeploymentId
          && receipt.portTransfer.sourceContainerId !== command.portTransfer.sourceContainerId
          && receipt.portTransfer.sourceContainerId !== receipt.containerId);
}

/** Authenticated HTTP adapter for the agent's durable TCP/UDP apply receipt lane. */
export class AuthenticatedAgentTransportPortApplyTransport implements TransportPortApplyAgentTransport {
  private readonly fetcher: typeof globalThis.fetch;
  constructor(private readonly options: Options) { this.fetcher = options.fetch ?? globalThis.fetch; }
  available(): boolean {
    try {
      const url = new URL(this.options.endpoint); validateAgentTransportKey(this.options.trustKey);
      const internal = url.hostname === "localhost" || url.hostname === "agent" || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname);
      return !url.username && !url.password && !url.hash && ["https:", ...(this.options.allowInsecureInternal && internal ? ["http:"] : [])].includes(url.protocol)
        && Boolean(this.options.agentId.trim());
    } catch { return false; }
  }
  private command(prepared: PreparedTransportPortApplyCommand, authority: ProjectControlAuthorityV1,
    context: Readonly<{ requestId: string; correlationId: string }>, timeoutMs: number) {
    const command = prepared.command;
    if (command.action !== "project.update" || command.scope.kind !== "project" || command.scope.projectId !== prepared.route.projectId
      || authority.projectId !== prepared.route.projectId || authority.commandId !== command.id || authority.inputDigest !== command.inputDigest
      || context.correlationId !== command.correlationId || authority.action !== "project.update") throw new TransportError("transport port project update scope rejected");
    return transportPortApplyAgentCommandSchema.parse({ schemaVersion: 1, action: "transport.port.apply", agentId: prepared.agentId,
      commandId: command.id, projectId: prepared.route.projectId, idempotencyKey: command.idempotencyKey, inputDigest: command.inputDigest,
      operation: prepared.operation, rollbackRevisionId: prepared.rollbackRevisionId, route: prepared.route, bindings: prepared.bindings,
      currentContainerId: prepared.currentContainerId, previousBindings: prepared.previousBindings,
      ...(prepared.portTransfer ? { portTransfer: prepared.portTransfer } : {}),
      executionReceipt: prepared.executionReceipt, effectiveImage: prepared.effectiveImage,
      requiredCapabilities: prepared.portTransfer ? [TRANSPORT_PORT_APPLY_CAPABILITY, TRANSPORT_PORT_TRANSFER_CAPABILITY] : [TRANSPORT_PORT_APPLY_CAPABILITY],
      authority, lease: authority.projectLease,
      context: { requestId: context.requestId, correlationId: context.correlationId }, timeoutMs, cancellationRequested: false });
  }
  async dispatchTransportPortApply(prepared: PreparedTransportPortApplyCommand, authority: ProjectControlAuthorityV1,
    context: Readonly<{ requestId: string; correlationId: string; signal?: AbortSignal }>): Promise<TransportPortApplyReceiptV1> {
    if (!this.available() || prepared.agentId !== this.options.agentId) throw markAgentPreDispatchRejection(new TransportError("agent transport is not configured"));
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    let body;
    try { body = this.command(prepared, projectControlAuthoritySchema.parse(authority), context, timeoutMs); }
    catch (error) { throw markAgentPreDispatchRejection(error instanceof Error ? error : new TransportError("transport port command is invalid")); }
    const payload = JSON.stringify(body);
    let posted = false;
    let response: Response;
    try { response = await this.operate(timeoutMs, context.signal, async (signal) => {
      await this.handshake(signal, Boolean(prepared.portTransfer)); posted = true;
      return await awaitAbortable(() => this.fetcher(`${this.options.endpoint.replace(/\/$/, "")}${TRANSPORT_PORT_APPLY_PATH}`, {
        method: "POST", headers: { "content-type": "application/json", "x-deploylite-signature": signAgentTransport(payload, this.options.trustKey) }, body: payload, signal
      }), signal);
    }); } catch (error) {
      if (!posted) throw markAgentPreDispatchRejection(error instanceof Error ? error : new TransportError("transport port preflight failed"));
      throw error;
    }
    if (!response.ok) throw new TransportError(`agent transport returned HTTP ${response.status}`);
    const receipt = transportPortApplyReceiptSchema.parse(await response.json());
    if (!matches(body, receipt)) throw new TransportError("transport port receipt identity mismatch");
    return receipt;
  }
  async readTransportPortApplyReceipt(prepared: PreparedTransportPortApplyCommand, authority: ProjectControlAuthorityV1,
    context: Readonly<{ requestId: string; correlationId: string; signal?: AbortSignal }>): Promise<TransportPortApplyReceiptV1 | null> {
    if (!this.available() || prepared.agentId !== this.options.agentId) throw new TransportError("agent transport is not configured");
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    const full = this.command(prepared, projectControlAuthoritySchema.parse(authority), context, timeoutMs);
    const query = transportPortApplyReceiptQuerySchema.parse(Object.fromEntries(Object.entries(full).filter(([key]) => key !== "cancellationRequested")));
    const payload = JSON.stringify(query);
    const response = await this.operate(timeoutMs, context.signal, async (signal) => {
      await this.handshake(signal, Boolean(prepared.portTransfer));
      return await awaitAbortable(() => this.fetcher(`${this.options.endpoint.replace(/\/$/, "")}${TRANSPORT_PORT_APPLY_RECEIPT_PATH}`, {
        method: "POST", headers: { "content-type": "application/json", "x-deploylite-signature": signAgentTransport(`POST ${TRANSPORT_PORT_APPLY_RECEIPT_PATH}\n${payload}`, this.options.trustKey) }, body: payload, signal
      }), signal);
    });
    if (!response.ok) throw new TransportError(`agent cache returned HTTP ${response.status}`);
    const cached = transportPortApplyCachedReceiptSchema.parse(await response.json());
    if (cached.agentId !== this.options.agentId || cached.commandId !== query.commandId || cached.correlationId !== query.context.correlationId
      || (cached.receipt && !matches(query, cached.receipt))) throw new TransportError("transport port cached receipt identity mismatch");
    return cached.receipt;
  }
  private async handshake(signal: AbortSignal, requireTransfer: boolean): Promise<void> {
    const signature = signAgentTransport("GET /capabilities", this.options.trustKey);
    const response = await awaitAbortable(() => this.fetcher(`${this.options.endpoint.replace(/\/$/, "")}/capabilities`, { headers: { "x-deploylite-signature": signature }, signal }), signal);
    if (!response.ok || response.headers.get("x-deploylite-request-signature") !== signature) throw new TransportError("capability_unavailable");
    const handshake = agentCapabilityHandshakeSchema.parse(await response.json());
    if (handshake.agentId !== this.options.agentId || !handshake.capabilities.includes(TRANSPORT_PORT_APPLY_CAPABILITY)
      || (requireTransfer && !handshake.capabilities.includes(TRANSPORT_PORT_TRANSFER_CAPABILITY))) throw new TransportError("capability_unavailable");
  }
  private async operate<T>(timeoutMs: number, parent: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController(), cancel = () => controller.abort(parent?.reason);
    parent?.addEventListener("abort", cancel, { once: true }); if (parent?.aborted) cancel();
    const timer = setTimeout(() => controller.abort(new Error("transport timeout")), timeoutMs);
    try { return await awaitAbortable(() => operation(controller.signal), controller.signal); }
    finally { clearTimeout(timer); parent?.removeEventListener("abort", cancel); }
  }
}
