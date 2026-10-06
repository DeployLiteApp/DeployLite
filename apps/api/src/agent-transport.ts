import { signAgentTransport, validateAgentTransportKey } from "@deploylite/config";
import { agentCachedReceiptSchema, agentReceiptQuerySchema, type AgentReceiptQuery, agentCapabilityHandshakeSchema, agentExecutionReceiptSchema, deploymentStopAgentReceiptSchema, dockerImageExecutionReceiptSchema, promotionPolicySchema, type AgentExecutionCommand, type AgentReplacementV1, type DeploymentExecutionAuthorityV1, type DeploymentSnapshotV1, type LeaseV1, TransportCanceledError, TransportError, TransportTimeoutError } from "@deploylite/contracts";
import { awaitAbortable, type DockerImageExecutionReceiptV1 } from "@deploylite/domain";

export type AgentTransportOptions = Readonly<{ endpoint: string; trustKey: string; agentId: string; allowInsecureInternal?: boolean; fetch?: typeof globalThis.fetch; timeoutMs?: number; now?: () => number }>;
export type AgentDispatchContext = Readonly<{ requestId: string; correlationId: string; agentId: string; signal?: AbortSignal; executionDeploymentId?: string; sourceDeploymentId?: string; authority?: DeploymentExecutionAuthorityV1; replacement?: AgentReplacementV1 }>;
export type DeploymentDispatchReceipt = DockerImageExecutionReceiptV1 & Readonly<{ projectId: string; sourceDeploymentId: string; snapshotHash: string; correlationId: string }>;
export type AgentStopDispatchInput = Readonly<{ projectId: string; deploymentId: string; candidateId: string; effectiveImage: string; containerId?: string; commandId: string }>;

// Only this local transport can prove that no POST was attempted.
const preDispatchRejections = new WeakSet<object>();
export function isAgentPreDispatchRejection(error: unknown): boolean { return typeof error === "object" && error !== null && preDispatchRejections.has(error); }

function beforeDispatch<T extends Error>(error: T): T { preDispatchRejections.add(error); return error; }

