import { getTableColumns } from "drizzle-orm";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createControlCommand } from "@deploylite/domain";
import { controlCommands } from "../schema.js";
import { createDbClient } from "../client.js";
import { DbControlCommandRepository } from "./control-plane.js";

// Two independent Drizzle sessions over a transactional recording boundary.
// This models serialization/rollback while retaining emitted SQL and mapped parameters.
class RecordingPool {
  readonly rows = new Map<string, Record<string, unknown>>();
  beforeWrite?: () => void;
  readonly queries: Array<{ connection: number; text: string; values: unknown[] }> = [];
  private connections = 0;
  private lock: Promise<void> = Promise.resolve();
  async query(query: string | { text: string }, values: unknown[] = []) { return this.execute(0, query, values); }
  async connect() {
    const id = ++this.connections; let staged: Map<string, Record<string, unknown>> | undefined;
    let unlock: (() => void) | undefined;
    return { release: () => {}, query: async (query: string | { text: string }, values: unknown[] = []) => {
      const text = typeof query === "string" ? query : query.text;
      if (text === "begin") staged = structuredClone(this.rows);
      if (text.includes("pg_advisory_xact_lock")) {
        const previous = this.lock; this.lock = new Promise<void>((resolve) => { unlock = resolve; });
        await previous; staged = structuredClone(this.rows);
      }
      const result = this.execute(id, query, values, staged);
      if (text === "commit") { this.rows.clear(); for (const [key, row] of staged!) this.rows.set(key, row); unlock?.(); }
      if (text === "rollback") unlock?.();
      return result;
    } };
  }
  private execute(connection: number, query: string | { text: string }, values: unknown[], records = this.rows) {
    const text = typeof query === "string" ? query : query.text; this.queries.push({ connection, text, values: structuredClone(values) });
    const idMatch = /"control_commands"\."id" = \$(\d+)/.exec(text);
    const id = idMatch ? values[Number(idMatch[1]) - 1] as string : undefined;
    let selected = id ? [...records.values()].filter((row) => row.id === id) : [...records.values()];
    if (text.includes("::jsonb ->> 0")) selected = selected.filter((row) => JSON.parse(row.scopeKey as string)[0] === values.at(-1));
    if (text.includes("execution_authority ->> 'projectId'")) selected = selected.filter((row) => (row.executionAuthority as { projectId?: string } | null)?.projectId === values[0]);
    if (text.startsWith('update "control_commands"')) {
      this.beforeWrite?.();
      if (text.includes("clock_timestamp()")) {
        selected = selected.filter((row) => new Date(row.expiresAt as string).getTime() > Date.now());
        const expiry = /to_timestamp\(\$(\d+)/.exec(text);
        if (expiry && Number(values[Number(expiry[1]) - 1]) <= Date.now()) selected = [];
      }
      const where = text.split(" where ")[1] ?? "";
      const statuses = [...where.matchAll(/"control_commands"\."status" = \$(\d+)/g)].map((match) => values[Number(match[1]) - 1]);
      if (statuses.length) selected = selected.filter((row) => statuses.includes(row.status));
      for (const row of selected) for (const match of (text.split(" set ")[1]?.split(" where ")[0] ?? "").matchAll(/"(\w+)" = \$(\d+)/g)) {
        const key = match[1]!.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()); const value = values[Number(match[2]) - 1];
        row[key] = ["result", "executionAuthority"].includes(key) && typeof value === "string" ? JSON.parse(value) : value;
      }
    }
    if (text.startsWith("select") && text.includes('from "deployments"')) return { rows: [] };
    if (text.includes('"control_commands"')) return { rows: selected.map((row) => Object.keys(getTableColumns(controlCommands)).map((key) => row[key])) };
    return { rows: [] };
  }
}
function fixture() {
  const pool = new RecordingPool();
  const seed = (id: string, action: "deployment.stop" | "deployment.redeploy") => {
    const command = { ...createControlCommand({ actorId: "actor", action, scope: { kind: "deployment", projectId: "project", deploymentId: "A" }, input: {}, idempotencyKey: id, correlationId: id }), id, status: "eligible" as const,
      ...(action === "deployment.redeploy" ? { result: { commandId: id, action, projectId: "project", sourceDeploymentId: "A", deploymentId: "B", snapshotHash: "a".repeat(64), status: "eligible" as const, correlationId: id, reason: null } } : {}) };
    pool.rows.set(id, { id, actorUserId: command.actorId, action, scopeKind: "deployment", scopeKey: JSON.stringify(["project", "A"]), inputDigest: command.inputDigest, idempotencyKey: id, correlationId: id, status: "eligible", result: command.result ?? null, executionAuthority: null, expiresAt: command.expiresAt, createdAt: new Date(), updatedAt: new Date() });
    return command;
  };
  const replace = seed("replace", "deployment.redeploy"); const stop = seed("stop", "deployment.stop");
  const db = () => createDbClient(pool as unknown as Pool);
  return { pool, replace, stop, first: new DbControlCommandRepository(db()), second: new DbControlCommandRepository(db()), db };
}

