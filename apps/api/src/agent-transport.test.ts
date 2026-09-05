import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import { createDeploymentSnapshot, createSourceIntent, TransportCanceledError, TransportTimeoutError } from "@deploylite/contracts";
import { AuthenticatedAgentDeploymentTransport } from "./agent-transport.js";

const digest = `sha256:${"a".repeat(64)}`;
const snapshot = createDeploymentSnapshot({ deploymentId: "dep_transport", projectId: "project_transport", source: createSourceIntent({ sourceMode: "image", requestedReference: `registry.example.com/team/app@${digest}` }, { policyVersion: "p1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true }), configRevision: "c1", runtimeRevision: "r1", runtimePort: 3000, secretRefs: [], policyVersion: "p1", schemaVersion: 1 }, { sha256: (bytes) => createHash("sha256").update(bytes).digest("hex") });
const receipt = { deploymentId: snapshot.deploymentId, effectiveImage: `registry.example.com/team/app@${digest}`, runtimePort: 3000, health: "passed" as const, terminalStatus: "succeeded" as const, rollback: { target: null, result: "not-required" as const }, proven: true };

describe("authenticated agent transport", () => {
  it("posts the immutable snapshot and preserves correlation and lease data", async () => {
    let request: RequestInit | undefined;
     const transport = new AuthenticatedAgentDeploymentTransport({ endpoint: "https://agent.test", trustKey: "transport_test_key_123", agentId: "agent-1", now: () => 1000, fetch: async (_url, init) => { request = init; return new Response(JSON.stringify({ schemaVersion: 1, commandId: "cmd-1", deploymentId: snapshot.deploymentId, terminalStatus: "succeeded", health: "passed", redacted: true, receipt }), { status: 200 }); } });
    const result = await transport.dispatch(snapshot, "cmd-1", { agentId: "agent-1", requestId: "req-1", correlationId: "corr-1" });
    const body = JSON.parse(String(request?.body));
    expect(result.terminalStatus).toBe("succeeded");
    expect(body.snapshotHash).toBe(snapshot.hash);
    expect(body.context).toEqual({ requestId: "req-1", correlationId: "corr-1" });
    expect(body.lease.expiresAt).toBe(31000);
    expect(request?.headers).toHaveProperty("x-deploylite-signature");
  });

  it("fails closed when transport configuration is absent", async () => {
    const transport = new AuthenticatedAgentDeploymentTransport({ endpoint: "", trustKey: "", agentId: "" });
    expect(transport.available()).toBe(false);
    await expect(transport.dispatch(snapshot, "cmd-1")).rejects.toThrow("not configured");
  });
  it("binds execution identity separately from the immutable source snapshot", async () => {
     let request: RequestInit | undefined; const executionId = "dep_execution"; const transport = new AuthenticatedAgentDeploymentTransport({ endpoint: "https://agent.test", trustKey: "transport_test_key_123", agentId: "agent-1", fetch: async (_url, init) => { request = init; const value = String(_url).endsWith("/capabilities") ? { schemaVersion: 1, agentId: "agent-1", capabilities: ["deploy.execute"], protocolVersions: [1, 2] } : { schemaVersion: 2, commandId: "cmd-target", deploymentId: executionId, sourceDeploymentId: snapshot.deploymentId, snapshotHash: snapshot.hash, terminalStatus: "succeeded", health: "passed", redacted: true, correlationId: "corr-target", receipt: { ...receipt, deploymentId: executionId } }; return new Response(JSON.stringify(value), { status: 200, headers: String(_url).endsWith("/capabilities") ? { "x-deploylite-request-signature": String((init?.headers as Record<string, string>)["x-deploylite-signature"]) } : undefined }); } });
    await expect(transport.dispatch(snapshot, "cmd-target", { agentId: "agent-1", requestId: "req-target", correlationId: "corr-target", executionDeploymentId: executionId })).resolves.toMatchObject({ deploymentId: executionId }); const body = JSON.parse(String(request?.body)); expect(body.deploymentId).toBe(executionId); expect(body.sourceDeploymentId).toBe(snapshot.deploymentId); expect(body.lease.deploymentId).toBe(executionId);
  });
  it("rejects an execution receipt with a mismatched target identity", async () => {
     const transport = new AuthenticatedAgentDeploymentTransport({ endpoint: "https://agent.test", trustKey: "transport_test_key_123", agentId: "agent-1", fetch: async (url, init) => new Response(JSON.stringify(String(url).endsWith("/capabilities") ? { schemaVersion: 1, agentId: "agent-1", capabilities: ["deploy.execute"], protocolVersions: [1, 2] } : { schemaVersion: 2, commandId: "cmd-target", deploymentId: "dep_execution", sourceDeploymentId: snapshot.deploymentId, snapshotHash: snapshot.hash, terminalStatus: "succeeded", health: "passed", redacted: true, correlationId: "corr-target", receipt: { ...receipt, deploymentId: "wrong-execution" } }), { status: 200, headers: String(url).endsWith("/capabilities") ? { "x-deploylite-request-signature": String((init?.headers as Record<string, string>)["x-deploylite-signature"]) } : undefined }) });
    await expect(transport.dispatch(snapshot, "cmd-target", { agentId: "agent-1", requestId: "req-target", correlationId: "corr-target", executionDeploymentId: "dep_execution" })).rejects.toThrow("identity mismatch");
  });
   it("fails closed before execution when v2 is not advertised", async () => { const calls: string[] = []; const transport = new AuthenticatedAgentDeploymentTransport({ endpoint: "https://agent.test", trustKey: "transport_test_key_123", agentId: "agent-1", fetch: async (url, init) => { calls.push(String(url)); return new Response(JSON.stringify({ schemaVersion: 1, agentId: "agent-1", capabilities: ["deploy.execute"], protocolVersions: [1] }), { status: 200, headers: { "x-deploylite-request-signature": String((init?.headers as Record<string, string>)["x-deploylite-signature"]) } }); } }); await expect(transport.dispatch(snapshot, "cmd-no-v2", { agentId: "agent-1", requestId: "req", correlationId: "corr", executionDeploymentId: "dep_execution" })).rejects.toThrow("capability_unavailable"); expect(calls).toHaveLength(1); });

  it.each(["missing", "wrong"]) ("rejects %s response binding before v2 execution", async (binding) => {
    let executed = false;
    const transport = new AuthenticatedAgentDeploymentTransport({ endpoint: "https://agent.test", trustKey: "transport_test_key_123", agentId: "agent-1", fetch: async (_url, init) => { if (String(_url).endsWith("/capabilities")) return new Response(JSON.stringify({ schemaVersion: 1, agentId: "agent-1", capabilities: ["deploy.execute"], protocolVersions: [1, 2] }), { status: 200, headers: binding === "wrong" ? { "x-deploylite-request-signature": "wrong" } : undefined }); executed = true; return new Response("{}", { status: 500 }); } });
    await expect(transport.dispatch(snapshot, "cmd-binding", { agentId: "agent-1", requestId: "req", correlationId: "corr", executionDeploymentId: "dep-execution" })).rejects.toThrow("capability_unavailable");
    expect(executed).toBe(false);
  });

  it("composes API transport with the authenticated agent handler through Fastify inject", async () => {
    const { AuthenticatedAgentCommandReceiver, createAgentExecutionHandler } = await import(new URL("../../agent/src/agent-transport.ts", import.meta.url).href);
    const receiver = new AuthenticatedAgentCommandReceiver({ agentId: "agent-1", trustKey: "transport_test_key_123", capabilities: ["deploy.execute"], dispatcher: { dispatch: async (_snapshot: unknown, _commandId: string, _signal: AbortSignal, _lease: unknown, options?: { executionDeploymentId?: string }) => ({ deploymentId: options!.executionDeploymentId!, effectiveImage: `registry.example.com/team/app@${digest}`, runtimePort: 3000, health: "passed" as const, terminalStatus: "succeeded" as const, rollback: { target: null, result: "not-required" as const }, proven: true as const }) }, replayStore: { durable: true, claim: async () => ({ claimed: true, claimToken: "claim" }), wait: async () => ({}), complete: async () => {}, release: async () => {} } });
    const agent = Fastify(); const handler = createAgentExecutionHandler(receiver);
    agent.get("/capabilities", async (request, reply) => { const signature = typeof request.headers["x-deploylite-signature"] === "string" ? request.headers["x-deploylite-signature"] : undefined; if (!receiver.verifyRequest("GET /capabilities", signature)) return reply.code(401).send({ error: "agent authentication failed" }); return reply.header("x-deploylite-request-signature", signature!).send({ schemaVersion: 1, agentId: receiver.agentId, capabilities: receiver.capabilities, protocolVersions: [1, 2] }); });
    agent.post("/deployments/execute", async (request, reply) => reply.send(await handler(request.body, { "x-deploylite-signature": typeof request.headers["x-deploylite-signature"] === "string" ? request.headers["x-deploylite-signature"] : undefined })));
    await agent.ready();
    try {
      const transport = new AuthenticatedAgentDeploymentTransport({ endpoint: "https://agent.test", trustKey: "transport_test_key_123", agentId: "agent-1", fetch: async (url, init) => { const result = await agent.inject({ method: (init?.method ?? "GET") as "GET" | "POST", url: new URL(String(url)).pathname, headers: init?.headers as Record<string, string>, payload: init?.body as string }); return new Response(result.body, { status: result.statusCode, headers: result.headers as Record<string, string> }); } });
      await expect(transport.dispatch(snapshot, "cmd-composed", { agentId: "agent-1", requestId: "req", correlationId: "corr", executionDeploymentId: "dep-execution" })).resolves.toMatchObject({ deploymentId: "dep-execution", sourceDeploymentId: snapshot.deploymentId, correlationId: "corr" });
    } finally { await agent.close(); }
  });
  it("runs v2 in process through receiver, dispatcher, and executor with distinct identities", async () => { const { AuthenticatedAgentCommandReceiver } = await import(new URL("../../agent/dist/agent-transport.js", import.meta.url).href); const { DigestDeploymentDispatcher } = await import(new URL("../../agent/dist/deployment-dispatcher.js", import.meta.url).href); const { FakeDockerImageTransport, InMemoryProtocolTransport } = await import("@deploylite/domain"); const replay = new Map<string, any>(); const replayStore = { claim: async (id: string) => replay.has(id) ? { claimed: false, receipt: replay.get(id).receipt } : { claimed: true, claimToken: "claim" }, wait: async (id: string) => replay.get(id).receipt, complete: async (id: string, value: any) => { replay.set(id, value); }, release: async () => {} }; const dispatcher = new DigestDeploymentDispatcher({ protocol: new InMemoryProtocolTransport({ clock: { now: () => 1 }, leasePolicy: { ttlMs: 100 }, retryPolicy: { maxAttempts: 1, deadlineMs: 0, backoffMs: () => 0 }, capabilities: ["deploy.execute"] }), transport: new FakeDockerImageTransport(), trustedHosts: ["registry.example.com"] }); const receiver = new AuthenticatedAgentCommandReceiver({ agentId: "agent-1", trustKey: "transport_test_key_123", capabilities: ["deploy.execute"], dispatcher, replayStore: replayStore as never, now: () => 1 }); const transport = new AuthenticatedAgentDeploymentTransport({ endpoint: "https://agent.test", trustKey: "transport_test_key_123", agentId: "agent-1", fetch: async (url, init) => { if (String(url).endsWith("/capabilities")) return new Response(JSON.stringify({ schemaVersion: 1, agentId: "agent-1", capabilities: ["deploy.execute"], protocolVersions: [1, 2] }), { headers: { "x-deploylite-request-signature": String((init?.headers as Record<string, string>)["x-deploylite-signature"]) } }); const body = JSON.parse(String(init?.body)); return new Response(JSON.stringify(await receiver.receive(body, String((init?.headers as Record<string, string>)["x-deploylite-signature"])))); } }); const result = await transport.dispatch(snapshot, "cmd-e2e", { agentId: "agent-1", requestId: "req-e2e", correlationId: "corr-e2e", executionDeploymentId: "dep-execution" }); expect(result).toMatchObject({ deploymentId: "dep-execution", sourceDeploymentId: snapshot.deploymentId, correlationId: "corr-e2e", terminalStatus: "succeeded" }); });
  it("allows operator-controlled internal HTTP only when explicitly opted in", () => {
    expect(new AuthenticatedAgentDeploymentTransport({ endpoint: "http://127.0.0.1:3000", trustKey: "transport_test_key_123", agentId: "a" }).available()).toBe(false);
    expect(new AuthenticatedAgentDeploymentTransport({ endpoint: "http://127.0.0.1:3000", trustKey: "transport_test_key_123", agentId: "a", allowInsecureInternal: true }).available()).toBe(true);
    expect(new AuthenticatedAgentDeploymentTransport({ endpoint: "https://agent.test/path#fragment", trustKey: "transport_test_key_123", agentId: "a" }).available()).toBe(false);
  });

  it("rejects a late receipt even when fetch ignores AbortSignal", async () => {
    const transport = new AuthenticatedAgentDeploymentTransport({ endpoint: "https://agent.test", trustKey: "transport_test_key_123", agentId: "a", timeoutMs: 5, fetch: async () => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response("{}")), 25)) });
    await expect(transport.dispatch(snapshot, "cmd-timeout")).rejects.toBeInstanceOf(TransportTimeoutError);
  });

  it("cancels promptly when fetch ignores AbortSignal and rejects late success", async () => {
    const controller = new AbortController(); const transport = new AuthenticatedAgentDeploymentTransport({ endpoint: "https://agent.test", trustKey: "transport_test_key_123", agentId: "a", timeoutMs: 100, fetch: async () => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response("{}")), 25)) });
    const pending = transport.dispatch(snapshot, "cmd-cancel", { agentId: "a", requestId: "r", correlationId: "c", signal: controller.signal }); controller.abort(); await expect(pending).rejects.toBeInstanceOf(TransportCanceledError);
  });

  it("accepts a valid response that arrives before the deadline", async () => {
     const transport = new AuthenticatedAgentDeploymentTransport({ endpoint: "https://agent.test", trustKey: "transport_test_key_123", agentId: "a", timeoutMs: 100, fetch: async () => new Response(JSON.stringify({ schemaVersion: 1, commandId: "cmd-near", deploymentId: snapshot.deploymentId, terminalStatus: "succeeded", health: "passed", redacted: true, correlationId: "cmd-near", receipt }), { status: 200 }) });
    await expect(transport.dispatch(snapshot, "cmd-near")).resolves.toMatchObject({ terminalStatus: "succeeded" });
  });

  it("rejects an empty inner receipt", async () => {
    const transport = new AuthenticatedAgentDeploymentTransport({ endpoint: "https://agent.test", trustKey: "transport_test_key_123", agentId: "a", fetch: async () => new Response(JSON.stringify({ schemaVersion: 1, commandId: "cmd-empty", deploymentId: snapshot.deploymentId, terminalStatus: "succeeded", health: "passed", redacted: true, receipt: {} }), { status: 200 }) });
    await expect(transport.dispatch(snapshot, "cmd-empty")).rejects.toThrow();
  });

  it("rejects an oversized deployment identity before persistence", async () => {
    const transport = new AuthenticatedAgentDeploymentTransport({ endpoint: "https://agent.test", trustKey: "transport_test_key_123", agentId: "a", fetch: async () => new Response(JSON.stringify({ schemaVersion: 1, commandId: "cmd-large", deploymentId: snapshot.deploymentId, terminalStatus: "succeeded", health: "passed", redacted: true, receipt: { ...receipt, deploymentId: "x".repeat(100_000) } }), { status: 200 }) });
    await expect(transport.dispatch(snapshot, "cmd-large")).rejects.toThrow();
  });

  it("rejects a caller-selected agent that differs from configured identity", async () => {
    let called = false; const transport = new AuthenticatedAgentDeploymentTransport({ endpoint: "https://agent.test", trustKey: "transport_test_key_123", agentId: "configured-agent", fetch: async () => { called = true; return new Response(); } });
    await expect(transport.dispatch(snapshot, "cmd-agent", { agentId: "other-agent", requestId: "r", correlationId: "c" })).rejects.toThrow("identity mismatch"); expect(called).toBe(false);
  });
  it("sends a closed stop capability and validates its correlated receipt", async () => {
    let request: RequestInit | undefined; const transport = new AuthenticatedAgentDeploymentTransport({ endpoint: "https://agent.test", trustKey: "transport_test_key_123", agentId: "agent-1", now: () => 1000, fetch: async (_url, init) => { request = init; return new Response(JSON.stringify({ schemaVersion: 1, action: "deployment.stop", agentId: "agent-1", commandId: "stop-1", projectId: "project-1", deploymentId: "dep-1", candidateId: "dep-1:candidate:cmd-1", effectiveImage: `registry.example.com/team/app@${digest}`, status: "stopped", redacted: true, correlationId: "corr-stop", reason: null })); } });
    const result = await transport.dispatchStop({ projectId: "project-1", deploymentId: "dep-1", candidateId: "dep-1:candidate:cmd-1", effectiveImage: `registry.example.com/team/app@${digest}`, commandId: "stop-1" }, { agentId: "agent-1", requestId: "req-stop", correlationId: "corr-stop" }); const body = JSON.parse(String(request?.body)); expect(result.status).toBe("stopped"); expect(body.requiredCapabilities).toEqual(["deployment.stop"]); expect(body.action).toBe("deployment.stop");
  });
  it("times out and cancels stop transport even when fetch ignores AbortSignal", async () => {
    const input = { projectId: "project-1", deploymentId: "dep-1", candidateId: "dep-1:candidate:cmd-1", effectiveImage: `registry.example.com/team/app@${digest}`, commandId: "stop-timeout" }; const transport = new AuthenticatedAgentDeploymentTransport({ endpoint: "https://agent.test", trustKey: "transport_test_key_123", agentId: "agent-1", timeoutMs: 5, fetch: async () => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response("{}")), 25)) }); await expect(transport.dispatchStop(input, { agentId: "agent-1", requestId: "req", correlationId: "corr" })).rejects.toBeInstanceOf(TransportTimeoutError);
    const controller = new AbortController(); const pending = transport.dispatchStop({ ...input, commandId: "stop-cancel" }, { agentId: "agent-1", requestId: "req", correlationId: "corr", signal: controller.signal }); controller.abort(); await expect(pending).rejects.toBeInstanceOf(TransportCanceledError);
  });
});
