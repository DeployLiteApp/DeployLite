import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { signAgentTransport, verifyAgentTransport } from "@deploylite/config";
import { COMPOSE_NETWORK_ATTACHMENT_CAPABILITY, COMPOSE_NETWORK_ATTACHMENT_PATH, COMPOSE_NETWORK_ATTACHMENT_RECEIPT_PATH, composeResourceInspectionAgentCommandSchema, composeResourceInspectionAgentResponseSchema, COMPOSE_RESOURCE_INSPECTION_CAPABILITY, COMPOSE_RESOURCE_INSPECTION_PATH, composePreviewSchema, protocolPayloadFingerprint, type ComposeNetworkAttachmentReceiptV1 } from "@deploylite/contracts";
import { startAgentServer } from "./server.js";

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
    composeResourceAttachmentExecutionDigest: () => "",
    digestControlInput: () => "",
    validateDockerImageSnapshot: () => {},
    digestComposeResourceObservation: (value: any) => {
      const { observedAt: _observedAt, stateDigest: _stateDigest, ...state } = value;
      return createHash("sha256").update(protocolPayloadFingerprint(state)).digest("hex");
    }
  };
});

const serverHarness = vi.hoisted(() => ({ callback: undefined as ((request: any, response: any) => Promise<void>) | undefined }));
vi.mock("node:http", () => ({ createServer: (callback: typeof serverHarness.callback) => {
  serverHarness.callback = callback;
  return { once: () => {}, removeListener: () => {}, listen: (_port: number, _host: string, ready: () => void) => ready(), close: (ready: (error?: Error) => void) => ready() };
} }));

const trustKey = "transport_test_key_123";
const receipt: ComposeNetworkAttachmentReceiptV1 = { schemaVersion: 1, action: "compose.network.attachment", agentId: "agent-compose", commandId: "command-compose", projectId: "project-compose",
  inputDigest: "a".repeat(64), correlationId: "correlation-compose", key: "backend", runtimeName: `dl-${"b".repeat(32)}-net-backend`, service: "api", attachmentAction: "attach",
  containerId: "c".repeat(64), resourceId: "d".repeat(64), beforeStateDigest: "e".repeat(64), afterStateDigest: "f".repeat(64), observedAt: 100,
  status: "attached", reconciled: false, redacted: true, reason: null };
const cached = { schemaVersion: 1 as const, action: "compose.network.attachment" as const, agentId: receipt.agentId, commandId: receipt.commandId, correlationId: receipt.correlationId, receipt };

function request(url: string, body: unknown, signature: string) {
  const stream = Readable.from([JSON.stringify(body)]) as Readable & { method: string; url: string; headers: Record<string, string> };
  stream.method = "POST"; stream.url = url; stream.headers = { "x-deploylite-signature": signature };
  return stream;
}
function response() {
  return { destroyed: false, status: 0, body: "", headers: {} as Record<string, string>, writeHead(status: number, headers: Record<string, string> = {}) { this.status = status; this.headers = headers; return this; }, end(body = "") { this.body = body; } };
}

