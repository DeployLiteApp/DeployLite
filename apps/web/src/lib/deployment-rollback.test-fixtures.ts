// Source-derived API v2 examples, not captured replies or actual runtime proof.
import { clearTimeout, setImmediate, setTimeout } from "node:timers";
import { vi } from "vitest";
import type { Deployment } from "@deploylite/contracts";

export const H_HASH = "c".repeat(64);
export const SERVER_R = "00000000-0000-4000-8000-000000000303";
export const CONTEXT = { commandId: "rollback-command", confirmationId: "confirmation", requestId: "request", correlationId: "correlation" };

export function execution(id: string, historical = false): Deployment {
  const hash = historical ? H_HASH : "a".repeat(64);
  const digest = `sha256:${(historical ? "d" : "b").repeat(64)}`;
  const origin = historical ? "origin-H" : "origin-A", candidate = `${id}:candidate:original-command`;
  return {
    id, projectId: "project", agentId: "agent", status: "succeeded", commitSha: "abcdef1",
    startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:01:00.000Z",
    snapshotOriginId: origin, snapshotHash: hash,
    stopTarget: { candidateId: candidate, effectiveImage: `registry.example.com/team/app@${digest}` },
    executionReceipt: {
      schemaVersion: 1, deploymentId: id, projectId: "project", candidateId: candidate,
      snapshotOriginId: origin, snapshotHash: hash, effectiveImageDigest: digest, runtimeHost: "agent",
      container: `deploylite-active-${id}`, containerId: `physical-${id}`,
      hostPort: 49170, containerPort: 8080, network: null
    }
  };
}

export type ReplyKind = "prepared" | "pending" | "pending-confirmation" | "unknown" | "completed-replay" | "succeeded" | "failed" | "canceled" |
  "expired" | "rejected" | "unauthenticated" | "forbidden" | "unsupported-history" | "storage-error" |
  "wrong-A" | "wrong-H" | "wrong-R" | "wrong-project" | "wrong-hash" | "wrong-origin" | "malformed";
export type ReplyBindings = { key: string; activeId?: string; historicalId?: string; hash?: string; nextAttempt?: boolean; correlationId?: string; requestId?: string; terminalFault?: "candidate" | "container-port" | "host-port" | "network" | "valid-extra" | "missing-candidate" | "missing-runtime" | "proven-failure" };

function terminal(status: "succeeded" | "failed" | "canceled") {
  const deployment = execution(SERVER_R, true);
  deployment.activeDeploymentId = "A"; deployment.sourceDeploymentId = "H"; deployment.status = status;
  const candidateId = `${SERVER_R}:candidate:deploy_${SERVER_R}`;
  deployment.stopTarget!.candidateId = candidateId;
  deployment.executionReceipt!.candidateId = candidateId;
  deployment.executionReceipt!.containerId = "8".repeat(64);
  const proof = deployment.executionReceipt;
  if (status !== "succeeded") delete deployment.executionReceipt;
  const runtimeConfig: { hostPort: number; containerPort: number; networkName?: string } = { hostPort: 49170, containerPort: 8080 };
  return {
    deployment,
    command: { commandId: CONTEXT.commandId, action: "deployment.rollback", projectId: "project",
      activeDeploymentId: "A", sourceDeploymentId: "H", deploymentId: SERVER_R, snapshotHash: H_HASH,
      status: "completed", correlationId: CONTEXT.correlationId, reason: status === "succeeded" ? null : `agent-${status}` },
    execution: { deploymentId: SERVER_R, ...(status === "succeeded" ? { candidateId, runtimeConfig } : {}), effectiveImage: deployment.stopTarget!.effectiveImage,
      runtimePort: 8080,
      health: status === "succeeded" ? "passed" : "failed", terminalStatus: status,
      rollback: { target: status === "failed" ? execution("A").stopTarget!.effectiveImage : null,
        result: status === "succeeded" ? "not-required" : status === "failed" ? "restored" : "not-available" }, proven: status === "succeeded",
      ...(status === "succeeded" ? { executionReceipt: proof } : {}) }
  };
}

function stored(status: "eligible" | "dispatching" | "completed", key: string) {
  return { id: CONTEXT.commandId, actorId: "user_fixture", action: "deployment.rollback",
    scope: { kind: "deployment", projectId: "project", deploymentId: "A" }, inputDigest: "d".repeat(64),
    idempotencyKey: key, correlationId: CONTEXT.correlationId, status, expiresAt: "2026-10-06T00:00:00.000Z",
    result: { ...terminal("succeeded").command, status: status === "completed" ? "completed" : "eligible" } };
}

