import {expect,it} from "vitest";
import {MANAGED_DATABASE_HEALTH_CAPABILITY,managedDatabaseHealthPreparationSchema,managedDatabaseHealthAgentQuerySchema,managedDatabaseHealthObservationSchema} from "./managed-database-health.js";
const digest="a".repeat(64), fp="b".repeat(32);
const origin={schemaVersion:1,projectId:"project-a",databaseId:"orders",engine:"postgres",action:"database.runtime",agentId:"agent-a",commandId:"origin-a",inputDigest:digest,planDigest:digest,environmentFingerprint:fp,correlationId:"origin-correlation",
    containerId:"c".repeat(64),imageId:"sha256:"+"d".repeat(64),volumeName:"dl-"+fp+"-vol-db-orders",networkName:"dl-"+fp+"-net-db-orders",networkId:"e".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",observedAt:1000,status:"ready",health:"passed",storage:"verified",idempotent:false,redacted:true};
const preparation={schemaVersion:1,projectId:"project-a",databaseId:"orders",engine:"postgres",profileId:"profile-a",planDigest:digest,environmentFingerprint:fp,originalReceipt:origin,originalReplayFingerprint:"f".repeat(64)};
const query={...preparation,action:"database.runtime.health",agentId:"agent-a",requiredCapabilities:[MANAGED_DATABASE_HEALTH_CAPABILITY],context:{requestId:"health-request",correlationId:"health-correlation"},timeoutMs:5000};
const {commandId:originalCommandId,inputDigest:_digest,correlationId:_correlation,status:_status,health:_health,idempotent:_idem,...physical}=origin;
const observation={...physical,action:"database.runtime.health",originalCommandId,profileId:"profile-a",state:"running",health:"healthy",uid:999,context:query.context,observedAt:2000};
for(const engine of ["postgres","mysql","mariadb","mongodb","redis"] as const)it(`binds readonly ${engine} health to original ready identity`,()=>{
 const prep={...preparation,engine,originalReceipt:{...origin,engine}};
 expect(managedDatabaseHealthPreparationSchema.safeParse(prep).success).toBe(true);expect(managedDatabaseHealthAgentQuerySchema.safeParse({...query,...prep}).success).toBe(true);
 expect(managedDatabaseHealthObservationSchema.safeParse({...observation,engine}).success).toBe(true);
});
it("accepts corroborated unhealthy, starting, unknown and stopped views without stale readiness",()=>{
 for(const health of ["unhealthy","starting","unknown"])expect(managedDatabaseHealthObservationSchema.safeParse({...observation,health}).success).toBe(true);
 expect(managedDatabaseHealthObservationSchema.safeParse({...observation,state:"stopped",health:"not-running",uid:null}).success).toBe(true);
});
it("rejects detached source scope, missing ready proof, capabilities and private fields",()=>{
 for(const patch of [{agentId:"foreign"},{projectId:"foreign"},{databaseId:"other"},{engine:"redis"},{requiredCapabilities:["database.runtime.v1"]},
  {password:"private"},{authority:{}},{sealedEnvironment:"private"},{argv:["--all"]},{cancellationRequested:false},{timeoutMs:60001},{context:{requestId:"",correlationId:"x"}}])expect(managedDatabaseHealthAgentQuerySchema.safeParse({...query,...patch}).success).toBe(false);
 for(const patch of [{status:"failed",health:"not-run"},{containerId:null},{networkId:null},{storage:"unverified"}])expect(managedDatabaseHealthAgentQuerySchema.safeParse({...query,originalReceipt:{...origin,...patch}}).success).toBe(false);
});
it("requires actual current nonroot/stopped state and public observation bounds",()=>{
 for(const patch of [{uid:0},{uid:4294967295},{uid:null},{state:"stopped"},{health:"not-running"},{state:"stopped",health:"not-running",uid:999},
  {password:"private"},{logs:"private"},{environment:{}},{observedAt:Number.NaN},{observedAt:-1},{containerId:null},{imageId:null},{redacted:false}])expect(managedDatabaseHealthObservationSchema.safeParse({...observation,...patch}).success).toBe(false);
});
