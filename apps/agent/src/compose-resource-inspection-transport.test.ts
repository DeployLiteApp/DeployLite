import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { signAgentTransport, verifyAgentTransport } from "@deploylite/config";
import {
  composeResourceInspectionAgentCommandSchema,
  composeResourceInspectionAgentResponseSchema,
  COMPOSE_RESOURCE_INSPECTION_CAPABILITY,
  COMPOSE_RESOURCE_INSPECTION_PATH,
  composePreviewSchema,
  protocolPayloadFingerprint,
  type ComposeResourceObservationV1
} from "@deploylite/contracts";
import { AuthenticatedAgentCommandReceiver } from "./agent-transport.js";

vi.mock("@deploylite/domain", async () => {
  const { createHash } = await import("node:crypto");
  const { protocolPayloadFingerprint } = await import("@deploylite/contracts");
  return {
    awaitAbortable: (operation: () => Promise<unknown>, signal?: AbortSignal) => new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const cancel = () => reject(signal?.reason);
      signal?.addEventListener("abort", cancel, { once: true });
      Promise.resolve().then(operation).then(resolve, reject).finally(() => signal?.removeEventListener("abort", cancel));
    }),
    composeVolumeBackupExecutionDigest: () => "",
    digestControlInput: () => "",
    validateDockerImageSnapshot: () => {},
    digestComposeResourceObservation: (value: ComposeResourceObservationV1) => {
      const { observedAt: _observedAt, stateDigest: _stateDigest, ...state } = value;
      return createHash("sha256").update(protocolPayloadFingerprint(state)).digest("hex");
    }
  };
});

const key = "inspection_transport_test_key_123";
const image = `registry.example.com/app@sha256:${"a".repeat(64)}`;
const preview = composePreviewSchema.parse({ schemaVersion: 1, projectId: "project-inspection", status: "preview", executionAllowed: false,
  policyVersion: "agent-inspection-test-1", configDigest: "a".repeat(64), canonicalDocument: "{\"services\":{}}",
  services: [{ name: "app", image, networks: ["app"], volumes: [], secretRefs: [] }],
  networks: [{ key: "app", projectId: "project-inspection", runtimeName: `dl-${"b".repeat(32)}-net-app`, attachedServices: ["app"], driver: "bridge", internal: false }], volumes: [] });

function observation(patch: Partial<ComposeResourceObservationV1> = {}): ComposeResourceObservationV1 {
  const value: ComposeResourceObservationV1 = { schemaVersion: 1, owner: "deploylite", agentId: "agent-inspection", projectId: preview.projectId,
    kind: "network", key: "app", runtimeName: preview.networks[0]!.runtimeName, physicalIdentity: "b".repeat(64),
    configDigest: preview.configDigest, observedAt: 100, stateDigest: "0".repeat(64), containers: [], ...patch };
  const { observedAt: _observedAt, stateDigest: _stateDigest, ...state } = value;
  value.stateDigest = createHash("sha256").update(protocolPayloadFingerprint(state)).digest("hex");
  return value;
}

function command() {
  return composeResourceInspectionAgentCommandSchema.parse({ schemaVersion: 1, action: "compose.resource.inspect", agentId: "agent-inspection",
    projectId: preview.projectId, preview, kind: "network", key: "app", expectedConfigDigest: preview.configDigest,
    requiredCapabilities: [COMPOSE_RESOURCE_INSPECTION_CAPABILITY], context: { requestId: "request-inspection", correlationId: "correlation-inspection" }, timeoutMs: 2_000 });
}

function receiver(inspect: ReturnType<typeof vi.fn>, capabilities = [COMPOSE_RESOURCE_INSPECTION_CAPABILITY]) {
  return new AuthenticatedAgentCommandReceiver({ agentId: "agent-inspection", trustKey: key, capabilities,
    dispatcher: { dispatch: vi.fn(async () => { throw new Error("read-only inspection cannot dispatch"); }) },
    replayStore: { claim: vi.fn(), wait: vi.fn(), complete: vi.fn(), release: vi.fn() } as never,
    resourceInspector: { inspect } as never, now: () => 100 });
}

describe("authenticated agent resource inspection receiver", () => {
  it("validates the signed request, scopes the observation and signs its response", async () => {
    const observed = observation();
    const inspect = vi.fn(async (_input, _signal, _context) => structuredClone(observed));
    const agent = receiver(inspect);
    const body = command();
    const payload = JSON.stringify(body);
    const signature = signAgentTransport(`POST ${COMPOSE_RESOURCE_INSPECTION_PATH}\n${payload}`, key);
    const result = composeResourceInspectionAgentResponseSchema.parse(await agent.inspectComposeResource(body, signature));
    expect(result).toMatchObject({ action: "compose.resource.inspect", agentId: "agent-inspection", projectId: preview.projectId,
      context: body.context, observation: observed });
    expect(inspect).toHaveBeenCalledWith({ preview, kind: "network", key: "app" }, expect.any(AbortSignal), body.context);
    const responseText = JSON.stringify(result);
    expect(verifyAgentTransport(`POST ${COMPOSE_RESOURCE_INSPECTION_PATH}\n${payload}\n${responseText}`,
      agent.signResponse(`POST ${COMPOSE_RESOURCE_INSPECTION_PATH}\n${payload}\n${responseText}`), key)).toBe(true);
  });

  it("rejects invalid HMAC, disabled capability and mismatched inspection scope before returning data", async () => {
    const inspect = vi.fn(async () => observation());
    const body = command(); const payload = JSON.stringify(body);
    const unauthorized = receiver(inspect);
    await expect(unauthorized.inspectComposeResource(body, "invalid")).rejects.toThrow("authentication");
    expect(inspect).not.toHaveBeenCalled();

    const disabled = receiver(inspect, []);
    await expect(disabled.inspectComposeResource(body, signAgentTransport(`POST ${COMPOSE_RESOURCE_INSPECTION_PATH}\n${payload}`, key))).rejects.toThrow("capability");
    expect(inspect).not.toHaveBeenCalled();

    const scoped = receiver(vi.fn(async () => observation({ projectId: "foreign" })));
    await expect(scoped.inspectComposeResource(body, signAgentTransport(`POST ${COMPOSE_RESOURCE_INSPECTION_PATH}\n${payload}`, key))).rejects.toThrow("scope");
  });

  it("does not claim replay state or invoke an execution dispatcher", async () => {
    const inspect = vi.fn(async () => observation()); const agent = receiver(inspect); const body = command(); const payload = JSON.stringify(body);
    await agent.inspectComposeResource(body, signAgentTransport(`POST ${COMPOSE_RESOURCE_INSPECTION_PATH}\n${payload}`, key));
    expect(inspect).toHaveBeenCalledOnce();
  });
});
