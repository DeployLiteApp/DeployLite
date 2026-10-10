import { expect, it, vi } from "vitest";
import { DockerProcessRunner, type SpawnedProcess } from "./docker-process-runner.js";
import { MANAGED_DATABASE_NETWORK_INSPECT_FORMAT, MANAGED_DATABASE_VOLUME_INSPECT_FORMAT } from "./docker-managed-database-resource-argv.js";
it("preserves only exact native resource names, physical IDs and public plan digests", async () => {
    for (const kind of ["network", "volume"] as const) {
        const name = "dl-" + "a".repeat(32) + (kind === "network" ? "-net-" : "-vol-") + "db-orders", id = "b".repeat(64), planDigest = "c".repeat(64);
        const format = kind === "network" ? MANAGED_DATABASE_NETWORK_INSPECT_FORMAT : MANAGED_DATABASE_VOLUME_INSPECT_FORMAT;
        const events = new Map<string, (...args: unknown[]) => void>(), stdout = { on: vi.fn() }, stderr = { on: vi.fn() };
        const child = { stdout, stderr, once: vi.fn((key: string, callback: (...args: unknown[]) => void) => { events.set(key, callback); return child; }), kill: vi.fn() } as unknown as SpawnedProcess;
        const promise = new DockerProcessRunner({ spawn: () => child }).run(["docker", kind, "inspect", "--format", format, name], new AbortController().signal);
        const value = { name, ...(kind === "network" ? { id } : { createdAt: "2026-10-10T00:00:00Z" }), planDigest, note: { planDigest }, password: "private" };
        stdout.on.mock.calls[0]![1](JSON.stringify(value));
        events.get("close")!(0, null);
        const parsed = JSON.parse((await promise).stdout);
        expect(parsed.name).toBe(name);
        expect(parsed.planDigest).toBe(planDigest);
        expect(parsed.note.planDigest).toBe("[REDACTED]");
        expect(parsed.password).toBe("[REDACTED]");
        if (kind === "network")
            expect(parsed.id).toBe(id);
    }
});
