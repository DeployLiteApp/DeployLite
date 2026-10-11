import { expect, it, vi } from "vitest";
import { prepareBackupRetentionPreview } from "./backup-retention-preview.js";
const input = {schemaVersion: 1, volumeKey: "data", destinationId: "local-1", keepNewest: 1};
function record(archiveId: string, createdAtMs: number) {
  return {schemaVersion: 1 as const, createdAtMs, receipt: {schemaVersion: 1 as const, action: "compose.volume.backup" as const, agentId: "agent-1", commandId: "command-1", projectId: "project-1", inputDigest: "a".repeat(64), correlationId: "correlation-1", volumeKey: "data", destinationId: "local-1", archiveId, status: "created" as const, consistency: "stopped" as const, archiveBytes: 100, entries: 2, archiveSha256: "b".repeat(64), manifestSha256: "c".repeat(64), idempotent: false, redacted: true as const}};
}
function ports() {
  return {expectedAgentId: "agent-1", inventory: {available: vi.fn(() => true), list: vi.fn(async () => [record("old", 1), record("middle", 2), record("new", 3)])},
    protections: {available: vi.fn(() => true), list: vi.fn(async () => ["old"])}};
}
it("prepares a bound preview using server-owned inventory and restore protections", async () => {
  const p = ports(), plan = await prepareBackupRetentionPreview("project-1", input, p);
  expect(plan).toMatchObject({executionAllowed: false, retainedArchiveIds: ["new", "old"], protectedArchiveIds: ["old"], deletionCandidates: [{archiveId: "middle"}]});
  expect(p.inventory.list).toHaveBeenCalledWith("project-1", "data", "local-1");
  expect(p.protections.list).toHaveBeenCalledTimes(2);
});
it("replays identical bound metadata and rejects a stale client inventory digest", async () => {
  const first = await prepareBackupRetentionPreview("project-1", input, ports());
  expect(await prepareBackupRetentionPreview("project-1", {...input, expectedInventoryDigest: first.inventoryDigest}, ports())).toEqual(first);
  await expect(prepareBackupRetentionPreview("project-1", {...input, expectedInventoryDigest: "e".repeat(64)}, ports())).rejects.toMatchObject({code: "stale-inventory"});
});
it("rejects inventory changed during preparation", async () => {
  const p = ports(); p.inventory.list.mockResolvedValueOnce([record("old", 1), record("middle", 2), record("new", 3)]);
  const changed = record("middle", 2); changed.receipt.archiveSha256 = "d".repeat(64);
  p.inventory.list.mockResolvedValueOnce([record("old", 1), changed, record("new", 3)]);
  await expect(prepareBackupRetentionPreview("project-1", input, p)).rejects.toMatchObject({code: "stale-inventory"});
});
it("rejects restore protections changed during preparation", async () => {
  const p = ports(); p.protections.list.mockResolvedValueOnce(["old"]).mockResolvedValueOnce([]);
  await expect(prepareBackupRetentionPreview("project-1", input, p)).rejects.toMatchObject({code: "stale-protection"});
});
it("refuses caller-provided inventory or protections before reading storage", async () => {
  const p = ports();
  await expect(prepareBackupRetentionPreview("project-1", {...input, backups: [], protectedArchiveIds: []}, p)).rejects.toMatchObject({code: "invalid-input"});
  expect(p.inventory.list).not.toHaveBeenCalled();
});
it("fails closed without configured server protection storage", async () => {
  const p = ports(); p.protections.available.mockReturnValue(false);
  await expect(prepareBackupRetentionPreview("project-1", input, p)).rejects.toMatchObject({code: "unavailable"});
  expect(p.inventory.list).not.toHaveBeenCalled();
});
it("rejects foreign durable archive evidence", async () => {
  const p = ports(), foreign = record("old", 1); foreign.receipt.projectId = "foreign";
  p.inventory.list.mockResolvedValue([foreign]);
  await expect(prepareBackupRetentionPreview("project-1", input, p)).rejects.toMatchObject({code: "unavailable"});
});
it("rejects already aborted preparation without reading inventory", async () => {
  const p = ports(), controller = new AbortController(); controller.abort();
  await expect(prepareBackupRetentionPreview("project-1", input, p, controller.signal)).rejects.toMatchObject({code: "unavailable"});
  expect(p.inventory.list).not.toHaveBeenCalled();
});
