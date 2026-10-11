import type { Clock } from "@deploylite/contracts";
import { awaitAbortable } from "@deploylite/domain";
import type { DockerCliRunner } from "./docker-cli-image-transport.js";
import type { createManagedDatabaseReadinessVerifier } from "./docker-managed-database-readiness.js";
type Verifier = ReturnType<typeof createManagedDatabaseReadinessVerifier>;
type Input = Parameters<Verifier["verifyRunning"]>[0];
type Resources = Parameters<Verifier["verifyRunning"]>[1];
type Authority = Parameters<Verifier["verifyRunning"]>[2];
function fail(): never { throw new Error("Database daemon stop is unavailable."); }
/** One bounded stop of the corroborated original daemon. No removal, restart, retry or adoption. */
export function createManagedDatabaseDaemonStopper(supplied: Readonly<{
    runner: DockerCliRunner;
    verifier: Pick<Verifier, "verifyRunning" | "verifyStopped">;
    clock: Clock;
    limits: Readonly<{deadlineMs: number; maxOutputBytes: number; stopGraceSeconds: number}>;
}>) {
    const options = {...supplied, limits: {...supplied.limits}}, limits = options.limits;
    if (!Number.isSafeInteger(limits.deadlineMs) || limits.deadlineMs < 1 || limits.deadlineMs > 60000
        || !Number.isSafeInteger(limits.maxOutputBytes) || limits.maxOutputBytes < 1 || limits.maxOutputBytes > 1048576
        || !Number.isSafeInteger(limits.stopGraceSeconds) || limits.stopGraceSeconds < 1 || limits.stopGraceSeconds > 30) fail();
    return {async stop(raw: Input, evidence: Resources, authority: Authority, external: AbortSignal) {
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
            const admitted = await call(() => options.verifier.verifyRunning(input, original, authority, controller.signal));
            if (admitted.containerId !== input.containerId || !Number.isSafeInteger(admitted.uid) || admitted.uid < 1 || admitted.uid > 4294967294) fail();
            await call(() => authority.assertValid());
            const stopped = await call(() => options.runner.run(Object.freeze(["docker", "stop", "--time", String(limits.stopGraceSeconds), input.containerId]), controller.signal));
            if (stopped.exitCode !== 0 || stopped.signal !== null
                || Buffer.byteLength(stopped.stdout) + Buffer.byteLength(stopped.stderr) > limits.maxOutputBytes
                || !new RegExp("^" + input.containerId + "\\n?$").test(stopped.stdout)) fail();
            const verified = await call(() => options.verifier.verifyStopped(input, original, authority, controller.signal));
            if (verified.containerId !== input.containerId) fail();
            await call(() => authority.assertValid());
            return Object.freeze({containerId: verified.containerId});
        } catch {return fail();}
        finally {clearTimeout(timer); external.removeEventListener("abort", cancel);}
    }};
}
