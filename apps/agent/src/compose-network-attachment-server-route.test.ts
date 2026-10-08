import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { signAgentTransport } from "@deploylite/config";
import { COMPOSE_NETWORK_ATTACHMENT_CAPABILITY, COMPOSE_NETWORK_ATTACHMENT_PATH, COMPOSE_NETWORK_ATTACHMENT_RECEIPT_PATH, type ComposeNetworkAttachmentReceiptV1 } from "@deploylite/contracts";
import { startAgentServer } from "./server.js";

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
  return { destroyed: false, status: 0, body: "", writeHead(status: number) { this.status = status; return this; }, end(body = "") { this.body = body; } };
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
});
