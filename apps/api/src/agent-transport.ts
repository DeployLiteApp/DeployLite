import { signAgentTransport, validateAgentTransportKey } from "@deploylite/config";
import { agentExecutionReceiptSchema, dockerImageExecutionReceiptSchema, type AgentExecutionCommand, type DeploymentSnapshotV1, type LeaseV1, TransportCanceledError, TransportError, TransportTimeoutError } from "@deploylite/contracts";
import { type DockerImageExecutionReceiptV1 } from "@deploylite/domain";

export type AgentTransportOptions = Readonly<{ endpoint: string; trustKey: string; agentId: string; allowInsecureInternal?: boolean; fetch?: typeof globalThis.fetch; timeoutMs?: number; now?: () => number }>;
export type AgentDispatchContext = Readonly<{ requestId: string; correlationId: string; agentId: string; signal?: AbortSignal }>;

export class AuthenticatedAgentDeploymentTransport {
  readonly #options: AgentTransportOptions; readonly #fetch: typeof globalThis.fetch;
  constructor(options: AgentTransportOptions) { this.#options = options; this.#fetch = options.fetch ?? globalThis.fetch; }
  available(): boolean { let url: URL; try { url = new URL(this.#options.endpoint); validateAgentTransportKey(this.#options.trustKey); } catch { return false; } const internal = url.hostname === "localhost" || url.hostname === "agent" || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname); if (url.username || url.password || url.hash || !["https:", ...(this.#options.allowInsecureInternal && internal ? ["http:"] : [])].includes(url.protocol)) return false; return Boolean(this.#options.agentId.trim()); }
  async dispatch(snapshot: DeploymentSnapshotV1, commandId: string, context?: AgentDispatchContext): Promise<DockerImageExecutionReceiptV1> {
    if (!this.available()) throw new TransportError("agent transport is not configured");
    if (context?.agentId && context.agentId !== this.#options.agentId) throw new TransportError("agent transport identity mismatch");
    const now = this.#options.now ?? Date.now; const timeoutMs = this.#options.timeoutMs ?? 30_000;
    if (context?.signal?.aborted) throw new TransportCanceledError();
    const lease: LeaseV1 = { leaseId: `${snapshot.deploymentId}:transport:1`, deploymentId: snapshot.deploymentId, fence: 1, expiresAt: now() + timeoutMs };
    const body: AgentExecutionCommand = { schemaVersion: 1, agentId: context?.agentId ?? this.#options.agentId, commandId, deploymentId: snapshot.deploymentId, projectId: snapshot.projectId, snapshot: { ...snapshot, canonicalBytes: undefined } as unknown as Record<string, unknown>, snapshotHash: snapshot.hash, requiredCapabilities: ["deploy.execute"], lease, context: { requestId: context?.requestId ?? commandId, correlationId: context?.correlationId ?? commandId }, timeoutMs, cancellationRequested: false };
    const payload = JSON.stringify(body); const controller = new AbortController(); let timedOut = false; let deadlineTimer: ReturnType<typeof setTimeout> | undefined; const abort = () => controller.abort(); const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs); context?.signal?.addEventListener("abort", abort, { once: true }); let canceled = false; const cancel = () => { canceled = true; controller.abort(); }; let rejectCanceled: ((error: TransportCanceledError) => void) | undefined; const onCancel = () => { cancel(); rejectCanceled?.(new TransportCanceledError()); }; const cancelPromise = new Promise<never>((_, reject) => { rejectCanceled = reject; if (context?.signal?.aborted) onCancel(); else context?.signal?.addEventListener("abort", onCancel, { once: true }); });
    try {
      const request = this.#fetch(`${this.#options.endpoint.replace(/\/$/, "")}/deployments/execute`, { method: "POST", headers: { "content-type": "application/json", "x-deploylite-signature": signAgentTransport(payload, this.#options.trustKey) }, body: payload, signal: controller.signal });
      const deadline = new Promise<never>((_, reject) => { deadlineTimer = setTimeout(() => { timedOut = true; controller.abort(); reject(new TransportTimeoutError()); }, timeoutMs); });
      const response = await Promise.race([request, deadline, cancelPromise]);
      if (!response.ok) throw new TransportError(`agent transport returned HTTP ${response.status}`);
      const result = agentExecutionReceiptSchema.parse(await response.json());
      if (result.commandId !== commandId || result.deploymentId !== snapshot.deploymentId) throw new TransportError("agent receipt identity mismatch");
      return dockerImageExecutionReceiptSchema.parse(result.receipt) as DockerImageExecutionReceiptV1;
    } catch (error) { if (error instanceof TransportError || error instanceof TransportTimeoutError || error instanceof TransportCanceledError) throw error; if (canceled || context?.signal?.aborted) throw new TransportCanceledError(); if (timedOut) throw new TransportTimeoutError(); throw new TransportError(error instanceof Error ? error.message : "agent transport failed"); } finally { clearTimeout(timer); if (deadlineTimer) clearTimeout(deadlineTimer); context?.signal?.removeEventListener("abort", abort); context?.signal?.removeEventListener("abort", onCancel); }
  }
}
