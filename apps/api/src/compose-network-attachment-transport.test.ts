import { describe, expect, it, vi } from "vitest";
import { COMPOSE_NETWORK_ATTACHMENT_CAPABILITY, COMPOSE_NETWORK_ATTACHMENT_RECEIPT_PATH, protocolPayloadFingerprint, type ComposeNetworkAttachmentReceiptV1, type ComposeResourceObservationV1, type ProjectControlAuthorityV1 } from "@deploylite/contracts";
import { claimProjectUpdateAuthority, createComposePreview, digestControlInput, digestComposeResourceObservation, prepareComposeAttachmentControlCommand, resolveControlCommandInMemory, type ControlCommand } from "@deploylite/domain";
import { AuthenticatedAgentCommandReceiver, type AgentReplayStore } from "@deploylite/agent";
import { AuthenticatedAgentDeploymentTransport } from "./agent-transport.js";

const trustKey = "compose_network_transport_test_key_123";
const agentId = "agent_mock_1";
const policy = { policyVersion: "compose-test-1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true };
const image = `registry.example.com/app@sha256:${"a".repeat(64)}`;

function fixture() {
  const document = JSON.stringify({ services: { api: { image, networks: ["backend"] } }, networks: { backend: {} } });
  const preview = createComposePreview(document, "project-1", policy);
  const observation: ComposeResourceObservationV1 = { schemaVersion: 1, owner: "deploylite", agentId, projectId: "project-1", kind: "network", key: "backend",
    runtimeName: preview.networks[0]!.runtimeName, physicalIdentity: "b".repeat(64), configDigest: preview.configDigest, observedAt: 990,
    stateDigest: "0".repeat(64), containers: [{ containerId: "c".repeat(64), service: "api", running: false, attached: false, mounts: [] }] };
  observation.stateDigest = digestComposeResourceObservation(observation);
  const commandRows = new Map<string, ControlCommand>();
  const preparedPromise = prepareComposeAttachmentControlCommand({ document, projectId: "project-1", kind: "network", key: "backend", service: "api", action: "attach",
    expectedConfigDigest: preview.configDigest, expectedStateDigest: observation.stateDigest, expectedContainerId: "c".repeat(64) }, {
    imagePolicy: policy, owner: "deploylite", agentId, inspector: { inspect: async () => structuredClone(observation) }, clock: { now: () => 1_000 }, maxAgeMs: 100,
    actorId: "operator-1", role: "operator", grants: { listForActor: async actorId => [{ id: "grant-1", actorId, action: "project.update", scope: { kind: "project", projectId: "project-1" } }] },
    controlCommands: { resolve: async command => resolveControlCommandInMemory(commandRows, command), complete: async command => command },
    correlationId: "corr-1", idempotencyKey: "attach-once", commandTtlMs: 5_000
  });
  return { preparedPromise, observation };
}

describe("authenticated Compose network attachment transport", () => {
  it("uses signed capability and command routes, persists a terminal receipt, and reconciles retries from the same replay", async () => {
    const f = fixture();
    const prepared = await f.preparedPromise;
    const command = structuredClone(prepared.command);
    const authority = claimProjectUpdateAuthority([command], command, 1_001)!;
    const calls = { validateAuthority: vi.fn(async (value: ProjectControlAuthorityV1) => { expect(protocolPayloadFingerprint(value)).toBe(protocolPayloadFingerprint(authority)); }), execute: vi.fn() };
    const receipt: ComposeNetworkAttachmentReceiptV1 = { schemaVersion: 1, action: "compose.network.attachment", agentId, commandId: command.id, projectId: "project-1",
      inputDigest: command.inputDigest, correlationId: "corr-1", key: "backend", runtimeName: prepared.request.runtimeName, service: "api", attachmentAction: "attach",
      containerId: prepared.request.containerId, resourceId: "b".repeat(64), beforeStateDigest: f.observation.stateDigest, afterStateDigest: "d".repeat(64),
      observedAt: 1_002, status: "attached", reconciled: false, redacted: true, reason: null };
    const rows = new Map<string, { fingerprint: string; token: string; receipt?: Record<string, unknown> }>();
    const replayStore: AgentReplayStore = {
      lookup: async (id, fingerprint) => { const row = rows.get(id); if (!row) return null; if (row.fingerprint !== fingerprint) throw new Error("replay conflict"); return row.receipt ?? null; },
      claim: async (id, fingerprint) => { if (rows.has(id)) { const row = rows.get(id)!; if (row.fingerprint !== fingerprint) throw new Error("replay conflict"); return { claimed: false, receipt: row.receipt }; } rows.set(id, { fingerprint, token: "claim-token" }); return { claimed: true, claimToken: "claim-token" }; },
      wait: async id => rows.get(id)?.receipt ?? Promise.reject(new Error("no completed receipt")),
      complete: async (id, value) => { const row = rows.get(id); if (!row || row.token !== value.claimToken || row.fingerprint !== value.fingerprint) throw new Error("claim changed"); row.receipt = structuredClone(value.receipt); },
      release: async id => { rows.delete(id); }
    };
    let agentNow = 1_001;
    const receiver = new AuthenticatedAgentCommandReceiver({ agentId, trustKey, capabilities: [COMPOSE_NETWORK_ATTACHMENT_CAPABILITY], dispatcher: { dispatch: async () => { throw new Error("not used"); } },
      networkAttachment: { execute: async (received, executionAuthority, signal) => { calls.execute(received); await executionAuthority.assertValid(); if (signal.aborted) throw signal.reason; return receipt; } },
      replayStore, authorityValidator: { validateDeploymentAuthority: async () => {}, validateProjectUpdateAuthority: calls.validateAuthority }, now: () => agentNow });
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input)); const headers = (init?.headers ?? {}) as Record<string, string>; const signature = headers["x-deploylite-signature"];
      try {
        if (url.pathname === "/capabilities") {
          if (!receiver.verifyRequest("GET /capabilities", signature)) return new Response("unauthorized", { status: 401 });
          return new Response(JSON.stringify({ schemaVersion: 1, agentId, capabilities: [COMPOSE_NETWORK_ATTACHMENT_CAPABILITY], protocolVersions: [1, 2] }), { headers: { "x-deploylite-request-signature": signature! } });
        }
        const body = JSON.parse(String(init?.body));
        if (url.pathname === COMPOSE_NETWORK_ATTACHMENT_RECEIPT_PATH) return new Response(JSON.stringify(await receiver.readComposeNetworkAttachmentReceipt(body, signature)));
        return new Response(JSON.stringify(await receiver.receive(body, signature)));
      } catch (error) { return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "rejected" }), { status: 403 }); }
    };
    const transport = new AuthenticatedAgentDeploymentTransport({ endpoint: "https://agent.test", trustKey, agentId, fetch, timeoutMs: 5_000, now: () => 1_000 });
    const context = { requestId: "request-1", correlationId: "corr-1" };
    await expect(transport.dispatchComposeNetworkAttachment(prepared, authority, context)).resolves.toEqual(receipt);
    agentNow = authority.projectLease.expiresAt + 1;
    await expect(transport.readComposeNetworkAttachmentReceipt(prepared, authority, context)).resolves.toEqual(receipt);
    await expect(transport.dispatchComposeNetworkAttachment(prepared, authority, context)).resolves.toEqual(receipt);
    expect(calls.execute).toHaveBeenCalledOnce();
    expect(calls.validateAuthority).toHaveBeenCalledTimes(2);
    expect(rows.get(command.id)?.receipt).toEqual(receipt);
  });

  it("rejects an input digest that is not the server-derived project.update request", async () => {
    const f = fixture(), prepared = await f.preparedPromise;
    expect(prepared.command.inputDigest).toBe(digestControlInput(prepared.request));
    expect(prepared.request.kind).toBe("network");
  });
});
