import type { Clock } from "@deploylite/contracts";
import { awaitAbortable } from "@deploylite/domain";
import type { DockerCliRunner } from "./docker-cli-image-transport.js";
import type { createManagedDatabaseDockerInspector } from "./docker-managed-database-inspection.js";
import type { createManagedDatabaseReadinessVerifier } from "./docker-managed-database-readiness.js";
type Verifier = ReturnType<typeof createManagedDatabaseReadinessVerifier>;
type Input = Parameters<Verifier["verify"]>[0];
type Resources = Parameters<Verifier["verify"]>[1];
type Authority = Parameters<Verifier["verify"]>[2];
function fail(): never { throw new Error("Database daemon startup is unavailable."); }
/** Starts a newly created, stopped original daemon only. No create, retry, adoption, replay or resource cleanup. */
export function createManagedDatabaseDaemonStarter(supplied: Readonly<{
    runner: DockerCliRunner;
    nativeInspector: Pick<ReturnType<typeof createManagedDatabaseDockerInspector>, "inspectContainer">;
    verifier: Pick<Verifier, "verifyStopped" | "verify">;
    clock: Clock;
    limits: Readonly<{deadlineMs: number; pollIntervalMs: number; maxOutputBytes: number}>;
}>) {
    const options = {...supplied, limits: {...supplied.limits}}, limits = options.limits;
    if (!Number.isSafeInteger(limits.deadlineMs) || limits.deadlineMs < 1 || limits.deadlineMs > 60000
        || !Number.isSafeInteger(limits.pollIntervalMs) || limits.pollIntervalMs < 1 || limits.pollIntervalMs > 1000
        || !Number.isSafeInteger(limits.maxOutputBytes) || limits.maxOutputBytes < 1 || limits.maxOutputBytes > 1048576) fail();
    return {async start(raw: Input, evidence: Resources, authority: Authority, external: AbortSignal) {
        const controller = new AbortController(), cancel = () => controller.abort();
        external.addEventListener("abort", cancel, {once: true});
        const timer = setTimeout(cancel, limits.deadlineMs);
        try {
            const input = structuredClone(raw), original = structuredClone(evidence), start = options.clock.now();
            if (!Number.isSafeInteger(start) || start < 0 || !/^[a-f0-9]{64}$/.test(input.containerId)
                || !/^sha256:[a-f0-9]{64}$/.test(input.imageId)) fail();
            function current() {
                const now = options.clock.now();
                if (external.aborted || controller.signal.aborted || !Number.isSafeInteger(now) || now < start || now - start >= limits.deadlineMs) fail();
            }
            async function call<T>(work: () => Promise<T>): Promise<T> {
                current(); const value = await awaitAbortable(work, controller.signal); current(); return value;
            }
            await call(() => authority.assertValid());
            const admitted = await call(() => options.verifier.verifyStopped(input, original, authority, controller.signal));
            if (admitted.containerId !== input.containerId) fail();
            await call(() => authority.assertValid());
            const started = await call(() => options.runner.run(Object.freeze(["docker", "start", input.containerId]), controller.signal));
            if (started.exitCode !== 0 || started.signal !== null
                || Buffer.byteLength(started.stdout) + Buffer.byteLength(started.stderr) > limits.maxOutputBytes
                || !new RegExp("^" + input.containerId + "\\n?$").test(started.stdout)) fail();
            while (true) {
                await call(() => authority.assertValid());
                const observed = await call(() => options.nativeInspector.inspectContainer(input.containerId, controller.signal));
                if (observed.id !== input.containerId || observed.imageId !== input.imageId || !observed.running
                    || observed.health !== "healthy" && observed.health !== "starting") fail();
                if (observed.health === "healthy") break;
                await call(() => new Promise<void>((resolve, reject) => {
                    const abort = () => {clearTimeout(pause); controller.signal.removeEventListener("abort", abort); reject(new Error("canceled"));};
                    const pause = setTimeout(() => {controller.signal.removeEventListener("abort", abort); resolve();}, limits.pollIntervalMs);
                    controller.signal.addEventListener("abort", abort, {once: true});
                    if (controller.signal.aborted) abort();
                }));
            }
            const result = await call(() => options.verifier.verify(input, original, authority, controller.signal));
            if (result.containerId !== input.containerId || !Number.isSafeInteger(result.uid) || result.uid < 1 || result.uid > 4294967294) fail();
            await call(() => authority.assertValid());
            return Object.freeze({containerId: result.containerId, uid: result.uid});
        } catch {return fail();}
        finally {clearTimeout(timer); external.removeEventListener("abort", cancel);}
    }};
}
