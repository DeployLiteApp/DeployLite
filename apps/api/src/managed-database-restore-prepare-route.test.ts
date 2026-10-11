import {afterEach,expect,it,vi} from "vitest";
import {MANAGED_DATABASE_RUNTIME_CAPABILITY} from "@deploylite/contracts";
import {planManagedDatabaseProfile,composeRuntimeResourceName,createControlCommand,createConfirmation,managedDatabaseRuntimeExecutionBinding,
 managedDatabaseRuntimeReplayFingerprintDigest,managedDatabaseBackupExecutionDigest,managedDatabaseBackupSourceDigest,
 managedDatabaseRestoreExecutionDigest,resolveControlCommandInMemory,type ControlCommand,type ControlConfirmation,type ProjectUpdateControlRepository} from "@deploylite/domain";
import {prepareManagedDatabaseRestore} from "./managed-database-restore-prepare.js";
import Fastify from "fastify";
import {registerManagedDatabaseRestorePrepareRoute} from "./managed-database-restore-prepare-route.js";
import {buildApiApp} from "./app.js";
const apps:ReturnType<typeof Fastify>[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
const engines=["postgres","mysql","mariadb","mongodb","redis"] as const;
function domainFixture(engine:typeof engines[number]="postgres"){
 const paths={postgres:"/var/lib/postgresql",mysql:"/var/lib/mysql",mariadb:"/var/lib/mysql",mongodb:"/data/db",redis:"/data"};
 const ports={postgres:5432,mysql:3306,mariadb:3306,mongodb:27017,redis:6379};
 const profile={schemaVersion:1 as const,profileId:"profile-a",engine,image:"registry.example.com/"+engine+"@sha256:"+"a".repeat(64),dataPath:paths[engine],containerPort:ports[engine],credentialKeys:["DATABASE_PASSWORD"],backupStrategy:engine==="redis"?"volume-quiesced" as const:"engine-native" as const};
 const imagePolicy={policyVersion:"images-1",trustedHosts:["registry.example.com"],allowTags:false,allowDigests:true};
 const plan=planManagedDatabaseProfile({schemaVersion:1,projectId:"project-a",databaseId:"orders",engine},profile,imagePolicy);
 const base={schemaVersion:1 as const,projectId:"project-a",databaseId:"orders",engine,profileId:"profile-a",planDigest:plan.planDigest,environmentFingerprint:"b".repeat(32)};
 const seed=createControlCommand({actorId:"original-operator",action:"project.update",scope:{kind:"project",projectId:base.projectId},input:managedDatabaseRuntimeExecutionBinding(base),idempotencyKey:"original-create",correlationId:"original-correlation",expiresAt:new Date(10000)});
 const original:ControlCommand={...seed,status:"completed",projectExecutionAuthority:{schemaVersion:1,projectId:base.projectId,commandId:seed.id,action:"project.update",inputDigest:seed.inputDigest,projectLease:{leaseId:"lease-original",projectId:base.projectId,fence:1,expiresAt:10000}}};
 const {profileId:_profile,...receiptBase}=base;
 const originalReceipt={...receiptBase,action:"database.runtime" as const,agentId:"agent-a",commandId:seed.id,inputDigest:seed.inputDigest,correlationId:seed.correlationId,containerId:"c".repeat(64),imageId:"sha256:"+"d".repeat(64),volumeName:composeRuntimeResourceName(base.projectId,"volume","db-orders"),networkName:composeRuntimeResourceName(base.projectId,"network","db-orders"),networkId:"e".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",observedAt:1000,status:"ready" as const,health:"passed" as const,storage:"verified" as const,idempotent:false,redacted:true as const};
 const query={...base,action:"database.runtime",operation:"database.runtime.apply",agentId:"agent-a",commandId:seed.id,inputDigest:seed.inputDigest,idempotencyKey:seed.idempotencyKey,requiredCapabilities:[MANAGED_DATABASE_RUNTIME_CAPABILITY],authority:original.projectExecutionAuthority,lease:original.projectExecutionAuthority!.projectLease,context:{requestId:"original-request",correlationId:seed.correlationId},timeoutMs:1000};
 const source={...base,originalReceipt,originalReplayFingerprint:managedDatabaseRuntimeReplayFingerprintDigest(query)},capture={...source,destinationId:"private-native",maxBytes:2097152};
 const {health:_health,status:_status,...physical}=originalReceipt;
 const backupReceipt={...physical,profileId:base.profileId,action:"database.runtime.backup",commandId:"backup-a",originalCommandId:seed.id,inputDigest:managedDatabaseBackupExecutionDigest(capture),correlationId:"backup-correlation",volumeKey:"db-orders",sourceDigest:managedDatabaseBackupSourceDigest(capture),destinationId:capture.destinationId,archiveId:"backup_"+"f".repeat(32),archiveBytes:4,archiveSha256:"a".repeat(64),manifestSha256:"b".repeat(64),format:{postgres:"postgres-custom-gzip",mysql:"mysql-sql-gzip",mariadb:"mariadb-sql-gzip",mongodb:"mongodb-archive-gzip",redis:"volume-tar"}[engine],consistency:{postgres:"native-snapshot",mysql:"global-read-lock",mariadb:"global-read-lock",mongodb:"quiesced-writes",redis:"all-consumers-stopped"}[engine],status:"created"};
 const selection={...source,archiveId:backupReceipt.archiveId,destinationId:backupReceipt.destinationId,expectedArchiveSha256:backupReceipt.archiveSha256,expectedManifestSha256:backupReceipt.manifestSha256,maxBytes:capture.maxBytes};
 const preparation={...source,backupReceipt,maxBytes:capture.maxBytes},ledger=new Map<string,ControlCommand>(),nonces=new Map<string,ControlConfirmation>();
 const forbidden=vi.fn(async()=>{throw new Error("Execution forbidden.");});
 const controls={resolve:vi.fn(async(command:ControlCommand)=>resolveControlCommandInMemory(ledger,command)),complete:forbidden,claimProjectUpdate:forbidden,validateProjectUpdateAuthority:forbidden,completeProjectUpdate:forbidden,
  findProjectUpdateById:vi.fn(async()=>structuredClone(original)),findProjectUpdateByIdempotency:vi.fn(async()=>structuredClone([...ledger.values()][0]??null)),
  resolveProjectUpdateConfirmation:vi.fn(async(command:ControlCommand)=>{let nonce=nonces.get(command.id);if(!nonce){nonce=createConfirmation({command,classification:"destructive"});nonces.set(command.id,nonce);}return structuredClone(nonce);})} satisfies ProjectUpdateControlRepository;
 const originalTransport={available:()=>true,readReceipt:vi.fn(async()=>structuredClone(originalReceipt)),dispatch:forbidden};
 const inventory={available:()=>true,list:vi.fn(async()=>[{schemaVersion:1,receipt:backupReceipt,createdAtMs:1000}] as any)};
 const view={archiveId:backupReceipt.archiveId,archiveBytes:4,archiveSha256:backupReceipt.archiveSha256,manifestSha256:backupReceipt.manifestSha256,format:backupReceipt.format,integrity:"verified",redacted:true};
 const archive={verify:vi.fn(async(_preparation:unknown,_signal:AbortSignal)=>({...view}))};
 const access={controls,originalTransport,agentId:"agent-a",deadlineMs:1000,inventory,archive,now:()=>1000,commandTtlMs:1000};
 const input={selection,actorId:"operator-a",idempotencyKey:"restore-orders",context:{requestId:"prepare-request",correlationId:"prepare-correlation"},authorize:vi.fn(async()=>true),current:vi.fn(()=>true),admit:vi.fn(async()=>{})};
 return {profile,imagePolicy,access,input,preparation,controls,nonces,ledger,originalTransport,inventory,archive,view,forbidden};
}
function fixture(engine:typeof engines[number]="postgres"){
 const f=domainFixture(engine),app=Fastify();apps.push(app);
 const grants=vi.fn(async()=>[{id:"grant-a",actorId:f.input.actorId,action:"project.update" as const,scope:{kind:"project" as const,projectId:"project-a"}}]);
 const projects=vi.fn(async()=>({id:"project-a",name:"fixture",repoUrl:"https://example.test/repo",defaultBranch:"main",buildCommand:null,runCommand:null,port:null,description:null,imageTag:null}));
 const options={prefix:"/api/v1",configuration:{profiles:new Map([[engine,f.profile]]),projectIds:new Set(["project-a"]),deadlineMs:1000},imagePolicy:f.imagePolicy,
  executions:new Map([["project-a",f.access]]),projects:{findById:projects},grants:{listForActor:grants},
  requireAuth:async(request:unknown)=>{Object.assign(request as object,{auth:{user:{id:f.input.actorId,role:"operator"}},correlationContext:f.input.context});},requireRole:async()=>{},
  ok:(_request:unknown,data:unknown)=>({data}),error:(_request:unknown,code:string)=>({error:{code}})};
 registerManagedDatabaseRestorePrepareRoute(app,options);
 const {projectId:_project,databaseId:_database,...body}=f.input.selection;
 const call=(payload:unknown=body,key="restore-orders")=>app.inject({method:"POST",url:"/api/v1/projects/project-a/databases/orders/runtime/restore/prepare",headers:{"idempotency-key":key},payload:payload as Record<string,unknown>});
 return {...f,app,options,grants,projects,body,call};
}
it.each(engines)("authenticates and recovers original %s pending approval without exposing archive data",async engine=>{
 const f=fixture(engine),first=await f.call();expect(first.statusCode).toBe(200);const data=first.json().data;
 expect(data).toMatchObject({idempotent:false,command:{status:"pending_confirmation",action:"project.update"},confirmation:{classification:"destructive",consumedAt:null}});
 expect(Object.keys(data).sort()).toEqual(["command","confirmation","idempotent"]);expect(data.command).not.toHaveProperty("actorId");expect(data.command).not.toHaveProperty("projectExecutionAuthority");expect(data.confirmation).not.toHaveProperty("inputDigest");
 expect((await f.call()).json().data).toEqual({...data,idempotent:true});expect(f.ledger.size).toBe(1);expect(f.nonces.size).toBe(1);expect(f.forbidden).not.toHaveBeenCalled();
});
it("requires project grant before private source and inventory reads",async()=>{const f=fixture();f.grants.mockResolvedValue([]);expect((await f.call()).statusCode).toBe(403);expect(f.projects).not.toHaveBeenCalled();expect(f.originalTransport.readReceipt).not.toHaveBeenCalled();});
it("refuses caller receipts paths credentials actor and force flags before private reads",async()=>{for(const patch of [{backupReceipt:{}},{path:"private-fixture"},{password:"private"},{actorId:"foreign"},{force:true},{confirmationId:"foreign"}]){const f=fixture();expect((await f.call({...f.body,...patch})).statusCode).toBe(400);expect(f.projects).not.toHaveBeenCalled();}});
it("rejects malformed idempotency key before source reads",async()=>{const f=fixture();expect((await f.call(f.body,"bad key")).statusCode).toBe(400);expect(f.projects).not.toHaveBeenCalled();});
it("refuses absent server access or profile without nonce creation",async()=>{for(const kind of ["access","profile","scope"]){const f=fixture();if(kind==="access")f.options.executions.clear();if(kind==="profile")f.options.configuration.profiles.clear();if(kind==="scope")f.options.configuration.projectIds.clear();expect((await f.call()).statusCode).toBe(503);expect(f.controls.resolve).not.toHaveBeenCalled();}});
it("rechecks grant revoked during private archive read before pending writes",async()=>{const f=fixture();f.archive.verify.mockImplementation(async()=>{f.grants.mockResolvedValue([]);return {...f.view};});expect((await f.call()).statusCode).toBe(503);expect(f.controls.resolve).not.toHaveBeenCalled();});
it("bounds stalled grant lookup without private reads",async()=>{const f=fixture();f.access.deadlineMs=5;f.grants.mockImplementation(()=>new Promise(()=>{}));expect((await f.call()).statusCode).toBe(503);expect(f.projects).not.toHaveBeenCalled();},2000);
it("redacts private archive failures in the API envelope",async()=>{const f=fixture();f.archive.verify.mockImplementation(async()=>{throw new Error("password=private-fixture");});const response=await f.call();expect(response.statusCode).toBe(503);expect(response.body).not.toContain("private-fixture");expect(f.controls.resolve).not.toHaveBeenCalled();});
it("registers authenticated restore preparation in actual bootstrap",async()=>{const f=fixture(),app=await buildApiApp({env:{NODE_ENV:"test"}});apps.push(app);expect((await app.inject({method:"POST",url:"/api/v1/projects/project-a/databases/orders/runtime/restore/prepare",headers:{"idempotency-key":"restore"},payload:f.body})).statusCode).toBe(401);});
it("refuses a project reader returning a foreign project before private archive reads",async()=>{const f=fixture();f.projects.mockResolvedValue({...await f.projects(),id:"foreign"});expect((await f.call()).statusCode).toBe(503);expect(f.archive.verify).not.toHaveBeenCalled();expect(f.controls.resolve).not.toHaveBeenCalled();});
it("refuses profile changes during archive reads before nonce persistence",async()=>{const f=fixture();f.archive.verify.mockImplementation(async()=>{f.profile.image="registry.example.com/postgres@sha256:"+"f".repeat(64);return {...f.view};});expect((await f.call()).statusCode).toBe(503);expect(f.controls.resolve).not.toHaveBeenCalled();});
it("refuses a consumed original nonce through the route without renewing it",async()=>{const f=fixture();expect((await f.call()).statusCode).toBe(200);const nonce=[...f.nonces.values()][0]!;nonce.consumedAt=new Date(1000);expect((await f.call()).statusCode).toBe(503);expect(f.nonces.size).toBe(1);expect(f.ledger.size).toBe(1);expect(f.forbidden).not.toHaveBeenCalled();});
