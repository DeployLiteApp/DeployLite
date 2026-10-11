import { expect, it } from "vitest";
import { managedDatabaseBackupAgentCommandSchema, managedDatabaseBackupReceiptSchema } from "./managed-database-backup.js";
const digest = "a".repeat(64), fingerprint = "b".repeat(32);
const engines = ["postgres", "mysql", "mariadb", "mongodb", "redis"] as const;
const formats = {postgres:"postgres-custom-gzip", mysql:"mysql-sql-gzip", mariadb:"mariadb-sql-gzip", mongodb:"mongodb-archive-gzip", redis:"volume-tar"};
const consistency = {postgres:"native-snapshot", mysql:"transactional-tables", mariadb:"transactional-tables", mongodb:"quiesced-writes", redis:"all-consumers-stopped"};
function fixture(engine:typeof engines[number] = "postgres") {
  const originalReceipt = {schemaVersion:1, projectId:"project-a", databaseId:"orders", engine, action:"database.runtime", agentId:"agent-a", commandId:"origin-a", inputDigest:digest, planDigest:digest, environmentFingerprint:fingerprint, correlationId:"origin-correlation", containerId:"c".repeat(64), imageId:"sha256:"+"d".repeat(64), volumeName:"dl-"+fingerprint+"-vol-db-orders", networkName:"dl-"+fingerprint+"-net-db-orders", networkId:"e".repeat(64), volumeCreatedAt:"2026-10-10T00:00:00Z", observedAt:1000, status:"ready", health:"passed", storage:"verified", idempotent:false, redacted:true};
  const lease = {projectId:"project-a", leaseId:"backup-lease", fence:2, expiresAt:10000};
  const command = {schemaVersion:1, projectId:"project-a", databaseId:"orders", engine, profileId:"profile-a", planDigest:digest, environmentFingerprint:fingerprint, originalReceipt, originalReplayFingerprint:"f".repeat(64), destinationId:"destination-a", maxBytes:1048576, action:"database.runtime.backup", operation:"database.runtime.backup", agentId:"agent-a", commandId:"backup-a", inputDigest:digest, idempotencyKey:"backup-once", requiredCapabilities:["database.runtime.backup.v1"], authority:{schemaVersion:1, projectId:"project-a", commandId:"backup-a", action:"project.update", inputDigest:digest, projectLease:lease}, lease, context:{requestId:"request-a", correlationId:"backup-correlation"}, timeoutMs:5000, cancellationRequested:false};
  const receipt = {schemaVersion:1, projectId:"project-a", databaseId:"orders", engine, action:"database.runtime.backup", agentId:"agent-a", commandId:"backup-a", originalCommandId:"origin-a", profileId:"profile-a", inputDigest:digest, planDigest:digest, environmentFingerprint:fingerprint, correlationId:"backup-correlation", containerId:originalReceipt.containerId, imageId:originalReceipt.imageId, volumeName:originalReceipt.volumeName, networkName:originalReceipt.networkName, networkId:originalReceipt.networkId, volumeCreatedAt:originalReceipt.volumeCreatedAt, observedAt:2000, destinationId:"destination-a", sourceDigest:"f".repeat(64), volumeKey:"db-orders",archiveId:"backup_"+"a".repeat(32), archiveBytes:4, archiveSha256:digest, manifestSha256:digest, format:formats[engine], consistency:consistency[engine], status:"created", idempotent:false, storage:"verified", redacted:true};
  return {command, receipt};
}
it.each(engines)("binds a private %s backup to existing project-update authority and engine evidence", engine => {
  const f=fixture(engine);
  expect(managedDatabaseBackupAgentCommandSchema.safeParse(f.command).success).toBe(true);
  expect(managedDatabaseBackupReceiptSchema.safeParse(f.receipt).success).toBe(true);
});
it("rejects detached authority, source, destination and caller secret/path/effect fields", () => {
  const f=fixture();
  for(const patch of [{authority:{...f.command.authority,commandId:"foreign"}}, {lease:{...f.command.lease,fence:3}}, {agentId:"foreign"}, {originalReceipt:{...f.command.originalReceipt,projectId:"foreign"}}, {destinationId:"/tmp/private"}, {maxBytes:0}, {password:"private"}, {path:"/tmp/private"}, {argv:["docker","exec"]}, {force:true}, {consistency:"native-snapshot"}])
    expect(managedDatabaseBackupAgentCommandSchema.safeParse({...f.command,...patch}).success).toBe(false);
});
it("rejects mismatched native format/consistency, incomplete integrity and private receipt data", () => {
  const f=fixture();
  for(const patch of [{format:"volume-tar"}, {consistency:"all-consumers-stopped"}, {archiveBytes:0}, {archiveSha256:null}, {sourceDigest:null}, {archiveId:"../archive"}, {path:"/private"}, {stdout:"private"}, {commandId:"origin-a"}, {idempotent:true}])
    expect(managedDatabaseBackupReceiptSchema.safeParse({...f.receipt,...patch}).success).toBe(false);
});
it("accepts immutable replay only with the matching already-created marker", () => {
  const f=fixture();
  expect(managedDatabaseBackupReceiptSchema.safeParse({...f.receipt,status:"already-created",idempotent:true}).success).toBe(true);
  expect(managedDatabaseBackupReceiptSchema.safeParse({...f.receipt,status:"already-created"}).success).toBe(false);
});

it("binds native archive inventory key to the original database without accepting another volume",()=>{
  const f=fixture();
  expect(managedDatabaseBackupReceiptSchema.safeParse({...f.receipt,volumeKey:"db-orders"}).success).toBe(true);
  expect(managedDatabaseBackupReceiptSchema.safeParse({...f.receipt,volumeKey:"db-foreign"}).success).toBe(false);
});

it.each(["mysql","mariadb"] as const)("accepts explicit %s global read lock consistency without changing previous metadata",engine=>{
 const f=fixture(engine);expect(managedDatabaseBackupReceiptSchema.safeParse({...f.receipt,consistency:"global-read-lock"}).success).toBe(true);
 expect(managedDatabaseBackupReceiptSchema.safeParse(f.receipt).success).toBe(true);
 expect(managedDatabaseBackupReceiptSchema.safeParse({...fixture("postgres").receipt,consistency:"global-read-lock"}).success).toBe(false);
});
