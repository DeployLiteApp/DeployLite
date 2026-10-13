import {expect,it} from "vitest";
import {createHash} from "node:crypto";
import {composeRuntimeResourceName} from "./compose-preview.js";
import {managedDatabaseRuntimeExecutionDigest} from "./managed-database-runtime-binding.js";
import {managedDatabaseStopExecutionDigest} from "./managed-database-stop-binding.js";
import {managedDatabaseDeleteExecutionDigest,managedDatabaseDeleteReceiptMatches,managedDatabaseDeleteReplayFingerprint,managedDatabaseDeleteReplayFingerprintDigest} from "./managed-database-delete-binding.js";
function fixture(engine="postgres") {
 const base={schemaVersion:1,projectId:"p1",databaseId:"orders",engine,profileId:"approved",planDigest:"a".repeat(64),environmentFingerprint:"b".repeat(32)};
 const original={schemaVersion:1,projectId:base.projectId,databaseId:base.databaseId,engine,action:"database.runtime",agentId:"agent1",commandId:"create1",inputDigest:managedDatabaseRuntimeExecutionDigest(base),planDigest:base.planDigest,environmentFingerprint:base.environmentFingerprint,correlationId:"create-correlation",containerId:"c".repeat(64),imageId:"sha256:"+"d".repeat(64),volumeName:composeRuntimeResourceName(base.projectId,"volume","db-orders"),networkName:composeRuntimeResourceName(base.projectId,"network","db-orders"),networkId:"e".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",observedAt:1000,status:"ready",health:"passed",storage:"verified",idempotent:false,redacted:true};
 const source={...base,originalReceipt:original,originalReplayFingerprint:"f".repeat(64)}, {health:_health,idempotent:_idem,...physical}=original;
 const stopped={...physical,action:"database.runtime.stop",commandId:"stop1",originalCommandId:"create1",profileId:base.profileId,inputDigest:managedDatabaseStopExecutionDigest(source),correlationId:"stop-correlation",observedAt:2000,status:"stopped"};
 return {...source,originalStopReceipt:stopped,originalStopReplayFingerprint:"0".repeat(64)};
}
function pair(engine:string,withStop:boolean){
 const full=fixture(engine),{originalStopReceipt:_stop,originalStopReplayFingerprint:_fp,...ready}=full,source=withStop?full:ready;
 const inputDigest=managedDatabaseDeleteExecutionDigest(source),lease={projectId:source.projectId,leaseId:"lease-delete",fence:3,expiresAt:10000};
 const query={...source,action:"database.runtime.delete",operation:"database.runtime.delete",storagePolicy:"retain-original",stopPolicy:"if-running",confirmationId:"approval1",agentId:"agent1",commandId:"delete1",inputDigest,idempotencyKey:"delete-key",requiredCapabilities:["database.runtime.delete.v1"],authority:{schemaVersion:1,projectId:source.projectId,commandId:"delete1",action:"project.update",inputDigest,projectLease:lease},lease,context:{requestId:"request1",correlationId:"delete-correlation"},timeoutMs:1000};
 const original=source.originalReceipt;
 const receipt={schemaVersion:1,action:query.action,agentId:query.agentId,commandId:query.commandId,originalCommandId:original.commandId,originalStopCommandId:withStop?full.originalStopReceipt.commandId:null,confirmationId:query.confirmationId,projectId:source.projectId,databaseId:source.databaseId,engine,profileId:source.profileId,inputDigest,planDigest:source.planDigest,environmentFingerprint:source.environmentFingerprint,correlationId:query.context.correlationId,containerId:original.containerId,imageId:original.imageId,volumeName:original.volumeName,networkName:original.networkName,networkId:original.networkId,volumeCreatedAt:original.volumeCreatedAt,observedAt:3000,status:"removed",storage:"retained",redacted:true};
 return {query,receipt};
}
it.each(["postgres","mysql","mariadb","mongodb","redis"])("matches all original and confirmed %s dimensions with and without STOP",engine=>{
 for(const withStop of [false,true]){const {query,receipt}=pair(engine,withStop);expect(managedDatabaseDeleteReceiptMatches(query,receipt)).toBe(true);
 for(const patch of [{confirmationId:"other"},{originalStopCommandId:withStop?null:"foreign"},{originalCommandId:"foreign"},{commandId:"foreign"},{agentId:"foreign"},{projectId:"foreign"},{databaseId:"foreign"},{profileId:"foreign"},{inputDigest:"0".repeat(64)},{containerId:"0".repeat(64)},{networkId:"0".repeat(64)},{correlationId:"foreign"},{observedAt:999},{storage:"removed"},{redacted:false}])expect(managedDatabaseDeleteReceiptMatches(query,{...receipt,...patch})).toBe(false);
 }
});
it("binds replay to approval and source while ignoring only read request and timeout",()=>{
 const {query}=pair("postgres",true),fp=managedDatabaseDeleteReplayFingerprint(query);
 expect(managedDatabaseDeleteReplayFingerprint({...query,timeoutMs:500,context:{...query.context,requestId:"next"}})).toBe(fp);
 expect(managedDatabaseDeleteReplayFingerprint({...query,confirmationId:"other"})).not.toBe(fp);
 expect(managedDatabaseDeleteReplayFingerprintDigest(query)).toBe(createHash("sha256").update(fp).digest("hex"));
 expect(()=>managedDatabaseDeleteReplayFingerprint({...query,force:true})).toThrow();
});
it("refuses coordinated forged digest and future prior STOP receipt",()=>{
 const {query,receipt}=pair("postgres",true);expect(managedDatabaseDeleteReceiptMatches({...query,inputDigest:"0".repeat(64),authority:{...query.authority,inputDigest:"0".repeat(64)}},{...receipt,inputDigest:"0".repeat(64)})).toBe(false);
 expect(managedDatabaseDeleteReceiptMatches(query,{...receipt,observedAt:1999})).toBe(false);
});
