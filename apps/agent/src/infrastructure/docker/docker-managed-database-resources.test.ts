import { expect, it, vi } from "vitest";
import { planManagedDatabaseProfile } from "@deploylite/domain";
import type { DockerCliRunner } from "./docker-cli-image-transport.js";
import { createManagedDatabaseResourceMaterializer } from "./docker-managed-database-resources.js";
const policy = { policyVersion: "images-1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true };
const request = { schemaVersion: 1, projectId: "project-a", databaseId: "orders", engine: "postgres" };
const profile = { schemaVersion: 1, profileId: "profile-a", engine: "postgres", image: `registry.example.com/postgres@sha256:${"a".repeat(64)}`, dataPath: "/var/lib/postgresql/data", containerPort: 5432, credentialKeys: ["DATABASE_PASSWORD"], backupStrategy: "engine-native" };
const plan = planManagedDatabaseProfile(request, profile, policy), commandId = "command-a";
function fixture() {
    const state = new Map<string, Record<string, unknown>>();
    const runner = { run: vi.fn<DockerCliRunner["run"]>(async (argv) => {
            const kind = argv[1]!, action = argv[2]!, name = argv.at(-1)!;
            if (action === "inspect")
                return state.has(kind) ? { exitCode: 0, signal: null, stdout: JSON.stringify(state.get(kind)), stderr: "" } : { exitCode: 1, signal: null, stdout: "", stderr: "Error: No such " + kind + ": " + name };
            if (action === "create") {
                const labels = Object.fromEntries(argv.flatMap((value, index) => value === "--label" ? [argv[index + 1]!.split("=")] : []));
                state.set(kind, { name, driver: kind === "volume" ? "local" : "bridge", scope: "local", optionsCount: 0, owner: labels["com.deploylite.owner"], projectId: labels["com.deploylite.project"],
                    resourceKind: labels["com.deploylite.resource.kind"], resourceKey: labels["com.deploylite.resource.key"], databaseId: labels["com.deploylite.database"], commandId: labels["com.deploylite.database.command"], planDigest: labels["com.deploylite.database.plan"],
                    ...(kind === "volume" ? { createdAt: "2026-10-10T00:00:00Z" } : { id: "b".repeat(64), internal: argv.includes("--internal") }) });
                return { exitCode: 0, signal: null, stdout: kind === "volume" ? name : "b".repeat(64), stderr: "" };
            }
            throw new Error("unexpected operation");
        }) };
    const options = { runner, imagePolicy: policy, owner: "deploylite", clock: { now: () => 1000 }, limits: { deadlineMs: 5000, maxOutputBytes: 8192 } }, authority = { assertValid: vi.fn(async () => { }) };
    return { state, runner, options, authority, materializer: createManagedDatabaseResourceMaterializer(options) };
}
it("creates only fresh scoped resources and corroborates their origin after current authority", async () => {
    const f = fixture();
    const result = await f.materializer.prepareFresh({ request, profile, commandId }, f.authority, new AbortController().signal);
    expect(result).toMatchObject({ projectId: "project-a", databaseId: "orders", commandId, planDigest: plan.planDigest,
        volume: { name: plan.volume.runtimeName, createdAt: "2026-10-10T00:00:00Z" }, network: { name: plan.network.runtimeName, id: "b".repeat(64) } });
    expect(f.authority.assertValid).toHaveBeenCalled();
    expect(f.runner.run.mock.calls.filter(([argv]) => argv[2] === "create").map(([argv]) => argv[1])).toEqual(["volume", "network"]);
    expect(f.runner.run.mock.calls.every(([argv]) => !argv.includes("rm") && !argv.includes("run"))).toBe(true);
});
it("preserves existing owned or foreign resources without adopting, overwriting or deleting them", async () => {
    for (const owner of ["deploylite", "foreign"]) {
        const f = fixture();
        f.state.set("volume", { name: plan.volume.runtimeName, driver: "local", scope: "local", optionsCount: 0, owner, projectId: "project-a", resourceKind: "volume", resourceKey: plan.volume.key, databaseId: "orders", commandId, planDigest: plan.planDigest, createdAt: "2026-10-10T00:00:00Z" });
        const original = structuredClone(f.state.get("volume"));
        await expect(f.materializer.prepareFresh({ request, profile, commandId }, f.authority, new AbortController().signal)).rejects.toThrow("Database resource preparation is unavailable");
        expect(f.state.get("volume")).toEqual(original);
        expect(f.runner.run.mock.calls.some(([argv]) => argv[2] === "create")).toBe(false);
    }
});
it("rejects a foreign creation race before creating the next resource", async () => {
    const f = fixture(), original = f.runner.run.getMockImplementation()!;
    f.runner.run.mockImplementation(async (argv, signal, env) => {
        const result = await original(argv, signal, env);
        if (argv[1] === "volume" && argv[2] === "create")
            f.state.get("volume")!.owner = "foreign";
        return result;
    });
    await expect(f.materializer.prepareFresh({ request, profile, commandId }, f.authority, new AbortController().signal)).rejects.toThrow("Database resource preparation is unavailable");
    expect(f.state.get("volume")?.owner).toBe("foreign");
    expect(f.state.has("network")).toBe(false);
});
it("requires the internal bridge postcondition and preserves partial preparation on failure", async () => {
    const f = fixture(), original = f.runner.run.getMockImplementation()!;
    f.runner.run.mockImplementation(async (argv, signal, env) => {
        const result = await original(argv, signal, env);
        if (argv[1] === "network" && argv[2] === "create")
            f.state.get("network")!.internal = false;
        return result;
    });
    await expect(f.materializer.prepareFresh({ request, profile, commandId }, f.authority, new AbortController().signal)).rejects.toThrow("Database resource preparation is unavailable");
    expect(f.state.has("volume")).toBe(true);
    expect(f.runner.run.mock.calls.some(([argv]) => argv.includes("rm"))).toBe(false);
});
it("rechecks authority before each mutation and never deletes a created volume after revocation", async () => {
    const f = fixture();
    f.authority.assertValid.mockResolvedValueOnce().mockResolvedValueOnce().mockRejectedValue(new Error("revoked"));
    await expect(f.materializer.prepareFresh({ request, profile, commandId }, f.authority, new AbortController().signal)).rejects.toThrow("Database resource preparation is unavailable");
    expect(f.state.has("volume")).toBe(true);
    expect(f.state.has("network")).toBe(false);
    expect(f.runner.run.mock.calls.some(([argv]) => argv.includes("rm"))).toBe(false);
});
it("rejects unsafe identity, bounds and revoked authority before process access", async () => {
    const f = fixture();
    await expect(f.materializer.prepareFresh({ request, profile, commandId: "../foreign" }, f.authority, new AbortController().signal)).rejects.toThrow("Database resource preparation is unavailable");
    f.authority.assertValid.mockRejectedValue(new Error("revoked"));
    await expect(f.materializer.prepareFresh({ request, profile, commandId }, f.authority, new AbortController().signal)).rejects.toThrow("Database resource preparation is unavailable");
    expect(f.runner.run).not.toHaveBeenCalled();
    expect(() => createManagedDatabaseResourceMaterializer({ ...f.options, limits: { deadlineMs: 0, maxOutputBytes: 8192 } })).toThrow("Database resource preparation is unavailable");
});
it("bounds an uncooperative process port without proceeding to creation", async () => {
    const f = fixture(), runner = { run: vi.fn<DockerCliRunner["run"]>(() => new Promise<never>(() => { })) };
    const materializer = createManagedDatabaseResourceMaterializer({ ...f.options, runner, limits: { deadlineMs: 1, maxOutputBytes: 8192 } });
    await expect(materializer.prepareFresh({ request, profile, commandId }, f.authority, new AbortController().signal)).rejects.toThrow("Database resource preparation is unavailable");
    expect(runner.run).toHaveBeenCalledOnce();
});
it("rejects a replaced network during paired postcondition reads", async () => {
    const f = fixture(), original = f.runner.run.getMockImplementation()!;
    f.runner.run.mockImplementation(async (argv, signal, env) => {
        const result = await original(argv, signal, env);
        if (argv[1] === "volume" && argv[2] === "inspect" && f.state.has("network"))
            f.state.get("network")!.id = "d".repeat(64);
        return result;
    });
    await expect(f.materializer.prepareFresh({ request, profile, commandId }, f.authority, new AbortController().signal)).rejects.toThrow("Database resource preparation is unavailable");
    expect(f.state.has("volume")).toBe(true);
    expect(f.runner.run.mock.calls.some(([argv]) => argv.includes("rm"))).toBe(false);
});
it("verifies the original fresh pair through read-only observations", async () => {
    const f = fixture(), input = { request, profile, commandId }, signal = new AbortController().signal;
    const original = await f.materializer.prepareFresh(input, f.authority, signal);
    f.runner.run.mockClear();
    expect(await f.materializer.verifyFresh(input, original, f.authority, signal)).toEqual(original);
    expect(f.runner.run.mock.calls.every(([argv]) => argv[2] === "inspect")).toBe(true);
});
it("rejects original identity changes without recreating or deleting resources", async () => {
    const f = fixture(), input = { request, profile, commandId }, signal = new AbortController().signal;
    const original = await f.materializer.prepareFresh(input, f.authority, signal);
    f.runner.run.mockClear();
    for (const patch of [{ network: { ...original.network, id: "e".repeat(64) } }, { volume: { ...original.volume, createdAt: "2026-10-09T00:00:00Z" } }, { projectId: "foreign" }, { commandId: "foreign" }])
        await expect(f.materializer.verifyFresh(input, { ...original, ...patch }, f.authority, signal)).rejects.toThrow("Database resource preparation is unavailable");
    expect(f.runner.run.mock.calls.every(([argv]) => argv[2] === "inspect")).toBe(true);
});
it("does not turn missing original evidence into a fresh resource operation", async () => {
    const f = fixture();
    await expect(f.materializer.verifyFresh({ request, profile, commandId }, undefined as unknown as import("./docker-managed-database-resources.js").ManagedDatabaseFreshResources, f.authority, new AbortController().signal)).rejects.toThrow("Database resource preparation is unavailable");
    expect(f.runner.run).not.toHaveBeenCalled();
});
