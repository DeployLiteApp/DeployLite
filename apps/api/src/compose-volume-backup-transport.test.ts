import { describe, expect, it, vi } from "vitest";
import { COMPOSE_VOLUME_BACKUP_CAPABILITY, COMPOSE_VOLUME_BACKUP_PATH, COMPOSE_VOLUME_BACKUP_RECEIPT_PATH,
  type ComposeVolumeBackupAgentCommandV1, type ComposeVolumeBackupReceiptV1, type ProjectControlAuthorityV1 } from "@deploylite/contracts";
import { composeVolumeBackupExecutionDigest } from "@deploylite/domain";
import { AuthenticatedAgentCommandReceiver, type AgentReplayStore } from "@deploylite/agent";
import { AuthenticatedAgentDeploymentTransport, type PreparedComposeVolumeBackupCommand } from "./agent-transport.js";

const trustKey = "compose_volume_backup_transport_test_key_123";
const agentId = "agent_backup_1";
const digest = "a".repeat(64);
const plan = { schemaVersion: 1 as const, operation: "compose.volume.backup.plan" as const, status: "preview" as const,
  executionAllowed: false as const, archiveCreated: false as const, projectId: "project-1", volumeKey: "data", configDigest: digest,
  stateDigest: digest, profileId: "profile-1", destinationId: "destination-1", consistency: "offline-required" as const,
  verification: "integrity-and-completeness-required" as const,
  limits: { maxBytes: 1_000_000, maxEntries: 10, maxDurationMs: 10_000, planTtlMs: 60_000 }, planDigest: digest };
const preparedBase = { schemaVersion: 1 as const, action: "compose.volume.backup" as const, agentId,
  commandId: "backup-command-1", projectId: "project-1", operation: "compose.volume.backup.execute" as const,
  idempotencyKey: "backup-once", inputDigest: digest, canonicalDocument: "{\"services\":{}}", plan,
  context: { requestId: "request-1", correlationId: "correlation-1" } };
const inputDigest = composeVolumeBackupExecutionDigest({ projectId: preparedBase.projectId, idempotencyKey: preparedBase.idempotencyKey, plan });
const prepared: PreparedComposeVolumeBackupCommand = { ...preparedBase, inputDigest };
const authority: ProjectControlAuthorityV1 = { schemaVersion: 1, projectId: prepared.projectId, commandId: prepared.commandId,
  action: "project.update", inputDigest, projectLease: { projectId: prepared.projectId, leaseId: "lease-1", fence: 4, expiresAt: 50_000 } };
const receipt: ComposeVolumeBackupReceiptV1 = { schemaVersion: 1, action: "compose.volume.backup", agentId, commandId: prepared.commandId,
  projectId: prepared.projectId, inputDigest, correlationId: prepared.context.correlationId, volumeKey: plan.volumeKey, destinationId: plan.destinationId,
  archiveId: "backup_0123456789abcdef0123456789abcdef", status: "created", consistency: "stopped", archiveBytes: 2048, entries: 1,
  archiveSha256: digest, manifestSha256: digest, idempotent: false, redacted: true };

describe("authenticated Compose volume backup transport", () => {
  it("dispatches a scoped command and reads its idempotent receipt through signed agent paths", async () => {
    const rows = new Map<string, { fingerprint: string; token: string; receipt?: Record<string, unknown> }>();
    const replayStore: AgentReplayStore = {
      lookup: async (id, fingerprint) => { const row = rows.get(id); if (!row) return null; if (row.fingerprint !== fingerprint) throw new Error("replay conflict"); return row.receipt ?? null; },
      claim: async (id, fingerprint) => { if (rows.has(id)) { const row = rows.get(id)!; if (row.fingerprint !== fingerprint) throw new Error("replay conflict"); return { claimed: false, receipt: row.receipt }; } rows.set(id, { fingerprint, token: "claim-token" }); return { claimed: true, claimToken: "claim-token" }; },
      wait: async id => rows.get(id)?.receipt ?? Promise.reject(new Error("no completed receipt")),
      complete: async (id, value) => { const row = rows.get(id); if (!row || row.token !== value.claimToken || row.fingerprint !== value.fingerprint) throw new Error("claim changed"); row.receipt = structuredClone(value.receipt); },
      release: async id => { rows.delete(id); }
    };
    const calls = { validateAuthority: vi.fn(async (value: ProjectControlAuthorityV1) => expect(value).toEqual(authority)), execute: vi.fn(async (_command: ComposeVolumeBackupAgentCommandV1) => receipt) };
    const receiver = new AuthenticatedAgentCommandReceiver({ agentId, trustKey, capabilities: [COMPOSE_VOLUME_BACKUP_CAPABILITY],
      dispatcher: { dispatch: async () => { throw new Error("deployment dispatcher must not run"); } },
      volumeBackup: { execute: async (command, executionAuthority, signal) => { calls.execute(command); await executionAuthority.assertValid(); if (signal.aborted) throw signal.reason; return receipt; } },
      replayStore, authorityValidator: { validateDeploymentAuthority: async () => {}, validateProjectUpdateAuthority: calls.validateAuthority }, now: () => 1_000 });
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input)); const headers = (init?.headers ?? {}) as Record<string, string>; const signature = headers["x-deploylite-signature"];
      try {
        if (url.pathname === "/capabilities") {
          if (!receiver.verifyRequest("GET /capabilities", signature)) return new Response("unauthorized", { status: 401 });
          return new Response(JSON.stringify({ schemaVersion: 1, agentId, capabilities: [COMPOSE_VOLUME_BACKUP_CAPABILITY], protocolVersions: [1, 2] }), { headers: { "x-deploylite-request-signature": signature! } });
        }
        const body = JSON.parse(String(init?.body));
        if (url.pathname === COMPOSE_VOLUME_BACKUP_RECEIPT_PATH) return new Response(JSON.stringify(await receiver.readComposeVolumeBackupReceipt(body, signature)));
        if (url.pathname === COMPOSE_VOLUME_BACKUP_PATH) return new Response(JSON.stringify(await receiver.receive(body, signature)));
        return new Response("not found", { status: 404 });
      } catch (error) { return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "rejected" }), { status: 403 }); }
    };
    const transport = new AuthenticatedAgentDeploymentTransport({ endpoint: "https://agent.test", trustKey, agentId, fetch, timeoutMs: 5_000, now: () => 1_000 });
    const context = { requestId: "request-1", correlationId: "correlation-1" };
    await expect(transport.dispatchComposeVolumeBackup(prepared, authority, context)).resolves.toEqual(receipt);
    await expect(transport.readComposeVolumeBackupReceipt(prepared, authority, context)).resolves.toMatchObject({ status: "already-created", idempotent: true });
    expect(calls.execute).toHaveBeenCalledOnce();
    expect(calls.validateAuthority).toHaveBeenCalledTimes(2);
    expect(rows.get(prepared.commandId)?.receipt).toEqual(receipt);
  });

  it("rejects a different agent or project authority before dispatch", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const transport = new AuthenticatedAgentDeploymentTransport({ endpoint: "https://agent.test", trustKey, agentId, fetch, timeoutMs: 5_000 });
    await expect(transport.dispatchComposeVolumeBackup({ ...prepared, agentId: "other-agent" }, authority, { requestId: "request-1", correlationId: "correlation-1" })).rejects.toThrow("project update authority scope rejected");
    expect(fetch).not.toHaveBeenCalled();
  });
});
