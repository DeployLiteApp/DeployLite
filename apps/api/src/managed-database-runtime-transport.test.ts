import { expect, it, vi } from "vitest";
import { openAgentSecretEnvelope, signAgentTransport } from "@deploylite/config";
import { claimProjectUpdateAuthority, composeRuntimeResourceName, createControlCommand, managedDatabaseRuntimeExecutionBinding } from "@deploylite/domain";
import { AuthenticatedManagedDatabaseRuntimeTransport } from "./managed-database-runtime-transport.js";
import { isAgentPreDispatchRejection } from "./agent-transport.js";
function fixture() {
  const input = { schemaVersion: 1 as const, projectId: "project-a", databaseId: "orders", engine: "postgres" as const,
    profileId: "profile-a", planDigest: "a".repeat(64), environmentFingerprint: "b".repeat(32) };
  const command = { ...createControlCommand({ actorId: "actor-a", action: "project.update", scope: { kind: "project" as const, projectId: input.projectId },
    input: managedDatabaseRuntimeExecutionBinding(input), idempotencyKey: "key-a", correlationId: "correlation-a", expiresAt: new Date(Date.now() + 30000) }), status: "eligible" as const };
  const authority = claimProjectUpdateAuthority([command], command)!;
  const prepared = { command, input, agentId: "agent-a" };
  const context = { requestId: "request-a", correlationId: command.correlationId };
  const environment = { POSTGRES_PASSWORD: "private-plaintext-credential" };
  const receipt = { schemaVersion: 1, projectId: input.projectId, databaseId: input.databaseId, engine: input.engine, action: "database.runtime",
    agentId: prepared.agentId, commandId: command.id, inputDigest: command.inputDigest, planDigest: input.planDigest,
    environmentFingerprint: input.environmentFingerprint, correlationId: command.correlationId, containerId: "c".repeat(64), imageId: "sha256:" + "d".repeat(64),
    volumeName: composeRuntimeResourceName(input.projectId, "volume", "db-" + input.databaseId), networkName: composeRuntimeResourceName(input.projectId, "network", "db-" + input.databaseId),
    observedAt: Date.now(), status: "ready", health: "passed", storage: "verified", idempotent: false, redacted: true };
  const trustKey = "native-transport-key-" + "x".repeat(64);
  const fetchResponse: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/capabilities")) return new Response(JSON.stringify({ schemaVersion: 1, agentId: "agent-a", capabilities: ["database.runtime.v1"], protocolVersions: [1, 2] }),
      { headers: { "x-deploylite-request-signature": String((init?.headers as Record<string, string>)["x-deploylite-signature"]) } });
    if (String(url).endsWith("/receipt")) return new Response(JSON.stringify({ schemaVersion: 1, action: "database.runtime", agentId: "agent-a", commandId: command.id, correlationId: command.correlationId, receipt }));
    return new Response(JSON.stringify(receipt));
  };
  const fetcher = vi.fn(fetchResponse);
  const options = { endpoint: "https://agent.test", trustKey, agentId: "agent-a", fetch: fetcher, timeoutMs: 1000 };
  const transport = new AuthenticatedManagedDatabaseRuntimeTransport(options);
  return { input, command, prepared, authority, context, environment, receipt, trustKey, fetcher, fetchResponse, options, transport };
}
it("signs native execution and seals plaintext with the existing exact command AAD", async () => {
  const f = fixture();
  expect(await f.transport.dispatch(f.prepared, f.authority, f.environment, f.context)).toEqual(f.receipt);
  const [url, init] = f.fetcher.mock.calls[1]!;
  expect(url).toBe("https://agent.test/databases/runtime");
  expect(init?.redirect).toBe("error");
  const body = JSON.parse(String(init?.body));
  expect((init?.headers as Record<string, string>)["x-deploylite-signature"]).toBe(signAgentTransport(String(init?.body), f.trustKey));
  expect(String(init?.body)).not.toContain(f.environment.POSTGRES_PASSWORD);
  expect(openAgentSecretEnvelope(body.sealedEnvironment, f.trustKey, { agentId: "agent-a", commandId: f.command.id, inputDigest: f.command.inputDigest, projectId: f.input.projectId })).toEqual(f.environment);
  expect(body).toMatchObject({ action: "database.runtime", operation: "database.runtime.apply", authority: f.authority, lease: f.authority.projectLease });
});
it("recovers only the original cache without transporting secrets or execution flags", async () => {
  const f = fixture();
  expect(await f.transport.readReceipt(f.prepared, f.authority, f.context)).toEqual(f.receipt);
  const [, init] = f.fetcher.mock.calls[1]!;
  const body = JSON.parse(String(init?.body));
  expect(body.sealedEnvironment).toBeUndefined(); expect(body.cancellationRequested).toBeUndefined();
  expect((init?.headers as Record<string, string>)["x-deploylite-signature"]).toBe(signAgentTransport("POST /databases/runtime/receipt\n" + init?.body, f.trustKey));
});
it("returns explicit cache absence without executing", async () => {
  const f = fixture(); f.fetcher.mockImplementationOnce(async (_url, init) => new Response(JSON.stringify({ schemaVersion: 1, agentId: "agent-a", capabilities: ["database.runtime.v1"], protocolVersions: [1] }),
    { headers: { "x-deploylite-request-signature": String((init?.headers as Record<string, string>)["x-deploylite-signature"]) } }));
  f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ schemaVersion: 1, action: "database.runtime", agentId: "agent-a", commandId: f.command.id, correlationId: f.command.correlationId, receipt: null })));
  expect(await f.transport.readReceipt(f.prepared, f.authority, f.context)).toBeNull();
  expect(f.fetcher.mock.calls.map(([url]) => String(url))).not.toContain("https://agent.test/databases/runtime");
});
it("rejects mismatched agent, preparation, authority or correlation before fetching", async () => {
  for (const field of ["agent", "digest", "authority", "correlation"] as const) {
    const f = fixture();
    const prepared = field === "agent" ? { ...f.prepared, agentId: "foreign" } : field === "digest" ? { ...f.prepared, input: { ...f.input, planDigest: "e".repeat(64) } } : f.prepared;
    const authority = field === "authority" ? { ...f.authority, commandId: "foreign" } : f.authority;
    const context = field === "correlation" ? { ...f.context, correlationId: "foreign" } : f.context;
    const error = await f.transport.dispatch(prepared, authority, f.environment, context).catch(error => error);
    expect(isAgentPreDispatchRejection(error)).toBe(true); expect(f.fetcher).not.toHaveBeenCalled();
  }
});
it("rejects a missing native handshake capability before POST", async () => {
  const f = fixture(); f.fetcher.mockImplementationOnce(async (_url, init) => new Response(JSON.stringify({ schemaVersion: 1, agentId: "agent-a", capabilities: [], protocolVersions: [1] }),
    { headers: { "x-deploylite-request-signature": String((init?.headers as Record<string, string>)["x-deploylite-signature"]) } }));
  const error = await f.transport.dispatch(f.prepared, f.authority, f.environment, f.context).catch(error => error);
  expect(isAgentPreDispatchRejection(error)).toBe(true); expect(f.fetcher).toHaveBeenCalledOnce();
});
it("rejects detached receipt binding and resource names after POST without claiming no effect", async () => {
  for (const patch of [{ databaseId: "foreign" }, { planDigest: "e".repeat(64) }, { environmentFingerprint: "e".repeat(32) },
    { volumeName: composeRuntimeResourceName("foreign", "volume", "db-orders") }, { networkName: composeRuntimeResourceName("foreign", "network", "db-orders") }]) {
    const f = fixture(); f.fetcher.mockImplementationOnce(f.fetchResponse).mockResolvedValueOnce(new Response(JSON.stringify({ ...f.receipt, ...patch })));
    const error = await f.transport.dispatch(f.prepared, f.authority, f.environment, f.context).catch(error => error);
    expect(error).toBeInstanceOf(Error); expect(f.fetcher).toHaveBeenCalledTimes(2); expect(isAgentPreDispatchRejection(error)).toBe(false);
  }
});
it("bounds fetch and response parsing including ports that ignore cancellation", async () => {
  for (const stage of ["fetch", "handshake-body", "receipt-body"] as const) {
    const f = fixture();
    if (stage === "fetch") f.fetcher.mockImplementation(() => new Promise<Response>(() => {}));
    else if (stage === "handshake-body") f.fetcher.mockImplementationOnce(async (_url, init) => ({ ok: true, headers: new Headers({ "x-deploylite-request-signature": String((init?.headers as Record<string, string>)["x-deploylite-signature"]) }), json: () => new Promise(() => {}) } as Response));
    else f.fetcher.mockImplementationOnce(f.fetchResponse).mockResolvedValueOnce({ ok: true, json: () => new Promise(() => {}) } as Response);
    const transport = new AuthenticatedManagedDatabaseRuntimeTransport({ ...f.options, timeoutMs: 10 });
    const error = await transport.dispatch(f.prepared, f.authority, f.environment, f.context).catch(error => error);
    expect(error).toBeInstanceOf(Error); expect(isAgentPreDispatchRejection(error)).toBe(stage !== "receipt-body");
  }
});
it("rejects insecure public endpoints, disguised private DNS names and invalid limits", () => {
  const f = fixture();
  for (const patch of [{ endpoint: "http://public.test" }, { endpoint: "http://10.attacker.test", allowInsecureInternal: true },
    { endpoint: "https://user:password@agent.test" }, { endpoint: "https://agent.test?token=secret" }, { timeoutMs: 0 }, { timeoutMs: 60001 }]) {
    expect(new AuthenticatedManagedDatabaseRuntimeTransport({ ...f.options, ...patch }).available()).toBe(false);
  }
  expect(new AuthenticatedManagedDatabaseRuntimeTransport({ ...f.options, endpoint: "http://127.0.0.1", allowInsecureInternal: true }).available()).toBe(true);
});
it("rejects prior cancellation without fetching", async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  await expect(f.transport.dispatch(f.prepared, f.authority, f.environment, { ...f.context, signal: controller.signal })).rejects.toThrow();
  expect(f.fetcher).not.toHaveBeenCalled();
});