describe("simulated agent network attachment HTTP routes", () => {
  it("dispatches network commands and parses durable cached receipts without opening a listener", async () => {
    const receiver = { agentId: receipt.agentId, capabilities: [COMPOSE_NETWORK_ATTACHMENT_CAPABILITY], verifyRequest: vi.fn(() => true),
      receive: vi.fn(async () => receipt), readComposeNetworkAttachmentReceipt: vi.fn(async () => cached) };
    const server = await startAgentServer({ host: "127.0.0.1", port: 1, receiver: receiver as never, replayStore: { durable: true } as never });
    try {
      const body = { action: "compose.network.attachment", commandId: receipt.commandId };
      const executeResponse = response();
      await serverHarness.callback!(request(COMPOSE_NETWORK_ATTACHMENT_PATH, body, signAgentTransport(JSON.stringify(body), trustKey)), executeResponse);
      expect(executeResponse.status).toBe(200); expect(JSON.parse(executeResponse.body)).toEqual(receipt);
      expect(receiver.receive).toHaveBeenCalledOnce();

      const query = { action: "compose.network.attachment", commandId: receipt.commandId };
      const queryText = JSON.stringify(query), cachedResponse = response();
      await serverHarness.callback!(request(COMPOSE_NETWORK_ATTACHMENT_RECEIPT_PATH, query, signAgentTransport(`POST ${COMPOSE_NETWORK_ATTACHMENT_RECEIPT_PATH}\n${queryText}`, trustKey)), cachedResponse);
      expect(cachedResponse.status).toBe(200); expect(JSON.parse(cachedResponse.body)).toEqual(cached);
      expect(receiver.readComposeNetworkAttachmentReceipt).toHaveBeenCalledOnce();
    } finally { await server.close(); }
  });

  it("serves signed read-only resource observations on the negotiated inspection route", async () => {
    const image = `registry.example.com/app@sha256:${"a".repeat(64)}`;
    const preview = composePreviewSchema.parse({ schemaVersion: 1, projectId: "project-compose", status: "preview", executionAllowed: false,
      policyVersion: "agent-inspection-test-1", configDigest: "a".repeat(64), canonicalDocument: "{\"services\":{}}",
      services: [{ name: "app", image, networks: ["app"], volumes: [], secretRefs: [] }],
      networks: [{ key: "app", projectId: "project-compose", runtimeName: `dl-${"b".repeat(32)}-net-app`, attachedServices: ["app"], driver: "bridge", internal: false }], volumes: [] });
    const body = composeResourceInspectionAgentCommandSchema.parse({ schemaVersion: 1, action: "compose.resource.inspect", agentId: "agent-compose",
      projectId: preview.projectId, preview, kind: "network", key: "app", expectedConfigDigest: preview.configDigest,
      requiredCapabilities: [COMPOSE_RESOURCE_INSPECTION_CAPABILITY], context: { requestId: "request-compose", correlationId: "correlation-compose" }, timeoutMs: 2_000 });
    const observation = { schemaVersion: 1 as const, owner: "deploylite", agentId: "agent-compose", projectId: preview.projectId, kind: "network" as const,
      key: "app", runtimeName: preview.networks[0]!.runtimeName, physicalIdentity: "b".repeat(64), configDigest: preview.configDigest,
      observedAt: 100, stateDigest: "0".repeat(64), containers: [] };
    const { observedAt: _observedAt, stateDigest: _stateDigest, ...state } = observation;
    observation.stateDigest = createHash("sha256").update(protocolPayloadFingerprint(state)).digest("hex");
    const result = composeResourceInspectionAgentResponseSchema.parse({ schemaVersion: 1, action: "compose.resource.inspect", agentId: "agent-compose",
      projectId: preview.projectId, configDigest: preview.configDigest, kind: "network", key: "app", context: body.context, observation });
    const receiver = { agentId: "agent-compose", capabilities: [COMPOSE_RESOURCE_INSPECTION_CAPABILITY], hasDurableReplayStore: () => true,
      verifyRequest: (payload: string, signature: string | undefined) => verifyAgentTransport(payload, signature, trustKey),
      signResponse: (payload: string) => signAgentTransport(payload, trustKey), inspectComposeResource: vi.fn(async () => result) };
    const server = await startAgentServer({ host: "127.0.0.1", port: 1, receiver: receiver as never, replayStore: { durable: true } as never });
    try {
      const bodyText = JSON.stringify(body);
      const res = response();
      await serverHarness.callback!(request(COMPOSE_RESOURCE_INSPECTION_PATH, body,
        signAgentTransport(`POST ${COMPOSE_RESOURCE_INSPECTION_PATH}\n${bodyText}`, trustKey)), res);
      expect(res.status).toBe(200);
      expect(composeResourceInspectionAgentResponseSchema.parse(JSON.parse(res.body))).toEqual(result);
      expect(verifyAgentTransport(`POST ${COMPOSE_RESOURCE_INSPECTION_PATH}\n${bodyText}\n${res.body}`,
        res.headers["x-deploylite-response-signature"], trustKey)).toBe(true);
      expect(receiver.inspectComposeResource).toHaveBeenCalledOnce();
    } finally { await server.close(); }
  });
});
