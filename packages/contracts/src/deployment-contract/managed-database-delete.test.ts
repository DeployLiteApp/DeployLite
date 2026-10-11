import {expect,it} from "vitest";
import {managedDatabaseDeletePreparationSchema,managedDatabaseDeleteAgentCommandSchema,managedDatabaseDeleteReceiptQuerySchema,managedDatabaseDeleteReceiptSchema,managedDatabaseDeleteCachedReceiptSchema} from "./managed-database-delete.js";
function fixture(engine="postgres",priorStop=false){
 const original={schemaVersion:1,projectId:"p1",databaseId:"orders",engine,action:"database.runtime",agentId:"agent1",commandId:"create1",inputDigest:"a".repeat(64),planDigest:"b".repeat(64),environmentFingerprint:"c".repeat(32),correlationId:"create-correlation",containerId:"d".repeat(64),imageId:"sha256:"+"e".repeat(64),volumeName:"dl-"+"f".repeat(32)+"-vol-db-orders",networkName:"dl-"+"f".repeat(32)+"-net-db-orders",networkId:"1".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",observedAt:1000,status:"ready",health:"passed",storage:"verified",idempotent:false,redacted:true};
 const {health:_health,idempotent:_idempotent,...physical}=original;
 const stopped={...physical,action:"database.runtime.stop",commandId:"stop1",originalCommandId:"create1",profileId:"approved",inputDigest:"2".repeat(64),correlationId:"stop-correlation",observedAt:2000,status:"stopped"};
 const source={schemaVersion:1,projectId:"p1",databaseId:"orders",engine,profileId:"approved",planDigest:original.planDigest,environmentFingerprint:original.environmentFingerprint,originalReceipt:original,originalReplayFingerprint:"3".repeat(64)};
 const preparation=priorStop?{...source,originalStopReceipt:stopped,originalStopReplayFingerprint:"4".repeat(64)}:source;
 const lease={projectId:"p1",leaseId:"delete-lease",fence:4,expiresAt:30000},command={...preparation,action:"database.runtime.delete",operation:"database.runtime.delete",storagePolicy:"retain-original",stopPolicy:"if-running",confirmationId:"confirmation1",agentId:"agent1",commandId:"delete1",inputDigest:"5".repeat(64),idempotencyKey:"delete-key",requiredCapabilities:["database.runtime.delete.v1"],authority:{schemaVersion:1,projectId:"p1",commandId:"delete1",action:"project.update",inputDigest:"5".repeat(64),projectLease:lease},lease,context:{requestId:"delete-request",correlationId:"delete-correlation"},timeoutMs:10000,cancellationRequested:false};
 const {cancellationRequested:_cancel,...query}=command;
 const receipt={...physical,action:"database.runtime.delete",commandId:"delete1",originalCommandId:"create1",originalStopCommandId:priorStop?"stop1":null,confirmationId:"confirmation1",profileId:"approved",inputDigest:command.inputDigest,correlationId:"delete-correlation",observedAt:3000,status:"removed",storage:"retained"};
 const cached={schemaVersion:1,action:"database.runtime.delete",confirmationId:"confirmation1",agentId:"agent1",commandId:"delete1",correlationId:"delete-correlation",receipt};
 return {original,stopped,preparation,command,query,receipt,cached};
}
it.each(["postgres","mysql","mariadb","mongodb","redis"])("binds confirmed %s removal to original ready source with optional original STOP",engine=>{
 for(const prior of [false,true]){const f=fixture(engine,prior);
  expect(managedDatabaseDeletePreparationSchema.safeParse(f.preparation).success).toBe(true);
  expect(managedDatabaseDeleteAgentCommandSchema.safeParse(f.command).success).toBe(true);
  expect(managedDatabaseDeleteReceiptQuerySchema.safeParse(f.query).success).toBe(true);
  expect(managedDatabaseDeleteReceiptSchema.safeParse(f.receipt).success).toBe(true);
  expect(managedDatabaseDeleteCachedReceiptSchema.safeParse(f.cached).success).toBe(true);
 }
});
it("refuses detached original scope optional STOP pairing resources and cache selectors",()=>{
 const f=fixture("postgres",true);
 for(const patch of [{projectId:"foreign"},{originalStopReceipt:undefined},{originalStopReplayFingerprint:undefined},{originalReplayFingerprint:"raw"},{originalStopReceipt:{...f.stopped,containerId:"0".repeat(64)}},{originalStopReceipt:{...f.stopped,observedAt:999}}])expect(managedDatabaseDeletePreparationSchema.safeParse({...f.preparation,...patch}).success).toBe(false);
});
it("refuses reused commands detached agent authority lease nonce and effect overrides",()=>{
 const f=fixture("postgres",true);
 for(const patch of [{commandId:"create1"},{commandId:"stop1"},{agentId:"foreign"},{confirmationId:""},{authority:{...f.command.authority,inputDigest:"0".repeat(64)}},{lease:{...f.command.lease,fence:5}},{storagePolicy:"remove"},{stopPolicy:"force"},{force:true},{deleteVolumes:true},{sealedEnvironment:"private"},{environment:{PASSWORD:"private"}},{argv:["rm","-v"]}])expect(managedDatabaseDeleteAgentCommandSchema.safeParse({...f.command,...patch}).success).toBe(false);
 expect(managedDatabaseDeleteReceiptQuerySchema.safeParse(f.command).success).toBe(false);
});
it("refuses reused removed receipt identities private fields and detached cache wrapper",()=>{
 const f=fixture("postgres",true);
 for(const patch of [{commandId:"create1"},{commandId:"stop1"},{confirmationId:""},{status:"ready"},{storage:"removed"},{password:"private"},{force:true}])expect(managedDatabaseDeleteReceiptSchema.safeParse({...f.receipt,...patch}).success).toBe(false);
 for(const patch of [{agentId:"foreign"},{commandId:"foreign"},{confirmationId:"foreign"},{correlationId:"foreign"},{password:"private"}])expect(managedDatabaseDeleteCachedReceiptSchema.safeParse({...f.cached,...patch}).success).toBe(false);
});