it("rejects handshake identity, request binding or protocol mismatches before POST", async () => {
  for (const patch of [{ agentId: "foreign" }, { protocolVersions: [2] }, { echo: "foreign" }]) {
    const f = fixture();
    f.fetcher.mockImplementationOnce(async (_url, init) => new Response(JSON.stringify({ schemaVersion: 1, agentId: "agent-a", capabilities: ["database.runtime.v1"], protocolVersions: [1], ...patch }),
      { headers: { "x-deploylite-request-signature": "echo" in patch ? String(patch.echo) : String((init?.headers as Record<string, string>)["x-deploylite-signature"]) } }));
    const error = await f.transport.dispatch(f.prepared, f.authority, f.environment, f.context).catch(error => error);
    expect(isAgentPreDispatchRejection(error)).toBe(true); expect(f.fetcher).toHaveBeenCalledOnce();
  }
});
it("bounds stalled cache-body recovery and rejects foreign cached identity", async () => {
  const f = fixture(); f.fetcher.mockImplementationOnce(f.fetchResponse).mockResolvedValueOnce({ ok: true, json: () => new Promise(() => {}) } as Response);
  await expect(new AuthenticatedManagedDatabaseRuntimeTransport({ ...f.options, timeoutMs: 10 }).readReceipt(f.prepared, f.authority, f.context)).rejects.toThrow();
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  const foreign = fixture(); foreign.fetcher.mockImplementationOnce(foreign.fetchResponse).mockResolvedValueOnce(new Response(JSON.stringify({ schemaVersion: 1, action: "database.runtime", agentId: "foreign", commandId: foreign.command.id, correlationId: foreign.command.correlationId, receipt: null })));
  await expect(foreign.transport.readReceipt(foreign.prepared, foreign.authority, foreign.context)).rejects.toThrow();
});