describe("persisted project authority through real Drizzle recording sessions", () => {
  it("serializes replacement and stop across two repository connections", async () => {
    const { first, second, replace, stop, pool } = fixture();
    const [execution, stopping] = await Promise.all([first.claimDeploymentRedeploy(replace), second.claimDeploymentStop(stop)]);
    expect([execution.claimed, stopping.claimed]).toEqual([true, false]);
    expect(execution).toMatchObject({ authority: { commandId: "replace", projectId: "project", projectLease: { fence: 2 }, sourceLease: { deploymentId: "A" }, executionLease: { deploymentId: "B" } } });
    expect(pool.rows.get("stop")?.status).toBe("eligible");
    expect(new Set(pool.queries.filter((query) => query.text.includes("pg_advisory_xact_lock")).map((query) => query.connection)).size).toBe(2);
  });
  it("rolls back both authority and dispatch status on a claim fault", async () => {
    const { pool, replace, db } = fixture();
    const repository = new DbControlCommandRepository(db(), async (stage) => { if (String(stage) === "authority-claimed") throw new Error("claim fault"); });
    await expect(repository.claimDeploymentRedeploy(replace)).rejects.toThrow("claim fault");
    expect(pool.rows.get("replace")).toMatchObject({ status: "eligible", executionAuthority: null });
    expect(pool.queries.at(-1)?.text).toBe("rollback");
  });
});


describe("fresh persisted authority validation", () => {
  it("reads authority from another repository after recreation", async () => {
    const { first, replace, db } = fixture(); const claim = await first.claimDeploymentRedeploy(replace);
    await expect(new DbControlCommandRepository(db()).validateDeploymentAuthority(claim.authority!)).resolves.toBeUndefined();
  });
  it.each(["project", "execution", "owner", "source", "command"])("rejects changed %s from a fresh connection", async (field) => {
    const { first, replace, db } = fixture(); const claim = await first.claimDeploymentRedeploy(replace); const authority = structuredClone(claim.authority!);
    if (field === "project") authority.projectId = "other";
    if (field === "execution") authority.executionLease.deploymentId = "other";
    if (field === "owner") authority.projectLease.leaseId = "other-owner-same-fence";
    if (field === "source") authority.sourceLease!.deploymentId = "other";
    if (field === "command") authority.commandId = "missing";
    await expect(new DbControlCommandRepository(db()).validateDeploymentAuthority(authority)).rejects.toThrow();
  });
  it("cannot validate authority after command completion", async () => {
    const { first, second, stop, pool } = fixture(); const claim = await first.claimDeploymentStop(stop);
    await first.completeDeploymentStop(claim.command, { commandId: stop.id, action: "deployment.stop", projectId: "project", deploymentId: "A", status: "completed", correlationId: stop.id, reason: "stopped" });
    expect(pool.rows.get(stop.id)?.status).toBe("completed");
    await expect(second.validateDeploymentAuthority(claim.authority!)).rejects.toThrow();
  });
  it("expires independently and rejects an older fence after another claim", async () => {
    vi.useFakeTimers();
    try {
      const { first, second, replace, stop, pool } = fixture(); const claim = await first.claimDeploymentRedeploy(replace);
      vi.setSystemTime(claim.authority!.projectLease.expiresAt);
      await expect(second.validateDeploymentAuthority(claim.authority!)).rejects.toThrow();
      pool.rows.get(stop.id)!.expiresAt = new Date(Date.now() + 120_000);
      const next = await second.claimDeploymentStop(stop);
      expect(next).toMatchObject({ claimed: true, authority: { projectLease: { fence: 3 } } });
      await expect(first.validateDeploymentAuthority(claim.authority!, claim.authority!.projectLease.expiresAt - 1)).rejects.toThrow();
    } finally { vi.useRealTimers(); }
  });
});


