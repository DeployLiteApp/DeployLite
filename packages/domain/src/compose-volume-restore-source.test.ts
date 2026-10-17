import {expect, it} from "vitest";
import {digestControlInput, evaluateConfirmation} from "./control-plane.js";
import {planBackupRetention} from "./backup-retention.js";
import {composeVolumeRestoreSourceBinding, composeVolumeRestoreSourceInputDigest, prepareComposeVolumeRestoreSourceConfirmation} from "./compose-volume-restore-source.js";

function fixture() {
  const receipt = {schemaVersion: 1, action: "compose.volume.backup", agentId: "agent-a", commandId: "backup-a", projectId: "project-a",
    inputDigest: "a".repeat(64), correlationId: "capture-a", volumeKey: "data", destinationId: "local-a", archiveId: "old",
    status: "created", consistency: "stopped", archiveBytes: 100, entries: 2, archiveSha256: "b".repeat(64), manifestSha256: "c".repeat(64), idempotent: false, redacted: true};
  return {source: {schemaVersion: 1, receipt, createdAtMs: 1}, projectId: "project-a", expectedAgentId: "agent-a", volumeKey: "data",
    destinationId: "local-a", archiveId: "old", backupCommandId: "backup-a", expectedArchiveSha256: receipt.archiveSha256,
    expectedManifestSha256: receipt.manifestSha256, actorId: "operator-a", idempotencyKey: "restore-source-a", correlationId: "restore-a", now: 1000, commandTtlMs: 1000};
}
it("binds one complete P3 inventory source to a distinct original pending command and destructive nonce without execution", () => {
  const input = fixture();
  expect(() => prepareComposeVolumeRestoreSourceConfirmation(input)).not.toThrow();
  const {binding, command, confirmation} = prepareComposeVolumeRestoreSourceConfirmation(input);
  expect(binding).toEqual({schemaVersion: 1, operation: "compose.volume.restore.source", executionAllowed: false, source: input.source});
  expect(command).toMatchObject({actorId: input.actorId, action: "project.update", scope: {kind: "project", projectId: input.projectId},
    status: "pending_confirmation", inputDigest: composeVolumeRestoreSourceInputDigest(binding), idempotencyKey: input.idempotencyKey, correlationId: input.correlationId, expiresAt: new Date(2000)});
  expect(command.id).not.toBe(input.source.receipt.commandId);
  expect(command.inputDigest).not.toBe(input.source.receipt.inputDigest);
  expect(command.result).toBeUndefined(); expect(command.executionAuthority).toBeUndefined(); expect(command.projectExecutionAuthority).toBeUndefined();
  expect(confirmation).toMatchObject({commandId: command.id, actorId: command.actorId, action: command.action, scope: command.scope,
    inputDigest: command.inputDigest, classification: "destructive", expiresAt: command.expiresAt, consumedAt: null});
  expect(evaluateConfirmation(command, confirmation, new Date(1000))).toEqual({eligible: true});
  expect(() => evaluateConfirmation(command, confirmation, new Date(2000))).toThrow();
  expect(Object.keys(prepareComposeVolumeRestoreSourceConfirmation(input)).sort()).toEqual(["binding", "command", "confirmation"]);
});
it.each(["protected", "retained"])("keeps a %s archive restore-selectable without retention deletion authority", reason => {
  const input = fixture();
  const newer = {...input.source, createdAtMs: 2, receipt: {...input.source.receipt, archiveId: "new"}};
  const plan = planBackupRetention({schemaVersion: 1, projectId: input.projectId, volumeKey: input.volumeKey, destinationId: input.destinationId,
    keepNewest: 1, protectedArchiveIds: reason === "protected" ? [input.archiveId] : [], backups: [input.source, newer].map(({receipt, createdAtMs}) => ({receipt, createdAtMs}))});
  const selected = reason === "protected" ? input.source : newer;
  expect(plan.retainedArchiveIds).toContain(selected.receipt.archiveId);
  expect(plan.deletionCandidates.map(row => row.archiveId)).not.toContain(selected.receipt.archiveId);
  expect(prepareComposeVolumeRestoreSourceConfirmation({...input, source: selected, archiveId: selected.receipt.archiveId}).binding.source).toEqual(selected);
});
it("copies caller input and keeps canonical binding/digest independent of object key order", () => {
  const input = fixture(), before = structuredClone(input), result = prepareComposeVolumeRestoreSourceConfirmation(input);
  expect(input).toEqual(before);
  const reversed = Object.fromEntries(Object.entries(result.binding).reverse());
  expect(composeVolumeRestoreSourceBinding(reversed)).toEqual(result.binding);
  expect(composeVolumeRestoreSourceInputDigest(reversed)).toBe(result.command.inputDigest);
  input.source.receipt.archiveSha256 = "d".repeat(64);
  expect(result.binding.source).toEqual(before.source);
});
it.each(["projectId", "agentId", "volumeKey", "destinationId", "archiveId", "commandId", "inputDigest", "correlationId", "archiveSha256", "manifestSha256"])("binds full source receipt field %s in the original intent digest", field => {
  const {binding, command, confirmation} = prepareComposeVolumeRestoreSourceConfirmation(fixture());
  const changed = structuredClone(binding) as unknown as {source: {receipt: Record<string, unknown>}};
  changed.source.receipt[field] = field.endsWith("Sha256") || field === "inputDigest" ? "d".repeat(64) : "foreign";
  const digest = composeVolumeRestoreSourceInputDigest(changed);
  expect(digest).not.toBe(command.inputDigest);
  expect(() => evaluateConfirmation({...command, inputDigest: digest}, confirmation, new Date(1000))).toThrow();
});
it.each(["projectId", "expectedAgentId", "volumeKey", "destinationId", "archiveId", "backupCommandId", "expectedArchiveSha256", "expectedManifestSha256"])("rejects foreign expected %s rather than treating a backup as restore authority", field => {
  const input: Record<string, unknown> = fixture(); input[field] = field.endsWith("Sha256") ? "d".repeat(64) : "foreign";
  expect(() => prepareComposeVolumeRestoreSourceConfirmation(input)).toThrow("Archive restore source is unavailable.");
});
it.each(["native", "extra-source", "extra-binding", "batch", "authority", "missing-actor", "bad-key", "bad-now", "future-source", "bad-created", "zero-ttl", "overflow", "null", "array", "consistency"])("rejects %s input without execution or invented defaults", mode => {
  const input = fixture() as unknown as Record<string, unknown>;
  const source = input.source as {schemaVersion: number; receipt: Record<string, unknown>; createdAtMs: number};
  if (mode === "native") source.receipt.action = "database.runtime.backup";
  if (mode === "extra-source") Object.assign(source, {authority: {claim: true}});
  if (mode === "extra-binding") {
    const {binding} = prepareComposeVolumeRestoreSourceConfirmation(fixture());
    expect(() => composeVolumeRestoreSourceBinding({...binding, executionAuthority: {claim: true}})).toThrow(); return;
  }
  if (mode === "batch") input.archiveIds = ["old", "new"];
  if (mode === "authority") input.command = {id: source.receipt.commandId, status: "completed"};
  if (mode === "missing-actor") delete input.actorId;
  if (mode === "bad-key") input.idempotencyKey = "unsafe key";
  if (mode === "bad-now") input.now = NaN;
  if (mode === "future-source") source.createdAtMs = 1001;
  if (mode === "bad-created") source.createdAtMs = -1;
  if (mode === "zero-ttl") input.commandTtlMs = 0;
  if (mode === "overflow") input.commandTtlMs = Number.MAX_SAFE_INTEGER;
  if (mode === "consistency") source.receipt.consistency = "running";
  expect(() => prepareComposeVolumeRestoreSourceConfirmation(mode === "null" ? null : mode === "array" ? [input] : input)).toThrow("Archive restore source is unavailable.");
});
it.each(["actor", "command", "scope", "digest", "consumed"])("preserves original nonce %s fences using the existing confirmation grammar", field => {
  const {command, confirmation} = prepareComposeVolumeRestoreSourceConfirmation(fixture());
  const changed = structuredClone(confirmation);
  if (field === "actor") changed.actorId = "foreign";
  if (field === "command") changed.commandId = "foreign";
  if (field === "scope") changed.scope = {kind: "project", projectId: "foreign"};
  if (field === "digest") changed.inputDigest = digestControlInput({operation: "compose.volume.backup"});
  if (field === "consumed") changed.consumedAt = new Date(1000);
  expect(() => evaluateConfirmation(command, changed, new Date(1000))).toThrow();
});
