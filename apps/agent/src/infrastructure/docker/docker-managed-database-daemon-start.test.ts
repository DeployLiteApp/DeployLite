import { expect, it, vi } from "vitest";
import { createManagedDatabaseDaemonStarter } from "./docker-managed-database-daemon-start.js";
import type { DockerCliRunner } from "./docker-cli-image-transport.js";
const containerId = "b".repeat(64), imageId = "sha256:" + "c".repeat(64);
function fixture(engine: "postgres" | "mysql" | "mariadb" | "mongodb" | "redis" = "postgres") {
    const input = {request: {schemaVersion: 1, projectId: "project-a", databaseId: "orders", engine}, profile: {}, commandId: "command-a", imageId, containerId, environmentFingerprint: "d".repeat(32)};
    const original = {projectId: "project-a", databaseId: "orders", commandId: "command-a", planDigest: "e".repeat(64), volume: {name: "volume-a", createdAt: "2026-10-10T00:00:00Z"}, network: {name: "network-a", id: "f".repeat(64)}};
    const events: string[] = [];
    const verifier = {
        verifyStopped: vi.fn(async () => {events.push("stopped-proof"); return Object.freeze({containerId});}),
        verify: vi.fn(async () => {events.push("ready-proof"); return Object.freeze({containerId, uid: 999 as number});})
    };
    const authority = {assertValid: vi.fn(async () => {events.push("authority");})};
    const runner = {run: vi.fn<DockerCliRunner["run"]>(async () => {events.push("start"); return {exitCode: 0, signal: null, stdout: containerId + "\n", stderr: ""};})};
    const nativeInspector = {inspectContainer: vi.fn(async () => {events.push("health"); return {id: containerId, imageId, running: true, health: "healthy"} as any;})};
    const options = {runner, verifier, nativeInspector, clock: {now: () => 1000}, limits: {deadlineMs: 1000, pollIntervalMs: 1, maxOutputBytes: 1024}};
    return {input, original, events, authority, runner, verifier, nativeInspector, options, starter: createManagedDatabaseDaemonStarter(options)};
}
for (const engine of ["postgres", "mysql", "mariadb", "mongodb", "redis"] as const) {
    it(`starts only the admitted original ${engine} daemon and corroborates readiness`, async () => {
        const f = fixture(engine);
        expect(await f.starter.start(f.input, f.original, f.authority, new AbortController().signal)).toEqual({containerId, uid: 999});
        expect(f.events).toEqual(["authority", "stopped-proof", "authority", "start", "authority", "health", "ready-proof", "authority"]);
        expect(f.runner.run).toHaveBeenCalledWith(["docker", "start", containerId], expect.any(AbortSignal));
        expect(f.verifier.verify).toHaveBeenCalledWith(f.input, f.original, f.authority, expect.any(AbortSignal));
    });
}
it("does not start when stopped admission or immediate authority fails", async () => {
    const f = fixture();
    f.verifier.verifyStopped.mockRejectedValue(new Error("private-diagnostic"));
    await expect(f.starter.start(f.input, f.original, f.authority, new AbortController().signal)).rejects.toThrow(/^Database daemon startup is unavailable\.$/);
    expect(f.runner.run).not.toHaveBeenCalled();
    const revoked = fixture();
    revoked.authority.assertValid.mockResolvedValueOnce().mockRejectedValue(new Error("revoked"));
    await expect(revoked.starter.start(revoked.input, revoked.original, revoked.authority, new AbortController().signal)).rejects.toThrow();
    expect(revoked.runner.run).not.toHaveBeenCalled();
});
it("waits through starting health before stable readiness without repeating start", async () => {
    const f = fixture();
    f.nativeInspector.inspectContainer.mockResolvedValueOnce({id: containerId, imageId, running: true, health: "starting"});
    await f.starter.start(f.input, f.original, f.authority, new AbortController().signal);
    expect(f.nativeInspector.inspectContainer).toHaveBeenCalledTimes(2);
    expect(f.runner.run).toHaveBeenCalledOnce();
    expect(f.verifier.verify).toHaveBeenCalledOnce();
});
it("preserves ambiguous state and refuses unhealthy, stopped or changed daemon", async () => {
    for (const patch of [{health: "unhealthy"}, {health: null}, {running: false}, {id: "a".repeat(64)}, {imageId: "sha256:" + "a".repeat(64)}]) {
        const f = fixture();
        f.nativeInspector.inspectContainer.mockResolvedValue({id: containerId, imageId, running: true, health: "healthy", ...patch});
        await expect(f.starter.start(f.input, f.original, f.authority, new AbortController().signal)).rejects.toThrow();
        expect(f.verifier.verify).not.toHaveBeenCalled();
        expect(f.runner.run.mock.calls.map(([argv]: any) => argv[1])).toEqual(["start"]);
    }
});
it("withholds success after final proof or authority revocation", async () => {
    const f = fixture();
    f.verifier.verify.mockRejectedValue(new Error("changed-volume"));
    await expect(f.starter.start(f.input, f.original, f.authority, new AbortController().signal)).rejects.toThrow();
    const revoked = fixture();
    revoked.authority.assertValid.mockResolvedValueOnce().mockResolvedValueOnce().mockResolvedValueOnce().mockRejectedValue(new Error("revoked"));
    await expect(revoked.starter.start(revoked.input, revoked.original, revoked.authority, new AbortController().signal)).rejects.toThrow();
});
it("bounds stalled start and health ports without deleting original resources", async () => {
    for (const stage of ["start", "health"] as const) {
        const f = fixture();
        if (stage === "start") f.runner.run.mockImplementation(() => new Promise<never>(() => {}));
        else f.nativeInspector.inspectContainer.mockImplementation(() => new Promise<never>(() => {}));
        const starter = createManagedDatabaseDaemonStarter({...f.options, limits: {...f.options.limits, deadlineMs: 5}});
        await expect(starter.start(f.input, f.original, f.authority, new AbortController().signal)).rejects.toThrow();
        expect(f.runner.run.mock.calls.map(([argv]: any) => argv[1])).toEqual(["start"]);
        expect(f.verifier.verify).not.toHaveBeenCalled();
    }
});
it("rejects failed or wrong start replies, invalid selectors and pre-cancellation", async () => {
    for (const patch of [{exitCode: 1}, {stdout: "a".repeat(64)}, {signal: "SIGTERM"}, {stdout: containerId + "\nprivate"}]) {
        const f = fixture();
        f.runner.run.mockResolvedValue({...{exitCode: 0, signal: null, stdout: containerId + "\n", stderr: ""}, ...patch} as any);
        f.runner.run.mockClear();
        await expect(f.starter.start(f.input, f.original, f.authority, new AbortController().signal)).rejects.toThrow();
        expect(f.verifier.verify).not.toHaveBeenCalled();
    }
    const f = fixture(), canceled = new AbortController(); canceled.abort();
    await expect(f.starter.start(f.input, f.original, f.authority, canceled.signal)).rejects.toThrow();
    await expect(f.starter.start({...f.input, containerId: "--all"}, f.original, f.authority, new AbortController().signal)).rejects.toThrow();
    expect(f.runner.run).not.toHaveBeenCalled();
});
it("rejects forged admission/readiness identities without granting success", async () => {
    const f = fixture();
    f.verifier.verifyStopped.mockResolvedValue({containerId: "a".repeat(64)});
    await expect(f.starter.start(f.input, f.original, f.authority, new AbortController().signal)).rejects.toThrow();
    expect(f.runner.run).not.toHaveBeenCalled();
    const changed = fixture();
    changed.verifier.verify.mockResolvedValue({containerId, uid: 0});
    await expect(changed.starter.start(changed.input, changed.original, changed.authority, new AbortController().signal)).rejects.toThrow();
});
it("expires before effects and cancels a starting health wait", async () => {
    const f = fixture(); let now = 1000;
    const starter = createManagedDatabaseDaemonStarter({...f.options, clock: {now: () => now}});
    f.verifier.verifyStopped.mockImplementation(async () => {now += 1000; return {containerId};});
    await expect(starter.start(f.input, f.original, f.authority, new AbortController().signal)).rejects.toThrow();
    expect(f.runner.run).not.toHaveBeenCalled();
    const canceled = fixture(), controller = new AbortController();
    canceled.nativeInspector.inspectContainer.mockImplementation(async () => {controller.abort(); return {id: containerId, imageId, running: true, health: "starting"};});
    await expect(canceled.starter.start(canceled.input, canceled.original, canceled.authority, controller.signal)).rejects.toThrow();
    expect(canceled.verifier.verify).not.toHaveBeenCalled();
});
