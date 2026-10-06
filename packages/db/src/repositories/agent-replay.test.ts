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
  it.each(["in_progress", "expired", "expiry-boundary"])("leaves %s original evidence unresolved without changing its claim", async (fault) => {
    const { pool, store } = cached();
    if (fault === "in_progress") pool.row!.status = "in_progress";
    else pool.row!.leaseExpiresAt = new Date(fault === "expired" ? Date.now() - 1 : Date.now());
    const before = structuredClone(pool.row);
    expect(await store.lookup("command", "original")).toBeNull(); expect(pool.row).toEqual(before);
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
