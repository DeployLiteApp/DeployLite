import { expect, it, vi } from "vitest";
import { createManagedDatabaseComposePreview, digestComposeResourceObservation, digestControlInput, planManagedDatabaseProfile } from "@deploylite/domain";
import { createManagedDatabaseReadinessVerifier } from "./docker-managed-database-readiness.js";
import type { ManagedDatabaseContainerObservation } from "./docker-managed-database-inspection.js";
import { managedDatabaseContainerName } from "./docker-managed-database-argv.js";
const containerId = "b".repeat(64), imageId = "sha256:" + "c".repeat(64), environmentFingerprint = "d".repeat(32);
function fixture(engine: "postgres" | "mysql" | "mariadb" | "mongodb" | "redis" = "postgres") {
    const imagePolicy = { policyVersion: "images-1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true };
    const request = { schemaVersion: 1, projectId: "project-a", databaseId: "orders", engine };
    const profile = { schemaVersion: 1, profileId: "profile-a", engine, image: `registry.example.com/${engine}@sha256:${"a".repeat(64)}`, dataPath: {postgres:"/var/lib/postgresql/data",mysql:"/var/lib/mysql",mariadb:"/var/lib/mysql",mongodb:"/data/db",redis:"/data"}[engine], containerPort: {postgres:5432,mysql:3306,mariadb:3306,mongodb:27017,redis:6379}[engine], credentialKeys: ["DATABASE_PASSWORD"], backupStrategy: engine === "redis" ? "volume-quiesced" : "engine-native" };
    const plan = planManagedDatabaseProfile(request, profile, imagePolicy), preview = createManagedDatabaseComposePreview(request, profile, imagePolicy);
    const original = { projectId: request.projectId, databaseId: request.databaseId, commandId: "command-a", planDigest: plan.planDigest, volume: { name: plan.volume.runtimeName, createdAt: "2026-10-10T00:00:00Z" }, network: { name: plan.network.runtimeName, id: "e".repeat(64) } };
    const input = { request, profile, commandId: "command-a", imageId, containerId, environmentFingerprint };
    const metadata: ManagedDatabaseContainerObservation = { id: containerId, name: "/" + managedDatabaseContainerName(request.projectId, request.databaseId), imageId, image: profile.image, owner: "deploylite", projectId: request.projectId, databaseId: request.databaseId, engine, commandId: "command-a", planDigest: plan.planDigest, environmentFingerprint,
        networkMode: plan.network.runtimeName, storageInitialization: null, running: true, health: "healthy", user: {postgres:"postgres",mysql:"mysql",mariadb:"mysql",mongodb:"mongodb",redis:"redis"}[engine], readOnly: true, privileged: false, capAdd: null, capDrop: ["ALL"], securityOpt: ["no-new-privileges"], cpu: 1000000000, memory: 536870912, pids: 256, ports: null };
    let extra = false;
    const resourceVerifier = { verifyFresh: vi.fn(async () => structuredClone(original)) };
    const nativeInspector = { inspectImage: vi.fn(async () => ({ imageId, declaredVolumes: [profile.dataPath] })), inspectContainer: vi.fn(async () => structuredClone(metadata)) };
    const composeInspector = { inspect: vi.fn(async ({ kind }: any) => {
            const consumer = { containerId, service: plan.volume.key, running: metadata.running, attached: true, composeConfigDigest: preview.configDigest, composeEnvironmentDigest: digestControlInput({ environmentFingerprint }), networks: [{ name: plan.network.runtimeName, networkId: original.network.id }], mounts: kind === "volume" ? [{ target: plan.volume.target, readOnly: false }] : [] };
            const value: any = { schemaVersion: 1, owner: "deploylite", agentId: "agent-a", projectId: request.projectId, kind, key: plan.volume.key, runtimeName: kind === "volume" ? plan.volume.runtimeName : plan.network.runtimeName, physicalIdentity: kind === "volume" ? original.volume.createdAt : original.network.id, configDigest: preview.configDigest, observedAt: 1000, stateDigest: "0".repeat(64), containers: [consumer, ...(extra ? [{ ...consumer, containerId: "f".repeat(64) }] : [])] };
            value.stateDigest = digestComposeResourceObservation(value);
            return value;
        }) };
    const processIdentityReader = { verify: vi.fn(async () => ({ uid: 999, daemon: {postgres:"postgres",mysql:"mysqld",mariadb:"mariadbd",mongodb:"mongod",redis:"redis-server"}[engine] })) }, authority = { assertValid: vi.fn(async () => { }) };
    const options = { owner: "deploylite", agentId: "agent-a", imagePolicy, resourceVerifier, nativeInspector, composeInspector, processIdentityReader, clock: { now: () => 1000 }, limits: { deadlineMs: 1000, cpus: 1, memoryBytes: 536870912, pidsLimit: 256 } };
    return { input, original, metadata, options, nativeInspector, composeInspector, resourceVerifier, processIdentityReader, authority, addConsumer: () => { extra = true; }, verifier: createManagedDatabaseReadinessVerifier(options) };
}
it("requires two physical snapshots around a verified nonroot PID1 before readiness", async () => {
    const f = fixture(), result = await f.verifier.verify(f.input, f.original, f.authority, new AbortController().signal);
    expect(result).toEqual({ uid: 999, containerId });
    expect(Object.isFrozen(result)).toBe(true);
    expect(f.nativeInspector.inspectContainer).toHaveBeenCalledTimes(2);
    expect(f.composeInspector.inspect).toHaveBeenCalledTimes(4);
    expect(f.processIdentityReader.verify).toHaveBeenCalledWith(containerId, "postgres", expect.any(AbortSignal));
    expect(f.authority.assertValid).toHaveBeenCalledTimes(4);
});
it("refuses a new global consumer appearing during the PID1 probe", async () => {
    const f = fixture();
    f.processIdentityReader.verify.mockImplementation(async () => { f.addConsumer(); return { uid: 999, daemon: "postgres" }; });
    await expect(f.verifier.verify(f.input, f.original, f.authority, new AbortController().signal)).rejects.toThrow("Database readiness is unavailable");
    expect(f.processIdentityReader.verify).toHaveBeenCalledOnce();
});
it("withholds readiness when current authority is revoked after corroboration", async () => {
    const f = fixture();
    f.authority.assertValid.mockResolvedValueOnce().mockResolvedValueOnce().mockResolvedValueOnce().mockRejectedValue(new Error("revoked"));
    await expect(f.verifier.verify(f.input, f.original, f.authority, new AbortController().signal)).rejects.toThrow("Database readiness is unavailable");
    expect(f.processIdentityReader.verify).toHaveBeenCalledOnce();
    expect(f.authority.assertValid).toHaveBeenCalledTimes(4);
});
it("does not mistake a helper, changed environment, host ports, root or temporary health for readiness", async () => {
    for (const patch of [{ storageInitialization: "v1" }, { environmentFingerprint: "f".repeat(32) }, { health: "starting" }, { running: false }, { capAdd: ["CHOWN"] }, { user: "0:0" }, { ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "12345" }] } }]) {
        const f = fixture();
        Object.assign(f.metadata, patch);
        await expect(f.verifier.verify(f.input, f.original, f.authority, new AbortController().signal)).rejects.toThrow(/^Database readiness is unavailable\.$/);
        expect(f.processIdentityReader.verify).not.toHaveBeenCalled();
    }
});
it("rejects changed original resources or unexpected image volumes before a PID probe", async () => {
    const f = fixture();
    f.resourceVerifier.verifyFresh.mockResolvedValue({ ...f.original, network: { ...f.original.network, id: "f".repeat(64) } });
    await expect(f.verifier.verify(f.input, f.original, f.authority, new AbortController().signal)).rejects.toThrow();
    expect(f.processIdentityReader.verify).not.toHaveBeenCalled();
    const image = fixture();
    image.nativeInspector.inspectImage.mockResolvedValue({ imageId, declaredVolumes: ["/anonymous"] });
    await expect(image.verifier.verify(image.input, image.original, image.authority, new AbortController().signal)).rejects.toThrow();
    expect(image.processIdentityReader.verify).not.toHaveBeenCalled();
});
it("bounds an uncooperative native inspection without leaking diagnostics", async () => {
    const f = fixture();
    f.nativeInspector.inspectContainer.mockImplementation(() => new Promise<never>(() => { }));
    const verifier = createManagedDatabaseReadinessVerifier({ ...f.options, limits: { ...f.options.limits, deadlineMs: 1 } });
    await expect(verifier.verify(f.input, f.original, f.authority, new AbortController().signal)).rejects.toThrow(/^Database readiness is unavailable\.$/);
});
it("rechecks authority immediately before the PID1 exec projection", async () => {
    const f = fixture();
    f.authority.assertValid.mockResolvedValueOnce().mockRejectedValue(new Error("revoked before exec"));
    await expect(f.verifier.verify(f.input, f.original, f.authority, new AbortController().signal)).rejects.toThrow();
    expect(f.nativeInspector.inspectContainer).toHaveBeenCalledOnce();
    expect(f.processIdentityReader.verify).not.toHaveBeenCalled();
});

