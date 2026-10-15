import {expect,it} from "vitest";
import {protocolPayloadFingerprint} from "@deploylite/contracts";
import {managedDatabaseRuntimeExecutionDigest} from "./managed-database-runtime-binding.js";
import {composeRuntimeResourceName} from "./compose-preview.js";
import {managedDatabaseBackupExecutionBinding, managedDatabaseBackupExecutionDigest, managedDatabaseBackupSourceDigest, managedDatabaseBackupReceiptMatches, managedDatabaseBackupReplayFingerprint} from "./managed-database-backup-binding.js";
function fixture() {
  const input={schemaVersion:1,projectId:"project-a",databaseId:"orders",engine:"postgres",profileId:"profile-a",planDigest:"a".repeat(64),environmentFingerprint:"b".repeat(32)};
  const originalReceipt={schemaVersion:1,projectId:input.projectId,databaseId:input.databaseId,engine:input.engine,action:"database.runtime",agentId:"agent-a",commandId:"origin-a",inputDigest:managedDatabaseRuntimeExecutionDigest(input),planDigest:input.planDigest,environmentFingerprint:input.environmentFingerprint,correlationId:"origin-correlation",containerId:"c".repeat(64),imageId:"sha256:"+"d".repeat(64),volumeName:composeRuntimeResourceName(input.projectId,"volume","db-orders"),networkName:composeRuntimeResourceName(input.projectId,"network","db-orders"),networkId:"e".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",observedAt:1000,status:"ready",health:"passed",storage:"verified",idempotent:false,redacted:true};
  const preparation={...input,originalReceipt,originalReplayFingerprint:"f".repeat(64),destinationId:"destination-a",maxBytes:1048576};
  const inputDigest=managedDatabaseBackupExecutionDigest(preparation);
  const lease={projectId:input.projectId,leaseId:"backup-lease",fence:2,expiresAt:10000};
  const query={...preparation,action:"database.runtime.backup",operation:"database.runtime.backup",agentId:"agent-a",commandId:"backup-a",inputDigest,idempotencyKey:"backup-once",requiredCapabilities:["database.runtime.backup.v1"],authority:{schemaVersion:1,projectId:input.projectId,commandId:"backup-a",action:"project.update",inputDigest,projectLease:lease},lease,context:{requestId:"request-a",correlationId:"backup-correlation"},timeoutMs:5000};
  const receipt={...input,action:"database.runtime.backup",agentId:"agent-a",commandId:"backup-a",originalCommandId:"origin-a",inputDigest,correlationId:query.context.correlationId,containerId:originalReceipt.containerId,imageId:originalReceipt.imageId,volumeName:originalReceipt.volumeName,networkName:originalReceipt.networkName,networkId:originalReceipt.networkId,volumeCreatedAt:originalReceipt.volumeCreatedAt,observedAt:2000,destinationId:preparation.destinationId,sourceDigest:managedDatabaseBackupSourceDigest(preparation),volumeKey:"db-orders",archiveId:"backup_"+"a".repeat(32),archiveBytes:4,archiveSha256:"a".repeat(64),manifestSha256:"a".repeat(64),format:"postgres-custom-gzip",consistency:"native-snapshot",status:"created",idempotent:false,storage:"verified",redacted:true};
  return {preparation,query,receipt};
}
it("binds backup to the existing project-update scope and original execution",()=>{
  const f=fixture();
  expect(managedDatabaseBackupExecutionBinding(f.preparation)).toMatchObject({action:"project.update",scope:{kind:"project",projectId:"project-a"},operation:"database.runtime.backup",destinationId:"destination-a",maxBytes:1048576});
  expect(managedDatabaseBackupExecutionDigest(f.preparation)).toMatch(/^[a-f0-9]{64}$/);
  expect(managedDatabaseBackupExecutionDigest({...f.preparation,destinationId:"destination-b"})).not.toBe(f.query.inputDigest);
  expect(managedDatabaseBackupExecutionDigest({...f.preparation,maxBytes:8})).not.toBe(f.query.inputDigest);
});
it("rejects detached original digest/physical names and caller source claims",()=>{
  const f=fixture();
  for(const patch of [{originalReceipt:{...f.preparation.originalReceipt,inputDigest:"0".repeat(64)}},{originalReceipt:{...f.preparation.originalReceipt,volumeName:composeRuntimeResourceName("foreign","volume","db-orders")}},{sourceDigest:"0".repeat(64)},{password:"private"}])
    expect(()=>managedDatabaseBackupExecutionBinding({...f.preparation,...patch})).toThrow();
});
it("matches complete bound backup evidence and refuses detached dimensions or byte overflow",()=>{
  const f=fixture();
  expect(managedDatabaseBackupReceiptMatches(f.query,f.receipt)).toBe(true);
  for(const patch of [{destinationId:"foreign"},{sourceDigest:"0".repeat(64)},{containerId:"0".repeat(64)},{inputDigest:"0".repeat(64)},{correlationId:"foreign"},{observedAt:999},{archiveBytes:f.preparation.maxBytes+1}])
    expect(managedDatabaseBackupReceiptMatches(f.query,{...f.receipt,...patch})).toBe(false);
});
it("keeps original source digest independent of destination but binds the opaque creation proof",()=>{
  const f=fixture(),digest=managedDatabaseBackupSourceDigest(f.preparation);
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
  expect(managedDatabaseBackupSourceDigest({...f.preparation,destinationId:"destination-b"})).toBe(digest);
  expect(managedDatabaseBackupSourceDigest({...f.preparation,originalReplayFingerprint:"0".repeat(64)})).not.toBe(digest);
});
it("replays the same command across read requests while binding authority, destination and correlation",()=>{
  const f=fixture(),fingerprint=managedDatabaseBackupReplayFingerprint(f.query);
  expect(fingerprint.length).toBeGreaterThan(0);
  expect(managedDatabaseBackupReplayFingerprint({...f.query,context:{...f.query.context,requestId:"retry"},timeoutMs:1000})).toBe(fingerprint);
  for(const patch of [{destinationId:"destination-b"},{context:{...f.query.context,correlationId:"foreign"}},{authority:{...f.query.authority,projectLease:{...f.query.lease,fence:3}},lease:{...f.query.lease,fence:3}}])
    expect(managedDatabaseBackupReplayFingerprint({...f.query,...patch})).not.toBe(fingerprint);
  expect(protocolPayloadFingerprint(f.preparation)).not.toBe(fingerprint);
});
