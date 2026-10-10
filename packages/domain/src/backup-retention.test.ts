import { expect, it } from "vitest";
import { planBackupRetention } from "./backup-retention.js";
const receipt = (archiveId: string) => ({schemaVersion: 1, action: "compose.volume.backup", agentId: "agent-1", commandId: "command-1", projectId: "project-1", inputDigest: "a".repeat(64), correlationId: "correlation-1", volumeKey: "data", destinationId: "local-1", archiveId, status: "created", consistency: "stopped", archiveBytes: 100, entries: 2, archiveSha256: "b".repeat(64), manifestSha256: "c".repeat(64), idempotent: false, redacted: true});
const input = () => ({schemaVersion: 1, projectId: "project-1", volumeKey: "data", destinationId: "local-1", keepNewest: 1, protectedArchiveIds: ["old"], backups: [{receipt: receipt("old"), createdAtMs: 1}, {receipt: receipt("middle"), createdAtMs: 2}, {receipt: receipt("new"), createdAtMs: 3}]});
it("retains the newest and restore-protected archives and returns bound deletion candidates without effects", () => {
 expect(planBackupRetention(input())).toMatchObject({executionAllowed: false, retainedArchiveIds: ["new", "old"], deletionCandidates: [{archiveId: "middle", archiveSha256: "b".repeat(64), manifestSha256: "c".repeat(64)}]});
});
it("binds the inventory digest to its project scope", () => {
 const a = input(), b = input(); b.projectId = "project-2"; b.backups.forEach(item => { item.receipt.projectId = "project-2"; });
 expect(planBackupRetention(a).inventoryDigest).not.toBe(planBackupRetention(b).inventoryDigest);
});
it("binds restore protection even when the protected archive is already newest", () => {
 const a = input(), b = input(); a.protectedArchiveIds = []; b.protectedArchiveIds = ["new"];
 expect(planBackupRetention(a).planDigest).not.toBe(planBackupRetention(b).planDigest);
});
it.each(["projectId", "volumeKey", "destinationId"] as const)("rejects foreign %s evidence", key => {
 const value = input(); value.backups[0]!.receipt[key] = "foreign";
 expect(() => planBackupRetention(value)).toThrow("cannot be planned safely");
});
it.each([0, -1, 1.5, 10_001])("rejects invalid keep count %s", keepNewest => {
 expect(() => planBackupRetention({...input(), keepNewest})).toThrow("cannot be planned safely");
});
it("rejects ambiguous inventory and stale restore protection", () => {
 const value = input(); value.backups.push(value.backups[0]!);
 expect(() => planBackupRetention(value)).toThrow("cannot be planned safely");
 expect(() => planBackupRetention({...input(), protectedArchiveIds: ["missing"]})).toThrow("cannot be planned safely");
});
it("keeps all existing archives when count exceeds inventory and leaves input intact", () => {
 const value = {...input(), keepNewest: 10}, snapshot = structuredClone(value);
 expect(planBackupRetention(value).deletionCandidates).toEqual([]);
 expect(value).toEqual(snapshot);
});
it("produces identical digests for reordered inventory and rejects secret-bearing records", () => {
 const a = input(), b = input(); b.backups.reverse();
 expect(planBackupRetention(a)).toEqual(planBackupRetention(b));
 expect(() => planBackupRetention({...a, password: "secret-canary"})).toThrow("cannot be planned safely");
});
it("binds retained archive integrity to the plan digest", () => {
 const a = input(), b = input(); b.backups[2]!.receipt.manifestSha256 = "d".repeat(64);
 expect(planBackupRetention(a).planDigest).not.toBe(planBackupRetention(b).planDigest);
});
