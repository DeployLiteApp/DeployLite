import { describe, expect, it, vi } from "vitest";
import { openAgentSecretEnvelope } from "@deploylite/config";
import { COMPOSE_VOLUME_ATTACHMENT_CAPABILITY, COMPOSE_VOLUME_ATTACHMENT_PATH, COMPOSE_VOLUME_ATTACHMENT_RECEIPT_PATH,
  type ComposeVolumeAttachmentExecutionRequestV1, type ComposeVolumeAttachmentReceiptV1, type ProjectControlAuthorityV1 } from "@deploylite/contracts";
import { claimProjectUpdateAuthority, composeVolumeAttachmentExecutionDigest, createControlCommand, type ControlCommand } from "@deploylite/domain";
import { AuthenticatedAgentCommandReceiver, type AgentReplayStore } from "@deploylite/agent";
import { AuthenticatedAgentDeploymentTransport, type PreparedComposeVolumeAttachmentCommand } from "./agent-transport.js";

const trustKey = "compose_volume_transport_test_key_123";
const agentId = "agent-volume-test";
const secret = "synthetic-api-secret-never-in-json";
const digest = (letter: string) => letter.repeat(64);

function fixture() {
  const request: ComposeVolumeAttachmentExecutionRequestV1 = { schemaVersion: 1, action: "project.update", scope: { kind: "project", projectId: "project-1" },
    operation: "compose.resource.attachment", idempotencyKey: "volume-attach-once", correlationId: "correlation-1", projectId: "project-1",
    priorRevisionId: "revision-1", revisionId: "revision-2", priorConfigDigest: digest("a"), configDigest: digest("b"), stateDigest: digest("c"),
    secretDigest: digest("d"), priorCanonicalDocument: "{\"services\":{}}", canonicalDocument: "{\"services\":{}}", key: "data",
    runtimeName: `dl-${"e".repeat(32)}-vol-data`, service: "app", attachmentAction: "attach", containerId: digest("f") };
  const input = Object.fromEntries(Object.entries(request).filter(([key]) => key !== "idempotencyKey" && key !== "correlationId"));
  const command: ControlCommand = { ...createControlCommand({ actorId: "operator-1", action: "project.update", scope: request.scope, input,
    idempotencyKey: request.idempotencyKey, correlationId: request.correlationId, expiresAt: new Date(20_000) }), status: "eligible" };
  const authority = claimProjectUpdateAuthority([command], command, 1_000)!;
  const prepared: PreparedComposeVolumeAttachmentCommand = { command, request, agentId, environment: { TOKEN: secret } };
  const receipt: ComposeVolumeAttachmentReceiptV1 = { schemaVersion: 1, action: "compose.volume.attachment", agentId, commandId: command.id,
    projectId: request.projectId, inputDigest: command.inputDigest, correlationId: command.correlationId, key: request.key, runtimeName: request.runtimeName,
    service: request.service, attachmentAction: request.attachmentAction, priorContainerId: request.containerId, replacementContainerId: digest("1"),
    resourceCreatedAt: "2026-10-08T00:00:00.000Z", beforeStateDigest: digest("2"), afterStateDigest: digest("3"), observedAt: 1_001,
    status: "replaced", health: "passed", rollback: "not-required", reconciled: false, redacted: true, reason: null };
  return { request, command, authority, prepared, receipt };
}