describe("persisted Stop terminal CAS", () => {
  it.each(["expired-before-lock", "expired-at-write", "superseded", "changed-owner"])("rejects %s while preserving the command", async (fault) => {
    vi.useFakeTimers();
    try {
      const f = fixture(), claim = await f.first.claimDeploymentStop(f.stop), submitted = structuredClone(claim.command);
      const result = { commandId: "stop", action: "deployment.stop" as const, projectId: "project", deploymentId: "A", status: "completed" as const, correlationId: "stop", reason: "stopped" };
      if (fault === "expired-before-lock") vi.setSystemTime(claim.authority!.projectLease.expiresAt);
      if (fault === "expired-at-write") f.pool.beforeWrite = () => vi.setSystemTime(claim.authority!.projectLease.expiresAt);
      if (fault === "changed-owner") submitted.executionAuthority!.projectLease.leaseId = "another-owner";
      if (fault === "superseded") f.pool.rows.set("newer", { ...structuredClone(f.pool.rows.get("stop")!), id: "newer", executionAuthority: { ...structuredClone(claim.authority!), commandId: "newer", projectLease: { ...claim.authority!.projectLease, fence: claim.authority!.projectLease.fence + 1 } } });
      await expect(f.second.completeDeploymentStop(submitted, result)).rejects.toThrow();
      expect(f.pool.rows.get("stop")?.status).toBe("dispatching"); expect(f.pool.rows.get("stop")?.result).toBeNull();
      const queries = f.pool.queries.filter((value) => value.connection > 0);
      expect(queries.some((value) => value.text.includes("pg_advisory_xact_lock"))).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it("replays completed equal result before expired mutable authority and conflicts on changed result", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(), claim = await f.first.claimDeploymentStop(f.stop), result = { commandId: "stop", action: "deployment.stop" as const, projectId: "project", deploymentId: "A", status: "completed" as const, correlationId: "stop", reason: "stopped" };
      const first = await f.first.completeDeploymentStop(claim.command, result); vi.setSystemTime(claim.authority!.projectLease.expiresAt);
      expect(await f.second.completeDeploymentStop(claim.command, result)).toEqual(first);
      await expect(f.second.completeDeploymentStop(claim.command, { ...result, reason: "different" })).rejects.toThrow();
    } finally { vi.useRealTimers(); }
  });
});


describe("cached Stop publication cancellation", () => {
  it("rolls back Stop completion when the caller aborts during the final SQL write", async () => {
    const f = fixture(), claim = await f.first.claimDeploymentStop(f.stop), controller = new AbortController(); const before = structuredClone(f.pool.rows.get("stop"));
    f.pool.beforeWrite = () => controller.abort(new Error("cache publication canceled"));
    const result = { commandId: "stop", action: "deployment.stop" as const, projectId: "project", deploymentId: "A", status: "completed" as const, correlationId: "stop", reason: "stopped" };
    await expect((f.second.completeDeploymentStop as any)(claim.command, result, controller.signal)).rejects.toThrow("cache publication canceled"); expect(f.pool.rows.get("stop")).toEqual(before); expect(f.pool.queries.at(-1)?.text).toBe("rollback");
  });
});
