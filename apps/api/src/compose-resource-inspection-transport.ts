import { randomUUID } from "node:crypto";
import { signAgentTransport, validateAgentTransportKey, verifyAgentTransport } from "@deploylite/config";
import {
  agentCapabilityHandshakeSchema,
  composeResourceInspectionAgentCommandSchema,
  composeResourceInspectionAgentResponseSchema,
  COMPOSE_RESOURCE_INSPECTION_CAPABILITY,
  COMPOSE_RESOURCE_INSPECTION_PATH,
  TransportCanceledError,
  TransportError,
  TransportTimeoutError,
  type ComposeResourceObservationV1
} from "@deploylite/contracts";
import type { ComposeResourceInspectionContext, ComposeResourceInspector } from "@deploylite/domain";
import type { AgentTransportOptions } from "./agent-transport.js";

function awaitWithAbort<T>(operation: () => PromiseLike<T> | T, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason ?? new TransportCanceledError()); return; }
    const cancel = () => reject(signal.reason ?? new TransportCanceledError());
    signal.addEventListener("abort", cancel, { once: true });
    Promise.resolve().then(operation).then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}

/** Authenticated read-only adapter for a negotiated agent's resource observation port. */
export class AuthenticatedAgentComposeResourceInspectionTransport implements ComposeResourceInspector {
  readonly #options: AgentTransportOptions;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: AgentTransportOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  available(): boolean {
    let url: URL;
    try { url = new URL(this.#options.endpoint); validateAgentTransportKey(this.#options.trustKey); }
    catch { return false; }
    const internal = url.hostname === "localhost" || url.hostname === "agent"
      || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname);
    return !url.username && !url.password && !url.hash
      && ["https:", ...(this.#options.allowInsecureInternal && internal ? ["http:"] : [])].includes(url.protocol)
      && Boolean(this.#options.agentId.trim());
  }

  async inspect(input: Parameters<ComposeResourceInspector["inspect"]>[0], parent?: AbortSignal, context?: ComposeResourceInspectionContext): Promise<ComposeResourceObservationV1> {
    if (!this.available()) throw new TransportError("agent transport is not configured");
    if (parent?.aborted) throw new TransportCanceledError();
    const timeoutMs = this.#options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new TransportError("agent transport timeout is invalid");
    const requestId = context?.requestId ?? randomUUID();
    const correlationId = context?.correlationId ?? requestId;
    const body = composeResourceInspectionAgentCommandSchema.parse({
      schemaVersion: 1,
      action: "compose.resource.inspect",
      agentId: this.#options.agentId,
      projectId: input.preview.projectId,
      preview: structuredClone(input.preview),
      kind: input.kind,
      key: input.key,
      expectedConfigDigest: input.preview.configDigest,
      requiredCapabilities: [COMPOSE_RESOURCE_INSPECTION_CAPABILITY],
      context: { requestId, correlationId },
      timeoutMs
    });
    const payload = JSON.stringify(body);
    const controller = new AbortController();
    const cancel = () => controller.abort(new TransportCanceledError());
    parent?.addEventListener("abort", cancel, { once: true });
    if (parent?.aborted) cancel();
    const timer = setTimeout(() => controller.abort(new TransportTimeoutError()), timeoutMs);
    try {
      const handshakeSignature = signAgentTransport("GET /capabilities", this.#options.trustKey);
      const handshakeResponse = await awaitWithAbort(() => this.#fetch(`${this.#options.endpoint.replace(/\/$/, "")}/capabilities`, {
        headers: { "x-deploylite-signature": handshakeSignature }, signal: controller.signal
      }), controller.signal);
      if (!handshakeResponse.ok || handshakeResponse.headers.get("x-deploylite-request-signature") !== handshakeSignature)
        throw new TransportError("capability_unavailable");
      const handshake = agentCapabilityHandshakeSchema.parse(await awaitWithAbort(() => handshakeResponse.json(), controller.signal));
      if (handshake.agentId !== this.#options.agentId || !handshake.protocolVersions.includes(1)
        || !handshake.capabilities.includes(COMPOSE_RESOURCE_INSPECTION_CAPABILITY)) throw new TransportError("capability_unavailable");

      const response = await awaitWithAbort(() => this.#fetch(`${this.#options.endpoint.replace(/\/$/, "")}${COMPOSE_RESOURCE_INSPECTION_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-deploylite-signature": signAgentTransport(`POST ${COMPOSE_RESOURCE_INSPECTION_PATH}\n${payload}`, this.#options.trustKey) },
        body: payload,
        signal: controller.signal
      }), controller.signal);
      if (!response.ok) throw new TransportError(`agent transport returned HTTP ${response.status}`);
      const responsePayload = await awaitWithAbort(() => response.text(), controller.signal);
      if (Buffer.byteLength(responsePayload, "utf8") > 1_048_576) throw new TransportError("agent inspection response is too large");
      const responseSignature = response.headers.get("x-deploylite-response-signature");
      if (!verifyAgentTransport(`POST ${COMPOSE_RESOURCE_INSPECTION_PATH}\n${payload}\n${responsePayload}`, responseSignature ?? undefined, this.#options.trustKey))
        throw new TransportError("agent inspection response authentication failed");
      let raw: unknown;
      try { raw = JSON.parse(responsePayload); } catch { throw new TransportError("agent inspection response is invalid"); }
      const result = composeResourceInspectionAgentResponseSchema.parse(raw);
      if (result.agentId !== this.#options.agentId || result.projectId !== body.projectId || result.configDigest !== body.expectedConfigDigest
        || result.kind !== body.kind || result.key !== body.key || result.context.requestId !== body.context.requestId
        || result.context.correlationId !== body.context.correlationId || result.observation.agentId !== this.#options.agentId
        || result.observation.runtimeName !== (body.kind === "network" ? body.preview.networks : body.preview.volumes).find(resource => resource.key === body.key)?.runtimeName)
        throw new TransportError("agent inspection response scope rejected");
      return result.observation;
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason instanceof Error ? controller.signal.reason : new TransportCanceledError();
      if (error instanceof TransportError || error instanceof TransportCanceledError || error instanceof TransportTimeoutError) throw error;
      throw new TransportError("agent inspection failed");
    } finally {
      clearTimeout(timer);
      parent?.removeEventListener("abort", cancel);
    }
  }
}
