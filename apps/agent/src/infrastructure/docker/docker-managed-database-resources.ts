import { z } from "zod";
import { protocolPayloadFingerprint, type Clock, type ImageReferencePolicyV1 } from "@deploylite/contracts";
import { awaitAbortable, planManagedDatabaseProfile } from "@deploylite/domain";
import type { DockerCliRunner } from "./docker-cli-image-transport.js";
import { MANAGED_DATABASE_NETWORK_INSPECT_FORMAT, MANAGED_DATABASE_VOLUME_INSPECT_FORMAT } from "./docker-managed-database-resource-argv.js";
const text = z.string().max(512).nullable(), digest = z.string().regex(/^[a-f0-9]{64}$/);
const fields = { name: z.string().max(160), driver: z.string().max(64), scope: z.string().max(64), optionsCount: z.number().int().nonnegative(),
    owner: text, projectId: text, resourceKind: text, resourceKey: text, databaseId: text, commandId: text, planDigest: digest.nullable() };
const volumeSchema = z.object({ ...fields, createdAt: z.string().datetime({ offset: true }) }).strict();
const networkSchema = z.object({ ...fields, id: digest, internal: z.boolean() }).strict();
export type ManagedDatabaseFreshResources = Readonly<{
    projectId: string;
    databaseId: string;
    commandId: string;
    planDigest: string;
    volume: Readonly<{
        name: string;
        createdAt: string;
    }>;
    network: Readonly<{
        name: string;
        id: string;
    }>;
}>;
export type ManagedDatabaseResourceOptions = Readonly<{
    runner: DockerCliRunner;
    imagePolicy: ImageReferencePolicyV1;
    owner: string;
    clock: Clock;
    limits: Readonly<{
        deadlineMs: number;
        maxOutputBytes: number;
    }>;
}>;
function fail(): never { throw new Error("Database resource preparation is unavailable."); }
/** Creates only absent native resources. Never adopts or deletes existing storage; partial/ambiguous preparation remains observable and unresolved. */
export function createManagedDatabaseResourceMaterializer(supplied: ManagedDatabaseResourceOptions) {
    const options = { ...supplied, imagePolicy: structuredClone(supplied.imagePolicy), limits: { ...supplied.limits } };
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(options.owner) || !Number.isSafeInteger(options.limits.deadlineMs) || options.limits.deadlineMs < 1 || options.limits.deadlineMs > 60000
        || !Number.isSafeInteger(options.limits.maxOutputBytes) || options.limits.maxOutputBytes < 1 || options.limits.maxOutputBytes > 1048576)
        fail();
    return { async prepareFresh(input: Readonly<{
            request: unknown;
            profile: unknown;
            commandId: string;
        }>, authority: Readonly<{
            assertValid(): Promise<void>;
        }>, external: AbortSignal): Promise<ManagedDatabaseFreshResources> {
            const controller = new AbortController(), cancel = () => controller.abort();
            external.addEventListener("abort", cancel, { once: true });
            const timer = setTimeout(cancel, options.limits.deadlineMs);
            let start = Number.NaN;
            function current() { const now = options.clock.now(); if (external.aborted || controller.signal.aborted || !Number.isSafeInteger(now) || now < start || now - start >= options.limits.deadlineMs)
                fail(); }
            async function authorize() { current(); await awaitAbortable(() => authority.assertValid(), controller.signal); current(); }
            async function run(argv: readonly string[], missing?: "volume" | "network") {
                current();
                let result: Awaited<ReturnType<DockerCliRunner["run"]>>;
                try {
                    result = await awaitAbortable(() => options.runner.run(Object.freeze([...argv]), controller.signal), controller.signal);
                }
                catch (error) {
                    current();
                    const caught = error as {
                        result?: typeof result;
                    };
                    if (!caught.result)
                        fail();
                    result = caught.result;
                }
                current();
                if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > options.limits.maxOutputBytes || result.signal !== null)
                    fail();
                if (result.exitCode !== 0) {
                    if (missing && new RegExp("(?:no such " + missing + "\\b|\\b" + missing + " .*not found)", "i").test(result.stderr))
                        return null;
                    fail();
                }
                return result.stdout;
            }
            try {
                start = options.clock.now();
                if (!Number.isSafeInteger(start) || start < 0 || !input || !/^[A-Za-z0-9_-]{1,200}$/.test(input.commandId))
                    fail();
                current();
                const plan = planManagedDatabaseProfile(structuredClone(input.request), structuredClone(input.profile), options.imagePolicy), commandId = input.commandId;
                const volume = async () => { const raw = await run(["docker", "volume", "inspect", "--format", MANAGED_DATABASE_VOLUME_INSPECT_FORMAT, plan.volume.runtimeName], "volume"); return raw === null ? null : volumeSchema.parse(JSON.parse(raw)); };
                const network = async () => { const raw = await run(["docker", "network", "inspect", "--format", MANAGED_DATABASE_NETWORK_INSPECT_FORMAT, plan.network.runtimeName], "network"); return raw === null ? null : networkSchema.parse(JSON.parse(raw)); };
                const labels = (kind: "volume" | "network") => Object.entries({ owner: options.owner, project: plan.projectId, "resource.kind": kind, "resource.key": plan.volume.key,
                    database: plan.databaseId, "database.command": commandId, "database.plan": plan.planDigest }).flatMap(([key, value]) => ["--label", "com.deploylite." + key + "=" + value]);
                function owned(value: z.infer<typeof volumeSchema> | z.infer<typeof networkSchema> | null, kind: "volume" | "network") {
                    if (!value || value.name !== (kind === "volume" ? plan.volume.runtimeName : plan.network.runtimeName) || value.owner !== options.owner || value.projectId !== plan.projectId
                        || value.resourceKind !== kind || value.resourceKey !== plan.volume.key || value.databaseId !== plan.databaseId || value.commandId !== commandId || value.planDigest !== plan.planDigest
                        || value.scope !== "local" || value.driver !== (kind === "volume" ? "local" : "bridge") || value.optionsCount !== 0 || "internal" in value && !value.internal)
                        fail();
                    return value;
                }
                await authorize();
                if (await volume() !== null || await network() !== null)
                    fail();
                await authorize();
                await run(["docker", "volume", "create", "--driver", "local", ...labels("volume"), plan.volume.runtimeName]);
                const createdVolume = owned(await volume(), "volume") as z.infer<typeof volumeSchema>;
                await authorize();
                await run(["docker", "network", "create", "--driver", "bridge", "--internal", ...labels("network"), plan.network.runtimeName]);
                const createdNetwork = owned(await network(), "network") as z.infer<typeof networkSchema>;
                const verifiedVolume = owned(await volume(), "volume") as z.infer<typeof volumeSchema>;
                const verifiedNetwork = owned(await network(), "network") as z.infer<typeof networkSchema>;
                if (protocolPayloadFingerprint(verifiedVolume) !== protocolPayloadFingerprint(createdVolume) || protocolPayloadFingerprint(verifiedNetwork) !== protocolPayloadFingerprint(createdNetwork))
                    fail();
                await authorize();
                return { projectId: plan.projectId, databaseId: plan.databaseId, commandId, planDigest: plan.planDigest,
                    volume: { name: verifiedVolume.name, createdAt: verifiedVolume.createdAt }, network: { name: createdNetwork.name, id: createdNetwork.id } };
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
