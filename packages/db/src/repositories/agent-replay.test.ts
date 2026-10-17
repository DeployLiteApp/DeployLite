import {createHash} from "node:crypto";
import { getTableColumns } from "drizzle-orm";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDbClient } from "../client.js";
import { agentReplay } from "../schema.js";
import { DbAgentReplayStore } from "./agent-replay.js";

/** Real Drizzle SQL/parameter boundary shared by independently recreated repositories. */
class RecordingPool {
  row: Record<string, any> | undefined;
  reservations = new Set<string>();
  beforeMutation?: (text: string) => Promise<void>;
  queries: Array<{ text: string; values: unknown[] }> = [];
  async query(query: { text: string }, values: unknown[]) {
    const text = query.text; this.queries.push({ text, values });
    if (/^(insert|update|delete)/.test(text)) await this.beforeMutation?.(text);
    const reservationAbsent = () => {
      if (!text.includes("not exists")) return true;
      const match = /"backup_retirement_reservations"\."command_id" = \$(\d+)/.exec(text);
      if (!match) throw new Error("unmodeled reservation predicate");
      return !this.reservations.has(String(values[Number(match[1]) - 1]).toLowerCase());
    };
    const camel = (key: string) => key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    const matches = () => [...text.matchAll(/"agent_replay"\."(command_id|fingerprint|claim_owner|claim_token|status)" = \$(\d+)/g)].every((match) => this.row?.[camel(match[1]!)] === values[Number(match[2]) - 1]);
    if (text.startsWith("insert")) {
      if (this.row) return { rows: [] };
      const columns = text.split("(")[1]!.split(")")[0]!.match(/"[^"]+"/g)!;
      const tokens = text.split("values (")[1]!.split(")")[0]!.split(", "); this.row = {};
      columns.forEach((column, index) => { const token = tokens[index]!, value = token.startsWith("$") ? values[Number(token.slice(1)) - 1] : null; this.row![camel(column.slice(1, -1))] = value; });
      return { rows: [[this.row.commandId]] };
    }
    if (text.startsWith("update")) {
      if (!this.row || !matches() || !reservationAbsent()) return { rows: [] };
      const expiry = /"agent_replay"\."lease_expires_at" <= \$(\d+)/.exec(text);
      if (expiry && new Date(this.row.leaseExpiresAt).getTime() > new Date(values[Number(expiry[1]) - 1] as string).getTime()) return { rows: [] };
      for (const match of text.split(" set ")[1]!.split(" where ")[0]!.matchAll(/"(\w+)" = \$(\d+)/g)) this.row[camel(match[1]!)] = values[Number(match[2]) - 1];
      return { rows: [[this.row.commandId]] };
    }
    if (text.startsWith("delete")) { if (matches() && reservationAbsent()) this.row = undefined; return { rows: [] }; }
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
  it("corroborates an opaque digest against original canonical bytes without mutating a row",async()=>{
    const canonical=JSON.stringify({action:"database.runtime",authority:{commandId:"original"},projectId:"project-a"}),f=cached("completed",canonical),before=structuredClone(f.pool.row);
    const digest=createHash("sha256").update(canonical).digest("hex"),receipt=await f.store.lookupByFingerprintDigest("command",digest);
    expect(receipt).toEqual({physicalId:"original-observed-container"});expect(f.pool.row).toEqual(before);
    expect(f.pool.queries.every(query=>query.text.startsWith("select"))).toBe(true);receipt!.physicalId="forged";
    expect(await f.store.lookupByFingerprintDigest("command",digest)).toEqual({physicalId:"original-observed-container"});
  });
  it("rejects wrong, malformed or oversized canonical digest selectors without writes",async()=>{
    const f=cached(),before=structuredClone(f.pool.row);
    for(const digest of ["0".repeat(64),"original","", "A".repeat(64)])await expect(f.store.lookupByFingerprintDigest("command",digest)).rejects.toThrow();
    f.pool.row!.fingerprint="x".repeat(131073);await expect(f.store.lookupByFingerprintDigest("command",createHash("sha256").update(String(f.pool.row!.fingerprint)).digest("hex"))).rejects.toThrow();
    f.pool.row!.fingerprint=before!.fingerprint;expect(f.pool.row).toEqual(before);expect(f.pool.queries.every(query=>query.text.startsWith("select"))).toBe(true);
  });
  it("leaves absent and unfinished digest lookups unresolved, retaining expired completed evidence",async()=>{
    const f=cached("in_progress"),digest=createHash("sha256").update("original").digest("hex");
    expect(await f.store.lookupByFingerprintDigest("command",digest)).toBeNull();expect(await f.store.lookupByFingerprintDigest("missing",digest)).toBeNull();
    f.pool.row!.status="completed";f.pool.row!.leaseExpiresAt=new Date(Date.now()-1);const before=structuredClone(f.pool.row);
    expect(await f.store.lookupByFingerprintDigest("command",digest)).toEqual({physicalId:"original-observed-container"});expect(f.pool.row).toEqual(before);
  });

});

