import { expect, it, vi } from "vitest";
import type { DockerCliRunner } from "./docker-cli-image-transport.js";
import { createManagedDatabaseProcessIdentityReader } from "./docker-managed-database-process-identity.js";
const id = "c".repeat(64);
function fixture(stdout = "999\npostgres\n999 999 999 999\n") {
    const runner = { run: vi.fn<DockerCliRunner["run"]>(async () => ({ exitCode: 0, signal: null, stdout, stderr: "" })) };
    const options = { runner, clock: { now: () => 1000 }, limits: { deadlineMs: 1000, maxOutputBytes: 1024 } };
    return { runner, options, reader: createManagedDatabaseProcessIdentityReader(options) };
}
it("verifies the actual native account and all PID1 UIDs for each engine", async () => {
    for (const [engine, daemon] of [["postgres", "postgres"], ["mysql", "mysqld"], ["mariadb", "mariadbd"], ["mongodb", "mongod"], ["redis", "redis-server"]] as const) {
        const f = fixture(`999\n${daemon}\n999 999 999 999\n`);
        expect(await f.reader.verify(id, engine, new AbortController().signal)).toEqual({ uid: 999, daemon });
    }
});
it("uses a static read-only process projection with no environment or health logs", async () => {
    const f = fixture();
    await f.reader.verify(id, "postgres", new AbortController().signal);
    const argv = f.runner.run.mock.calls[0]?.[0] as unknown as readonly string[];
    expect(argv.slice(0, 4)).toEqual(["docker", "exec", id, "sh"]);
    expect(argv.join(" ")).toContain("/proc/1/status");
    expect(argv.join(" ")).not.toMatch(/environ|printenv|passwd|--privileged|--user/);
});
it("returns only frozen numeric identity, never private diagnostics", async () => {
    const f = fixture(), value = await f.reader.verify(id, "postgres", new AbortController().signal);
    expect(Object.isFrozen(value)).toBe(true);
    expect(JSON.stringify(value)).toBe('{"uid":999,"daemon":"postgres"}');
});
it("can verify a nonstandard unprivileged image account without guessing fixed UIDs", async () => {
    const f = fixture("12345\npostgres\n12345 12345 12345 12345\n");
    expect(await f.reader.verify(id, "postgres", new AbortController().signal)).toEqual({ uid: 12345, daemon: "postgres" });
});
it("rejects root, changed UID, a temporary server, malformed or secret-bearing output", async () => {
    for (const stdout of ["0\npostgres\n0 0 0 0\n", "999\npostgres\n999 0 999 999\n", "999\nsh\n999 999 999 999\n", "999\nmysqld\n999 999 999 999\n", "999\npostgres\n999 999 999\n", "999\npostgres\n999 999 999 999\npassword=private", "999\npostgres\n999 999 999 999\n".repeat(100)]) {
        await expect(fixture(stdout).reader.verify(id, "postgres", new AbortController().signal)).rejects.toThrow(/^Database process identity is unavailable\.$/);
    }
});
it("rejects unsafe selectors, engines and cancellation before invoking Docker", async () => {
    const f = fixture(), controller = new AbortController();
    controller.abort();
    await expect(f.reader.verify("--all", "postgres", new AbortController().signal)).rejects.toThrow();
    await expect(f.reader.verify(id, "unknown" as "postgres", new AbortController().signal)).rejects.toThrow();
    await expect(f.reader.verify(id, "postgres", controller.signal)).rejects.toThrow();
    expect(f.runner.run).not.toHaveBeenCalled();
});
it("bounds uncooperative ports, clock movement and failed diagnostics", async () => {
    const f = fixture();
    const stalled = createManagedDatabaseProcessIdentityReader({ ...f.options, runner: { run: () => new Promise<never>(() => { }) }, limits: { ...f.options.limits, deadlineMs: 1 } });
    await expect(stalled.verify(id, "postgres", new AbortController().signal)).rejects.toThrow();
    f.runner.run.mockResolvedValue({ exitCode: 1, signal: null, stdout: "password=private", stderr: "token=private" });
    await expect(f.reader.verify(id, "postgres", new AbortController().signal)).rejects.toThrow(/^Database process identity is unavailable\.$/);
    let n = 0;
    const moved = createManagedDatabaseProcessIdentityReader({ ...fixture().options, clock: { now: () => n++ ? 999 : 1000 } });
    await expect(moved.verify(id, "postgres", new AbortController().signal)).rejects.toThrow();
});
