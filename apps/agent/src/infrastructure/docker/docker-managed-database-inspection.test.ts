import type { DockerCliRunner } from "./docker-cli-image-transport.js";
import { expect, it, vi } from "vitest";
import { createManagedDatabaseDockerInspector } from "./docker-managed-database-inspection.js";
const image = `registry.example.com/postgres@sha256:${"a".repeat(64)}`, imageId = "sha256:" + "b".repeat(64), id = "c".repeat(64);
const policy = { policyVersion: "images-1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true };
const container = { id, name: "/dl-" + "d".repeat(32) + "-database", imageId, image, owner: "deploylite", projectId: "project-a", databaseId: "orders", engine: "postgres",
    commandId: "command-a", planDigest: "a".repeat(64), environmentFingerprint: "b".repeat(32), networkMode:"dl-network",storageInitialization:null,running: true, health: "healthy", user: "postgres",
    readOnly: true, privileged: false, capAdd: [], capDrop: ["ALL"], securityOpt: ["no-new-privileges"], cpu: 1000000000, memory: 536870912, pids: 256, ports: null };
function fixture(stdout: string) {
    const runner = { run: vi.fn<DockerCliRunner["run"]>(async () => ({ exitCode: 0, signal: null, stdout, stderr: "" })) };
    const options = { runner, imagePolicy: policy, clock: { now: () => 1000 }, limits: { deadlineMs: 5000, maxOutputBytes: 8192 } };
    return { runner, options, inspector: createManagedDatabaseDockerInspector(options) };
}
it("reads only pinned image identity and declared mount targets through the injected runner", async () => {
    const f = fixture(JSON.stringify({ id: imageId, volumes: { "/var/lib/postgresql/data": {} } }));
    expect(await f.inspector.inspectImage(image, new AbortController().signal)).toEqual({ imageId, declaredVolumes: ["/var/lib/postgresql/data"] });
    expect(f.runner.run.mock.calls[0]?.[0]?.slice(0, 3)).toEqual(["docker", "image", "inspect"]);
});
it("projects native container ownership, physical image and hardening without Config.Env or health output", async () => {
    const f = fixture(JSON.stringify(container));
    expect(await f.inspector.inspectContainer(id, new AbortController().signal)).toEqual(container);
    const argv = f.runner.run.mock.calls[0]?.[0];
    expect(argv?.slice(0, 3)).toEqual(["docker", "container", "inspect"]);
    expect(argv?.join(" ")).not.toContain(".Config.Env");
    expect(argv?.join(" ")).not.toContain(".State.Health.Log");
});
it("rejects unpinned images and unsafe container selectors before Docker reads", async () => {
    const f = fixture("private");
    await expect(f.inspector.inspectImage("registry.example.com/postgres:latest", new AbortController().signal)).rejects.toThrow("Database inspection is unavailable");
    await expect(f.inspector.inspectContainer("--all", new AbortController().signal)).rejects.toThrow("Database inspection is unavailable");
    expect(f.runner.run).not.toHaveBeenCalled();
});
it("rejects malformed, secret-bearing and oversized projections with bounded generic errors", async () => {
    for (const value of [{ ...container, environment: { PASSWORD: "private" } }, { ...container, imageId: "malformed" }, { ...container, planDigest: "private" },
        { ...container, capDrop: Array.from({ length: 65 }, () => "ALL") }]) {
        const f = fixture(JSON.stringify(value));
        await expect(f.inspector.inspectContainer(id, new AbortController().signal)).rejects.toThrow("Database inspection is unavailable");
    }
    const f = fixture("x".repeat(9000));
    await expect(f.inspector.inspectImage(image, new AbortController().signal)).rejects.toThrow("Database inspection is unavailable");
});
it("does not read after caller cancellation and bounds an uncooperative process port", async () => {
    const f = fixture("private"), controller = new AbortController();
    controller.abort();
    await expect(f.inspector.inspectImage(image, controller.signal)).rejects.toThrow("Database inspection is unavailable");
    expect(f.runner.run).not.toHaveBeenCalled();
    const runner = { run: vi.fn(() => new Promise<never>(() => { })) }, inspector = createManagedDatabaseDockerInspector({ ...f.options, runner, limits: { deadlineMs: 1, maxOutputBytes: 8192 } });
    await expect(inspector.inspectImage(image, new AbortController().signal)).rejects.toThrow("Database inspection is unavailable");
});
it("never reflects failed daemon diagnostics or unsafe configured bounds", async () => {
    const f = fixture("password=private");
    f.runner.run.mockResolvedValue({ exitCode: 1, signal: null, stdout: "password=private", stderr: "private" });
    await expect(f.inspector.inspectImage(image, new AbortController().signal)).rejects.toThrow(/^Database inspection is unavailable\.$/);
    expect(() => createManagedDatabaseDockerInspector({ ...f.options, limits: { deadlineMs: 0, maxOutputBytes: 8192 } })).toThrow("Database inspection is unavailable");
});

it("projects added capabilities separately so a daemon cannot hide bootstrap privileges",async()=>{
 const value={...container,capAdd:["CHOWN"]},f=fixture(JSON.stringify(value));
 expect(await f.inspector.inspectContainer(id,new AbortController().signal)).toEqual(value);
 expect(f.runner.run.mock.calls[0]![0].join(" ")).toContain(".HostConfig.CapAdd");
});

it("reads bootstrap kind and network mode without private environment fields",async()=>{
 const value={...container,networkMode:"none",storageInitialization:"v1"},f=fixture(JSON.stringify(value));
 expect(await f.inspector.inspectContainer(id,new AbortController().signal)).toEqual(value);
 expect(f.runner.run.mock.calls[0]![0].join(" ")).toContain(".HostConfig.NetworkMode");
});
