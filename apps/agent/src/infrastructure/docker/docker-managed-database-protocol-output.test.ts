import { expect, it, vi } from "vitest";
import { DockerProcessRunner, type SpawnedProcess } from "./docker-process-runner.js";
import { MANAGED_DATABASE_CONTAINER_INSPECT_FORMAT, MANAGED_DATABASE_IMAGE_INSPECT_FORMAT } from "./docker-managed-database-inspection-argv.js";
function fakeProcess() {
    const callbacks = new Map<string, (...args: unknown[]) => void>();
    const stdout = { on: vi.fn() }, stderr = { on: vi.fn() };
    const child = { stdout, stderr, once: vi.fn((name: string, callback: (...args: unknown[]) => void) => { callbacks.set(name, callback); return child; }), kill: vi.fn() } as unknown as SpawnedProcess;
    return { child, callbacks, stdout };
}
it("preserves only native projection identities and public keyed fingerprints while redacting unknown secrets", async () => {
    const id = "a".repeat(64), imageId = "sha256:" + "b".repeat(64), name = "/dl-" + "c".repeat(32) + "-database", planDigest = "d".repeat(64), environmentFingerprint = "e".repeat(32);
    for (const format of [MANAGED_DATABASE_CONTAINER_INSPECT_FORMAT, MANAGED_DATABASE_IMAGE_INSPECT_FORMAT]) {
        const native = format === MANAGED_DATABASE_CONTAINER_INSPECT_FORMAT;
        const value = native ? { id, name, imageId, planDigest, environmentFingerprint, note: { planDigest }, password: "private-password" } : { id: imageId, volumes: { "/var/lib/postgresql/data": {} }, note: { planDigest }, password: "private-password" };
        const f = fakeProcess(), promise = new DockerProcessRunner({ spawn: () => f.child }).run(["docker", native ? "container" : "image", "inspect", "--format", format, native ? id : "registry.example.com/postgres@sha256:" + id], new AbortController().signal);
        f.stdout.on.mock.calls[0]![1](JSON.stringify(value));
        f.callbacks.get("close")!(0, null);
        const parsed = JSON.parse((await promise).stdout);
        expect(parsed.id).toBe(native ? id : imageId);
        expect(parsed.password).toBe("[REDACTED]");
        expect(parsed.note.planDigest).toBe("[REDACTED]");
        if (native) {
            expect(parsed.name).toBe(name);
            expect(parsed.imageId).toBe(imageId);
            expect(parsed.planDigest).toBe(planDigest);
            expect(parsed.environmentFingerprint).toBe(environmentFingerprint);
        }
    }
});
