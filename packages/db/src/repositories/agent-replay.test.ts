import { getTableColumns } from "drizzle-orm";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDbClient } from "../client.js";
import { agentReplay } from "../schema.js";
import { DbAgentReplayStore } from "./agent-replay.js";

/** Real Drizzle SQL/parameter boundary shared by independently recreated repositories. */
class RecordingPool {
  row: Record<string, any> | undefined;
  queries: Array<{ text: string; values: unknown[] }> = [];
  async query(query: { text: string }, values: unknown[]) {
    const text = query.text; this.queries.push({ text, values });
    const camel = (key: string) => key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    const matches = () => [...text.matchAll(/"agent_replay"\."(command_id|claim_owner|claim_token|status)" = \$(\d+)/g)].every((match) => this.row?.[camel(match[1]!)] === values[Number(match[2]) - 1]);
    if (text.startsWith("insert")) {
      if (this.row) return { rows: [] };
      const columns = text.split("(")[1]!.split(")")[0]!.match(/"[^"]+"/g)!;
      const tokens = text.split("values (")[1]!.split(")")[0]!.split(", "); this.row = {};
      columns.forEach((column, index) => { const token = tokens[index]!, value = token.startsWith("$") ? values[Number(token.slice(1)) - 1] : null; this.row![camel(column.slice(1, -1))] = value; });
      return { rows: [[this.row.commandId]] };
    }
    if (text.startsWith("update")) {
      if (!this.row || !matches()) return { rows: [] };
      const expiry = /"agent_replay"\."lease_expires_at" <= \$(\d+)/.exec(text);
      if (expiry && new Date(this.row.leaseExpiresAt).getTime() > new Date(values[Number(expiry[1]) - 1] as string).getTime()) return { rows: [] };
      for (const match of text.split(" set ")[1]!.split(" where ")[0]!.matchAll(/"(\w+)" = \$(\d+)/g)) this.row[camel(match[1]!)] = values[Number(match[2]) - 1];
      return { rows: [[this.row.commandId]] };
    }
    if (text.startsWith("delete")) { if (matches()) this.row = undefined; return { rows: [] }; }
    return { rows: this.row && matches() ? [Object.keys(getTableColumns(agentReplay)).map((key) => this.row![key])] : [] };
  }
}
afterEach(() => vi.useRealTimers());
describe("replay release claim-token CAS", () => {
  it("cannot release a reclaimed successor from an old instance of the same configured owner", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000); const pool = new RecordingPool();
    const old = new DbAgentReplayStore(createDbClient(pool as unknown as Pool), "agent"), fresh = new DbAgentReplayStore(createDbClient(pool as unknown as Pool), "agent");
    const first = await old.claim("command", "fingerprint", { leaseId: "first", deploymentId: "A", fence: 1, expiresAt: 2000 }); expect(first.claimed).toBe(true);
    vi.setSystemTime(2001); const next = await fresh.claim("command", "fingerprint", { leaseId: "next", deploymentId: "A", fence: 2, expiresAt: 5000 });
    expect(next.claimed).toBe(true); expect(next.claimToken).not.toBe(first.claimToken);
    await old.release("command", first.claimToken!);
    expect(pool.row?.claimToken).toBe(next.claimToken); expect(pool.row?.status).toBe("in_progress");
    expect(pool.queries.at(-1)?.text).toContain('"agent_replay"."claim_token" =');
    await fresh.release("command", next.claimToken!); expect(pool.row).toBeUndefined();
  });
  it("fails closed when release has no matching token", async () => {
    const pool = new RecordingPool(); pool.row = { commandId: "command", claimOwner: "agent", claimToken: "current", status: "in_progress" };
    const store = new DbAgentReplayStore(createDbClient(pool as unknown as Pool), "agent");
    await store.release("command"); expect(pool.row?.claimToken).toBe("current");
    await store.release("command", "other"); expect(pool.row?.claimToken).toBe("current");
  });
  it("stores a terminal receipt after lease expiry if the original claim token still owns the row", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000); const pool = new RecordingPool();
    const store = new DbAgentReplayStore(createDbClient(pool as unknown as Pool), "agent");
    const claim = await store.claim("command", "fingerprint", { leaseId: "lease", fence: 1, expiresAt: 2000 });
    vi.setSystemTime(2001);
    await store.complete("command", { fingerprint: "fingerprint", claimToken: claim.claimToken!, receipt: { status: "attached" } });
    expect(pool.row?.status).toBe("completed");
    expect(await store.lookup("command", "fingerprint")).toEqual({ status: "attached" });
  });
  it("rejects a late terminal receipt from an expired claim after a successor reclaims it", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000); const pool = new RecordingPool();
    const old = new DbAgentReplayStore(createDbClient(pool as unknown as Pool), "agent"), successor = new DbAgentReplayStore(createDbClient(pool as unknown as Pool), "agent");
    const first = await old.claim("command", "fingerprint", { leaseId: "old-lease", fence: 1, expiresAt: 2000 });
    vi.setSystemTime(2001);
    const next = await successor.claim("command", "fingerprint", { leaseId: "new-lease", fence: 2, expiresAt: 5000 });
    await expect(old.complete("command", { fingerprint: "fingerprint", claimToken: first.claimToken!, receipt: { status: "stale" } })).rejects.toThrow("stale");
    expect(pool.row?.claimToken).toBe(next.claimToken);
    expect(pool.row?.status).toBe("in_progress");
  });
});


