import { composeResourceObservationSchema, protocolPayloadFingerprint, type Clock, type ImageReferencePolicyV1 } from "@deploylite/contracts";
import { awaitAbortable, createManagedDatabaseComposePreview, digestComposeResourceObservation, planManagedDatabaseProfile, type ComposeResourceInspector } from "@deploylite/domain";
import type { DockerCliRunner } from "./docker-cli-image-transport.js";
import type { createManagedDatabaseDockerInspector } from "./docker-managed-database-inspection.js";
import type { createManagedDatabaseResourceMaterializer, ManagedDatabaseFreshResources } from "./docker-managed-database-resources.js";
import { buildManagedDatabaseStorageInitializationArgv } from "./docker-managed-database-storage-argv.js";
export type ManagedDatabaseStorageInitializerOptions = Readonly<{
    owner: string;
    agentId: string;
    imagePolicy: ImageReferencePolicyV1;
    runner: DockerCliRunner;
    clock: Clock;
    nativeInspector: ReturnType<typeof createManagedDatabaseDockerInspector>;
    resourceVerifier: Pick<ReturnType<typeof createManagedDatabaseResourceMaterializer>, "verifyFresh">;
    composeInspector: ComposeResourceInspector;
    limits: Readonly<{
        deadlineMs: number;
        maxOutputBytes: number;
        cpus: number;
        memoryBytes: number;
        pidsLimit: number;
    }>;
}>;
function fail(): never { throw new Error("Database storage initialization is unavailable."); }
/** Injected fresh-storage helper only. Never removes persistent resources or retries ambiguous helper effects. */
export function createManagedDatabaseStorageInitializer(supplied: ManagedDatabaseStorageInitializerOptions) {
    const options = { ...supplied, imagePolicy: structuredClone(supplied.imagePolicy), limits: { ...supplied.limits } };
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(options.owner) || !/^[A-Za-z0-9_-]{1,200}$/.test(options.agentId)
        || !Number.isSafeInteger(options.limits.deadlineMs) || options.limits.deadlineMs < 1 || options.limits.deadlineMs > 60000
        || !Number.isSafeInteger(options.limits.maxOutputBytes) || options.limits.maxOutputBytes < 1 || options.limits.maxOutputBytes > 1048576)
        fail();
    return { async initializeFresh(raw: Readonly<{
            request: unknown;
            profile: unknown;
            commandId: string;
            imageId: string;
        }>, evidence: ManagedDatabaseFreshResources, authority: Readonly<{
            assertValid(): Promise<void>;
        }>, external: AbortSignal): Promise<ManagedDatabaseFreshResources> {
            const controller = new AbortController(), cancel = () => controller.abort();
            external.addEventListener("abort", cancel, { once: true });
            const timer = setTimeout(cancel, options.limits.deadlineMs);
            try {
                const input = structuredClone(raw), original = structuredClone(evidence), start = options.clock.now();
                if (!Number.isSafeInteger(start) || start < 0 || !/^sha256:[a-f0-9]{64}$/.test(input.imageId))
                    fail();
                const plan = planManagedDatabaseProfile(input.request, input.profile, options.imagePolicy), preview = createManagedDatabaseComposePreview(input.request, input.profile, options.imagePolicy);
                const create = buildManagedDatabaseStorageInitializationArgv({ ...input, imagePolicy: options.imagePolicy, owner: options.owner, limits: options.limits });
                const helperName = create[create.indexOf("--name") + 1];
                function current() { const now = options.clock.now(); if (external.aborted || controller.signal.aborted || !Number.isSafeInteger(now) || now < start || now - start >= options.limits.deadlineMs)
                    fail(); }
                async function call<T>(work: () => Promise<T>): Promise<T> { current(); const result = await awaitAbortable(work, controller.signal); current(); return result; }
                async function run(argv: readonly string[]) {
                    const result = await call(() => options.runner.run(argv, controller.signal));
                    if (result.exitCode !== 0 || result.signal !== null || Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > options.limits.maxOutputBytes)
                        fail();
                    return result.stdout;
                }
                async function guard(helperId: string | null) {
                    const verified = await call(() => options.resourceVerifier.verifyFresh(input, original, authority, controller.signal));
                    if (protocolPayloadFingerprint(verified) !== protocolPayloadFingerprint(original))
                        fail();
                    const image = await call(() => options.nativeInspector.inspectImage(plan.image, controller.signal));
                    const targets = [plan.volume.target, ...(plan.engine === "mongodb" ? ["/data/configdb"] : [])];
                    if (image.imageId !== input.imageId || !image.declaredVolumes.includes(plan.volume.target) || image.declaredVolumes.some(path => !targets.includes(path)))
                        fail();
                    for (const kind of ["volume", "network"] as const) {
                        const value = composeResourceObservationSchema.parse(await call(() => options.composeInspector.inspect({ preview, kind, key: plan.volume.key }, controller.signal)));
                        if (value.owner !== options.owner || value.agentId !== options.agentId || value.projectId !== plan.projectId || value.kind !== kind || value.key !== plan.volume.key
                            || value.runtimeName !== (kind === "volume" ? original.volume.name : original.network.name) || value.physicalIdentity !== (kind === "volume" ? original.volume.createdAt : original.network.id)
                            || value.configDigest !== preview.configDigest || value.observedAt < start || value.observedAt > options.clock.now() || value.stateDigest !== digestComposeResourceObservation(value))
                            fail();
                        if (helperId === null) {
                            if (value.containers.length !== 0)
                                fail();
                        }
                        else {
                            const target = value.containers[0];
                            if (value.containers.length !== 1 || !target || target.containerId !== helperId || target.service !== plan.volume.key || target.running || target.attached !== (kind === "volume")
                                || target.composeConfigDigest !== preview.configDigest || !target.networks || target.networks.length > 1 || target.networks.some(network => network.name !== "none")
                                || JSON.stringify(target.mounts) !== JSON.stringify(kind === "volume" ? [{ target: plan.volume.target, readOnly: false }] : []))
                                fail();
                        }
                    }
                    if (helperId) {
                        const helper = await call(() => options.nativeInspector.inspectContainer(helperId, controller.signal));
                        if (helper.id !== helperId || helper.name !== "/" + helperName || helper.imageId !== input.imageId || helper.image !== plan.image || helper.owner !== options.owner || helper.projectId !== plan.projectId
                            || helper.databaseId !== plan.databaseId || helper.engine !== plan.engine || helper.commandId !== input.commandId || helper.planDigest !== plan.planDigest || helper.storageInitialization !== "v1"
                            || helper.networkMode !== "none" || helper.environmentFingerprint !== null || helper.running || helper.health !== null || helper.user !== "0:0" || !helper.readOnly || helper.privileged
                            || JSON.stringify(helper.capAdd) !== JSON.stringify(["CHOWN"]) || JSON.stringify(helper.capDrop) !== JSON.stringify(["ALL"]) || JSON.stringify(helper.securityOpt) !== JSON.stringify(["no-new-privileges"])
                            || helper.cpu !== Math.round(options.limits.cpus * 1e9) || helper.memory !== options.limits.memoryBytes || helper.pids !== options.limits.pidsLimit || Object.values(helper.ports ?? {}).some(bindings => bindings.length !== 0))
                            fail();
                    }
                    await call(() => authority.assertValid());
                }
                await guard(null);
                const helperId = (await run(create)).trim();
                if (!/^[a-f0-9]{64}$/.test(helperId))
                    fail();
                await guard(helperId);
                await run(["docker", "start", helperId]);
                if ((await run(["docker", "wait", helperId])).trim() !== "0")
                    fail();
                await guard(helperId);
                await run(["docker", "rm", helperId]);
                await guard(null);
                return original;
            }
            catch {
                return fail();
            }
            finally {
                clearTimeout(timer);
                external.removeEventListener("abort", cancel);
            }
        } };
}
