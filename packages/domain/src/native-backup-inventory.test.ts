import {expect,it} from "vitest";
import {nativeBackupInventoryAuditMetadata,prepareBackupInventoryRecord} from "./backup-inventory.js";
function fixture() {
  const receipt={schemaVersion:1,projectId:"project-a",databaseId:"orders",engine:"postgres",action:"database.runtime.backup",agentId:"agent-a",commandId:"backup-a",originalCommandId:"origin-a",profileId:"profile-a",inputDigest:"a".repeat(64),planDigest:"a".repeat(64),environmentFingerprint:"b".repeat(32),correlationId:"correlation-a",containerId:"c".repeat(64),imageId:"sha256:"+"d".repeat(64),volumeName:"dl-"+"b".repeat(32)+"-vol-db-orders",networkName:"dl-"+"b".repeat(32)+"-net-db-orders",networkId:"e".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",observedAt:1000,volumeKey:"db-orders",destinationId:"destination-a",sourceDigest:"f".repeat(64),archiveId:"backup_"+"a".repeat(32),archiveBytes:4,archiveSha256:"a".repeat(64),manifestSha256:"b".repeat(64),format:"postgres-custom-gzip",consistency:"native-snapshot",status:"created",idempotent:false,storage:"verified",redacted:true};
  const command={id:receipt.commandId,actorId:"actor-a",action:"project.update",scope:{kind:"project",projectId:receipt.projectId},status:"completed",inputDigest:receipt.inputDigest,correlationId:receipt.correlationId};
  const metadata=nativeBackupInventoryAuditMetadata(receipt);
  return {receipt,command,expectedAgentId:receipt.agentId,observedAtMs:2000,audit:{action:"database.runtime.backup.executed",actorUserId:command.actorId,targetType:"project",targetId:receipt.projectId,correlationId:receipt.correlationId,createdAt:new Date(1500),metadata}};
}
it("projects native archive evidence into the existing scoped immutable inventory",()=>{
  const f=fixture();expect(prepareBackupInventoryRecord(f)).toEqual({schemaVersion:1,receipt:f.receipt,createdAtMs:1500});
});
it.each(["sourceDigest","databaseId","engine","format","containerId","volumeCreatedAt","originalCommandId"])("rejects detached native audit %s",field=>{
  const f=fixture();Object.assign(f.audit.metadata,{[field]:"foreign"});expect(()=>prepareBackupInventoryRecord(f)).toThrow();
});
it("refuses native evidence under the old Compose audit action or another inventory key",()=>{
  const f=fixture();f.audit.action="compose.volume.backup.executed";expect(()=>prepareBackupInventoryRecord(f)).toThrow();
  const g=fixture();g.receipt.volumeKey="db-foreign";g.audit.metadata.volumeKey="db-foreign";expect(()=>prepareBackupInventoryRecord(g)).toThrow();
});
it("corroborates a redacted completion by digest without exposing physical resource identifiers",async()=>{
  const {redactSecrets}=await import("@deploylite/config");const {digestControlInput}=await import("./control-plane.js");
  const f=fixture();f.audit.metadata={...redactSecrets(f.receipt),nativeReceiptDigest:digestControlInput({...f.receipt,status:"created",idempotent:false})} as typeof f.audit.metadata;
  expect(f.audit.metadata.containerId).toBe("[REDACTED]");
  expect(prepareBackupInventoryRecord(f).receipt.containerId).toBe(f.receipt.containerId);
});