for (const engine of ["postgres", "mysql", "mariadb", "mongodb", "redis"] as const) {
    it(`corroborates ${engine} native daemon and original persistent storage`, async () => {
        const f = fixture(engine);
        const result = await f.verifier.verify(f.input, f.original, f.authority, new AbortController().signal);
        expect(f.input.request.engine).toBe(engine);
        expect(result.containerId).toBe(containerId);
        expect(f.processIdentityReader.verify).toHaveBeenCalledWith(containerId, engine, expect.any(AbortSignal));
        expect(f.composeInspector.inspect).toHaveBeenCalledTimes(4);
        expect(f.resourceVerifier.verifyFresh).toHaveBeenCalledTimes(2);
    });
}

it("corroborates a stopped original daemon before granting start", async () => {
    const f = fixture();
    f.metadata.running = false;
    f.metadata.health = null;
    const result = await f.verifier.verifyStopped(f.input, f.original, f.authority, new AbortController().signal);
    expect(result).toEqual({containerId});
    expect(f.nativeInspector.inspectContainer).toHaveBeenCalledTimes(2);
    expect(f.processIdentityReader.verify).not.toHaveBeenCalled();
});
it("refuses start admission for a running daemon or a changed original consumer", async () => {
    const running = fixture();
    await expect(running.verifier.verifyStopped(running.input, running.original, running.authority, new AbortController().signal)).rejects.toThrow();
    const changed = fixture();
    changed.metadata.running = false;
    changed.metadata.health = null;
    changed.addConsumer();
    await expect(changed.verifier.verifyStopped(changed.input, changed.original, changed.authority, new AbortController().signal)).rejects.toThrow();
});
