import { expect, it, vi } from "vitest";
import { DockerProcessRunner, type SpawnedProcess } from "./docker-process-runner.js";
import { MANAGED_DATABASE_CONTAINER_INSPECT_FORMAT } from "./docker-managed-database-inspection-argv.js";
import { MANAGED_DATABASE_NETWORK_INSPECT_FORMAT, MANAGED_DATABASE_VOLUME_INSPECT_FORMAT } from "./docker-managed-database-resource-argv.js";
it.each([MANAGED_DATABASE_CONTAINER_INSPECT_FORMAT, MANAGED_DATABASE_NETWORK_INSPECT_FORMAT, MANAGED_DATABASE_VOLUME_INSPECT_FORMAT])("preserves bounded public native scope only in its exact root projection", async (format) => {
    const scope = { owner: "a".repeat(64), projectId: "b".repeat(64), databaseId: "c".repeat(60), commandId: "d".repeat(64) };
    const events = new Map<string, (...args: unknown[]) => void>(), stdout = { on: vi.fn() }, stderr = { on: vi.fn() };
    const child = { stdout, stderr, once: vi.fn((key: string, callback: (...args: unknown[]) => void) => { events.set(key, callback); return child; }), kill: vi.fn() } as unknown as SpawnedProcess;
    const promise = new DockerProcessRunner({ spawn: () => child }).run(["docker", format === MANAGED_DATABASE_CONTAINER_INSPECT_FORMAT ? "container" : format === MANAGED_DATABASE_NETWORK_INSPECT_FORMAT ? "network" : "volume", "inspect", "--format", format, "owned"], new AbortController().signal);
    stdout.on.mock.calls[0]![1](JSON.stringify({ ...scope, note: scope, unknown: "e".repeat(64) }));
    events.get("close")!(0, null);
    const value = JSON.parse((await promise).stdout);
    for (const [key, expected] of Object.entries(scope)) {
        expect(value[key]).toBe(expected);
        expect(value.note[key]).toBe("[REDACTED]");
    }
    expect(value.unknown).toBe("[REDACTED]");
});
it("keeps long native service/resource scope intact through the reused Compose projections", async () => {
    const { COMPOSE_CONTAINER_INSPECT_FORMAT, COMPOSE_NETWORK_INSPECT_FORMAT, COMPOSE_VOLUME_INSPECT_FORMAT } = await import("./docker-compose-resource-argv.js");
    for (const format of [COMPOSE_CONTAINER_INSPECT_FORMAT, COMPOSE_NETWORK_INSPECT_FORMAT, COMPOSE_VOLUME_INSPECT_FORMAT]) {
        const owner = "a".repeat(64), projectId = "b".repeat(64), key = "db-" + "c".repeat(60), scope = { owner, projectId, ...(format === COMPOSE_CONTAINER_INSPECT_FORMAT ? { service: key } : { resourceKey: key }) };
        const events = new Map<string, (...args: unknown[]) => void>(), stdout = { on: vi.fn() }, stderr = { on: vi.fn() };
        const child = { stdout, stderr, once: vi.fn((name: string, callback: (...args: unknown[]) => void) => { events.set(name, callback); return child; }), kill: vi.fn() } as unknown as SpawnedProcess;
        const promise = new DockerProcessRunner({ spawn: () => child }).run(["docker", format === COMPOSE_CONTAINER_INSPECT_FORMAT ? "container" : format === COMPOSE_NETWORK_INSPECT_FORMAT ? "network" : "volume", "inspect", "--format", format, "owned"], new AbortController().signal);
        stdout.on.mock.calls[0]![1](JSON.stringify({ ...scope, note: scope, unknown: "e".repeat(64) }));
        events.get("close")!(0, null);
        const value = JSON.parse((await promise).stdout);
        for (const [name, expected] of Object.entries(scope)) {
            expect(value[name]).toBe(expected);
            expect(value.note[name]).not.toBe(expected);
        }
        expect(value.unknown).toBe("[REDACTED]");
    }
});
