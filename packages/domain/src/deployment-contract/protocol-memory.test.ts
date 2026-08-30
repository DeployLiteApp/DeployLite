import { describe, expect, it } from "vitest";
import { InMemoryProtocolTransport } from "./protocol-memory.js";
import { TransientTransportError } from "@deploylite/contracts";
const clock = { value: 0, now() { return this.value; } }; const options = () => ({ clock, leasePolicy: { ttlMs: 50 }, retryPolicy: { maxAttempts: 3, deadlineMs: 100, backoffMs: () => 1 }, capabilities: ["deploy"] as const });
describe("in-memory protocol delivery", () => {
  it("admits leases, retries bounded transient failures, and replays by identity", () => { const transport = new InMemoryProtocolTransport(options()); const lease = transport.claimLease("d1"); const command = transport.createCommand({ commandId: "c1", deploymentId: "d1", requiredCapabilities: ["deploy"], payload: { image: "x" }, lease }); let attempts = 0; const first = transport.deliver(command, () => { attempts++; if (attempts < 2) throw new TransientTransportError("busy"); return "ok"; }); expect(first.attempts).toBe(2); expect(transport.deliver(command).replayed).toBe(true); });
  it("fences older leases and rejects expired leases", () => { const transport = new InMemoryProtocolTransport(options()); const old = transport.claimLease("d1"); transport.claimLease("d1"); const command = transport.createCommand({ commandId: "old", deploymentId: "d1", requiredCapabilities: [], payload: {}, lease: old }); expect(() => transport.deliver(command)).toThrow("fence"); });
});
