import { EventEmitter } from "node:events";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";

const mockedModules = ["vitest", "pg", "./client.js",
  "./managed-database-credentials-postgres.cases.js", "./native-backup-inventory-postgres.cases.js", "./backup-protection-postgres.cases.js"];
afterEach(() => {
  for (const name of mockedModules) vi.doUnmock(name);
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function fixture() {
  vi.resetModules();
  vi.stubEnv("DEPLOYLITE_DB_INTEGRATION", "1");
  vi.stubEnv("DATABASE_URL", "postgres://fixture:fixture@127.0.0.1:1/fixture");
  const hooks: { open?: () => Promise<void>; close?: () => Promise<void> } = {};
  const events = new EventEmitter(), end = vi.fn(async () => {});
  const pool = Object.assign(events, { end });
  const clients: Client[] = [];
  class Client {
    connect = vi.fn(async () => {});
    query = vi.fn(async (_sql: string) => ({ rows: [] }));
    end = vi.fn(async () => {});
    constructor() { clients.push(this); }
  }
  vi.doMock("pg", () => ({ default: { Client } }));
  vi.doMock("./client.js", () => ({ createDbPool: () => pool, createDbClient: () => ({}),
    closeDbPool: async (connection: typeof pool) => { await connection.end(); } }));
  vi.doMock("./managed-database-credentials-postgres.cases.js", () => ({ defineManagedDatabaseCredentialCases() {} }));
  vi.doMock("./native-backup-inventory-postgres.cases.js", () => ({ defineNativeBackupInventoryCases() {} }));
  vi.doMock("./backup-protection-postgres.cases.js", () => ({ defineBackupProtectionCases() {}, prepareMigrationProbe: async () => undefined }));
  vi.doMock("vitest", () => ({ expect, it: vi.fn(),
    describe: (_name: string, define: () => void) => define(),
    beforeAll: (run: () => Promise<void>) => { hooks.open = run; },
    afterAll: (run: () => Promise<void>) => { hooks.close = run; } }));
  await import("./backup-inventory-postgres.integration-cases.js");
  await hooks.open!();
  const maintenance = clients[0]!;
  const drops = () => maintenance.query.mock.calls.filter(([sql]) => sql.startsWith("DROP DATABASE"));
  return { events, end, close: hooks.close!, drops };
}

it("waits for every inventory socket removal before forcing database cleanup", async () => {
  const f = await fixture(), first = {}, second = {};
  f.events.emit("connect", first); f.events.emit("connect", second);
  const closing = f.close();
  try {
    await yieldToLoop();
    expect(f.end).toHaveBeenCalledOnce();
    expect(f.drops()).toHaveLength(0);
    f.events.emit("remove", first); await yieldToLoop();
    expect(f.drops()).toHaveLength(0);
    f.events.emit("remove", second); await closing;
    expect(f.drops()).toHaveLength(1);
  } finally {
    f.events.emit("remove", first); f.events.emit("remove", second); await closing;
  }
});

it("propagates shutdown failures and never installs an error suppressor", async () => {
  const f = await fixture(), failure = new Error("unexpected pool failure");
  expect(f.events.listenerCount("error")).toBe(0);
  expect(() => f.events.emit("error", failure)).toThrow(failure);
  f.end.mockRejectedValueOnce(failure);
  await expect(f.close()).rejects.toBe(failure);
  expect(f.drops()).toHaveLength(0);
});
