import {expect, it} from "vitest";
import * as domain from "./index.js";
const receipt = {schemaVersion: 1, action: "compose.volume.backup", agentId: "agent-a", commandId: "backup-a", projectId: "project-a", inputDigest: "a".repeat(64), correlationId: "capture-a", volumeKey: "data", destinationId: "local-a", archiveId: "old", status: "created", consistency: "stopped", archiveBytes: 100, entries: 2, archiveSha256: "b".repeat(64), manifestSha256: "c".repeat(64), idempotent: false, redacted: true};
function input() {
  const snapshot = {schemaVersion: 1, projectId: "project-a", volumeKey: "data", destinationId: "local-a", keepNewest: 1, protectedArchiveIds: [], backups: [{receipt, createdAtMs: 1}, {receipt: {...receipt, commandId: "backup-b", archiveId: "new"}, createdAtMs: 2}]};
  const plan = domain.planBackupRetention(snapshot);
  return {snapshot, archiveId: "old", expectedInventoryDigest: plan.inventoryDigest, expectedPlanDigest: plan.planDigest, actorId: "operator-a", idempotencyKey: "retire-old", correlationId: "retire-a", now: 1000, commandTtlMs: 1000};
}
const prepare = (raw: unknown) => (domain as unknown as {prepareBackupRetirementConfirmation?: (raw: unknown) => {binding: unknown; command: domain.ControlCommand; confirmation: domain.ControlConfirmation}}).prepareBackupRetirementConfirmation?.(raw);
it("binds one explicit archive to a distinct destructive confirmation without execution authority", () => {
  const value = prepare(input());
  expect(value?.binding).toMatchObject({operation: "backup.retire", executionAllowed: false, receipt});
  expect(value?.command).toMatchObject({action: "project.update", status: "pending_confirmation", actorId: "operator-a"});
  expect(value?.confirmation).toMatchObject({classification: "destructive", consumedAt: null, commandId: value?.command.id});
  expect(value?.command.projectExecutionAuthority).toBeUndefined();
});
it.each(["archive", "inventory", "plan", "protected", "retained", "batch", "expired"])("rejects %s detached or ineligible individual intent", mode => {
  const raw = input();
  if (mode === "archive") raw.archiveId = "missing";
  if (mode === "inventory") raw.expectedInventoryDigest = "0".repeat(64);
  if (mode === "plan") raw.expectedPlanDigest = "0".repeat(64);
  if (mode === "protected") raw.snapshot.protectedArchiveIds = ["old"] as never[];
  if (mode === "retained") raw.archiveId = "new";
  if (mode === "expired") raw.commandTtlMs = 0;
  expect(() => prepare(mode === "batch" ? {...raw, archiveIds: ["old", "new"]} : raw)).toThrow("Archive retirement is unavailable.");
});
