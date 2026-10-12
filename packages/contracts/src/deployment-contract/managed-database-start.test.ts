import {expect,it} from "vitest";
import {managedDatabaseStartPreparationSchema,managedDatabaseStartAgentCommandSchema,managedDatabaseStartReceiptSchema,managedDatabaseStartCachedReceiptSchema} from "./managed-database-start.js";
function fixture(engine = "postgres") {
  const original = {schemaVersion:1,projectId:"p1",databaseId:"orders",engine,action:"database.runtime",agentId:"agent1",commandId:"create1",inputDigest:"a".repeat(64),
    planDigest:"b".repeat(64),environmentFingerprint:"c".repeat(32),correlationId:"create-correlation",containerId:"d".repeat(64),imageId:"sha256:"+"e".repeat(64),
    volumeName:"dl-"+"f".repeat(32)+"-vol-db-orders",networkName:"dl-"+"f".repeat(32)+"-net-db-orders",networkId:"1".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",
    observedAt:1000,status:"ready",health:"passed",storage:"verified",idempotent:false,redacted:true};
  const {health:_health,idempotent:_idempotent,...physical} = original;
  const stopped = {...physical,action:"database.runtime.stop",commandId:"stop1",originalCommandId:original.commandId,profileId:"approved",inputDigest:"2".repeat(64),correlationId:"stop-correlation",observedAt:2000,status:"stopped"};
  const preparation = {schemaVersion:1,projectId:original.projectId,databaseId:original.databaseId,engine,profileId:"approved",planDigest:original.planDigest,
    environmentFingerprint:original.environmentFingerprint,originalReceipt:original,originalReplayFingerprint:"3".repeat(64),originalStopReceipt:stopped,originalStopReplayFingerprint:"4".repeat(64)};
  const lease = {projectId:original.projectId,leaseId:"new-lease",fence:3,expiresAt:30000};
  const command = {...preparation,action:"database.runtime.start",operation:"database.runtime.start",agentId:original.agentId,commandId:"start1",inputDigest:"5".repeat(64),idempotencyKey:"start-key",
    requiredCapabilities:["database.runtime.start.v1"],authority:{schemaVersion:1,projectId:original.projectId,commandId:"start1",action:"project.update",inputDigest:"5".repeat(64),projectLease:lease},
    lease,context:{requestId:"start-request",correlationId:"start-correlation"},timeoutMs:10000,cancellationRequested:false};
  const receipt = {...original,action:"database.runtime.start",commandId:command.commandId,inputDigest:command.inputDigest,correlationId:command.context.correlationId,
    originalCommandId:original.commandId,originalStopCommandId:stopped.commandId,profileId:preparation.profileId,observedAt:3000};
  return {original,stopped,preparation,command,receipt};
}
it.each(["postgres","mysql","mariadb","mongodb","redis"])("binds %s start to both original ready and stopped identities", engine => {
  const f=fixture(engine);expect(managedDatabaseStartPreparationSchema.safeParse(f.preparation).success).toBe(true);
  expect(managedDatabaseStartPreparationSchema.parse(f.preparation)).toEqual(f.preparation);
  expect(managedDatabaseStartAgentCommandSchema.parse(f.command)).toEqual(f.command);expect(managedDatabaseStartReceiptSchema.parse(f.receipt)).toEqual(f.receipt);
});
it("rejects changed source scope profile storage creator agent and stopped chronology", () => {
  const f=fixture();
  for(const patch of [{projectId:"foreign"},{databaseId:"foreign"},{engine:"redis"},{agentId:"foreign"},{originalCommandId:"foreign"},{containerId:"0".repeat(64)},
    {imageId:"sha256:"+"0".repeat(64)},{planDigest:"0".repeat(64)},{networkId:"0".repeat(64)},{volumeCreatedAt:"2026-10-09T00:00:00Z"},{profileId:"foreign"},{observedAt:999}])
    expect(managedDatabaseStartPreparationSchema.safeParse({...f.preparation,originalStopReceipt:{...f.stopped,...patch}}).success).toBe(false);
  expect(managedDatabaseStartPreparationSchema.safeParse({...f.preparation,originalReceipt:{...f.original,status:"failed",health:"failed"}}).success).toBe(false);
});
it("rejects new command reuse and detached authority lease or agent", () => {
  const f=fixture();
  for(const patch of [{commandId:"create1"},{commandId:"stop1"},{agentId:"foreign"},{lease:{...f.command.lease,fence:4}},
    {authority:{...f.command.authority,commandId:"foreign"}},{authority:{...f.command.authority,inputDigest:"0".repeat(64)}}])
    expect(managedDatabaseStartAgentCommandSchema.safeParse({...f.command,...patch}).success).toBe(false);
});
it("refuses caller secret environment image argv port grace and invalid opaque fingerprints", () => {
  const f=fixture();
  for(const patch of [{sealedEnvironment:"private"},{environment:{PASSWORD:"private"}},{image:"foreign"},{argv:["docker","rm"]},{port:1234},{stopGraceSeconds:10},
    {originalReplayFingerprint:"raw-proof"},{originalStopReplayFingerprint:"raw-proof"}])
    expect(managedDatabaseStartAgentCommandSchema.safeParse({...f.command,...patch}).success).toBe(false);
});
it("requires ready nonnull original resources and distinct linked source commands", () => {
  const f=fixture();
  for(const patch of [{containerId:null},{networkId:null},{volumeCreatedAt:null},{status:"failed"},{health:"not-run"},{storage:"unverified"},
    {originalCommandId:"start1"},{originalStopCommandId:"start1"},{originalStopCommandId:"create1"},{password:"private"}])
    expect(managedDatabaseStartReceiptSchema.safeParse({...f.receipt,...patch}).success).toBe(false);
});
it("binds cache wrapper exactly to its own start command and correlation", () => {
  const f=fixture(),cache={schemaVersion:1,action:"database.runtime.start",agentId:"agent1",commandId:"start1",correlationId:"start-correlation",receipt:f.receipt};
  expect(managedDatabaseStartCachedReceiptSchema.safeParse(cache).success).toBe(true);
  expect(managedDatabaseStartCachedReceiptSchema.parse(cache)).toEqual(cache);
  for(const patch of [{agentId:"foreign"},{commandId:"foreign"},{correlationId:"foreign"},{password:"private"}])
    expect(managedDatabaseStartCachedReceiptSchema.safeParse({...cache,...patch}).success).toBe(false);
});
