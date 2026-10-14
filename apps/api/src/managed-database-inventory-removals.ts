import { managedDatabaseDeleteReceiptSchema, managedDatabaseHealthPreparationSchema, projectControlAuthoritySchema, managedDatabaseProfileRequestSchema,
  type ManagedDatabaseDeleteReceiptV1, type ManagedDatabaseHealthPreparationV1 } from "@deploylite/contracts";
import { digestControlInput, type ControlCommand } from "@deploylite/domain";

/** Immutable completed commands are the retirement ledger; absent or malformed proof fails closed. */
export function validateManagedDatabaseRemovalHistory(projectId: string, commands: readonly ControlCommand[]): Readonly<{
  receipts: readonly ManagedDatabaseDeleteReceiptV1[]; fingerprint: string;
}> {
  managedDatabaseProfileRequestSchema.pick({projectId: true}).parse({projectId});
  const snapshot = structuredClone(commands), ids = new Set<string>(), originals = new Set<string>();
  const receipts = snapshot.map(command => {
    const receipt = managedDatabaseDeleteReceiptSchema.parse(command.result), authority = projectControlAuthoritySchema.parse(command.projectExecutionAuthority);
    const expiry = command.expiresAt instanceof Date ? command.expiresAt.getTime() : NaN;
    if (command.status !== "completed" || command.action !== "project.update" || command.scope.kind !== "project"
      || command.scope.projectId !== projectId || receipt.projectId !== projectId || receipt.commandId !== command.id
      || receipt.inputDigest !== command.inputDigest || receipt.correlationId !== command.correlationId
      || !authority || authority.projectId !== projectId || authority.commandId !== command.id
      || authority.action !== command.action || authority.inputDigest !== command.inputDigest
      || authority.projectLease.projectId !== projectId || !Number.isSafeInteger(expiry)
      || authority.projectLease.expiresAt !== expiry || receipt.observedAt >= expiry
      || ids.has(command.id) || originals.has(receipt.originalCommandId)) throw new Error("Invalid database retirement history");
    ids.add(command.id); originals.add(receipt.originalCommandId);
    return receipt;
  });
  const fingerprint = digestControlInput(snapshot.map(command => ({...command, expiresAt: command.expiresAt.getTime()}))
    .sort((left, right) => left.id.localeCompare(right.id)));
  return {receipts, fingerprint};
}

/** A later creation with the same database name must remain visible. */
export function isOriginalManagedDatabaseRemoved(source: ManagedDatabaseHealthPreparationV1,
  receipts: readonly ManagedDatabaseDeleteReceiptV1[]): boolean {
  const original = managedDatabaseHealthPreparationSchema.parse(source);
  const removed = receipts.find(receipt => receipt.originalCommandId === original.originalReceipt.commandId);
  if (!removed) return false;
  const parsed = managedDatabaseDeleteReceiptSchema.parse(removed), ready = original.originalReceipt;
  for (const key of ["projectId", "databaseId", "engine", "planDigest", "environmentFingerprint", "agentId",
    "containerId", "imageId", "volumeName", "networkName", "networkId", "volumeCreatedAt"] as const) {
    if (parsed[key] !== ready[key]) throw new Error("Retirement does not match original physical database");
  }
  if (parsed.profileId !== original.profileId || parsed.observedAt < ready.observedAt) throw new Error("Invalid original retirement binding");
  return true;
}
