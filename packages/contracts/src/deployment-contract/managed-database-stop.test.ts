import {expect,it} from "vitest";
import {managedDatabaseStopPreparationSchema,managedDatabaseStopAgentCommandSchema,managedDatabaseStopReceiptQuerySchema,managedDatabaseStopReceiptSchema,managedDatabaseStopCachedReceiptSchema} from "./managed-database-stop.js";
const digest="a".repeat(64), fp="b".repeat(32);
const origin={schemaVersion:1,projectId:"project-a",databaseId:"orders",engine:"postgres",action:"database.runtime",agentId:"agent-a",commandId:"origin-a",inputDigest:digest,planDigest:digest,environmentFingerprint:fp,correlationId:"origin-correlation",
    containerId:"c".repeat(64),imageId:"sha256:"+"d".repeat(64),volumeName:"dl-"+fp+"-vol-db-orders",networkName:"dl-"+fp+"-net-db-orders",networkId:"e".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",observedAt:1000,status:"ready",health:"passed",storage:"verified",idempotent:false,redacted:true};
const preparation={schemaVersion:1,projectId:"project-a",databaseId:"orders",engine:"postgres",profileId:"profile-a",planDigest:digest,environmentFingerprint:fp,originalReceipt:origin,originalReplayFingerprint:"f".repeat(64)};
const lease={projectId:"project-a",leaseId:"stop-lease",fence:2,expiresAt:10000};
const query={...preparation,action:"database.runtime.stop",operation:"database.runtime.stop",agentId:"agent-a",commandId:"stop-a",inputDigest:digest,idempotencyKey:"stop-once",requiredCapabilities:["database.runtime.stop.v1"],
    authority:{schemaVersion:1,projectId:"project-a",commandId:"stop-a",action:"project.update",inputDigest:digest,projectLease:lease},lease,context:{requestId:"request-a",correlationId:"stop-correlation"},timeoutMs:5000};
it("binds the existing ready origin to a new project update stop command without secrets",()=>{
    expect(managedDatabaseStopPreparationSchema.parse(preparation)).toEqual(preparation);
    expect(managedDatabaseStopAgentCommandSchema.parse({...query,cancellationRequested:false})).toEqual({...query,cancellationRequested:false});
});
it("rejects foreign, failed or incomplete original execution evidence",()=>{
    for(const patch of [{projectId:"foreign"},{databaseId:"foreign"},{engine:"redis"},{planDigest:"f".repeat(64)},{environmentFingerprint:"f".repeat(32)},{status:"failed",health:"not-run"},{networkId:null}])
        expect(managedDatabaseStopPreparationSchema.safeParse({...preparation,originalReceipt:{...origin,...patch}}).success).toBe(false);
});
it("rejects detached authority, lease, origin agent or reused creation command",()=>{
    for(const patch of [{authority:{...query.authority,commandId:"foreign"}},{lease:{...lease,fence:3}},{agentId:"foreign"},{commandId:origin.commandId,authority:{...query.authority,commandId:origin.commandId}},{requiredCapabilities:[]}])
        expect(managedDatabaseStopAgentCommandSchema.safeParse({...query,cancellationRequested:false,...patch}).success).toBe(false);
});
it("forbids sealed or plaintext secrets, effects in cache query and caller stop argv",()=>{
    for(const patch of [{sealedEnvironment:"private"},{environment:{PASSWORD:"private"}},{command:["docker","rm"]},{force:true},{stopGraceSeconds:0}])
        expect(managedDatabaseStopAgentCommandSchema.safeParse({...query,cancellationRequested:false,...patch}).success).toBe(false);
    expect(managedDatabaseStopReceiptQuerySchema.parse(query)).toEqual(query);
    expect(managedDatabaseStopReceiptQuerySchema.safeParse({...query,cancellationRequested:false}).success).toBe(false);
});
const receipt={schemaVersion:1,projectId:"project-a",databaseId:"orders",engine:"postgres",action:"database.runtime.stop",agentId:"agent-a",commandId:"stop-a",originalCommandId:origin.commandId,profileId:"profile-a",inputDigest:digest,planDigest:digest,environmentFingerprint:fp,correlationId:"stop-correlation",
    containerId:origin.containerId,imageId:origin.imageId,volumeName:origin.volumeName,networkName:origin.networkName,networkId:origin.networkId,volumeCreatedAt:origin.volumeCreatedAt,observedAt:2000,status:"stopped",storage:"verified",redacted:true};
it("accepts stopped original identity without claiming health/readiness or removal",()=>{
    expect(managedDatabaseStopReceiptSchema.parse(receipt)).toEqual(receipt);
    for(const patch of [{status:"ready"},{health:"passed"},{removed:true},{containerId:null},{storage:"unverified"},{networkId:null}])
        expect(managedDatabaseStopReceiptSchema.safeParse({...receipt,...patch}).success).toBe(false);
});
it("binds nullable stop cache to its own command, agent and correlation",()=>{
    const cached={schemaVersion:1,action:"database.runtime.stop",agentId:"agent-a",commandId:"stop-a",correlationId:"stop-correlation",receipt};
    expect(managedDatabaseStopCachedReceiptSchema.parse(cached)).toEqual(cached);
    expect(managedDatabaseStopCachedReceiptSchema.safeParse({...cached,receipt:null}).success).toBe(true);
    for(const patch of [{commandId:"origin-a"},{agentId:"foreign"},{correlationId:"foreign"}])
        expect(managedDatabaseStopCachedReceiptSchema.safeParse({...cached,...patch}).success).toBe(false);
});
