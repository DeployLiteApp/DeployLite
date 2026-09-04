import { describe, expect, it } from "vitest";
import { createDeploymentSnapshot, createSourceIntent, TransportCanceledError, TransportTimeoutError } from "@deploylite/contracts";
import { AuthenticatedAgentDeploymentTransport } from "./agent-transport.js";

const digest = `sha256:${"a".repeat(64)}`;
const snapshot = createDeploymentSnapshot({ deploymentId: "dep_transport", projectId: "project_transport", source: createSourceIntent({ sourceMode: "image", requestedReference: `registry.example.com/team/app@${digest}` }, { policyVersion: "p1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true }), configRevision: "c1", runtimeRevision: "r1", runtimePort: 3000, secretRefs: [], policyVersion: "p1", schemaVersion: 1 }, { sha256: () => "b".repeat(64) });
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
    const transport = new AuthenticatedAgentDeploymentTransport({ endpoint: "https://agent.test", trustKey: "transport_test_key_123", agentId: "a", timeoutMs: 100, fetch: async () => new Response(JSON.stringify({ schemaVersion: 1, commandId: "cmd-near", deploymentId: snapshot.deploymentId, terminalStatus: "succeeded", health: "passed", redacted: true, receipt }), { status: 200 }) });
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
