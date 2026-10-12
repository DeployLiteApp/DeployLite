import { MANAGED_DATABASE_RUNTIME_CAPABILITY, managedDatabaseRuntimeAgentCommandSchema, managedDatabaseRuntimeReceiptSchema, protocolPayloadFingerprint, type CapabilityRegistry, type Clock, type ImageReferencePolicyV1, type ManagedDatabaseEngineV1 } from "@deploylite/contracts";
import { awaitAbortable, managedDatabaseRuntimeExecutionDigest, planManagedDatabaseProfile } from "@deploylite/domain";
import type { DockerCliRunner } from "./docker-cli-image-transport.js";
import type { createManagedDatabaseStartupPreparation } from "./docker-managed-database-startup-preparation.js";
import type { createManagedDatabaseResourceMaterializer } from "./docker-managed-database-resources.js";
import type { createManagedDatabaseStorageInitializer } from "./docker-managed-database-storage-initializer.js";
import type { createManagedDatabaseDaemonStarter } from "./docker-managed-database-daemon-start.js";
import { managedDatabaseContainerName } from "./docker-managed-database-argv.js";
function fail(): never { throw new Error("Database runtime execution is unavailable."); }
/** Fresh execution only; authenticated claim/cache ownership must be established by the caller. No adoption or replay. */
export function createManagedDatabaseRuntimeExecutor(supplied: Readonly<{
    agentId: string;
    profiles: Readonly<Partial<Record<ManagedDatabaseEngineV1, unknown>>>;
    imagePolicy: ImageReferencePolicyV1;
    capabilities: CapabilityRegistry;
    clock: Clock;
    runner: DockerCliRunner;
    preparation: ReturnType<typeof createManagedDatabaseStartupPreparation>;
    resources: ReturnType<typeof createManagedDatabaseResourceMaterializer>;
    storage: ReturnType<typeof createManagedDatabaseStorageInitializer>;
    starter: ReturnType<typeof createManagedDatabaseDaemonStarter>;
    limits: Readonly<{deadlineMs: number; maxOutputBytes: number}>;
}>) {
    const options = {...supplied, profiles: structuredClone(supplied.profiles), imagePolicy: structuredClone(supplied.imagePolicy), limits: {...supplied.limits}};
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(options.agentId) || !Number.isSafeInteger(options.limits.deadlineMs) || options.limits.deadlineMs < 1 || options.limits.deadlineMs > 60000
        || !Number.isSafeInteger(options.limits.maxOutputBytes) || options.limits.maxOutputBytes < 1 || options.limits.maxOutputBytes > 1048576) fail();
    return {async apply(raw: unknown, authority: Readonly<{assertValid(): Promise<void>}>, external: AbortSignal) {
        const controller = new AbortController(), cancel = () => controller.abort();
        external.addEventListener("abort", cancel, {once: true});
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const command = managedDatabaseRuntimeAgentCommandSchema.parse(structuredClone(raw)), start = options.clock.now();
            if (!Number.isSafeInteger(start) || start < 0) fail();
            const deadline = Math.min(start + options.limits.deadlineMs, start + command.timeoutMs, command.lease.expiresAt);
            function current() {
                const now = options.clock.now();
                if (external.aborted || controller.signal.aborted || !Number.isSafeInteger(now) || now < start || now >= deadline
                    || command.agentId !== options.agentId || !options.capabilities.has(MANAGED_DATABASE_RUNTIME_CAPABILITY)) fail();
            }
            async function call<T>(work: () => Promise<T>): Promise<T> {current(); const value = await awaitAbortable(work, controller.signal); current(); return value;}
            async function authorize() {await call(() => authority.assertValid());}
            current(); timer = setTimeout(cancel, deadline - start);
            await authorize();
            const request = {schemaVersion: 1, projectId: command.projectId, databaseId: command.databaseId, engine: command.engine};
            const profile = options.profiles[command.engine], plan = planManagedDatabaseProfile(request, profile, options.imagePolicy);
            if (plan.profileId !== command.profileId || plan.planDigest !== command.planDigest || managedDatabaseRuntimeExecutionDigest({...request, profileId: command.profileId, planDigest: command.planDigest, environmentFingerprint: command.environmentFingerprint}) !== command.inputDigest) fail();
            const prepared = await call(() => options.preparation.prepare(command, authority, controller.signal));
            if (protocolPayloadFingerprint(prepared.plan) !== protocolPayloadFingerprint(plan) || !/^sha256:[a-f0-9]{64}$/.test(prepared.imageId)
                || JSON.stringify(prepared.runtimeArgv.slice(0, 3)) !== '["docker","run","--detach"]') fail();
            const resourceInput = {request, profile, commandId: command.commandId};
            async function run(argv: readonly string[], environment?: Readonly<Record<string, string>>) {
                const result = await call(() => options.runner.run(Object.freeze([...argv]), controller.signal, environment));
                if (result.exitCode !== 0 || result.signal !== null || Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > options.limits.maxOutputBytes) fail();
                return result.stdout;
            }
            async function absent() {
                const name = managedDatabaseContainerName(command.projectId, command.databaseId);
                const result = await run(["docker", "container", "ls", "--all", "--no-trunc", "--filter", "name=^/" + name + "$", "--format", "{{.ID}}"]);
                if (result.trim() !== "") fail();
            }
            await absent();
            const original = await call(() => options.resources.prepareFresh(resourceInput, authority, controller.signal));
            if (original.projectId !== plan.projectId || original.databaseId !== plan.databaseId || original.commandId !== command.commandId
                || original.planDigest !== plan.planDigest || original.volume.name !== plan.volume.runtimeName || original.network.name !== plan.network.runtimeName) fail();
            const initialized = await call(() => options.storage.initializeFresh({...resourceInput, imageId: prepared.imageId}, original, authority, controller.signal));
            if (protocolPayloadFingerprint(original) !== protocolPayloadFingerprint(initialized)) fail();
            const verified = await call(() => options.resources.verifyFresh(resourceInput, original, authority, controller.signal));
            if (protocolPayloadFingerprint(original) !== protocolPayloadFingerprint(verified)) fail();
            await absent(); await authorize();
            // Create stopped; only the starter's full original-resource admission can permit the start effect.
            const output = await run(["docker", "create", ...prepared.runtimeArgv.slice(3)], prepared.environment);
            if (!/^[a-f0-9]{64}\n?$/.test(output)) fail();
            const containerId = output.trim();
            const ready = await call(() => options.starter.start({...resourceInput, imageId: prepared.imageId, containerId, environmentFingerprint: command.environmentFingerprint}, original, authority, controller.signal));
            if (ready.containerId !== containerId || !Number.isSafeInteger(ready.uid) || ready.uid < 1 || ready.uid > 4294967294) fail();
            await authorize();
            const observedAt = options.clock.now();
            if (!Number.isSafeInteger(observedAt) || observedAt < start || observedAt >= deadline) fail();
            return Object.freeze(managedDatabaseRuntimeReceiptSchema.parse({...request, action: "database.runtime", agentId: command.agentId, commandId: command.commandId,
                inputDigest: command.inputDigest, planDigest: command.planDigest, environmentFingerprint: command.environmentFingerprint, correlationId: command.context.correlationId,
                containerId, imageId: prepared.imageId, volumeName: original.volume.name, networkName: original.network.name, observedAt, status: "ready", health: "passed", storage: "verified", idempotent: false, redacted: true}));
        } catch {return fail();}
        finally {if (timer !== undefined) clearTimeout(timer); external.removeEventListener("abort", cancel);}
    }};
}
