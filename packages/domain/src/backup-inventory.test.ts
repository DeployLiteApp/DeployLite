import { expect, it } from "vitest";
import { prepareBackupInventoryRecord } from "./backup-inventory.js";
function fixture() {
 const receipt = {schemaVersion: 1, action: "compose.volume.backup", agentId: "agent-1", commandId: "command-1", projectId: "project-1", inputDigest: "a".repeat(64), correlationId: "correlation-1", volumeKey: "data", destinationId: "local-1", archiveId: "archive-1", status: "created", consistency: "stopped", archiveBytes: 100, entries: 2, archiveSha256: "b".repeat(64), manifestSha256: "c".repeat(64), idempotent: false, redacted: true};
 const command = {id: receipt.commandId, actorId: "actor-1", action: "project.update", scope: {kind: "project", projectId: receipt.projectId}, status: "completed", inputDigest: receipt.inputDigest, correlationId: receipt.correlationId};
 const metadata = {projectId: receipt.projectId, commandId: receipt.commandId, inputDigest: receipt.inputDigest, volumeKey: receipt.volumeKey, destinationId: receipt.destinationId, archiveId: receipt.archiveId, archiveBytes: receipt.archiveBytes, entries: receipt.entries, archiveSha256: receipt.archiveSha256, manifestSha256: receipt.manifestSha256, consistency: receipt.consistency, status: receipt.status};
 return {receipt, command, expectedAgentId: "agent-1", observedAtMs: 2000, audit: {action: "compose.volume.backup.executed", actorUserId: "actor-1", targetType: "project", targetId: receipt.projectId, correlationId: receipt.correlationId, createdAt: new Date(1000), metadata}};
}
it("projects authenticated backup evidence corroborated by completed control and durable audit", () => {
 const value = fixture();
 expect(prepareBackupInventoryRecord(value)).toEqual({schemaVersion: 1, receipt: value.receipt, createdAtMs: 1000});
});
it.each(["commandId", "projectId", "inputDigest", "volumeKey", "destinationId", "archiveId", "archiveSha256", "manifestSha256"])("rejects mismatched durable audit %s", key => {
 const value = fixture(); Object.assign(value.audit.metadata, {[key]: "foreign"});
 expect(() => prepareBackupInventoryRecord(value)).toThrow("cannot be accepted safely");
});
it.each(["status", "action", "inputDigest", "correlationId", "id", "actorId"])("rejects mismatched completed control %s", key => {
 const value = fixture(); Object.assign(value.command, {[key]: "foreign"});
 expect(() => prepareBackupInventoryRecord(value)).toThrow("cannot be accepted safely");
});
it("rejects foreign agent, project scope and audit actor", () => {
 const value = fixture(); value.expectedAgentId = "foreign";
 expect(() => prepareBackupInventoryRecord(value)).toThrow("cannot be accepted safely");
 const scoped = fixture(); scoped.command.scope.projectId = "foreign";
 expect(() => prepareBackupInventoryRecord(scoped)).toThrow("cannot be accepted safely");
 const actor = fixture(); actor.audit.actorUserId = "foreign";
 expect(() => prepareBackupInventoryRecord(actor)).toThrow("cannot be accepted safely");
});
it.each([new Date(NaN), new Date(-1), new Date(3000)])("rejects invalid or future durable creation time", createdAt => {
 expect(() => prepareBackupInventoryRecord({...fixture(), audit: {...fixture().audit, createdAt}})).toThrow("cannot be accepted safely");
});