export class AuthenticatedAgentDeploymentTransport {
  readonly #options: AgentTransportOptions; readonly #fetch: typeof globalThis.fetch;
  constructor(options: AgentTransportOptions) { this.#options = options; this.#fetch = options.fetch ?? globalThis.fetch; }
  available(): boolean { let url: URL; try { url = new URL(this.#options.endpoint); validateAgentTransportKey(this.#options.trustKey); } catch { return false; } const internal = url.hostname === "localhost" || url.hostname === "agent" || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname); if (url.username || url.password || url.hash || !["https:", ...(this.#options.allowInsecureInternal && internal ? ["http:"] : [])].includes(url.protocol)) return false; return Boolean(this.#options.agentId.trim()); }
  async dispatch(snapshot: DeploymentSnapshotV1, commandId: string, context?: AgentDispatchContext): Promise<DockerImageExecutionReceiptV1 | DeploymentDispatchReceipt> {
    snapshot = structuredClone(snapshot);
    context = context ? { ...context, authority: context.authority ? structuredClone(context.authority) : undefined, replacement: context.replacement ? structuredClone(context.replacement) : undefined } : undefined;
    if (!this.available()) throw beforeDispatch(new TransportError("agent transport is not configured"));
    if (context?.agentId && context.agentId !== this.#options.agentId) throw beforeDispatch(new TransportError("agent transport identity mismatch"));
    const now = this.#options.now ?? Date.now; const timeoutMs = this.#options.timeoutMs ?? 30_000;
    const responseTimeoutMs = timeoutMs + (context?.replacement ? promotionPolicySchema.parse(context.replacement.policy).maxOutageMs + context.replacement.policy.maxRecoveryMs : 0);
    if (context?.signal?.aborted) throw beforeDispatch(new TransportCanceledError());
      const lease: LeaseV1 = context?.authority?.executionLease ?? { leaseId: `${snapshot.deploymentId}:transport:1`, deploymentId: snapshot.deploymentId, fence: 1, expiresAt: now() + timeoutMs };
    const executionDeploymentId = context?.executionDeploymentId ?? snapshot.deploymentId; const sourceDeploymentId = context?.sourceDeploymentId ?? snapshot.deploymentId; const v2 = context?.executionDeploymentId !== undefined;
    return this.operate(responseTimeoutMs, context?.signal, async (signal, dispatched) => {
    if (v2) { const handshakeRequestSignature = signAgentTransport("GET /capabilities", this.#options.trustKey); const handshakeResponse = await awaitAbortable(() => this.#fetch(`${this.#options.endpoint.replace(/\/$/, "")}/capabilities`, { headers: { "x-deploylite-signature": handshakeRequestSignature }, signal }), signal); const responseBinding = handshakeResponse.headers.get("x-deploylite-request-signature"); // This echo binds the response to the signed request target; it does not authenticate the response body.
      if (!handshakeResponse.ok || responseBinding !== handshakeRequestSignature) throw new TransportError("capability_unavailable"); const handshake = agentCapabilityHandshakeSchema.parse(await awaitAbortable(() => handshakeResponse.json(), signal)); if (handshake.agentId !== this.#options.agentId || !handshake.capabilities.includes("deploy.execute") || !handshake.protocolVersions.includes(2)) throw new TransportError("capability_unavailable"); }
    const body: AgentExecutionCommand = v2 ? { schemaVersion: 2, agentId: context?.agentId ?? this.#options.agentId, commandId, deploymentId: executionDeploymentId, sourceDeploymentId, ...(context?.authority ? { authority: context.authority } : {}), ...(context?.replacement ? { replacement: context.replacement } : {}), projectId: snapshot.projectId, snapshot: { ...snapshot, canonicalBytes: undefined } as unknown as Record<string, unknown>, snapshotHash: snapshot.hash, requiredCapabilities: ["deploy.execute"], lease: { ...lease, deploymentId: executionDeploymentId }, context: { requestId: context?.requestId ?? commandId, correlationId: context?.correlationId ?? commandId }, timeoutMs, cancellationRequested: false } : { schemaVersion: 1, agentId: context?.agentId ?? this.#options.agentId, commandId, deploymentId: executionDeploymentId, projectId: snapshot.projectId, snapshot: { ...snapshot, canonicalBytes: undefined } as unknown as Record<string, unknown>, snapshotHash: snapshot.hash, requiredCapabilities: ["deploy.execute"], lease, context: { requestId: context?.requestId ?? commandId, correlationId: context?.correlationId ?? commandId }, timeoutMs, cancellationRequested: false };
    const payload = JSON.stringify(body);
    dispatched();
    const response = await awaitAbortable(() => this.#fetch(`${this.#options.endpoint.replace(/\/$/, "")}/deployments/execute`, { method: "POST", headers: { "content-type": "application/json", "x-deploylite-signature": signAgentTransport(payload, this.#options.trustKey) }, body: payload, signal }), signal);
    if (!response.ok) throw new TransportError(`agent transport returned HTTP ${response.status}`);
    const result = agentExecutionReceiptSchema.parse(await awaitAbortable(() => response.json(), signal));
    if (result.commandId !== commandId || result.deploymentId !== executionDeploymentId || result.receipt.deploymentId !== executionDeploymentId) throw new TransportError("agent receipt identity mismatch");
    const receipt = dockerImageExecutionReceiptSchema.parse(result.receipt) as DockerImageExecutionReceiptV1;
    if (v2) { if (result.schemaVersion !== 2 || result.sourceDeploymentId !== sourceDeploymentId || result.snapshotHash !== snapshot.hash || result.correlationId !== (context?.correlationId ?? commandId)) throw new TransportError("agent receipt identity mismatch"); return { ...receipt, projectId: snapshot.projectId, sourceDeploymentId, snapshotHash: snapshot.hash, correlationId: result.correlationId }; }
    if (result.schemaVersion !== 1) throw new TransportError("agent receipt identity mismatch"); return receipt;
    });
  }

  async readExecutionReceipt(snapshot: DeploymentSnapshotV1, commandId: string, context?: AgentDispatchContext): Promise<DockerImageExecutionReceiptV1 | DeploymentDispatchReceipt | null> {
    snapshot = structuredClone(snapshot); context = context ? { ...context, authority: context.authority ? structuredClone(context.authority) : undefined, replacement: context.replacement ? structuredClone(context.replacement) : undefined } : undefined;
    const query = agentReceiptQuerySchema.parse({ schemaVersion: 1, action: "deploy.execute", agentId: context?.agentId ?? this.#options.agentId, commandId, projectId: snapshot.projectId, deploymentId: context?.executionDeploymentId ?? snapshot.deploymentId, sourceDeploymentId: context?.executionDeploymentId === undefined ? null : context.sourceDeploymentId ?? snapshot.deploymentId, snapshot: { ...snapshot, canonicalBytes: undefined }, snapshotHash: snapshot.hash, correlationId: context?.correlationId ?? commandId, authority: context?.authority ?? null, replacement: context?.replacement ?? null, timeoutMs: this.#options.timeoutMs ?? 30_000 });
    const result = await this.readCached(query, context?.signal);
    if (result.action !== "deploy.execute" || query.action !== "deploy.execute") throw new TransportError("agent cached receipt identity mismatch");
    if (!result.receipt) return null;
    const receipt = result.receipt;
    if (receipt.commandId !== query.commandId || receipt.deploymentId !== query.deploymentId || receipt.receipt.deploymentId !== query.deploymentId || (query.sourceDeploymentId === null ? receipt.schemaVersion !== 1 : receipt.schemaVersion !== 2 || receipt.sourceDeploymentId !== query.sourceDeploymentId || receipt.snapshotHash !== query.snapshotHash || receipt.correlationId !== query.correlationId)) throw new TransportError("agent cached execution identity mismatch");
    return query.action === "deploy.execute" && query.sourceDeploymentId !== null ? { ...result.receipt.receipt, projectId: query.projectId, sourceDeploymentId: query.sourceDeploymentId, snapshotHash: query.snapshotHash, correlationId: query.correlationId } : result.receipt.receipt;
  }
  async readStopReceipt(input: AgentStopDispatchInput, context: AgentDispatchContext): Promise<ReturnType<typeof deploymentStopAgentReceiptSchema.parse> | null> {
    input = structuredClone(input); context = { ...context, authority: context.authority ? structuredClone(context.authority) : undefined };
    const query = agentReceiptQuerySchema.parse({ schemaVersion: 1, action: "deployment.stop", agentId: context.agentId, commandId: input.commandId, projectId: input.projectId, deploymentId: input.deploymentId, candidateId: input.candidateId, effectiveImage: input.effectiveImage, containerId: input.containerId ?? null, correlationId: context.correlationId, authority: context.authority ?? null, timeoutMs: this.#options.timeoutMs ?? 30_000 });
    const result = await this.readCached(query, context.signal);
    if (result.action !== "deployment.stop" || query.action !== "deployment.stop") throw new TransportError("agent cached receipt identity mismatch");
    const receipt = result.receipt;
    if (receipt && (receipt.agentId !== this.#options.agentId || receipt.commandId !== query.commandId || receipt.projectId !== query.projectId || receipt.deploymentId !== query.deploymentId || receipt.candidateId !== query.candidateId || receipt.effectiveImage !== query.effectiveImage || (receipt.containerId ?? null) !== query.containerId || receipt.correlationId !== query.correlationId)) throw new TransportError("agent cached Stop identity mismatch");
    return receipt;
  }
  private async readCached(query: AgentReceiptQuery, parent?: AbortSignal) {
    if (!this.available()) throw new TransportError("agent transport is not configured");
    if (query.agentId !== this.#options.agentId) throw new TransportError("agent transport identity mismatch");
    const payload = JSON.stringify(query);
    return this.operate(query.timeoutMs, parent, async (signal, sent) => {
      sent(); const response = await awaitAbortable(() => this.#fetch(`${this.#options.endpoint.replace(/\/$/, "")}/deployments/receipt`, { method: "POST", headers: { "content-type": "application/json", "x-deploylite-signature": signAgentTransport(`POST /deployments/receipt\n${payload}`, this.#options.trustKey) }, body: payload, signal }), signal);
      if (!response.ok) throw new TransportError(`agent cache returned HTTP ${response.status}`);
      const result = agentCachedReceiptSchema.parse(await awaitAbortable(() => response.json(), signal));
      if (result.action !== query.action || result.agentId !== this.#options.agentId || result.commandId !== query.commandId || result.correlationId !== query.correlationId) throw new TransportError("agent cached receipt identity mismatch");
      return result;
    });
  }

  async dispatchStop(input: AgentStopDispatchInput, context: AgentDispatchContext): Promise<ReturnType<typeof deploymentStopAgentReceiptSchema.parse>> {
    input = structuredClone(input); context = { ...context, authority: context.authority ? structuredClone(context.authority) : undefined };
    if (!this.available()) throw beforeDispatch(new TransportError("agent transport is not configured")); if (context.agentId !== this.#options.agentId) throw beforeDispatch(new TransportError("agent transport identity mismatch")); if (context.signal?.aborted) throw beforeDispatch(new TransportCanceledError());
    const now = this.#options.now ?? Date.now; const timeoutMs = this.#options.timeoutMs ?? 30_000; const body = { schemaVersion: 1 as const, action: "deployment.stop" as const, agentId: this.#options.agentId, commandId: input.commandId, projectId: input.projectId, deploymentId: input.deploymentId, candidateId: input.candidateId, effectiveImage: input.effectiveImage, ...(input.containerId ? { containerId: input.containerId } : {}), requiredCapabilities: ["deployment.stop" as const], lease: context.authority?.executionLease ?? { leaseId: `${input.deploymentId}:transport:stop:1`, deploymentId: input.deploymentId, fence: 1, expiresAt: now() + timeoutMs }, ...(context.authority ? { authority: context.authority } : {}), context: { requestId: context.requestId, correlationId: context.correlationId }, timeoutMs, cancellationRequested: false };
    return this.operate(timeoutMs, context.signal, async (signal, dispatched) => {
      const payload = JSON.stringify(body); dispatched();
      const response = await awaitAbortable(() => this.#fetch(`${this.#options.endpoint.replace(/\/$/, "")}/deployments/stop`, { method: "POST", headers: { "content-type": "application/json", "x-deploylite-signature": signAgentTransport(payload, this.#options.trustKey) }, body: payload, signal }), signal);
      if (!response.ok) throw new TransportError(`agent transport returned HTTP ${response.status}`);
      const result = deploymentStopAgentReceiptSchema.parse(await awaitAbortable(() => response.json(), signal));
      if (result.commandId !== input.commandId || result.agentId !== this.#options.agentId || result.projectId !== input.projectId || result.deploymentId !== input.deploymentId || result.correlationId !== context.correlationId || (input.containerId !== undefined && result.containerId !== input.containerId)) throw new TransportError("agent stop receipt identity mismatch");
      return result;
    });
  }
  private async operate<T>(timeoutMs: number, parent: AbortSignal | undefined, operation: (signal: AbortSignal, dispatched: () => void) => Promise<T>): Promise<T> {
    const controller = new AbortController(); let sent = false; const deadline = Date.now() + timeoutMs;
    const assertBudget = () => { if (Date.now() >= deadline && !controller.signal.aborted) controller.abort(new TransportTimeoutError()); if (controller.signal.aborted) throw controller.signal.reason; };
    const cancel = () => controller.abort(new TransportCanceledError());
    parent?.addEventListener("abort", cancel, { once: true }); if (parent?.aborted) cancel();
    const timer = setTimeout(() => controller.abort(new TransportTimeoutError()), timeoutMs);
    try { const result = await awaitAbortable(() => operation(controller.signal, () => { assertBudget(); sent = true; }), controller.signal); assertBudget(); return result; }
    catch (error) {
      const classified = error instanceof TransportError || error instanceof TransportTimeoutError || error instanceof TransportCanceledError ? error : new TransportError(error instanceof Error ? error.message : "agent transport failed");
      if (!sent) preDispatchRejections.add(classified); throw classified;
    } finally { clearTimeout(timer); parent?.removeEventListener("abort", cancel); }
  }
}
