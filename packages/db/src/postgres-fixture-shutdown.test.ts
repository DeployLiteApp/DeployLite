import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { trackPostgresFixtureShutdown } from "./postgres-fixture-shutdown.js";
function fixture() {
  const events = new EventEmitter();
  const end = vi.fn(async () => {});
  const pool = { on: events.on.bind(events), end } as unknown as Pick<Pool, "on" | "end">;
  return { events, end, close: trackPostgresFixtureShutdown(pool) };
}
describe("owned PostgreSQL fixture shutdown", () => {
  it("waits for every connection removal after the pool end promise resolves", async () => {
    const f = fixture(), first = {}, second = {};
    f.events.emit("connect", first); f.events.emit("connect", second);
    let closed = false;
    const closing = f.close().then(() => { closed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.end).toHaveBeenCalledOnce(); expect(closed).toBe(false);
    f.events.emit("remove", first);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(closed).toBe(false);
    f.events.emit("remove", second); await closing; expect(closed).toBe(true);
  });
  it("does not wait on a connection already removed before shutdown", async () => {
    const f = fixture(), client = {};
    f.events.emit("connect", client); f.events.emit("remove", client);
    await f.close(); expect(f.end).toHaveBeenCalledOnce();
  });
  it("propagates pool shutdown failure without accepting closure", async () => {
    const f = fixture(); f.events.emit("connect", {});
    f.end.mockRejectedValueOnce(new Error("fixture close failed"));
    await expect(f.close()).rejects.toThrow("fixture close failed");
  });
});
