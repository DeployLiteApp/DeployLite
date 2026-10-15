import {managedDatabaseRestorePreparationSchema, managedDatabaseRestoreSelectionSchema} from "@deploylite/contracts";
import {awaitAbortable} from "./deployment-contract/docker-image-executor.js";
import {digestControlInput} from "./control-plane.js";
import {prepareManagedDatabaseRestoreConfirmation, selectManagedDatabaseRestoreInventory} from "./managed-database-restore-binding.js";
import type {BackupInventoryReader} from "./backup-inventory.js";

export type VerifiedRestorePorts = Readonly<{
  expectedAgentId: string;
  inventory: BackupInventoryReader;
  archive: Readonly<{verify(preparation: unknown, signal: AbortSignal): Promise<unknown>}>;
  clock: Readonly<{now(): number}>;
  maxDurationMs: number;
}>;
export type VerifiedRestoreRequest = Readonly<{
  selection: unknown;
  actorId: string;
  idempotencyKey: string;
  correlationId: string;
  commandTtlMs: number;
}>;
function unavailable(): never {throw new Error("Verified database restore confirmation is unavailable.");}
type Preparation = ReturnType<typeof managedDatabaseRestorePreparationSchema.parse>;
type Intent = ReturnType<typeof prepareManagedDatabaseRestoreConfirmation> & {preparation: Preparation};

/** Read-only preparation. Authenticated admission and original-cache proof remain caller prerequisites. */
export async function prepareVerifiedManagedDatabaseRestoreConfirmation(
  suppliedRequest: VerifiedRestoreRequest, suppliedPorts: VerifiedRestorePorts, signal?: AbortSignal
): Promise<Intent> {
  const controller = new AbortController(), cancel = () => controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    signal?.addEventListener("abort", cancel, {once: true});
    if (signal?.aborted) cancel();
    const request = structuredClone(suppliedRequest), ports = {...suppliedPorts};
    const inventory = ports.inventory, archive = ports.archive, clock = ports.clock;
    const list = inventory.list, available = inventory.available, verify = archive.verify, now = clock.now;
    if (!Number.isSafeInteger(ports.maxDurationMs) || ports.maxDurationMs < 1 || ports.maxDurationMs > 60000) unavailable();
    const start = now.call(clock), deadline = start + ports.maxDurationMs;
    let lastNow = start;
    const current = () => {
      const observed = now.call(clock);
      if (controller.signal.aborted || signal?.aborted
        || Object.entries(ports).some(([key, value]) => suppliedPorts[key as keyof VerifiedRestorePorts] !== value)
        || inventory.list !== list || inventory.available !== available || archive.verify !== verify || clock.now !== now
        || !available.call(inventory) || !Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(deadline)
        || !Number.isSafeInteger(observed) || observed < lastNow || observed >= deadline) unavailable();
      lastNow = observed;
      return observed;
    };
    const bounded = async <T>(work: () => Promise<T>) => {
      current();
      const value = await awaitAbortable(work, controller.signal);
      current();
      return value;
    };
    current();
    timer = setTimeout(cancel, ports.maxDurationMs);
    const selection = managedDatabaseRestoreSelectionSchema.parse(request.selection);
    const select = () => selectManagedDatabaseRestoreInventory(selection, {
      expectedAgentId: ports.expectedAgentId,
      inventory: {available: () => {current(); return true;}, list: (...args) => list.call(inventory, ...args)},
      clock: {now: current}
    }, controller.signal);
    const first = await bounded(select);
    const preparation = (binding: typeof first): Preparation => {
      const {action: _action, scope: _scope, operation: _operation, ...source} = binding;
      return managedDatabaseRestorePreparationSchema.parse(source);
    };
    const selected = preparation(first);
    const verifyArchive = async () => {
      const value = await bounded(() => verify.call(archive, structuredClone(selected), controller.signal));
      const receipt = selected.backupReceipt;
      const expected = {archiveId: receipt.archiveId, archiveBytes: receipt.archiveBytes,
        archiveSha256: receipt.archiveSha256, manifestSha256: receipt.manifestSha256,
        format: receipt.format, integrity: "verified", redacted: true};
      const keys = Object.keys(expected);
      if (!value || typeof value !== "object" || Reflect.ownKeys(value).length !== keys.length) unavailable();
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor) || descriptor.value !== expected[key as keyof typeof expected]) unavailable();
      }
      current();
    };
    await verifyArchive();
    const second = await bounded(select);
    if (digestControlInput(first) !== digestControlInput(second)) unavailable();
    await verifyArchive();
    const intent = prepareManagedDatabaseRestoreConfirmation({preparation: selected, actorId: request.actorId,
      idempotencyKey: request.idempotencyKey, correlationId: request.correlationId,
      now: current(), commandTtlMs: request.commandTtlMs});
    if (intent.command.expiresAt.getTime() <= current()) unavailable();
    return Object.freeze({...intent, preparation: selected});
  } catch {return unavailable();}
  finally {
    controller.abort();
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