describe("permanent retirement reservation replay guards", () => {
  const fingerprint = "original-retirement-intent", lease = {leaseId: "original", fence: 1, expiresAt: 2000};
  const formats = [["native", "a1111111-a111-4111-8111-111111111111"], ["p3", "b2222222-b222-4222-8222-222222222222"]] as const;
  function fixture(commandId: string, reserved = true) {
    vi.useFakeTimers(); vi.setSystemTime(1000); const pool = new RecordingPool(); if (reserved) pool.reservations.add(commandId.toLowerCase());
    const store = new DbAgentReplayStore(createDbClient(pool as unknown as Pool), "original-owner");
    const reopen = () => new DbAgentReplayStore(createDbClient(pool as unknown as Pool), "reopened-owner");
    return {pool, store, reopen, commandId};
  }
  function guarded(pool: RecordingPool, operation: "update" | "delete", commandId: string) {
    const query = pool.queries.filter(item => item.text.startsWith(operation)).at(-1)!;
    expect(query.text).toMatch(/not exists \(select .* from "backup_retirement_reservations"/);
    const match = /"backup_retirement_reservations"\."command_id" = \$(\d+)/.exec(query.text)!;
    expect(match).not.toBeNull(); expect(query.values[Number(match[1]) - 1]).toBe(commandId);
    expect(query.text).toContain('"agent_replay"."status" =');
    expect(pool.queries.every(item => /^(insert into|update|delete from|select .* from) "agent_replay"/.test(item.text))).toBe(true);
  }
  for (const [format, commandId] of formats) {
    it(`${format}: permits initial insert only and preserves expired bytes under recreated concurrent owners`, async () => {
      const f = fixture(commandId), first = await f.store.claim(commandId, fingerprint, lease); expect(first.claimed).toBe(true);
      expect(await f.reopen().claim(commandId, fingerprint, {...lease, expiresAt: 5000})).toEqual({claimed: false});
      const before = structuredClone(f.pool.row); vi.setSystemTime(2001);
      expect(await Promise.all([f.reopen(), f.reopen()].map(store => store.claim(commandId, fingerprint, {...lease, expiresAt: 5000})))).toEqual([{claimed: false}, {claimed: false}]);
      expect(f.pool.row).toEqual(before); guarded(f.pool, "update", commandId);
      expect(f.pool.queries[0]!.text.startsWith("insert")).toBe(true); expect(f.pool.queries[0]!.text).not.toContain("backup_retirement_reservations");
    });
    it(`${format}: gives concurrent initial duplicates only one original token`, async () => {
      const f = fixture(commandId), claims = await Promise.all([f.store, f.reopen()].map(store => store.claim(commandId, fingerprint, lease)));
      expect(claims.filter(claim => claim.claimed)).toHaveLength(1); expect(claims.find(claim => claim.claimed)?.claimToken).toBe(f.pool.row?.claimToken);
      const before = structuredClone(f.pool.row); vi.setSystemTime(2001); expect(await f.reopen().claim(commandId, fingerprint, {...lease, expiresAt: 5000})).toEqual({claimed: false}); expect(f.pool.row).toEqual(before);
    });
    it(`${format}: matches canonical uppercase UUID reservation identities without text-to-UUID casts`, async () => {
      const upper = commandId.toUpperCase(), f = fixture(upper), first = await f.store.claim(upper, fingerprint, lease), before = structuredClone(f.pool.row); vi.setSystemTime(2001);
      expect(await f.reopen().claim(upper, fingerprint, {...lease, expiresAt: 5000})).toEqual({claimed: false}); await f.store.release(upper, first.claimToken); expect(f.pool.row).toEqual(before); guarded(f.pool, "delete", upper);
    });
    it(`${format}: cannot release original admission using current, foreign, absent or expired tokens`, async () => {
      const f = fixture(commandId), first = await f.store.claim(commandId, fingerprint, lease), before = structuredClone(f.pool.row);
      for (const token of [undefined, "foreign", first.claimToken]) {await f.store.release(commandId, token); expect(f.pool.row).toEqual(before);}
      vi.setSystemTime(2001); await f.store.release(commandId, first.claimToken); expect(f.pool.row).toEqual(before); guarded(f.pool, "delete", commandId);
      expect(f.pool.queries.at(-1)!.text).toContain('"agent_replay"."claim_owner" ='); expect(f.pool.queries.at(-1)!.text).toContain('"agent_replay"."claim_token" =');
    });
    it(`${format}: completes the exact original token after expiry and reads original cache after reopen`, async () => {
      const f = fixture(commandId), first = await f.store.claim(commandId, fingerprint, lease); vi.setSystemTime(2001);
      const receipt = {admissionTestOnly: true, original: commandId}; await f.store.complete(commandId, {fingerprint, claimToken: first.claimToken!, receipt});
      const before = structuredClone(f.pool.row); expect(await f.reopen().lookup(commandId, fingerprint)).toEqual(receipt);
      const found = await f.reopen().lookupByFingerprintDigest(commandId, createHash("sha256").update(fingerprint).digest("hex")); expect(found).toEqual(receipt); found!.original = "changed";
      expect(await f.reopen().claim(commandId, fingerprint, {...lease, expiresAt: 5000})).toEqual({claimed: false, receipt});
      await f.store.release(commandId, first.claimToken); expect(f.pool.row).toEqual(before);
      await expect(f.store.complete(commandId, {fingerprint, claimToken: first.claimToken!, receipt})).rejects.toThrow("stale"); expect(f.pool.row).toEqual(before);
      const completion = f.pool.queries.find(query => query.text.startsWith("update") && query.text.includes('"resolved_at"'))!; expect(completion.text).not.toContain("backup_retirement_reservations");
    });
    it(`${format}: rejects mismatched intent and foreign owner/token completion without mutation`, async () => {
      const f = fixture(commandId), first = await f.store.claim(commandId, fingerprint, lease), before = structuredClone(f.pool.row); vi.setSystemTime(2001);
      await expect(f.reopen().claim(commandId, "foreign", {...lease, expiresAt: 5000})).rejects.toThrow("replay");
      for (const [store, input, token] of [[f.reopen(), fingerprint, first.claimToken!], [f.store, "foreign", first.claimToken!], [f.store, fingerprint, "foreign"]] as const)
        await expect(store.complete(commandId, {fingerprint: input, claimToken: token, receipt: {admissionTestOnly: true}})).rejects.toThrow("stale");
      await f.reopen().release(commandId, first.claimToken); expect(f.pool.row).toEqual(before);
    });
    it(`${format}: does not freeze the distinct original backup command or unreserved legacy replay`, async () => {
      const backupId = "33333333-3333-4333-8333-333333333333", f = fixture(backupId, false); f.pool.reservations.add(commandId);
      const first = await f.store.claim(backupId, fingerprint, lease); vi.setSystemTime(2001);
      const next = await f.reopen().claim(backupId, fingerprint, {...lease, expiresAt: 5000}); expect(next.claimed).toBe(true); expect(next.claimToken).not.toBe(first.claimToken);
      await f.store.release(backupId, first.claimToken); expect(f.pool.row?.claimToken).toBe(next.claimToken); await f.reopen().release(backupId, next.claimToken); expect(f.pool.row).toBeUndefined();
    });
    it(`${format}: retains an initial claim that resolves after caller cancellation and generic release`, async () => {
      const f = fixture(commandId); let unblock!: () => void, entered!: () => void; const started = new Promise<void>(resolve => {entered = resolve;}), barrier = new Promise<void>(resolve => {unblock = resolve;});
      f.pool.beforeMutation = async text => {if (text.startsWith("insert")) {entered(); await barrier;}};
      const pending = f.store.claim(commandId, fingerprint, lease); await started; const cancellation = new AbortController(); cancellation.abort(); unblock(); const first = await pending; expect(cancellation.signal.aborted).toBe(true);
      const before = structuredClone(f.pool.row); await f.store.release(commandId, first.claimToken); expect(f.pool.row).toEqual(before); vi.setSystemTime(2001);
      expect(await f.reopen().claim(commandId, fingerprint, {...lease, expiresAt: 5000})).toEqual({claimed: false}); expect(f.pool.row).toEqual(before);
    });
    for (const operation of ["update", "delete"] as const) {
      it(`${format}: observes reservation committed at the ${operation} statement, not a prior membership read`, async () => {
        const f = fixture(commandId, false), first = await f.store.claim(commandId, fingerprint, lease); vi.setSystemTime(2001); const before = structuredClone(f.pool.row);
        f.pool.beforeMutation = async text => {if (text.startsWith(operation)) f.pool.reservations.add(commandId);};
        if (operation === "update") expect(await f.reopen().claim(commandId, fingerprint, {...lease, expiresAt: 5000})).toEqual({claimed: false}); else await f.store.release(commandId, first.claimToken);
        expect(f.pool.row).toEqual(before); guarded(f.pool, operation, commandId);
      });
      it(`${format}: leaves bytes unchanged when guarded ${operation} rejects`, async () => {
        const f = fixture(commandId), first = await f.store.claim(commandId, fingerprint, lease); vi.setSystemTime(2001); const before = structuredClone(f.pool.row);
        f.pool.beforeMutation = async text => {if (text.startsWith(operation)) throw new Error("injected statement rejection");};
        const result = operation === "update" ? f.reopen().claim(commandId, fingerprint, {...lease, expiresAt: 5000}) : f.store.release(commandId, first.claimToken);
        await expect(result).rejects.toMatchObject({cause: {message: "injected statement rejection"}}); expect(f.pool.row).toEqual(before);
      });
      it(`${format}: preserves original completion while a competing ${operation} is suspended`, async () => {
        const f = fixture(commandId), first = await f.store.claim(commandId, fingerprint, lease); vi.setSystemTime(2001);
        let unblock!: () => void, entered!: () => void; const started = new Promise<void>(resolve => {entered = resolve;}), barrier = new Promise<void>(resolve => {unblock = resolve;});
        f.pool.beforeMutation = async text => {if (text.startsWith(operation) && !text.includes('"resolved_at"')) {entered(); await barrier;}};
        const pending = operation === "update" ? f.reopen().claim(commandId, fingerprint, {...lease, expiresAt: 5000}) : f.store.release(commandId, first.claimToken); await started;
        await f.store.complete(commandId, {fingerprint, claimToken: first.claimToken!, receipt: {admissionTestOnly: true}}); const completed = structuredClone(f.pool.row); unblock(); await pending;
        expect(f.pool.row).toEqual(completed); expect(await f.reopen().lookup(commandId, fingerprint)).toEqual({admissionTestOnly: true});
      });
    }
  }
  for (const commandId of ["legacy-command", "not-a-uuid", "11111111-1111-4111-8111-11111111111Z", "", "a1111111-a111-4111-8111-111111111111".toUpperCase()]) {
    it(`preserves ordinary unreserved reclaim/release for ${JSON.stringify(commandId)}`, async () => {
      const f = fixture(commandId, false), first = await f.store.claim(commandId, fingerprint, lease); vi.setSystemTime(2001);
      const next = await f.reopen().claim(commandId, fingerprint, {...lease, expiresAt: 5000}); expect(next.claimed).toBe(true);
      await f.store.release(commandId, first.claimToken); expect(f.pool.row?.claimToken).toBe(next.claimToken); await f.reopen().release(commandId, next.claimToken); expect(f.pool.row).toBeUndefined();
      expect(f.pool.queries.every(query => !query.text.includes("::uuid"))).toBe(true);
    });
  }
});
