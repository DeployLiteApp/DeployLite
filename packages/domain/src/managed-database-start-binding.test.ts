import {expect,it} from "vitest";
import {composeRuntimeResourceName} from "./compose-preview.js";
import {managedDatabaseRuntimeExecutionDigest} from "./managed-database-runtime-binding.js";
import {managedDatabaseStopExecutionDigest} from "./managed-database-stop-binding.js";
import {managedDatabaseStartExecutionBinding,managedDatabaseStartExecutionDigest,managedDatabaseStartReceiptMatches,
  managedDatabaseStartReplayFingerprint,managedDatabaseStartReplayFingerprintDigest} from "./managed-database-start-binding.js";
function fixture(){
  const base={schemaVersion:1,projectId:"p1",databaseId:"orders",engine:"postgres",profileId:"approved",planDigest:"a".repeat(64),environmentFingerprint:"b".repeat(32)};
  const original={schemaVersion:1,projectId:base.projectId,databaseId:base.databaseId,engine:base.engine,action:"database.runtime",agentId:"agent1",commandId:"create1",
    inputDigest:managedDatabaseRuntimeExecutionDigest(base),planDigest:base.planDigest,environmentFingerprint:base.environmentFingerprint,correlationId:"create-correlation",
    containerId:"c".repeat(64),imageId:"sha256:"+"d".repeat(64),volumeName:composeRuntimeResourceName(base.projectId,"volume","db-orders"),
    networkName:composeRuntimeResourceName(base.projectId,"network","db-orders"),networkId:"e".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",
    observedAt:1000,status:"ready",health:"passed",storage:"verified",idempotent:false,redacted:true};
  const stopInput={...base,originalReceipt:original,originalReplayFingerprint:"f".repeat(64)};
  const {health:_health,idempotent:_idempotent,...physical}=original;
  const stopped={...physical,action:"database.runtime.stop",commandId:"stop1",originalCommandId:original.commandId,profileId:base.profileId,
    inputDigest:managedDatabaseStopExecutionDigest(stopInput),correlationId:"stop-correlation",observedAt:2000,status:"stopped"};
  const preparation={...stopInput,originalStopReceipt:stopped,originalStopReplayFingerprint:"0".repeat(64)};
  const inputDigest=managedDatabaseStartExecutionDigest(preparation),lease={projectId:base.projectId,leaseId:"start-lease",fence:3,expiresAt:30000};
  const query={...preparation,action:"database.runtime.start",operation:"database.runtime.start",agentId:original.agentId,commandId:"start1",idempotencyKey:"start-key",inputDigest,
    requiredCapabilities:["database.runtime.start.v1"],authority:{schemaVersion:1,projectId:base.projectId,commandId:"start1",action:"project.update",inputDigest,projectLease:lease},
    lease,context:{requestId:"start-request",correlationId:"start-correlation"},timeoutMs:10000};
  const receipt={...original,action:query.action,commandId:query.commandId,inputDigest,correlationId:query.context.correlationId,profileId:base.profileId,
    originalCommandId:original.commandId,originalStopCommandId:stopped.commandId,observedAt:3000};
  return {preparation,query,receipt};
}
it("binds start to both prior receipts without mutating inputs",()=>{
  const f=fixture(),before=structuredClone(f.preparation);
  expect(managedDatabaseStartExecutionBinding(f.preparation)).toEqual({...f.preparation,action:"project.update",scope:{kind:"project",projectId:"p1"},operation:"database.runtime.start"});
  expect(f.preparation).toEqual(before);expect(managedDatabaseStartExecutionDigest(f.preparation)).toMatch(/^[a-f0-9]{64}$/);
});
it("rejects detached creation/stop digests and resource names",()=>{
  const f=fixture();
  for(const patch of [{originalReceipt:{...f.preparation.originalReceipt,inputDigest:"0".repeat(64)}},{originalStopReceipt:{...f.preparation.originalStopReceipt,inputDigest:"0".repeat(64)}},
    {originalReceipt:{...f.preparation.originalReceipt,volumeName:"dl-"+"0".repeat(32)+"-vol-db-orders"},originalStopReceipt:{...f.preparation.originalStopReceipt,volumeName:"dl-"+"0".repeat(32)+"-vol-db-orders"}}])
    expect(()=>managedDatabaseStartExecutionBinding({...f.preparation,...patch})).toThrow();
});
it("matches every original resource source-command and new-command dimension",()=>{
  const f=fixture();expect(managedDatabaseStartReceiptMatches(f.query,f.receipt)).toBe(true);
  for(const patch of [{agentId:"foreign"},{commandId:"foreign"},{originalCommandId:"foreign"},{originalStopCommandId:"foreign"},{profileId:"foreign"},{correlationId:"foreign"},
    {containerId:"0".repeat(64)},{imageId:"sha256:"+"0".repeat(64)},{networkId:"0".repeat(64)},{inputDigest:"0".repeat(64)},{observedAt:1999}])
    expect(managedDatabaseStartReceiptMatches(f.query,{...f.receipt,...patch})).toBe(false);
});
it("never matches a query whose new digest or authority is detached",()=>{
  const f=fixture();expect(managedDatabaseStartReceiptMatches({...f.query,inputDigest:"0".repeat(64)},f.receipt)).toBe(false);
  expect(managedDatabaseStartReceiptMatches({...f.query,authority:{...f.query.authority,commandId:"foreign"}},f.receipt)).toBe(false);
});
it("ignores read request/timeout but binds correlation and both opaque original selectors",()=>{
  const f=fixture(),fingerprint=managedDatabaseStartReplayFingerprint(f.query);
  expect(managedDatabaseStartReplayFingerprintDigest(f.query)).toMatch(/^[a-f0-9]{64}$/);
  expect(managedDatabaseStartReplayFingerprint({...f.query,context:{...f.query.context,requestId:"read-request"},timeoutMs:1})).toBe(fingerprint);
  expect(managedDatabaseStartReplayFingerprint({...f.query,context:{...f.query.context,correlationId:"foreign"}})).not.toBe(fingerprint);
  expect(managedDatabaseStartReplayFingerprint({...f.query,originalStopReplayFingerprint:"1".repeat(64)})).not.toBe(fingerprint);
});