describe("authenticated Compose volume attachment transport", () => {
  it("sends only a bound encrypted environment and omits it from receipt recovery queries", async () => {
    const f = fixture(), sentBodies: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input)), signature = String(((init?.headers ?? {}) as Record<string, string>)["x-deploylite-signature"] ?? "");
      if (url.pathname === "/capabilities") return new Response(JSON.stringify({ schemaVersion: 1, agentId, capabilities: [COMPOSE_VOLUME_ATTACHMENT_CAPABILITY], protocolVersions: [1, 2] }),
        { headers: { "x-deploylite-request-signature": signature } });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sentBodies.push({ path: url.pathname, body });
      if (url.pathname === COMPOSE_VOLUME_ATTACHMENT_PATH) {
        const envelope = String(body.sealedEnvironment);
        expect(envelope).not.toContain(secret);
        expect(openAgentSecretEnvelope(envelope, trustKey, { agentId, commandId: f.command.id, inputDigest: f.command.inputDigest, projectId: f.request.projectId })).toEqual({ TOKEN: secret });
        return new Response(JSON.stringify(f.receipt));
      }
      return new Response(JSON.stringify({ schemaVersion: 1, action: "compose.volume.attachment", agentId, commandId: f.command.id,
        correlationId: f.command.correlationId, receipt: f.receipt }));
    };
    const transport = new AuthenticatedAgentDeploymentTransport({ endpoint: "https://agent.test", trustKey, agentId, fetch, timeoutMs: 5_000 });
    const context = { requestId: "request-1", correlationId: "correlation-1" };
    expect(f.command.inputDigest).toBe(composeVolumeAttachmentExecutionDigest(f.request));
    await expect(transport.dispatchComposeVolumeAttachment(f.prepared, f.authority, context)).resolves.toEqual(f.receipt);
    await expect(transport.readComposeVolumeAttachmentReceipt(f.prepared, f.authority, context)).resolves.toEqual(f.receipt);
    expect(sentBodies.map(value => value.path)).toEqual([COMPOSE_VOLUME_ATTACHMENT_PATH, COMPOSE_VOLUME_ATTACHMENT_RECEIPT_PATH]);
    expect(sentBodies[0]!.body).toHaveProperty("sealedEnvironment");
    expect(sentBodies[1]!.body).not.toHaveProperty("sealedEnvironment");
    expect(JSON.stringify(sentBodies)).not.toContain(secret);
  });

  it("rejects a mismatched persisted command digest before network calls", async () => {
    const f = fixture(); let calls = 0;
    const transport = new AuthenticatedAgentDeploymentTransport({ endpoint: "https://agent.test", trustKey, agentId, fetch: async () => { calls++; return new Response("{}"); } });
    const wrong = { ...f.prepared, command: { ...f.command, inputDigest: digest("9") } };
    await expect(transport.dispatchComposeVolumeAttachment(wrong, f.authority as ProjectControlAuthorityV1, { requestId: "request-1", correlationId: "correlation-1" })).rejects.toThrow();
    expect(calls).toBe(0);
  });

  it("round-trips through the agent receiver, validates project authority, and executes once across replay", async () => {
    const f = fixture(), rows = new Map<string, { fingerprint: string; token: string; receipt?: Record<string, unknown> }>();
    const replayStore: AgentReplayStore = {
      lookup: async (id, fingerprint) => { const row = rows.get(id); if (!row) return null; if (row.fingerprint !== fingerprint) throw new Error("replay conflict"); return row.receipt ?? null; },
      claim: async (id, fingerprint) => {
        if (rows.has(id)) { const row = rows.get(id)!; if (row.fingerprint !== fingerprint) throw new Error("replay conflict"); return { claimed: false, receipt: row.receipt }; }
        rows.set(id, { fingerprint, token: "volume-claim-token" }); return { claimed: true, claimToken: "volume-claim-token" };
      },
      wait: async id => rows.get(id)?.receipt ?? Promise.reject(new Error("receipt not complete")),
      complete: async (id, value) => { const row = rows.get(id); if (!row || row.token !== value.claimToken || row.fingerprint !== value.fingerprint) throw new Error("claim changed"); row.receipt = structuredClone(value.receipt); },
      release: async (id, token) => { if (!token || rows.get(id)?.token === token) rows.delete(id); }
    };
    const validateAuthority = vi.fn(async (authority: ProjectControlAuthorityV1) => { expect(authority).toEqual(f.authority); });
    const execute = vi.fn(async () => f.receipt);
    const receiver = new AuthenticatedAgentCommandReceiver({ agentId, trustKey, capabilities: [COMPOSE_VOLUME_ATTACHMENT_CAPABILITY],
      dispatcher: { dispatch: async () => { throw new Error("deployment dispatcher must not run"); } }, volumeAttachment: { execute: async (_command, authority) => { await authority.assertValid(); return execute(); } },
      replayStore, authorityValidator: { validateDeploymentAuthority: async () => {}, validateProjectUpdateAuthority: validateAuthority }, now: () => 1_000 });
    const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input)), headers = (init?.headers ?? {}) as Record<string, string>, signature = headers["x-deploylite-signature"];
      try {
        if (url.pathname === "/capabilities") {
          if (!receiver.verifyRequest("GET /capabilities", signature)) return new Response("unauthorized", { status: 401 });
          return new Response(JSON.stringify({ schemaVersion: 1, agentId, capabilities: receiver.capabilities, protocolVersions: [1, 2] }),
            { headers: { "x-deploylite-request-signature": signature! } });
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>; sent.push({ path: url.pathname, body });
        if (url.pathname === COMPOSE_VOLUME_ATTACHMENT_RECEIPT_PATH) return new Response(JSON.stringify(await receiver.readComposeVolumeAttachmentReceipt(body, signature)));
        if (url.pathname === COMPOSE_VOLUME_ATTACHMENT_PATH) return new Response(JSON.stringify(await receiver.receive(body, signature)));
        return new Response("not found", { status: 404 });
      } catch (error) { return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "rejected" }), { status: 403 }); }
    };
    const transport = new AuthenticatedAgentDeploymentTransport({ endpoint: "https://agent.test", trustKey, agentId, fetch, timeoutMs: 5_000, now: () => 1_000 });
    const context = { requestId: "request-1", correlationId: "correlation-1" };
    await expect(transport.dispatchComposeVolumeAttachment(f.prepared, f.authority, context)).resolves.toEqual(f.receipt);
    await expect(transport.readComposeVolumeAttachmentReceipt(f.prepared, f.authority, context)).resolves.toEqual(f.receipt);
    await expect(transport.dispatchComposeVolumeAttachment(f.prepared, f.authority, context)).resolves.toEqual(f.receipt);
    expect(execute).toHaveBeenCalledOnce();
    expect(validateAuthority).toHaveBeenCalledTimes(2);
    expect(rows.get(f.command.id)?.receipt).toEqual(f.receipt);
    expect(sent.find(value => value.path === COMPOSE_VOLUME_ATTACHMENT_RECEIPT_PATH)?.body).not.toHaveProperty("sealedEnvironment");
  });
});
