import type { Clock, ManagedDatabaseEngineV1 } from "@deploylite/contracts";
import { awaitAbortable } from "@deploylite/domain";
import type { DockerCliRunner } from "./docker-cli-image-transport.js";
const daemons: Readonly<Record<ManagedDatabaseEngineV1, string>> = { postgres: "postgres", mysql: "mysqld", mariadb: "mariadbd", mongodb: "mongod", redis: "redis-server" };
const projection = "id -u && cat /proc/1/comm && awk '/^Uid:/ { print $2, $3, $4, $5; found=1 } END { if (!found) exit 1 }' /proc/1/status";
function fail(): never { throw new Error("Database process identity is unavailable."); }
/** Read-only injected projection. Container/resource identity and current authority remain the executor's responsibility. */
export function createManagedDatabaseProcessIdentityReader(supplied: Readonly<{
    runner: DockerCliRunner;
    clock: Clock;
    limits: Readonly<{
        deadlineMs: number;
        maxOutputBytes: number;
    }>;
}>) {
    const options = { ...supplied, limits: { ...supplied.limits } };
    if (!Number.isSafeInteger(options.limits.deadlineMs) || options.limits.deadlineMs < 1 || options.limits.deadlineMs > 60000
        || !Number.isSafeInteger(options.limits.maxOutputBytes) || options.limits.maxOutputBytes < 1 || options.limits.maxOutputBytes > 1048576)
        fail();
    return { async verify(id: string, engine: ManagedDatabaseEngineV1, external: AbortSignal): Promise<Readonly<{
            uid: number;
            daemon: string;
        }>> {
            const controller = new AbortController(), cancel = () => controller.abort();
            external.addEventListener("abort", cancel, { once: true });
            const timer = setTimeout(cancel, options.limits.deadlineMs);
            try {
                const start = options.clock.now();
                if (external.aborted || !/^[a-f0-9]{64}$/.test(id) || !Object.hasOwn(daemons, engine) || !Number.isSafeInteger(start) || start < 0)
                    fail();
                const result = await awaitAbortable(() => options.runner.run(Object.freeze(["docker", "exec", id, "sh", "-c", projection]), controller.signal), controller.signal);
                const end = options.clock.now();
                if (external.aborted || controller.signal.aborted || !Number.isSafeInteger(end) || end < start || end - start >= options.limits.deadlineMs
                    || result.exitCode !== 0 || result.signal !== null || Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > options.limits.maxOutputBytes)
                    fail();
                const match = /^([1-9][0-9]{0,9})\n([a-z-]{1,15})\n([0-9]{1,10}) ([0-9]{1,10}) ([0-9]{1,10}) ([0-9]{1,10})\n$/.exec(result.stdout);
                if (!match || match[2] !== daemons[engine])
                    fail();
                const uid = Number(match[1]);
                if (uid > 4294967294 || match.slice(3).some(value => Number(value) !== uid))
                    fail();
                return Object.freeze({ uid, daemon: match[2]! });
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
