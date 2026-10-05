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