export function serverReply(kind: ReplyKind, bindings: ReplyBindings): Response {
  let httpStatus = 200, data: unknown, error: unknown = null;
  if (kind === "prepared" || kind === "pending-confirmation") {
    httpStatus = 202;
    data = { commandId: CONTEXT.commandId, deploymentId: SERVER_R, confirmationId: CONTEXT.confirmationId,
      confirmationRequired: true, correlationId: CONTEXT.correlationId };
  } else if (kind === "pending") {
    httpStatus = 202; data = { command: stored("dispatching", bindings.key), pending: true };
  } else if (kind === "completed-replay") {
    data = { command: stored("completed", bindings.key), deploymentId: SERVER_R, idempotent: true };
  } else if (["expired", "rejected", "unauthenticated", "forbidden", "unsupported-history", "unknown", "storage-error"].includes(kind)) {
    httpStatus = kind === "unauthenticated" ? 401 : kind === "forbidden" ? 403 : kind === "unknown" ? 502 : kind === "storage-error" ? 500 : 409;
    const code = kind === "unauthenticated" ? "UNAUTHENTICATED" : kind === "forbidden" ? "FORBIDDEN" :
      kind === "storage-error" ? "INTERNAL_ERROR" : kind === "unknown" ? "ROLLBACK_OUTCOME_UNKNOWN" : kind === "unsupported-history" ? "ROLLBACK_SNAPSHOT_INELIGIBLE" : "CONFIRMATION_REJECTED";
    data = null; error = { code, message: "secret-never-display", correlationId: CONTEXT.correlationId };
  } else {
    data = kind === "malformed" ? { unsupported: "secret-never-display" } : terminal(kind === "failed" || kind === "canceled" ? kind : "succeeded");
    if (bindings.terminalFault) {
      const received = (data as ReturnType<typeof terminal>).execution;
      if (bindings.terminalFault === "missing-candidate") delete received.candidateId;
      else if (bindings.terminalFault === "missing-runtime") delete received.runtimeConfig;
      else if (bindings.terminalFault === "proven-failure") received.proven = true;
      else {
        received.candidateId = bindings.terminalFault === "candidate" ? "wrong-candidate" : `${SERVER_R}:candidate:deploy_${SERVER_R}`;
        received.runtimeConfig = { hostPort: bindings.terminalFault === "host-port" ? 49171 : 49170,
          containerPort: bindings.terminalFault === "container-port" ? 8081 : 8080,
          ...(bindings.terminalFault === "network" ? { networkName: "unexpected" } : {}) };
      }
    }
    if (kind.startsWith("wrong-")) {
      const replacement = { "wrong-A": ["A", "wrong-A"], "wrong-H": ["H", "wrong-H"],
        "wrong-project": ["project", "wrong-project"], "wrong-hash": [H_HASH, "e".repeat(64)],
        "wrong-origin": ["origin-H", "wrong-origin"] }[kind as "wrong-A"];
      if (kind === "wrong-R") (data as ReturnType<typeof terminal>).deployment.id = "00000000-0000-4000-8000-000000000399";
      else data = JSON.parse(JSON.stringify(data), (_, value) => value === replacement?.[0] ? replacement[1] : value);
    }
  }
  const raw = JSON.parse(JSON.stringify({ data, error, requestId: CONTEXT.requestId }), (_, value: unknown) => {
    if (typeof value !== "string") return value;
    if (value === "A") return bindings.activeId ?? value;
    if (value === "H") return bindings.historicalId ?? value;
    if (value === H_HASH) return bindings.hash ?? value;
    if (value === CONTEXT.correlationId && bindings.correlationId) return bindings.correlationId;
    if (value === CONTEXT.requestId && bindings.requestId) return bindings.requestId;
    if (!bindings.nextAttempt) return value;
    if (value === CONTEXT.confirmationId) return "confirmation-next";
    if (value === CONTEXT.correlationId) return "correlation-next";
    return value.replaceAll(CONTEXT.commandId, "rollback-command-next")
      .replaceAll(SERVER_R, "00000000-0000-4000-8000-000000000304");
  });
  const response = new Response(JSON.stringify(raw), { status: httpStatus, headers: { "content-type": "application/json" } });
  response.json = async () => JSON.parse(JSON.stringify(raw));
  return response;
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
export type RecordedRequest = { url: string; init: RequestInit };
export function record(calls: RecordedRequest[], url: RequestInfo | URL, init?: RequestInit) {
  // Retain the real signal without passing a jsdom signal into native Node Request.
  calls.push({ url: String(url), init: { ...init } });
}
export const requestBody = (call: RecordedRequest) => JSON.parse(String(call.init.body));
export const requestHeader = (call: RecordedRequest, name: string) => new Headers(call.init.headers).get(name);
export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
export function advance(milliseconds: number) { vi.advanceTimersByTime(milliseconds); return tick(); }
export function watchdog<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("INVALID fixture watchdog")), 2_000); });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}
