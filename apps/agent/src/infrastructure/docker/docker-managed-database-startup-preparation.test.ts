import { expect, it, vi } from "vitest";
import { sealAgentSecretEnvelope } from "@deploylite/config";
import { InMemoryCapabilityRegistry } from "@deploylite/contracts";
import { digestControlInput, managedDatabaseRuntimeExecutionDigest, planManagedDatabaseProfile } from "@deploylite/domain";
import { createManagedDatabaseStartupPreparation } from "./docker-managed-database-startup-preparation.js";
const trustKey = "test-agent-key-" + "x".repeat(64), password = "b".repeat(64), imageId = "sha256:" + "c".repeat(64);
function fixture(engine: "postgres" | "redis" = "postgres") {
    const imagePolicy = { policyVersion: "images-1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true };
    const request = { schemaVersion: 1, projectId: "project-a", databaseId: "orders", engine };
    const profile = { schemaVersion: 1, profileId: "profile-a", engine, image: `registry.example.com/${engine}@sha256:${"a".repeat(64)}`, dataPath: engine === "redis" ? "/data" : "/var/lib/postgresql/data", containerPort: engine === "redis" ? 6379 : 5432, credentialKeys: ["DATABASE_PASSWORD"], backupStrategy: engine === "redis" ? "volume-quiesced" as const : "engine-native" as const };
    const plan = planManagedDatabaseProfile(request, profile, imagePolicy), preparation = { ...request, profileId: profile.profileId, planDigest: plan.planDigest, environmentFingerprint: "d".repeat(32) };
    const inputDigest = managedDatabaseRuntimeExecutionDigest(preparation), lease = { projectId: "project-a", leaseId: "lease-a", fence: 1, expiresAt: 10000 };
    const environment: Record<string,string> = engine === "redis" ? {REDIS_PASSWORD:password} : { POSTGRES_DB: "orders", POSTGRES_USER: "dl_" + digestControlInput({ projectId: "project-a", databaseId: "orders" }).slice(0, 12), POSTGRES_PASSWORD: password };
    const command = { ...preparation, action: "database.runtime", operation: "database.runtime.apply", agentId: "agent-a", commandId: "command-a", idempotencyKey: "key-a", inputDigest,
        requiredCapabilities: ["database.runtime.v1"], authority: { schemaVersion: 1, projectId: "project-a", commandId: "command-a", action: "project.update", inputDigest, projectLease: lease }, lease,
        context: { requestId: "request-a", correlationId: "correlation-a" }, timeoutMs: 5000, cancellationRequested: false,
        sealedEnvironment: sealAgentSecretEnvelope(environment, trustKey, { agentId: "agent-a", commandId: "command-a", inputDigest, projectId: "project-a" }) };
    const imageInspector = { inspectImage: vi.fn(async () => ({ imageId, declaredVolumes: [profile.dataPath] })) }, authority = { assertValid: vi.fn(async () => { }) };
    const options = { agentId: "agent-a", owner: "deploylite", trustKey, imagePolicy, profiles: { [engine]: profile }, capabilities: new InMemoryCapabilityRegistry(["database.runtime.v1"]),
        clock: { now: () => 1000 }, imageInspector, limits: { deadlineMs: 5000, cpus: 1, memoryBytes: 536870912, pidsLimit: 256 } };
    return { request, profile, plan, command, options, imageInspector, authority, prepare: createManagedDatabaseStartupPreparation(options) };
}
it("opens only the exact existing sealed binding and returns private native preparation", async () => {
    const f = fixture(), result = await f.prepare.prepare(f.command, f.authority, new AbortController().signal);
    expect(result.plan).toEqual(f.plan);
    expect(result.imageId).toBe(imageId);
    expect(result.environment.POSTGRES_PASSWORD).toBe(password);
    expect(JSON.stringify(result)).not.toContain(password);
    expect(JSON.stringify(result)).not.toContain(f.command.sealedEnvironment);
    expect(Object.keys(result)).not.toContain("environment");
    expect(Object.isFrozen(result.environment)).toBe(true);
    expect(result.runtimeArgv.slice(0, 3)).toEqual(["docker", "run", "--detach"]);
    expect(result.storageArgv.slice(0, 3)).toEqual(["docker", "create", "--pull=never"]);
    expect(f.authority.assertValid).toHaveBeenCalledTimes(2);
    expect(f.imageInspector.inspectImage).toHaveBeenCalledWith(f.profile.image, expect.any(AbortSignal));
});
it("rejects image-declared volumes that would escape explicit mounts", async () => {
    const f = fixture();
    f.imageInspector.inspectImage.mockResolvedValue({ imageId, declaredVolumes: [f.profile.dataPath, "/anonymous"] });
    await expect(f.prepare.prepare(f.command, f.authority, new AbortController().signal)).rejects.toThrow("Database startup preparation is unavailable");
    expect(f.imageInspector.inspectImage).toHaveBeenCalledOnce();
});
it("bounds an uncooperative image port and never returns preparation", async () => {
    const f = fixture();
    f.options.limits.deadlineMs = 1;
    f.imageInspector.inspectImage.mockImplementation(() => new Promise(() => { }));
    await expect(createManagedDatabaseStartupPreparation(f.options).prepare(f.command, f.authority, new AbortController().signal)).rejects.toThrow("Database startup preparation is unavailable");
    expect(f.imageInspector.inspectImage).toHaveBeenCalledOnce();
});
it("checks current authority before secret/image access and before returning", async () => {
    const f = fixture();
    f.authority.assertValid.mockRejectedValue(new Error(password));
    await expect(f.prepare.prepare(f.command, f.authority, new AbortController().signal)).rejects.toThrow("Database startup preparation is unavailable");
    expect(f.authority.assertValid).toHaveBeenCalledOnce();
    expect(f.imageInspector.inspectImage).not.toHaveBeenCalled();
    const next = fixture();
    next.authority.assertValid.mockResolvedValueOnce().mockRejectedValue(new Error("revoked"));
    await expect(next.prepare.prepare(next.command, next.authority, new AbortController().signal)).rejects.toThrow("Database startup preparation is unavailable");
    expect(next.imageInspector.inspectImage).toHaveBeenCalledOnce();
});
it("rejects a foreign sealed AAD without projecting secret diagnostics", async () => {
    const f = fixture();
    f.command.sealedEnvironment = sealAgentSecretEnvelope({ POSTGRES_PASSWORD: password }, trustKey, { agentId: "agent-a", commandId: "foreign", inputDigest: f.command.inputDigest, projectId: "project-a" });
    await expect(f.prepare.prepare(f.command, f.authority, new AbortController().signal)).rejects.toThrow("Database startup preparation is unavailable");
    expect(f.authority.assertValid).toHaveBeenCalledOnce();
    expect(f.imageInspector.inspectImage).not.toHaveBeenCalled();
});
it("fails closed for changed local profiles before image reads", async () => {
    const f = fixture();
    f.options.profiles.postgres = { ...f.profile, profileId: "foreign" };
    await expect(createManagedDatabaseStartupPreparation(f.options).prepare(f.command, f.authority, new AbortController().signal)).rejects.toThrow("Database startup preparation is unavailable");
    expect(f.authority.assertValid).toHaveBeenCalledOnce();
    expect(f.imageInspector.inspectImage).not.toHaveBeenCalled();
});
it("rejects foreign digests, expired leases, missing capability, wrong agents and cancelled admission", async () => {
    const f = fixture();
    await f.prepare.prepare(f.command, f.authority, new AbortController().signal);
    for (const patch of [{ inputDigest: "e".repeat(64), authority: { ...f.command.authority, inputDigest: "e".repeat(64) } }, { agentId: "foreign" },
        { lease: { ...f.command.lease, expiresAt: 1000 }, authority: { ...f.command.authority, projectLease: { ...f.command.lease, expiresAt: 1000 } } }])
        await expect(f.prepare.prepare({ ...f.command, ...patch }, f.authority, new AbortController().signal)).rejects.toThrow("Database startup preparation is unavailable");
    await expect(createManagedDatabaseStartupPreparation({ ...f.options, capabilities: new InMemoryCapabilityRegistry([]) }).prepare(f.command, f.authority, new AbortController().signal)).rejects.toThrow("Database startup preparation is unavailable");
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(f.prepare.prepare(f.command, f.authority, cancelled.signal)).rejects.toThrow("Database startup preparation is unavailable");
    expect(f.imageInspector.inspectImage).toHaveBeenCalledOnce();
});

it("keeps the explicit owned Redis data mount when its approved image declares no Docker volumes",async () => {
 const f=fixture("redis");f.imageInspector.inspectImage.mockResolvedValue({imageId,declaredVolumes:[]});
 const prepared=await f.prepare.prepare(f.command,f.authority,new AbortController().signal);
 expect(prepared.runtimeArgv).toContain(`type=volume,source=${f.plan.volume.runtimeName},target=/data,volume-nocopy`);
 expect(prepared.runtimeArgv).toContain("--read-only");
 expect(prepared.environment.REDIS_PASSWORD).toBe(password);
});
