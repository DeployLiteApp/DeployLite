import { expect, it, vi } from "vitest";
import { createManagedDatabaseComposePreview, digestComposeResourceObservation, planManagedDatabaseProfile } from "@deploylite/domain";
import type { ComposeResourceObservationV1 } from "@deploylite/contracts";
import { createManagedDatabaseStorageInitializer } from "./docker-managed-database-storage-initializer.js";
const helperId = "b".repeat(64), imageId = "sha256:" + "c".repeat(64);
function fixture() {
    const imagePolicy = { policyVersion: "images-1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true };
    const request = { schemaVersion: 1, projectId: "project-a", databaseId: "orders", engine: "postgres" as const };
    const profile = { schemaVersion: 1, profileId: "profile-a", engine: "postgres" as const, image: `registry.example.com/postgres@sha256:${"a".repeat(64)}`, dataPath: "/var/lib/postgresql/data", containerPort: 5432, credentialKeys: ["DATABASE_PASSWORD"], backupStrategy: "engine-native" as const };
    const plan = planManagedDatabaseProfile(request, profile, imagePolicy), preview = createManagedDatabaseComposePreview(request, profile, imagePolicy);
    const original = { projectId: "project-a", databaseId: "orders", commandId: "command-a", planDigest: plan.planDigest, volume: { name: plan.volume.runtimeName, createdAt: "2026-10-10T00:00:00Z" }, network: { name: plan.network.runtimeName, id: "d".repeat(64) } };
    const input = { request, profile, commandId: "command-a", imageId };
    let helper: any = null;
    const runner = { run: vi.fn(async (argv: readonly string[]) => {
            let stdout = "";
            if (argv[1] === "create") {
                helper = { id: helperId, name: "/" + argv[argv.indexOf("--name") + 1], imageId, image: profile.image, owner: "deploylite", projectId: "project-a", databaseId: "orders", engine: "postgres", commandId: "command-a", planDigest: plan.planDigest,
                    environmentFingerprint: null, storageInitialization: "v1", networkMode: "none", running: false, health: null, user: "0:0", readOnly: true, privileged: false, capAdd: ["CHOWN"], capDrop: ["ALL"], securityOpt: ["no-new-privileges"], cpu: 1000000000, memory: 536870912, pids: 256, ports: null };
                stdout = helperId;
            }
            else if (argv[1] === "start")
                helper.running = true;
            else if (argv[1] === "wait") {
                helper.running = false;
                stdout = "0\n";
            }
            else if (argv[1] === "rm")
                helper = null;
            else
                throw new Error("unexpected process");
            return { exitCode: 0, signal: null, stdout, stderr: "" };
        }) };
    const resourceVerifier = { verifyFresh: vi.fn(async () => structuredClone(original)) };
    const nativeInspector = { inspectImage: vi.fn(async () => ({ imageId, declaredVolumes: [profile.dataPath] })), inspectContainer: vi.fn(async () => structuredClone(helper)) };
    const composeInspector = { inspect: vi.fn(async ({ kind }: {
            kind: "volume" | "network";
        }) => {
            const value = { schemaVersion: 1, owner: "deploylite", agentId: "agent-a", projectId: "project-a", kind, key: plan.volume.key, runtimeName: kind === "volume" ? plan.volume.runtimeName : plan.network.runtimeName,
                physicalIdentity: kind === "volume" ? original.volume.createdAt : original.network.id, configDigest: preview.configDigest, observedAt: 1000, stateDigest: "0".repeat(64),
                containers: helper ? [{ containerId: helperId, service: plan.volume.key, running: helper.running, attached: kind === "volume", composeConfigDigest: preview.configDigest, networks: [{ name: "none", networkId: "f".repeat(64) }], mounts: kind === "volume" ? [{ target: profile.dataPath, readOnly: false }] : [] }] : [] } as ComposeResourceObservationV1;
            value.stateDigest = digestComposeResourceObservation(value);
            return value;
        }) };
    const authority = { assertValid: vi.fn(async () => { }) }, options = { owner: "deploylite", agentId: "agent-a", imagePolicy, runner, resourceVerifier, nativeInspector, composeInspector, clock: { now: () => 1000 }, limits: { deadlineMs: 5000, maxOutputBytes: 8192, cpus: 1, memoryBytes: 536870912, pidsLimit: 256 } };
    return { input, original, options, runner, authority, nativeInspector, composeInspector, resourceVerifier, getHelper: () => helper, initializer: createManagedDatabaseStorageInitializer(options) };
}
it("initializes only original empty storage with individually fenced helper effects", async () => {
    const f = fixture(), result = await f.initializer.initializeFresh(f.input, f.original, f.authority, new AbortController().signal);
    expect(result).toEqual(f.original);
    expect(f.runner.run.mock.calls.map(([argv]) => argv[1])).toEqual(["create", "start", "wait", "rm"]);
    expect(f.authority.assertValid).toHaveBeenCalledTimes(4);
    expect(f.getHelper()).toBeNull();
    expect(f.runner.run.mock.calls.every(([argv]) => !argv.includes("--volumes") && !argv.includes("--force") && !argv.includes("run"))).toBe(true);
});
it("preserves the stopped helper and storage when authority is revoked before start", async () => {
    const f = fixture();
    f.authority.assertValid.mockResolvedValueOnce().mockRejectedValue(new Error("revoked"));
    await expect(f.initializer.initializeFresh(f.input, f.original, f.authority, new AbortController().signal)).rejects.toThrow("Database storage initialization is unavailable");
    expect(f.runner.run.mock.calls.map(([argv]) => argv[1])).toEqual(["create"]);
    expect(f.getHelper()?.running).toBe(false);
});
it("rejects changed ownership or extra privileges without starting/removing a helper", async () => {
    for (const patch of [{ commandId: "foreign" }, { capAdd: ["CHOWN", "SYS_ADMIN"] }, { networkMode: "host" }]) {
        const f = fixture(), inspect = f.nativeInspector.inspectContainer.getMockImplementation()!;
        f.nativeInspector.inspectContainer.mockImplementation(async () => ({ ...await inspect(), ...patch }));
        await expect(f.initializer.initializeFresh(f.input, f.original, f.authority, new AbortController().signal)).rejects.toThrow("Database storage initialization is unavailable");
        expect(f.runner.run.mock.calls.map(([argv]) => argv[1])).toEqual(["create"]);
    }
});
it("refuses unrelated image volumes and global stale proof before creating a helper", async () => {
    const f = fixture();
    f.nativeInspector.inspectImage.mockResolvedValue({ imageId, declaredVolumes: ["/anonymous"] });
    await expect(f.initializer.initializeFresh(f.input, f.original, f.authority, new AbortController().signal)).rejects.toThrow("Database storage initialization is unavailable");
    expect(f.nativeInspector.inspectImage).toHaveBeenCalledOnce();
    expect(f.runner.run).not.toHaveBeenCalled();
    const stale = fixture();
    stale.resourceVerifier.verifyFresh.mockResolvedValue({ ...stale.original, network: { ...stale.original.network, id: "e".repeat(64) } });
    await expect(stale.initializer.initializeFresh(stale.input, stale.original, stale.authority, new AbortController().signal)).rejects.toThrow("Database storage initialization is unavailable");
    expect(stale.resourceVerifier.verifyFresh).toHaveBeenCalledOnce();
    expect(stale.runner.run).not.toHaveBeenCalled();
});
it("bounds stalled helper processes while preserving ambiguous state", async () => {
    const f = fixture();
    f.options.limits.deadlineMs = 1;
    f.runner.run.mockImplementation(() => new Promise(() => { }));
    await expect(createManagedDatabaseStorageInitializer(f.options).initializeFresh(f.input, f.original, f.authority, new AbortController().signal)).rejects.toThrow("Database storage initialization is unavailable");
    expect(f.runner.run).toHaveBeenCalledOnce();
});
it("withholds success and preserves the stopped helper after a failing permission process", async () => {
    const f = fixture(), run = f.runner.run.getMockImplementation()!;
    f.runner.run.mockImplementation(async (argv) => { const value = await run(argv); return argv[1] === "wait" ? { ...value, stdout: "1\n" } : value; });
    await expect(f.initializer.initializeFresh(f.input, f.original, f.authority, new AbortController().signal)).rejects.toThrow("Database storage initialization is unavailable");
    expect(f.runner.run.mock.calls.map(([argv]) => argv[1])).toEqual(["create", "start", "wait"]);
    expect(f.getHelper()?.running).toBe(false);
});
it("does not trust a successful remove reply while the original consumer remains", async () => {
    const f = fixture(), run = f.runner.run.getMockImplementation()!;
    f.runner.run.mockImplementation(async (argv) => argv[1] === "rm" ? { exitCode: 0, signal: null, stdout: "", stderr: "" } : run(argv));
    await expect(f.initializer.initializeFresh(f.input, f.original, f.authority, new AbortController().signal)).rejects.toThrow("Database storage initialization is unavailable");
    expect(f.runner.run.mock.calls.map(([argv]) => argv[1])).toEqual(["create", "start", "wait", "rm"]);
    expect(f.getHelper()).not.toBeNull();
});
it("refuses a previous global consumer before initializing existing storage", async () => {
    const f = fixture(), inspect = f.composeInspector.inspect.getMockImplementation()!;
    f.composeInspector.inspect.mockImplementation(async (input) => {
        const value = await inspect(input);
        value.containers = [{ containerId: "e".repeat(64), service: "db-orders", running: false, attached: true, networks: [], mounts: [{ target: "/var/lib/postgresql/data", readOnly: false }] }];
        value.stateDigest = digestComposeResourceObservation(value);
        return value;
    });
    await expect(f.initializer.initializeFresh(f.input, f.original, f.authority, new AbortController().signal)).rejects.toThrow("Database storage initialization is unavailable");
    expect(f.runner.run).not.toHaveBeenCalled();
});
