import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import { agentExecutionReceiptSchema, createDeploymentSnapshot, createSourceIntent, dockerImageExecutionReceiptSchema, TransportCanceledError, TransportTimeoutError } from "@deploylite/contracts";
import { isAgentPreDispatchRejection, AuthenticatedAgentDeploymentTransport } from "./agent-transport.js";

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
  it("proves dispatcher-to-Docker argv-to-API receipt evidence with a fake process runner", async () => {
    const { DigestDeploymentDispatcher } = await import(new URL("../../agent/src/deployment-dispatcher.ts", import.meta.url).href);
    const { DockerCliImageTransport } = await import(new URL("../../agent/src/infrastructure/docker/docker-cli-image-transport.ts", import.meta.url).href);
    const { AuthenticatedAgentCommandReceiver } = await import(new URL("../../agent/src/agent-transport.ts", import.meta.url).href);
    const { InMemoryProtocolTransport } = await import("@deploylite/domain");
    const executionId = "dep_execution";
    const projectId = "project_e2e";
    const configured = { hostPort: 45123, containerPort: 4567, networkName: "runtime-net" } as const;
    const image = `registry.example.com/team/app@${digest}`;
    const e2eSnapshot = createDeploymentSnapshot({
      deploymentId: "dep_source",
      projectId,
      source: createSourceIntent({ sourceMode: "image", requestedReference: image }, { policyVersion: "p1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true }),
      configRevision: "c1",
      runtimeRevision: "r1",
      runtimePort: configured.containerPort,
      secretRefs: [],
      policyVersion: "p1",
      schemaVersion: 1
    }, { sha256: (bytes) => createHash("sha256").update(bytes).digest("hex") });
    const calls: string[][] = [];
    const actualContainerId = "c".repeat(64);
    const actualImageId = `sha256:${"b".repeat(64)}`;
    const actualBindings = { [`${configured.containerPort}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: String(configured.hostPort) }] };
    const runner = {
      run: async (argv: readonly string[]) => {
        calls.push([...argv]);
        const format = argv[3] ?? "";
        const stdout = argv[1] === "container" && argv[2] === "inspect"
          ? JSON.stringify({ id: actualContainerId, name: `/${"deploylite-active-" + executionId}`, imageId: actualImageId,
              owner: "agent-1", projectId, deploymentId: executionId, candidateId: `${executionId}:candidate:cmd-e2e`, effectiveImage: image,
              running: true, health: "healthy", hostBindings: actualBindings, portBindings: actualBindings,
              networkMode: configured.networkName, networks: { [configured.networkName]: { networkId: "d".repeat(64), endpointId: "e".repeat(64) } } })
          : argv[1] === "image" && argv[2] === "inspect" ? JSON.stringify(actualImageId)
          : format.includes("State.Health")
          ? "healthy"
          : format.includes("com.deploylite.owner")
            ? `agent-1|${executionId}|${executionId}:candidate:cmd-e2e|${image}`
            : "";
        return { exitCode: 0, signal: null, stdout, stderr: "" };
      }
    };
    const protocol = new InMemoryProtocolTransport({
      clock: { now: () => 1 },
      leasePolicy: { ttlMs: 30_000 },
      retryPolicy: { maxAttempts: 1, deadlineMs: 0, backoffMs: () => 0 },
      capabilities: ["deploy.execute"]
    });
    const dockerTransport = new DockerCliImageTransport({ runner, owner: "agent-1", ...configured, allowedNetworks: [configured.networkName] });
    const dispatcher = new DigestDeploymentDispatcher({ protocol, transport: dockerTransport, trustedHosts: ["registry.example.com"], allowedNetworks: [configured.networkName], ...configured });
    const replayStore = {
      durable: true,
      claim: async () => ({ claimed: true, claimToken: "claim" }),
      wait: async () => ({}),
      complete: async () => {},
      release: async () => {}
    };
    let wireReceipt: unknown;
    const receiver = new AuthenticatedAgentCommandReceiver({
      agentId: "agent-1",
      trustKey: "transport_test_key_123",
      capabilities: ["deploy.execute"],
      dispatcher,
      replayStore: replayStore as never,
      now: () => 1
    });
    const apiTransport = new AuthenticatedAgentDeploymentTransport({
      endpoint: "https://agent.test",
      trustKey: "transport_test_key_123",
      agentId: "agent-1",
      fetch: async (url, init) => {
        const signature = String((init?.headers as Record<string, string>)["x-deploylite-signature"]);
        if (String(url).endsWith("/capabilities")) {
          return new Response(JSON.stringify({ schemaVersion: 1, agentId: "agent-1", capabilities: ["deploy.execute"], protocolVersions: [1, 2] }), { headers: { "x-deploylite-request-signature": signature } });
        }
        const response = await receiver.receive(JSON.parse(String(init?.body)), signature);
        wireReceipt = response;
        return new Response(JSON.stringify(response), { status: 200 });
      }
    });
    const result = await apiTransport.dispatch(e2eSnapshot, "cmd-e2e", {
      agentId: "agent-1",
      requestId: "request-e2e",
      correlationId: "correlation-e2e",
      executionDeploymentId: executionId
    });
    const wire = agentExecutionReceiptSchema.parse(wireReceipt);
    const parsedReceipt = dockerImageExecutionReceiptSchema.parse(wire.receipt);
    expect(parsedReceipt).toMatchObject({ deploymentId: executionId, effectiveImage: image, health: "passed", terminalStatus: "succeeded", proven: true, runtimeConfig: configured });
    expect(result).toMatchObject({ projectId, sourceDeploymentId: e2eSnapshot.deploymentId, snapshotHash: e2eSnapshot.hash, correlationId: "correlation-e2e", runtimeConfig: configured });
    expect(calls.filter((argv) => argv[1] === "container" || argv[1] === "image").map((argv) => [argv.slice(0, 3), argv.at(-1)])).toEqual([
      [["docker", "container", "inspect"], `deploylite-active-${executionId}`],
      [["docker", "image", "inspect"], image]
    ]);
    expect(parsedReceipt.executionReceipt).toMatchObject({ deploymentId: executionId, projectId, snapshotOriginId: e2eSnapshot.deploymentId, snapshotHash: e2eSnapshot.hash, runtimeHost: "agent-1", container: `deploylite-active-${executionId}`, containerId: actualContainerId, effectiveImageDigest: digest, hostPort: configured.hostPort, containerPort: configured.containerPort, network: configured.networkName });
    expect(result.executionReceipt).toEqual(parsedReceipt.executionReceipt);
    expect(calls.find((argv) => argv[1] === "run")).toEqual([
      "docker", "run", "--detach", "--name", "deploylite-candidate-dep_execution-cmd-e2e",
      "--label", "com.deploylite.owner=agent-1", "--label", `com.deploylite.project=${projectId}`,
      "--label", `com.deploylite.deployment=${executionId}`, "--label", `com.deploylite.candidate=${executionId}:candidate:cmd-e2e`,
      "--label", `com.deploylite.image=${image}`, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--restart=no",
      "--tmpfs", "/tmp:rw,noexec,nosuid,nodev", "--tmpfs", "/var/cache/nginx:rw,noexec,nosuid,nodev", "--tmpfs", "/var/run:rw,noexec,nosuid,nodev",
      "--network", configured.networkName, "--publish", `127.0.0.1:${configured.hostPort}:${configured.containerPort}`, image
    ]);
  });
  it("runs v2 in process through receiver, dispatcher, and executor with distinct identities", async () => { const { AuthenticatedAgentCommandReceiver, DigestDeploymentDispatcher } = await import("@deploylite/agent"); const { FakeDockerImageTransport, InMemoryProtocolTransport } = await import("@deploylite/domain"); const replay = new Map<string, any>(); const replayStore = { claim: async (id: string) => replay.has(id) ? { claimed: false, receipt: replay.get(id).receipt } : { claimed: true, claimToken: "claim" }, wait: async (id: string) => replay.get(id).receipt, complete: async (id: string, value: any) => { replay.set(id, value); }, release: async () => {} }; const dispatcher = new DigestDeploymentDispatcher({ protocol: new InMemoryProtocolTransport({ clock: { now: () => 1 }, leasePolicy: { ttlMs: 100 }, retryPolicy: { maxAttempts: 1, deadlineMs: 0, backoffMs: () => 0 }, capabilities: ["deploy.execute"] }), transport: new FakeDockerImageTransport(), trustedHosts: ["registry.example.com"] }); const receiver = new AuthenticatedAgentCommandReceiver({ agentId: "agent-1", trustKey: "transport_test_key_123", capabilities: ["deploy.execute"], dispatcher, replayStore: replayStore as never, now: () => 1 }); const transport = new AuthenticatedAgentDeploymentTransport({ endpoint: "https://agent.test", trustKey: "transport_test_key_123", agentId: "agent-1", fetch: async (url, init) => { if (String(url).endsWith("/capabilities")) return new Response(JSON.stringify({ schemaVersion: 1, agentId: "agent-1", capabilities: ["deploy.execute"], protocolVersions: [1, 2] }), { headers: { "x-deploylite-request-signature": String((init?.headers as Record<string, string>)["x-deploylite-signature"]) } }); const body = JSON.parse(String(init?.body)); return new Response(JSON.stringify(await receiver.receive(body, String((init?.headers as Record<string, string>)["x-deploylite-signature"])))); } }); const result = await transport.dispatch(snapshot, "cmd-e2e", { agentId: "agent-1", requestId: "req-e2e", correlationId: "corr-e2e", executionDeploymentId: "dep-execution" }); expect(result).toMatchObject({ deploymentId: "dep-execution", sourceDeploymentId: snapshot.deploymentId, correlationId: "corr-e2e", terminalStatus: "succeeded" }); });
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


describe("repeated lineage transport", () => {
  it("signs immediate B separately from canonical A and validates the echoed source", async () => {
    let body: any;
    const transport = new AuthenticatedAgentDeploymentTransport({ endpoint: "https://agent.test", agentId: "agent-1", trustKey: "transport_test_key_123", now: () => 1, fetch: async (url, init) => {
      if (String(url).endsWith("/capabilities")) return new Response(JSON.stringify({ schemaVersion: 1, agentId: "agent-1", capabilities: ["deploy.execute"], protocolVersions: [1, 2] }), { headers: { "x-deploylite-request-signature": String((init?.headers as Record<string, string>)["x-deploylite-signature"]) } });
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ schemaVersion: 2, commandId: "cmd-C", deploymentId: "execution-C", sourceDeploymentId: "execution-B", snapshotHash: snapshot.hash, terminalStatus: "succeeded", health: "passed", redacted: true, correlationId: "corr-C", receipt: { ...receipt, deploymentId: "execution-C" } }));
    } });
    let result: any; let failure: unknown;
    try { result = await transport.dispatch(snapshot, "cmd-C", { agentId: "agent-1", requestId: "req-C", correlationId: "corr-C", executionDeploymentId: "execution-C", sourceDeploymentId: "execution-B" }); } catch (error) { failure = error; }
    expect(body).toMatchObject({ sourceDeploymentId: "execution-B", deploymentId: "execution-C", snapshot: { deploymentId: snapshot.deploymentId }, snapshotHash: snapshot.hash });
    expect(failure).toBeUndefined(); expect(result).toMatchObject({ sourceDeploymentId: "execution-B", deploymentId: "execution-C" });
  });
});


function coordinatedAuthority(action: "deployment.redeploy" | "deployment.stop", executionId: string) {
  const lease = (deploymentId: string, kind: string) => ({ deploymentId, leaseId: `control:${kind}:2`, fence: 2, expiresAt: 200_000 });
  return { projectId: snapshot.projectId, commandId: "control", action, projectLease: lease(snapshot.projectId, "project"), executionLease: lease(executionId, "execution"), ...(action === "deployment.redeploy" ? { sourceLease: lease(snapshot.deploymentId, "source") } : {}) };
}
function replacement() {
  return { effectiveImage: receipt.effectiveImage, policy: { maxOutageMs: 30_000, maxRecoveryMs: 60_000 }, prior: { schemaVersion: 1 as const, projectId: snapshot.projectId, deploymentId: snapshot.deploymentId, candidateId: `${snapshot.deploymentId}:candidate:prior`, snapshotOriginId: snapshot.deploymentId, snapshotHash: snapshot.hash, effectiveImageDigest: digest, runtimeHost: "agent-1", container: "active-prior", containerId: "physical-prior", hostPort: 43000, containerPort: 3000, network: null } };
}
describe("signed coordinated authority forwarding", () => {
  it("uses allocated execution lease and retains replacement policy/observed prior in the signed v2 body", async () => {
    const context = { agentId: "agent-1", requestId: "req", correlationId: "corr", executionDeploymentId: "B", sourceDeploymentId: snapshot.deploymentId, authority: coordinatedAuthority("deployment.redeploy", "B"), replacement: replacement() };
    let body: Record<string, unknown> = {};
    const transport = new AuthenticatedAgentDeploymentTransport({ endpoint: "https://agent.test", trustKey: "transport_test_key_123", agentId: "agent-1", now: () => 1, fetch: async (url, init) => {
      if (String(url).endsWith("/capabilities")) return new Response(JSON.stringify({ schemaVersion: 1, agentId: "agent-1", capabilities: ["deploy.execute"], protocolVersions: [1, 2] }), { headers: { "x-deploylite-request-signature": String((init?.headers as Record<string, string>)["x-deploylite-signature"]) } });
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ schemaVersion: 2, commandId: "deploy_B", deploymentId: "B", sourceDeploymentId: snapshot.deploymentId, snapshotHash: snapshot.hash, terminalStatus: "succeeded", health: "passed", redacted: true, correlationId: "corr", receipt: { ...receipt, deploymentId: "B" } }));
    } });
    await transport.dispatch(snapshot, "deploy_B", context);
    expect(body).toMatchObject({ authority: context.authority, replacement: context.replacement, lease: context.authority.executionLease });
  });
  it("uses the same coordinated authority contract for stop instead of a new fixed fence", async () => {
    const input = { projectId: snapshot.projectId, deploymentId: snapshot.deploymentId, candidateId: `${snapshot.deploymentId}:candidate:prior`, effectiveImage: receipt.effectiveImage, commandId: "control" };
    const context = { agentId: "agent-1", requestId: "req", correlationId: "corr", authority: coordinatedAuthority("deployment.stop", snapshot.deploymentId) };
    let body: Record<string, unknown> = {};
    const transport = new AuthenticatedAgentDeploymentTransport({ endpoint: "https://agent.test", trustKey: "transport_test_key_123", agentId: "agent-1", now: () => 1, fetch: async (_url, init) => { body = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ ...input, schemaVersion: 1, action: "deployment.stop", agentId: "agent-1", status: "stopped", redacted: true, correlationId: "corr", reason: null })); } });
    await transport.dispatchStop(input, context);
    expect(body).toMatchObject({ authority: context.authority, lease: context.authority.executionLease });
  });
});


it("captures replacement/authority bindings before capability transport awaits", async () => {
  const context = { agentId: "agent-1", requestId: "req", correlationId: "corr", executionDeploymentId: "B", sourceDeploymentId: snapshot.deploymentId, authority: coordinatedAuthority("deployment.redeploy", "B"), replacement: replacement() };
  const original = structuredClone(context); let body: Record<string, unknown> = {};
  const transport = new AuthenticatedAgentDeploymentTransport({ endpoint: "https://agent.test", trustKey: "transport_test_key_123", agentId: "agent-1", now: () => 1, fetch: async (url, init) => {
    if (String(url).endsWith("/capabilities")) {
      context.authority.projectLease.leaseId = "mutated-owner"; context.replacement.policy.maxRecoveryMs = 1; context.replacement.prior.containerId = "mutated-physical-id";
      return new Response(JSON.stringify({ schemaVersion: 1, agentId: "agent-1", capabilities: ["deploy.execute"], protocolVersions: [1, 2] }), { headers: { "x-deploylite-request-signature": String((init?.headers as Record<string, string>)["x-deploylite-signature"]) } });
    }
    body = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ schemaVersion: 2, commandId: "deploy_B", deploymentId: "B", sourceDeploymentId: snapshot.deploymentId, snapshotHash: snapshot.hash, terminalStatus: "succeeded", health: "passed", redacted: true, correlationId: "corr", receipt: { ...receipt, deploymentId: "B" } }));
  } });
  await transport.dispatch(snapshot, "deploy_B", context);
  expect(body).toMatchObject({ authority: original.authority, replacement: original.replacement });
});


it.each([80_000, 110_000])("keeps the full preparation/cutover/recovery response window separate from execution timeout for %s ms", async (elapsed) => {
  vi.useFakeTimers();
  try {
    const prior = replacement(); prior.policy = { maxOutageMs: 30_000, maxRecoveryMs: 60_000 };
    let signedTimeout = 0;
    const transport = new AuthenticatedAgentDeploymentTransport({ endpoint: "https://agent.test", trustKey: "transport_test_key_123", agentId: "agent-1", timeoutMs: 30_000, now: () => 1, fetch: async (url, init) => {
      if (String(url).endsWith("/capabilities")) return new Response(JSON.stringify({ schemaVersion: 1, agentId: "agent-1", capabilities: ["deploy.execute"], protocolVersions: [1, 2] }), { headers: { "x-deploylite-request-signature": String((init?.headers as Record<string, string>)["x-deploylite-signature"]) } });
      signedTimeout = JSON.parse(String(init?.body)).timeoutMs;
      await new Promise((resolve) => setTimeout(resolve, elapsed));
      return new Response(JSON.stringify({ schemaVersion: 2, commandId: "deploy_B", deploymentId: "B", sourceDeploymentId: snapshot.deploymentId, snapshotHash: snapshot.hash, terminalStatus: "failed", health: "failed", redacted: true, correlationId: "corr", receipt: { ...receipt, deploymentId: "B", terminalStatus: "failed", health: "failed", proven: false, rollback: { target: prior.effectiveImage, result: "restored" } } }));
    } });
    const pending = transport.dispatch(snapshot, "deploy_B", { agentId: "agent-1", requestId: "req", correlationId: "corr", executionDeploymentId: "B", authority: coordinatedAuthority("deployment.redeploy", "B"), replacement: prior }).then((value) => value.terminalStatus, () => "transport-timeout");
    await vi.advanceTimersByTimeAsync(elapsed); expect(await pending).toBe("failed"); expect(signedTimeout).toBe(30_000);
  } finally { vi.useRealTimers(); }
});


afterEach(() => vi.useRealTimers());
describe("whole transport operation response budget", () => {
  it.each(["handshake-fetch", "handshake-body", "execute-body", "stop-body"])("settles hanging %s at its deadline and never sends execute after late admission", async (stage) => {
    vi.useFakeTimers(); let resume!: (value: any) => void; const barrier = new Promise<any>((resolve) => { resume = resolve; }); const urls: string[] = [];
    const transport = new AuthenticatedAgentDeploymentTransport({ endpoint: "https://agent.test", trustKey: "transport_test_key_123", agentId: "agent-1", timeoutMs: 5, fetch: async (url, init) => {
      urls.push(String(url)); const handshake = String(url).endsWith("/capabilities");
      if (handshake && stage === "handshake-fetch") return barrier;
      const response = new Response(JSON.stringify(handshake ? { schemaVersion: 1, agentId: "agent-1", capabilities: ["deploy.execute"], protocolVersions: [1, 2] } : {}), { headers: handshake ? { "x-deploylite-request-signature": String((init?.headers as Record<string, string>)["x-deploylite-signature"]) } : undefined });
      if ((handshake && stage === "handshake-body") || (!handshake && ["execute-body", "stop-body"].includes(stage))) vi.spyOn(response, "json").mockImplementation(async () => barrier);
      return response;
    } });
    const context = { agentId: "agent-1", requestId: "req", correlationId: "corr", executionDeploymentId: "dep_execution" }; let error: unknown;
    const pending = (stage === "stop-body" ? transport.dispatchStop({ projectId: "project-1", deploymentId: "dep-1", candidateId: "dep-1:candidate:cmd", effectiveImage: receipt.effectiveImage, commandId: "stop" }, context) : transport.dispatch(snapshot, "execute", context)).catch((value) => { error = value; });
    await vi.advanceTimersByTimeAsync(5);
    try { expect(error).toBeInstanceOf(TransportTimeoutError); }
    finally { resume(new Response("{}")); await vi.advanceTimersByTimeAsync(0); await pending; }
    if (stage.startsWith("handshake")) expect(urls).toHaveLength(1);
  });
  it.each(["handshake", "execute-body", "stop-body"])("settles canceled %s even when fetch/body ignores the signal", async (stage) => {
    vi.useFakeTimers(); const abort = new AbortController(); let resume!: (value: any) => void; const barrier = new Promise<any>((resolve) => { resume = resolve; }); const urls: string[] = [];
    const transport = new AuthenticatedAgentDeploymentTransport({ endpoint: "https://agent.test", trustKey: "transport_test_key_123", agentId: "agent-1", fetch: async (url, init) => {
      urls.push(String(url)); if (String(url).endsWith("/capabilities")) { if (stage === "handshake") return barrier; return new Response(JSON.stringify({ schemaVersion: 1, agentId: "agent-1", capabilities: ["deploy.execute"], protocolVersions: [1, 2] }), { headers: { "x-deploylite-request-signature": String((init?.headers as Record<string, string>)["x-deploylite-signature"]) } }); }
      const response = new Response("{}"); vi.spyOn(response, "json").mockImplementation(async () => barrier); return response;
    } });
    const context = { agentId: "agent-1", requestId: "req", correlationId: "corr", executionDeploymentId: "dep_execution", signal: abort.signal }; let error: unknown;
    const pending = (stage === "stop-body" ? transport.dispatchStop({ projectId: "project-1", deploymentId: "dep-1", candidateId: "dep-1:candidate:cmd", effectiveImage: receipt.effectiveImage, commandId: "stop" }, context) : transport.dispatch(snapshot, "execute", context)).catch((value) => { error = value; });
    await vi.advanceTimersByTimeAsync(0); abort.abort(); await vi.advanceTimersByTimeAsync(0);
    try { expect(error).toBeInstanceOf(TransportCanceledError); }
    finally { resume(new Response("{}")); await vi.advanceTimersByTimeAsync(0); await pending; }
    if (stage === "handshake") expect(urls).toHaveLength(1);
  });
});


it.each(["handshake", "terminal-body"])("enforces the same response deadline when %s exhausts it before the timer callback", async (stage) => {
  vi.useFakeTimers(); vi.setSystemTime(0); const calls: string[] = [];
  const transport = new AuthenticatedAgentDeploymentTransport({ endpoint: "https://agent.test", trustKey: "transport_test_key_123", agentId: "agent-1", timeoutMs: 5, fetch: async (url, init) => {
    calls.push(String(url)); const handshake = String(url).endsWith("/capabilities");
    const value = handshake ? { schemaVersion: 1, agentId: "agent-1", capabilities: ["deploy.execute"], protocolVersions: [1, 2] } : stage === "handshake" ? { schemaVersion: 2, commandId: "command", deploymentId: "B", sourceDeploymentId: snapshot.deploymentId, snapshotHash: snapshot.hash, correlationId: "corr", terminalStatus: "succeeded", health: "passed", redacted: true, receipt: { ...receipt, deploymentId: "B" } } : { schemaVersion: 1, commandId: "command", deploymentId: snapshot.deploymentId, terminalStatus: "succeeded", health: "passed", redacted: true, receipt };
    const response = new Response(JSON.stringify(value), { headers: handshake ? { "x-deploylite-request-signature": String((init?.headers as Record<string, string>)["x-deploylite-signature"]) } : undefined });
    vi.spyOn(response, "json").mockImplementation(async () => { vi.setSystemTime(5); return value; }); return response;
  } });
  let error: unknown; try { await transport.dispatch(snapshot, "command", stage === "handshake" ? { agentId: "agent-1", requestId: "req", correlationId: "corr", executionDeploymentId: "B" } : undefined); } catch (value) { error = value; }
  expect(error).toBeInstanceOf(TransportTimeoutError); expect(isAgentPreDispatchRejection(error)).toBe(stage === "handshake");
  expect(calls).toHaveLength(1);
});