describe("read-only completed receipt lookup", () => {
  function cached(status = "completed", fingerprint = "original") {
    const pool = new RecordingPool(); pool.row = { commandId: "command", fingerprint, status, claimOwner: "original-owner", claimToken: "original-token", leaseId: "original-lease", leaseExpiresAt: new Date(Date.now() + 60_000), receipt: { physicalId: "original-observed-container" } };
    const store = new DbAgentReplayStore(createDbClient(pool as unknown as Pool), "restarted-owner");
    return { pool, store };
  }
  it("reads a completed original receipt across recreated owners without claiming or waiting", async () => {
    const { pool, store } = cached(), before = structuredClone(pool.row);
    expect(await store.lookup("command", "original")).toEqual({ physicalId: "original-observed-container" });
    expect(pool.row).toEqual(before); expect(pool.queries.every((query) => query.text.startsWith("select"))).toBe(true);
  });
  it("leaves in-progress evidence unresolved without changing its claim", async () => {
    const { pool, store } = cached();
    pool.row!.status = "in_progress";
    const before = structuredClone(pool.row);
    expect(await store.lookup("command", "original")).toBeNull(); expect(pool.row).toEqual(before);
    expect(pool.queries.every((query) => query.text.startsWith("select"))).toBe(true);
  });
  it("keeps a terminal receipt queryable after the execution lease expires", async () => {
    const { pool, store } = cached();
    pool.row!.leaseExpiresAt = new Date(Date.now() - 1);
    expect(await store.lookup("command", "original")).toEqual({ physicalId: "original-observed-container" });
    expect(pool.row?.status).toBe("completed");
    expect(pool.queries.every((query) => query.text.startsWith("select"))).toBe(true);
  });
  it("rejects a different original fingerprint without mutating evidence", async () => {
    const { pool, store } = cached(), before = structuredClone(pool.row);
    await expect(store.lookup("command", "different")).rejects.toThrow("replay"); expect(pool.row).toEqual(before);
  });
  it("keeps missing commands unresolved without allocating a replay owner", async () => {
    const { pool, store } = cached(); expect(await store.lookup("missing", "original")).toBeNull();
    expect(pool.queries.every((query) => query.text.startsWith("select"))).toBe(true);
  });
  it("returns an independent clone rather than making cached evidence mutable by its caller", async () => {
    const { pool, store } = cached(); const first = await store.lookup("command", "original");
    expect(first).not.toBeNull(); first!.physicalId = "forged";
    expect(await store.lookup("command", "original")).toEqual({ physicalId: "original-observed-container" });
    expect(pool.row?.receipt).toEqual({ physicalId: "original-observed-container" });
  });
});
