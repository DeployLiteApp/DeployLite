import {backupInventoryReceiptSchema} from "@deploylite/contracts";
import {createConfirmation, createControlCommand, digestControlInput} from "./control-plane.js";
import {planBackupRetention} from "./backup-retention.js";

const identity = /^[A-Za-z0-9_-]{1,200}$/;
const digest = /^[a-f0-9]{64}$/;
function unavailable(): never { throw new Error("Archive retirement is unavailable."); }
function object(raw: unknown, keys: string[]) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) unavailable();
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).sort().join() !== keys.sort().join()) unavailable();
  return value;
}
/** Preparatory binding only. Neither receipt shape nor a reservation authorizes deletion. */
export function backupRetirementBinding(raw: unknown) {
  const value = object(raw, ["schemaVersion", "operation", "executionAllowed", "receipt", "inventoryDigest", "planDigest"]);
  const receipt = backupInventoryReceiptSchema.parse(value.receipt);
  if (value.schemaVersion !== 1 || value.operation !== "backup.retire" || value.executionAllowed !== false
    || typeof value.inventoryDigest !== "string" || !digest.test(value.inventoryDigest)
    || typeof value.planDigest !== "string" || !digest.test(value.planDigest)) unavailable();
  return {schemaVersion: 1 as const, operation: "backup.retire" as const, executionAllowed: false as const,
    receipt, inventoryDigest: value.inventoryDigest, planDigest: value.planDigest};
}
/** Caller owns authenticated inventory/grants. Select exactly one current unprotected candidate. */
export function prepareBackupRetirementConfirmation(raw: unknown) {
  try {
    const value = object(structuredClone(raw), ["snapshot", "archiveId", "expectedInventoryDigest", "expectedPlanDigest",
      "actorId", "idempotencyKey", "correlationId", "now", "commandTtlMs"]);
    for (const key of ["archiveId", "actorId", "idempotencyKey", "correlationId"])
      if (typeof value[key] !== "string" || !identity.test(value[key] as string)) unavailable();
    if (typeof value.now !== "number" || !Number.isSafeInteger(value.now) || value.now < 0
      || typeof value.commandTtlMs !== "number" || !Number.isSafeInteger(value.commandTtlMs) || value.commandTtlMs <= 0) unavailable();
    const expiresAt = new Date(value.now + value.commandTtlMs);
    if (!Number.isSafeInteger(expiresAt.getTime())) unavailable();
    const plan = planBackupRetention(value.snapshot);
    if (plan.inventoryDigest !== value.expectedInventoryDigest || plan.planDigest !== value.expectedPlanDigest
      || !plan.deletionCandidates.some(candidate => candidate.archiveId === value.archiveId)) unavailable();
    const snapshot = value.snapshot as {backups: {receipt: unknown; createdAtMs: number}[]};
    const selected = snapshot.backups.find(row => backupInventoryReceiptSchema.parse(row.receipt).archiveId === value.archiveId);
    if (!selected || snapshot.backups.some(row => row.createdAtMs > (value.now as number))) unavailable();
    const binding = backupRetirementBinding({schemaVersion: 1, operation: "backup.retire", executionAllowed: false,
      receipt: selected.receipt, inventoryDigest: plan.inventoryDigest, planDigest: plan.planDigest});
    const command = createControlCommand({actorId: value.actorId as string, action: "project.update",
      scope: {kind: "project", projectId: plan.projectId}, input: binding, idempotencyKey: value.idempotencyKey as string,
      correlationId: value.correlationId as string, expiresAt});
    return {binding, command, confirmation: createConfirmation({command, classification: "destructive", expiresAt})};
  } catch { return unavailable(); }
}
export const backupRetirementInputDigest = (raw: unknown) => digestControlInput(backupRetirementBinding(raw));
