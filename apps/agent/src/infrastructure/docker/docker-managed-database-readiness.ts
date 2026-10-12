import { composeResourceObservationSchema, protocolPayloadFingerprint, type Clock, type ImageReferencePolicyV1 } from "@deploylite/contracts";
import { awaitAbortable, createManagedDatabaseComposePreview, digestComposeResourceObservation, digestControlInput, planManagedDatabaseProfile, type ComposeResourceInspector } from "@deploylite/domain";
import type { createManagedDatabaseDockerInspector } from "./docker-managed-database-inspection.js";
import type { createManagedDatabaseProcessIdentityReader } from "./docker-managed-database-process-identity.js";
import type { createManagedDatabaseResourceMaterializer, ManagedDatabaseFreshResources } from "./docker-managed-database-resources.js";
import { managedDatabaseContainerName } from "./docker-managed-database-argv.js";
export type ManagedDatabaseReadinessOptions = Readonly<{
    owner: string;
    agentId: string;
    imagePolicy: ImageReferencePolicyV1;
    clock: Clock;
    nativeInspector: ReturnType<typeof createManagedDatabaseDockerInspector>;
    resourceVerifier: Pick<ReturnType<typeof createManagedDatabaseResourceMaterializer>, "verifyFresh">;
    composeInspector: ComposeResourceInspector;
    processIdentityReader: ReturnType<typeof createManagedDatabaseProcessIdentityReader>;
    limits: Readonly<{
        deadlineMs: number;
        cpus: number;
        memoryBytes: number;
        pidsLimit: number;
    }>;
}>;
function fail(): never { throw new Error("Database readiness is unavailable."); }
/** Read-only original daemon corroboration. Running admission permits unhealthy health but never grants readiness. */
export function createManagedDatabaseReadinessVerifier(supplied: ManagedDatabaseReadinessOptions) {
    const options = { ...supplied, imagePolicy: structuredClone(supplied.imagePolicy), limits: { ...supplied.limits } }, bounds = options.limits;
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(options.owner) || !/^[A-Za-z0-9_-]{1,200}$/.test(options.agentId)
        || !Number.isSafeInteger(bounds.deadlineMs) || bounds.deadlineMs < 1 || bounds.deadlineMs > 60000
        || !Number.isFinite(bounds.cpus) || bounds.cpus < 0.1 || bounds.cpus > 2
        || !Number.isSafeInteger(bounds.memoryBytes) || bounds.memoryBytes < 67108864 || bounds.memoryBytes > 4294967296
        || !Number.isSafeInteger(bounds.pidsLimit) || bounds.pidsLimit < 16 || bounds.pidsLimit > 1024)
        fail();
    async function verify(raw: Readonly<{
            request: unknown;
            profile: unknown;
            commandId: string;
            imageId: string;
            containerId: string;
            environmentFingerprint: string;
        }>, evidence: ManagedDatabaseFreshResources, authority: Readonly<{
            assertValid(): Promise<void>;
        }>, external: AbortSignal, mode: "ready" | "running" | "stopped" = "ready"): Promise<Readonly<{
            uid: number | null;
            containerId: string;
        }>> {
            const controller = new AbortController(), cancel = () => controller.abort();
            external.addEventListener("abort", cancel, { once: true });
            const timer = setTimeout(cancel, bounds.deadlineMs);
            try {
                const input = structuredClone(raw), original = structuredClone(evidence), start = options.clock.now(), stopped = mode === "stopped";
                if (!Number.isSafeInteger(start) || start < 0 || !/^[a-f0-9]{64}$/.test(input.containerId) || !/^sha256:[a-f0-9]{64}$/.test(input.imageId)
                    || !/^[a-f0-9]{32}$/.test(input.environmentFingerprint) || !/^[A-Za-z0-9_-]{1,200}$/.test(input.commandId))
                    fail();
                const plan = planManagedDatabaseProfile(input.request, input.profile, options.imagePolicy), preview = createManagedDatabaseComposePreview(input.request, input.profile, options.imagePolicy);
                const users = { postgres: "postgres", mysql: "mysql", mariadb: "mysql", mongodb: "mongodb", redis: "redis" };
                const daemons = { postgres: "postgres", mysql: "mysqld", mariadb: "mariadbd", mongodb: "mongod", redis: "redis-server" };
                function current() { const now = options.clock.now(); if (external.aborted || controller.signal.aborted || !Number.isSafeInteger(now) || now < start || now - start >= bounds.deadlineMs)
                    fail(); }
                async function call<T>(work: () => Promise<T>): Promise<T> { current(); const value = await awaitAbortable(work, controller.signal); current(); return value; }
                async function snapshot() {
                    await call(() => authority.assertValid());
                    const verified = await call(() => options.resourceVerifier.verifyFresh(input, original, authority, controller.signal));
                    if (protocolPayloadFingerprint(verified) !== protocolPayloadFingerprint(original))
                        fail();
                    const image = await call(() => options.nativeInspector.inspectImage(plan.image, controller.signal));
                    const targets = [plan.volume.target, ...(plan.engine === "mongodb" ? ["/data/configdb"] : [])];
                    if (image.imageId !== input.imageId || (!image.declaredVolumes.includes(plan.volume.target) && !(plan.engine === "redis" && image.declaredVolumes.length === 0)) || image.declaredVolumes.some(path => !targets.includes(path)))
                        fail();
                    const container = await call(() => options.nativeInspector.inspectContainer(input.containerId, controller.signal));
                    if (container.id !== input.containerId || container.name !== "/" + managedDatabaseContainerName(plan.projectId, plan.databaseId) || container.imageId !== input.imageId || container.image !== plan.image
                        || container.owner !== options.owner || container.projectId !== plan.projectId || container.databaseId !== plan.databaseId || container.engine !== plan.engine
                        || container.commandId !== input.commandId || container.planDigest !== plan.planDigest || container.environmentFingerprint !== input.environmentFingerprint
                        || container.storageInitialization !== null || container.networkMode !== plan.network.runtimeName || (stopped ? container.running : !container.running || mode === "ready" && container.health !== "healthy")
                        || container.user !== users[plan.engine] || !container.readOnly || container.privileged || (container.capAdd ?? []).length !== 0
                        || JSON.stringify(container.capDrop) !== '["ALL"]' || JSON.stringify(container.securityOpt) !== '["no-new-privileges"]'
                        || container.cpu !== Math.round(bounds.cpus * 1e9) || container.memory !== bounds.memoryBytes || container.pids !== bounds.pidsLimit
                        || Object.values(container.ports ?? {}).some(bindings => bindings.length !== 0))
                        fail();
                    const states: string[] = [];
                    for (const kind of ["volume", "network"] as const) {
                        const value = composeResourceObservationSchema.parse(await call(() => options.composeInspector.inspect({ preview, kind, key: plan.volume.key }, controller.signal)));
                        if (value.owner !== options.owner || value.agentId !== options.agentId || value.projectId !== plan.projectId || value.kind !== kind || value.key !== plan.volume.key
                            || value.runtimeName !== (kind === "volume" ? original.volume.name : original.network.name) || value.physicalIdentity !== (kind === "volume" ? original.volume.createdAt : original.network.id)
                            || value.configDigest !== preview.configDigest || value.observedAt < start || value.observedAt > options.clock.now() || value.stateDigest !== digestComposeResourceObservation(value))
                            fail();
                        const consumer = value.containers[0];
                        if (value.containers.length !== 1 || !consumer || consumer.containerId !== input.containerId || consumer.service !== plan.volume.key || consumer.running !== !stopped || !consumer.attached
                            || consumer.composeConfigDigest !== preview.configDigest || consumer.composeEnvironmentDigest !== digestControlInput({ environmentFingerprint: input.environmentFingerprint })
                            || !consumer.networks || consumer.networks.length !== 1 || consumer.networks[0]?.name !== plan.network.runtimeName || (consumer.networks[0]?.networkId !== original.network.id && !(stopped && kind === "volume" && consumer.networks[0]?.networkId === ""))
                            || JSON.stringify(consumer.mounts) !== JSON.stringify(kind === "volume" ? [{ target: plan.volume.target, readOnly: false }] : []))
                            fail();
                        states.push(value.stateDigest);
                    }
                    return protocolPayloadFingerprint({ container, image, states });
                }
                const before = await snapshot();
                if (stopped) {
                    if (await snapshot() !== before) fail();
                    await call(() => authority.assertValid());
                    return Object.freeze({uid: null, containerId: input.containerId});
                }
                await call(() => authority.assertValid());
                const identity = await call(() => options.processIdentityReader.verify(input.containerId, plan.engine, controller.signal));
                if (!Number.isSafeInteger(identity.uid) || identity.uid < 1 || identity.uid > 4294967294 || identity.daemon !== daemons[plan.engine])
                    fail();
                if (await snapshot() !== before)
                    fail();
                await call(() => authority.assertValid());
                return Object.freeze({ uid: identity.uid, containerId: input.containerId });
            }
            catch {
                return fail();
            }
            finally {
                clearTimeout(timer);
                external.removeEventListener("abort", cancel);
            }
        }
    return {
        async verifyRunning(...args: Parameters<typeof verify>) {
            const result = await verify(args[0], args[1], args[2], args[3], "running");
            if (result.uid === null) fail();
            return Object.freeze({uid: result.uid, containerId: result.containerId});
        },
        async verify(...args: Parameters<typeof verify>) {
            const result = await verify(args[0], args[1], args[2], args[3]);
            if (result.uid === null) fail();
            return Object.freeze({uid: result.uid, containerId: result.containerId});
        },
        async verifyStopped(...args: Parameters<typeof verify>) {
            const result = await verify(args[0], args[1], args[2], args[3], "stopped");
            return Object.freeze({containerId: result.containerId});
        }
    };
}
