import { describe, expect, it, vi } from "vitest";
import { signAgentTransport, verifyAgentTransport } from "@deploylite/config";
import {
  agentCapabilityHandshakeSchema,
  composePreviewSchema,
  COMPOSE_RESOURCE_INSPECTION_CAPABILITY,
  COMPOSE_RESOURCE_INSPECTION_PATH,
  type ComposeResourceObservationV1
} from "@deploylite/contracts";
import { AuthenticatedAgentComposeResourceInspectionTransport } from "./compose-resource-inspection-transport.js";

const trustKey = "inspection_transport_test_key_123";
const image = `registry.example.com/app@sha256:${"a".repeat(64)}`;
const preview = composePreviewSchema.parse({ schemaVersion: 1, projectId: "project-inspection", status: "preview", executionAllowed: false,
  policyVersion: "inspection-transport-test-1", configDigest: "a".repeat(64), canonicalDocument: "{\"services\":{}}",
  services: [{ name: "app", image, networks: ["app"], volumes: [], secretRefs: [] }],
  networks: [{ key: "app", projectId: "project-inspection", runtimeName: `dl-${"b".repeat(32)}-net-app`, attachedServices: ["app"], driver: "bridge", internal: false }], volumes: [] });

function observation(): ComposeResourceObservationV1 {
  const value: ComposeResourceObservationV1 = {
    schemaVersion: 1, owner: "deploylite", agentId: "agent-inspection", projectId: preview.projectId,
    kind: "network", key: "app", runtimeName: preview.networks[0]!.runtimeName,
    physicalIdentity: "b".repeat(64), configDigest: preview.configDigest, observedAt: 100,
    stateDigest: "c".repeat(64), containers: []
  };
  return value;
}

function response(status: number, payload: unknown, headers: Record<string, string> = {}) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => JSON.parse(text),
    text: async () => text
  } as unknown as Response;
}

function makeTransport({ capability = true, validResponseSignature = true }: { capability?: boolean; validResponseSignature?: boolean } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const target = String(url); calls.push({ url: target, init });
    if (target.endsWith("/capabilities")) {
      const signature = new Headers(init?.headers).get("x-deploylite-signature")!;
      const handshake = agentCapabilityHandshakeSchema.parse({ schemaVersion: 1, agentId: "agent-inspection",
        capabilities: capability ? [COMPOSE_RESOURCE_INSPECTION_CAPABILITY] : [], protocolVersions: [1] });
      return response(200, handshake, { "x-deploylite-request-signature": signature });
    }
    const bodyText = String(init?.body);
    const request = JSON.parse(bodyText);
    const requestSignature = new Headers(init?.headers).get("x-deploylite-signature");
    expect(verifyAgentTransport(`POST ${COMPOSE_RESOURCE_INSPECTION_PATH}\n${bodyText}`, requestSignature ?? undefined, trustKey)).toBe(true);
    const result = { schemaVersion: 1, action: "compose.resource.inspect", agentId: "agent-inspection", projectId: request.projectId,
      configDigest: request.expectedConfigDigest, kind: request.kind, key: request.key, context: request.context, observation: observation() };
    const responseText = JSON.stringify(result);
    const responseSignature = signAgentTransport(`POST ${COMPOSE_RESOURCE_INSPECTION_PATH}\n${bodyText}\n${responseText}`, trustKey);
    return response(200, responseText, { "x-deploylite-response-signature": validResponseSignature ? responseSignature : "invalid" });
  });
  const transport = new AuthenticatedAgentComposeResourceInspectionTransport({ endpoint: "https://agent.example.test", trustKey,
    agentId: "agent-inspection", fetch: fetch as typeof globalThis.fetch, timeoutMs: 2_000 });
  return { calls, fetch, transport };
}

describe("authenticated negotiated agent resource inspection transport", () => {
  it("negotiates the capability and returns only a scope-bound observation", async () => {
    const f = makeTransport();
    const result = await f.transport.inspect({ preview, kind: "network", key: "app" }, undefined,
      { requestId: "request-inspection", correlationId: "correlation-inspection" });
    expect(result).toEqual(observation());
    expect(f.calls.map(call => call.url)).toEqual(["https://agent.example.test/capabilities", `https://agent.example.test${COMPOSE_RESOURCE_INSPECTION_PATH}`]);
    const request = JSON.parse(String(f.calls[1]!.init?.body));
    expect(request).toMatchObject({ action: "compose.resource.inspect", requiredCapabilities: [COMPOSE_RESOURCE_INSPECTION_CAPABILITY],
      context: { requestId: "request-inspection", correlationId: "correlation-inspection" }, projectId: preview.projectId, expectedConfigDigest: preview.configDigest });
    expect(f.calls[1]!.init?.method).toBe("POST");
  });

  it("fails closed before POST when the negotiated capability is absent", async () => {
    const f = makeTransport({ capability: false });
    await expect(f.transport.inspect({ preview, kind: "network", key: "app" })).rejects.toThrow("capability_unavailable");
    expect(f.calls).toHaveLength(1);
  });

  it("rejects an unauthenticated agent observation response", async () => {
    const f = makeTransport({ validResponseSignature: false });
    await expect(f.transport.inspect({ preview, kind: "network", key: "app" })).rejects.toThrow("agent inspection response authentication failed");
  });

  it("keeps the transport read-only and rejects insecure public endpoints", async () => {
    const f = makeTransport();
    const insecure = new AuthenticatedAgentComposeResourceInspectionTransport({ endpoint: "http://agent.example.test", trustKey,
      agentId: "agent-inspection", fetch: f.fetch as typeof globalThis.fetch, allowInsecureInternal: true });
    expect(insecure.available()).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
});
