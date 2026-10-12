import { openAgentSecretEnvelope } from "@deploylite/config";
import { MANAGED_DATABASE_RUNTIME_CAPABILITY, managedDatabaseRuntimeAgentCommandSchema, type CapabilityRegistry, type Clock, type ImageReferencePolicyV1, type ManagedDatabaseEngineV1 } from "@deploylite/contracts";
import { awaitAbortable, managedDatabaseRuntimeExecutionDigest, planManagedDatabaseProfile, validateManagedDatabaseNativeEnvironment } from "@deploylite/domain";
import { buildManagedDatabaseRunArgv } from "./docker-managed-database-argv.js";
import { buildManagedDatabaseStorageInitializationArgv } from "./docker-managed-database-storage-argv.js";
export type ManagedDatabaseStartupPreparationOptions = Readonly<{
    agentId: string;
    owner: string;
    trustKey: string;
    imagePolicy: ImageReferencePolicyV1;
    profiles: Readonly<Partial<Record<ManagedDatabaseEngineV1, unknown>>>;
    capabilities: CapabilityRegistry;
    clock: Clock;
    imageInspector: Readonly<{
        inspectImage(image: string, signal: AbortSignal): Promise<Readonly<{
            imageId: string;
            declaredVolumes: readonly string[];
        }>>;
    }>;
    limits: Readonly<{
        deadlineMs: number;
        cpus: number;
        memoryBytes: number;
        pidsLimit: number;
    }>;
}>;
function fail(): never { throw new Error("Database startup preparation is unavailable."); }
/** Read-only admission. This result is private preparation, not resource ownership, permission to execute, or a readiness receipt. */
export function createManagedDatabaseStartupPreparation(supplied: ManagedDatabaseStartupPreparationOptions) {
    const options = { ...supplied, imagePolicy: structuredClone(supplied.imagePolicy), profiles: structuredClone(supplied.profiles), limits: { ...supplied.limits } };
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(options.agentId) || !/^[A-Za-z0-9_-]{1,200}$/.test(options.owner)
        || !Number.isSafeInteger(options.limits.deadlineMs) || options.limits.deadlineMs < 1 || options.limits.deadlineMs > 60000)
        fail();
    return { async prepare(raw: unknown, authority: Readonly<{
            assertValid(): Promise<void>;
        }>, external: AbortSignal) {
            const controller = new AbortController(), cancel = () => controller.abort();
            external.addEventListener("abort", cancel, { once: true });
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                const command = managedDatabaseRuntimeAgentCommandSchema.parse(structuredClone(raw)), start = options.clock.now();
                if (!Number.isSafeInteger(start) || start < 0)
                    fail();
                const deadline = Math.min(start + options.limits.deadlineMs, start + command.timeoutMs, command.lease.expiresAt);
                function current() {
                    const now = options.clock.now();
                    if (external.aborted || controller.signal.aborted || !Number.isSafeInteger(now) || now < start || now >= deadline
                        || !options.capabilities.has(MANAGED_DATABASE_RUNTIME_CAPABILITY) || command.agentId !== options.agentId)
                        fail();
                }
                current();
                timer = setTimeout(cancel, deadline - start);
                await awaitAbortable(() => authority.assertValid(), controller.signal);
                current();
                const request = { schemaVersion: 1, projectId: command.projectId, databaseId: command.databaseId, engine: command.engine };
                const profile = options.profiles[command.engine], plan = planManagedDatabaseProfile(request, profile, options.imagePolicy);
                if (plan.profileId !== command.profileId || plan.planDigest !== command.planDigest || managedDatabaseRuntimeExecutionDigest({ ...request,
                    profileId: command.profileId, planDigest: command.planDigest, environmentFingerprint: command.environmentFingerprint }) !== command.inputDigest)
                    fail();
                const opened = openAgentSecretEnvelope(command.sealedEnvironment, options.trustKey, { agentId: command.agentId, commandId: command.commandId, inputDigest: command.inputDigest, projectId: command.projectId });
                const native = validateManagedDatabaseNativeEnvironment(request, profile, options.imagePolicy, opened, command.environmentFingerprint);
                const input = { request, profile, imagePolicy: options.imagePolicy, owner: options.owner, commandId: command.commandId, limits: options.limits };
                const runtimeArgv = buildManagedDatabaseRunArgv({ ...input, environment: native.environment, environmentFingerprint: native.environmentFingerprint });
                const storageArgv = buildManagedDatabaseStorageInitializationArgv(input);
                current();
                const image = structuredClone(await awaitAbortable(() => options.imageInspector.inspectImage(plan.image, controller.signal), controller.signal));
                current();
                const allowed = [plan.volume.target, ...(plan.engine === "mongodb" ? ["/data/configdb"] : [])];
                if (!/^sha256:[a-f0-9]{64}$/.test(image.imageId) || !Array.isArray(image.declaredVolumes) || (!image.declaredVolumes.includes(plan.volume.target) && !(plan.engine === "redis" && image.declaredVolumes.length === 0))
                    || image.declaredVolumes.some(path => !allowed.includes(path)) || new Set(image.declaredVolumes).size !== image.declaredVolumes.length)
                    fail();
                await awaitAbortable(() => authority.assertValid(), controller.signal);
                current();
                Object.freeze(plan.volume);
                Object.freeze(plan.network);
                Object.freeze(plan.credentialKeys);
                Object.freeze(plan);
                const result = { plan, imageId: image.imageId, runtimeArgv, storageArgv };
                Object.defineProperty(result, "environment", { value: native.environment, enumerable: false, writable: false, configurable: false });
                return Object.freeze(result) as Readonly<typeof result & {
                    environment: Readonly<Record<string, string>>;
                }>;
            }
            catch {
                return fail();
            }
            finally {
                if (timer !== undefined)
                    clearTimeout(timer);
                external.removeEventListener("abort", cancel);
            }
        } };
}
