import { z } from "zod";
import { normalizeImageReferencePolicy, validateImageReference, type Clock, type ImageReferencePolicyV1 } from "@deploylite/contracts";
import { awaitAbortable } from "@deploylite/domain";
import type { DockerCliRunner } from "./docker-cli-image-transport.js";
import { MANAGED_DATABASE_IMAGE_INSPECT_FORMAT, MANAGED_DATABASE_CONTAINER_INSPECT_FORMAT } from "./docker-managed-database-inspection-argv.js";
const imageId = z.string().regex(/^sha256:[a-f0-9]{64}$/), digest = z.string().regex(/^[a-f0-9]{64}$/);
const nullableText = z.string().max(512).nullable();
const imageSchema = z.object({ id: imageId, volumes: z.record(z.object({}).strict()).nullable() }).strict();
const containerSchema = z.object({ id: digest, name: z.string().max(160), imageId, image: z.string().max(512), owner: nullableText, projectId: nullableText, databaseId: nullableText,
    engine: nullableText, commandId: nullableText, planDigest: digest.nullable(), environmentFingerprint: z.string().regex(/^[a-f0-9]{32}$/).nullable(),
    networkMode:z.string().max(160), storageInitialization:nullableText, running: z.boolean(), health: z.enum(["healthy", "unhealthy", "starting"]).nullable(), user: z.string().max(64), readOnly: z.boolean(), privileged: z.boolean(),
    capAdd: z.array(z.string().max(128)).max(64).nullable(), capDrop: z.array(z.string().max(128)).max(64).nullable(), securityOpt: z.array(z.string().max(128)).max(64).nullable(),
    cpu: z.number().int().safe().nonnegative(), memory: z.number().int().safe().nonnegative(), pids: z.number().int().safe().nullable(),
    ports: z.record(z.array(z.object({ HostIp: z.string().max(64), HostPort: z.string().max(5).regex(/^[0-9]+$/) }).strict()).max(128)).nullable()
}).strict();
export type ManagedDatabaseContainerObservation = z.infer<typeof containerSchema>;
export type ManagedDatabaseDockerInspectorOptions = Readonly<{
    runner: DockerCliRunner;
    imagePolicy: ImageReferencePolicyV1;
    clock: Clock;
    limits: Readonly<{
        deadlineMs: number;
        maxOutputBytes: number;
    }>;
}>;
function fail(): never { throw new Error("Database inspection is unavailable."); }
/** Read-only injected Docker projection; ownership and stable resource corroboration remain the existing executor/Compose inspector's responsibility. */
export function createManagedDatabaseDockerInspector(supplied: ManagedDatabaseDockerInspectorOptions) {
    const options = { ...supplied, imagePolicy: normalizeImageReferencePolicy({ ...supplied.imagePolicy, allowTags: false }), limits: { ...supplied.limits } };
    if (!Number.isSafeInteger(options.limits.deadlineMs) || options.limits.deadlineMs < 1 || options.limits.deadlineMs > 60000
        || !Number.isSafeInteger(options.limits.maxOutputBytes) || options.limits.maxOutputBytes < 1 || options.limits.maxOutputBytes > 1048576)
        fail();
    async function read(argv: readonly string[], external: AbortSignal): Promise<unknown> {
        if (external.aborted)
            fail();
        const controller = new AbortController(), cancel = () => controller.abort();
        external.addEventListener("abort", cancel, { once: true });
        const timer = setTimeout(cancel, options.limits.deadlineMs);
        try {
            const start = options.clock.now();
            if (!Number.isSafeInteger(start) || start < 0)
                fail();
            if (external.aborted)
                fail();
            const result = await awaitAbortable(() => options.runner.run(Object.freeze([...argv]), controller.signal), controller.signal);
            const end = options.clock.now();
            if (external.aborted || controller.signal.aborted || !Number.isSafeInteger(end) || end < start || end - start >= options.limits.deadlineMs
                || result.exitCode !== 0 || result.signal !== null || Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > options.limits.maxOutputBytes)
                fail();
            return JSON.parse(result.stdout);
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
        async inspectImage(image: string, signal: AbortSignal) {
            try {
                const reference = validateImageReference(image, options.imagePolicy).reference;
                const result = imageSchema.parse(await read(["docker", "image", "inspect", "--format", MANAGED_DATABASE_IMAGE_INSPECT_FORMAT, reference], signal));
                const declaredVolumes = Object.keys(result.volumes ?? {}).sort();
                if (declaredVolumes.length > 128 || declaredVolumes.some(path => path.length > 256 || !/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(path) || path.split("/").some(part => part === "." || part === "..")))
                    fail();
                return { imageId: result.id, declaredVolumes };
            }
            catch {
                return fail();
            }
        },
        async inspectContainer(id: string, signal: AbortSignal): Promise<ManagedDatabaseContainerObservation> {
            try {
                if (!digest.safeParse(id).success)
                    fail();
                const value = containerSchema.parse(await read(["docker", "container", "inspect", "--format", MANAGED_DATABASE_CONTAINER_INSPECT_FORMAT, id], signal));
                if (value.id !== id)
                    fail();
                return value;
            }
            catch {
                return fail();
            }
        }
    };
}
