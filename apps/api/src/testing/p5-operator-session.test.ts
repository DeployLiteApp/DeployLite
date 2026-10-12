import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { openOperatorSession, type OperatorSessionPorts } from "./p5-operator-session.js";
function fixture() {
  const path = "packages/db/migrations/0000_fixture.sql", sql = "fixture migration", nonce = "a".repeat(24);
  const scope = { nonce, databaseName: "deploylite_p5_operator_" + nonce, postgresContainerId: "b".repeat(64), postgresPort: 15432,
    sourceHashes: { [path]: createHash("sha256").update(sql).digest("hex") } };
  let exists = false;
  const queries: string[] = [], ends: string[] = [];
  const createPool = vi.fn((url: string) => ({
    on: vi.fn(), query: vi.fn(async (text: string) => {
      queries.push(text);
      if (text.startsWith("CREATE DATABASE")) exists = true;
      if (text.startsWith("DROP DATABASE")) exists = false;
      return { rows: text.includes("pg_database") ? [{ exists }] : [] };
    }), end: vi.fn(async () => { ends.push(url); })
  }));
  const ports = { admission: vi.fn(async () => structuredClone(scope)), migrations: vi.fn(async () => [{ path, sql }]),
    pool: createPool as unknown as OperatorSessionPorts["pool"] };
  return { scope, ports, createPool, queries, ends, exists: () => exists, setExists: () => { exists = true; } };
}
it("opens only the nonce-owned database after admission and exact migration hashes", async () => {
  const f = fixture(), session = await openOperatorSession(f.ports);
  expect(session).toMatchObject({ databaseName: f.scope.databaseName });
  expect(f.createPool.mock.calls.map(([url]) => url)).toEqual([
    "postgres://deploylite:deploylite-ci-only@127.0.0.1:15432/postgres",
    "postgres://deploylite:deploylite-ci-only@127.0.0.1:15432/" + f.scope.databaseName]);
  expect(f.queries).toContain('CREATE DATABASE "' + f.scope.databaseName + '"');
  expect(f.queries).toContain("fixture migration"); await session.close(); expect(f.exists()).toBe(false);
});
it("denies missing admission before any pool or SQL effect", async () => {
  const f = fixture(); f.ports.admission.mockRejectedValue(new Error("no grant"));
  await expect(openOperatorSession(f.ports)).rejects.toThrow(); expect(f.createPool).not.toHaveBeenCalled();
});
it("rejects existing nonce databases without adoption or deletion", async () => {
  const f = fixture(); f.setExists(); await expect(openOperatorSession(f.ports)).rejects.toThrow();
  expect(f.queries.some(sql => sql.startsWith("CREATE") || sql.startsWith("DROP"))).toBe(false); expect(f.ends).toHaveLength(1);
});
it("rejects changed or omitted migrations before creating pools", async () => {
  for (const missing of [false, true]) {
    const f = fixture(); f.ports.migrations.mockResolvedValue(missing ? [] : [{ path: "packages/db/migrations/0000_fixture.sql", sql: "changed" }]);
    await expect(openOperatorSession(f.ports)).rejects.toThrow(); expect(f.createPool).not.toHaveBeenCalled();
  }
});
it("reopens clients only after reaffirming original admission without creating another database", async () => {
  const f = fixture(), session = await openOperatorSession(f.ports); expect(session).toHaveProperty("reopen", expect.any(Function));
  await session.reopen(); expect(f.ends).toHaveLength(1); expect(f.ports.admission).toHaveBeenCalledTimes(2);
  expect(f.queries.filter(sql => sql.startsWith("CREATE"))).toHaveLength(1); await session.close();
});
it("refuses cleanup on changed service or nonce and closes owned clients without deleting", async () => {
  const f = fixture(), session = await openOperatorSession(f.ports); expect(session).toHaveProperty("close", expect.any(Function));
  f.ports.admission.mockResolvedValue({ ...f.scope, postgresContainerId: "c".repeat(64) });
  await expect(session.close()).rejects.toThrow(); expect(f.queries.some(sql => sql.startsWith("DROP"))).toBe(false);
  expect(f.ends).toHaveLength(2);
});

it("never redirects failure cleanup to a changed database name after a migration error", async () => {
  const f = fixture(), original = f.createPool.getMockImplementation()!;
  f.createPool.mockImplementation(url => {
    const pool = original(url), query = pool.query.getMockImplementation()!;
    pool.query.mockImplementation(async text => {
      if (text === "fixture migration") {
        f.ports.admission.mockResolvedValue({ ...f.scope, databaseName: "protected" });
        throw new Error("migration error");
      }
      return query(text);
    }); return pool;
  });
  await expect(openOperatorSession(f.ports)).rejects.toThrow();
  expect(f.queries.some(sql => sql.startsWith("DROP"))).toBe(false);
  expect(f.ends).toHaveLength(2);
});
it("closes clients and removes only its original created database after migration failure", async () => {
  const f = fixture(), original = f.createPool.getMockImplementation()!;
  f.createPool.mockImplementation(url => {
    const pool = original(url), query = pool.query.getMockImplementation()!;
    pool.query.mockImplementation(async text => { if (text === "fixture migration") throw new Error("migration error"); return query(text); });
    return pool;
  });
  await expect(openOperatorSession(f.ports)).rejects.toThrow("Operator database fixture unavailable");
  expect(f.queries.filter(sql => sql.startsWith("DROP"))).toEqual(['DROP DATABASE "' + f.scope.databaseName + '"']);
  expect(f.exists()).toBe(false); expect(f.ends).toHaveLength(2);
});

it("keeps hashed migration bytes immutable across pool construction", async () => {
  const f = fixture(), migrations = [{ path: "packages/db/migrations/0000_fixture.sql", sql: "fixture migration" }];
  f.ports.migrations.mockResolvedValue(migrations);
  const original = f.createPool.getMockImplementation()!;
  f.createPool.mockImplementation(url => { migrations[0]!.sql = "changed after validation"; return original(url); });
  const session = await openOperatorSession(f.ports);
  expect(f.queries).toContain("fixture migration"); expect(f.queries).not.toContain("changed after validation");
  await session.close();
});
