import {managedDatabaseHealthObservationSchema, managedDatabaseProfileRequestSchema, protocolPayloadFingerprint, type Clock} from "@deploylite/contracts";
import {redactLogMessage} from "@deploylite/config";
import {awaitAbortable} from "@deploylite/domain";
import type {createManagedDatabaseHealthObserver} from "./docker-managed-database-health.js";
import type {createManagedDatabaseLogReader, ManagedDatabaseLogReadOptions} from "./docker-managed-database-logs.js";

type Health = ReturnType<typeof createManagedDatabaseHealthObserver>;
type Args = Parameters<Health["observe"]>;
const healthSchema = managedDatabaseHealthObservationSchema.innerType().pick({
  schemaVersion: true, projectId: true, databaseId: true, engine: true, containerId: true,
  imageId: true, uid: true, state: true, health: true, observedAt: true, redacted: true
}).strict();
function fail(): never {throw new Error("Database logs are unavailable.");}

/** Retained logs are readable from stopped workloads only after original-resource corroboration. */
export function createManagedDatabaseLogsObserver(supplied: Readonly<{
  health: Health; logs: ReturnType<typeof createManagedDatabaseLogReader>; clock: Clock;
  limits: Readonly<{deadlineMs: number; maxOutputBytes: number}>;
}>) {
  const options = {...supplied, limits: {...supplied.limits}};
  const deadline = options.limits.deadlineMs, maximum = options.limits.maxOutputBytes;
  if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 60000 ||
      !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1048576) fail();
  return {async observe(raw: Args[0], resources: Args[1], rawSelection: ManagedDatabaseLogReadOptions, authority: Args[2], external: AbortSignal) {
    const controller = new AbortController(), cancel = () => controller.abort();
    external.addEventListener("abort", cancel, {once: true});
    if (external.aborted) cancel();
    const timer = setTimeout(cancel, deadline);
    try {
      const input = structuredClone(raw), original = structuredClone(resources), selection = structuredClone(rawSelection);
      const request = managedDatabaseProfileRequestSchema.parse(input.request);
      const start = options.clock.now(), observe = options.health.observe, read = options.logs.read;
      function current() {
        const now = options.clock.now();
        if (controller.signal.aborted || external.aborted || !Number.isSafeInteger(start) || start < 0 ||
            !Number.isSafeInteger(now) || now < start || now - start >= deadline ||
            options.health.observe !== observe || options.logs.read !== read) fail();
        return now;
      }
      current();
      if (!selection || Object.keys(selection).some(key => key !== "tail" && key !== "since") ||
          !Number.isSafeInteger(selection.tail) || selection.tail < 1 || selection.tail > 5000) fail();
      if (selection.since !== undefined) {
        if (typeof selection.since !== "string") fail();
        const time = Date.parse(selection.since);
        if (!Number.isSafeInteger(time) || time < 0 || time > start || new Date(time).toISOString() !== selection.since) fail();
      }
      async function valid() {
        current(); await awaitAbortable(() => authority.assertValid(), controller.signal); current();
      }
      async function call<T>(work: () => Promise<T>) {
        await valid(); const value = await awaitAbortable(work, controller.signal); await valid(); return value;
      }
      function view(value: unknown) {
        const parsed = healthSchema.parse(value), now = current();
        if (parsed.projectId !== request.projectId || parsed.databaseId !== request.databaseId || parsed.engine !== request.engine ||
            parsed.containerId !== input.containerId || parsed.imageId !== input.imageId || parsed.observedAt < start || parsed.observedAt > now ||
            (parsed.state === "running" ? parsed.uid === null || parsed.uid < 1 || parsed.health === "not-running" : parsed.uid !== null || parsed.health !== "not-running")) fail();
        return parsed;
      }
      const before = view(await call(() => observe.call(options.health, input, original, authority, controller.signal)));
      const value = await call(() => read.call(options.logs, input.containerId, selection, controller.signal));
      if (!value || Object.keys(value).length !== 3 || Object.keys(value).some(key => !["stdout", "stderr", "redacted"].includes(key)) ||
          value.redacted !== true || typeof value.stdout !== "string" || typeof value.stderr !== "string" ||
          Buffer.byteLength(value.stdout) + Buffer.byteLength(value.stderr) > maximum ||
          redactLogMessage(value.stdout) !== value.stdout || redactLogMessage(value.stderr) !== value.stderr) fail();
      const logs = Object.freeze({stdout: value.stdout, stderr: value.stderr, redacted: true as const}), logsObservedAt = current();
      const after = view(await call(() => observe.call(options.health, input, original, authority, controller.signal)));
      const {observedAt: _beforeTime, ...first} = before, {observedAt: _afterTime, ...last} = after;
      if (protocolPayloadFingerprint(first) !== protocolPayloadFingerprint(last) || after.observedAt < before.observedAt || after.observedAt < logsObservedAt) fail();
      return Object.freeze({...after, observedAt: current(), logs, logsObservedAt});
    } catch {return fail();}
    finally {clearTimeout(timer); external.removeEventListener("abort", cancel);}
  }};
}
