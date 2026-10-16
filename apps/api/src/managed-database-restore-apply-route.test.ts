import {afterEach,expect,it,vi} from "vitest";
import {MANAGED_DATABASE_RUNTIME_CAPABILITY} from "@deploylite/contracts";
import {composeRuntimeResourceName,createControlCommand,createConfirmation,managedDatabaseRuntimeExecutionBinding,
 managedDatabaseRuntimeReplayFingerprintDigest,managedDatabaseBackupExecutionDigest,managedDatabaseBackupSourceDigest,
 managedDatabaseRestoreExecutionDigest,resolveControlCommandInMemory,type ControlCommand,type ControlConfirmation,type ProjectUpdateControlRepository} from "@deploylite/domain";
import {prepareManagedDatabaseRestore} from "./managed-database-restore-prepare.js";
import Fastify from "fastify";
import {registerManagedDatabaseRestoreApplyRoute} from "./managed-database-restore-apply-route.js";
import {buildApiApp} from "./app.js";
import {planManagedDatabaseProfile} from "@deploylite/domain";
const apps:ReturnType<typeof Fastify>[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
const engines=["postgres","mysql","mariadb","mongodb","redis"] as const;
import {applyManagedDatabaseRestore} from "./managed-database-restore-apply.js";
import {managedDatabaseRestoreReceiptMatches,type ManagedDatabaseRestoreCompletionInput} from "@deploylite/domain";
import {managedDatabaseRestoreReceiptSchema,managedDatabaseRestorePreparationSchema,type ManagedDatabaseRestoreReceiptV1} from "@deploylite/contracts";
function fixture(engine:typeof engines[number]="postgres"){
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
 const preparation=managedDatabaseRestorePreparationSchema.parse({...source,backupReceipt,maxBytes:capture.maxBytes}),ledger=new Map<string,ControlCommand>(),nonces=new Map<string,ControlConfirmation>();
 const forbidden=vi.fn(async()=>{throw new Error("Execution forbidden.");});
 const controls={resolve:vi.fn(async(command:ControlCommand)=>resolveControlCommandInMemory(ledger,command)),complete:forbidden,claimProjectUpdate:forbidden,validateProjectUpdateAuthority:forbidden,completeProjectUpdate:forbidden,
  findProjectUpdateById:vi.fn(async()=>structuredClone(original)),findProjectUpdateByIdempotency:vi.fn(async()=>structuredClone([...ledger.values()][0]??null)),
  resolveProjectUpdateConfirmation:vi.fn(async(command:ControlCommand)=>{let nonce=nonces.get(command.id);if(!nonce){nonce=createConfirmation({command,classification:"destructive"});nonces.set(command.id,nonce);}return structuredClone(nonce);})} satisfies ProjectUpdateControlRepository;
 const originalTransport={available:()=>true,readReceipt:vi.fn(async()=>structuredClone(originalReceipt)),dispatch:forbidden};
 const inventory={available:()=>true,list:vi.fn(async()=>[{schemaVersion:1,receipt:backupReceipt,createdAtMs:1000}] as any)};
 const view={archiveId:backupReceipt.archiveId,archiveBytes:4,archiveSha256:backupReceipt.archiveSha256,manifestSha256:backupReceipt.manifestSha256,format:backupReceipt.format,integrity:"verified",redacted:true};
 const archive={verify:vi.fn(async(_preparation:unknown,_signal:AbortSignal)=>({...view}))};
 const protection={protect:vi.fn(async()=>{})};
 const access={protection,controls,originalTransport,agentId:"agent-a",deadlineMs:1000,inventory,archive,now:()=>1000,commandTtlMs:1000};
 const input={selection,actorId:"operator-a",idempotencyKey:"restore-orders",context:{requestId:"prepare-request",correlationId:"prepare-correlation"},authorize:vi.fn(async()=>true),current:vi.fn(()=>true),admit:vi.fn(async()=>{})};
 return {profile,imagePolicy,protection,access,input,preparation,controls,nonces,ledger,originalTransport,inventory,archive,view,forbidden};
}
async function setup(engine:typeof engines[number]="postgres"){
 const f=fixture(engine),now={value:1000};f.access.now=()=>now.value;const intent=await prepareManagedDatabaseRestore(f.access,f.input),nonce=f.nonces.get(intent.command.id)!;
 const save=(command:ControlCommand)=>{const key=[...f.ledger].find(([,value])=>value.id===command.id)![0];f.ledger.set(key,structuredClone(command));return structuredClone(command);};
 const claimConfirmedProjectUpdate=vi.fn(async(command:ControlCommand,confirmation:ControlConfirmation)=>{
  if(confirmation.id!==nonce.id||nonce.consumedAt!==null||nonce.expiresAt.getTime()<=now.value)return {command,accepted:false,claimed:false,reason:"confirmation_rejected"};
  nonce.consumedAt=new Date(now.value);const authority={schemaVersion:1 as const,projectId:command.scope.kind==="project"?command.scope.projectId:"foreign",commandId:command.id,action:"project.update" as const,inputDigest:command.inputDigest,projectLease:{leaseId:"restore-lease",projectId:"project-a",fence:2,expiresAt:command.expiresAt.getTime()}};
  return {command:save({...command,status:"dispatching",projectExecutionAuthority:authority}),accepted:true,claimed:true,authority,reason:null};
 });
 const audit=vi.fn(),completeManagedDatabaseRestore=vi.fn(async(input:ManagedDatabaseRestoreCompletionInput)=>{
  if(!managedDatabaseRestoreReceiptMatches(input.query,input.receipt))throw new Error("invalid receipt");const current=[...f.ledger.values()][0]!;
  if(current.status==="completed")return structuredClone(current);audit(input.audit);return save({...input.command,status:"completed",result:input.receipt});
 });
 const controls={...f.controls,claimConfirmedProjectUpdate,completeManagedDatabaseRestore,validateProjectUpdateAuthority:vi.fn(async()=>{}),validateConfirmedProjectUpdateAuthority:vi.fn(async(_authority:unknown,id:string)=>{if(id!==nonce.id||!nonce.consumedAt)throw new Error("unconsumed");})};
 const assertProtected=vi.fn(async(_preparation:unknown,command:ControlCommand,id:string)=>{if(command.id!==intent.command.id||id!==nonce.id)throw new Error("detached protection");}),protection={...f.protection,assertProtected};
 const receiptFor=(command:ControlCommand):ManagedDatabaseRestoreReceiptV1=>{
  const original=f.preparation.originalReceipt,backup=f.preparation.backupReceipt;
  return managedDatabaseRestoreReceiptSchema.parse({schemaVersion:1,action:"database.runtime.restore",projectId:f.preparation.projectId,databaseId:f.preparation.databaseId,engine,profileId:f.preparation.profileId,agentId:"agent-a",commandId:command.id,originalCommandId:original.commandId,backupCommandId:backup.commandId,confirmationId:nonce.id,inputDigest:command.inputDigest,planDigest:f.preparation.planDigest,environmentFingerprint:f.preparation.environmentFingerprint,correlationId:command.correlationId,containerId:original.containerId,imageId:original.imageId,volumeName:original.volumeName,networkName:original.networkName,networkId:original.networkId,volumeCreatedAt:original.volumeCreatedAt,archiveId:backup.archiveId,archiveBytes:backup.archiveBytes,archiveSha256:backup.archiveSha256,manifestSha256:backup.manifestSha256,format:backup.format as ManagedDatabaseRestoreReceiptV1["format"],observedAt:1000,status:"restored",storage:"original",health:"passed",redacted:true});
 };
 const cache=new Map<string,ManagedDatabaseRestoreReceiptV1>(),transport={available:vi.fn(()=>true),readReceipt:vi.fn(async(p:{command:ControlCommand})=>cache.get(p.command.id)??null),dispatch:vi.fn(async(p:{command:ControlCommand})=>{const receipt=receiptFor(p.command);cache.set(p.command.id,receipt);return receipt;})};
 const options={...f.access,controls,protection,transport},input={preparation:f.preparation,actorId:f.input.actorId,idempotencyKey:f.input.idempotencyKey,confirmationId:nonce.id,context:{requestId:"apply-request",correlationId:"request-correlation"},authorize:f.input.authorize,current:f.input.current,admit:f.input.admit};
 f.controls.resolve.mockClear();f.originalTransport.readReceipt.mockClear();f.inventory.list.mockClear();f.archive.verify.mockClear();
 return {...f,options,input,intent,nonce,controls,protection,transport,cache,now,receiptFor,save,audit};
}

async function routeFixture(engine:typeof engines[number]="postgres") {
 const f=await setup(engine),app=Fastify();apps.push(app);
 f.controls.resolveProjectUpdateConfirmation.mockClear();f.controls.findProjectUpdateByIdempotency.mockClear();
 const grants=vi.fn(async()=>[{id:"grant-a",actorId:f.input.actorId,action:"project.update" as const,scope:{kind:"project" as const,projectId:"project-a"}}]);
 const projects=vi.fn(async()=>({id:"project-a",name:"fixture",repoUrl:"https://example.test/repo",defaultBranch:"main",buildCommand:null,runCommand:null,port:null,description:null,imageTag:null}));
 const options={prefix:"/api/v1",configuration:{profiles:new Map([[engine,f.profile]]),projectIds:new Set(["project-a"]),deadlineMs:1000},imagePolicy:f.imagePolicy,
  executions:new Map([["project-a",f.options]]),projects:{findById:projects},grants:{listForActor:grants},
  requireAuth:async(request:unknown)=>{Object.assign(request as object,{auth:{user:{id:f.input.actorId,role:"operator"}},correlationContext:f.input.context});},requireRole:async()=>{},
  ok:(_request:unknown,data:unknown)=>({data}),error:(_request:unknown,code:string)=>({error:{code}})};
 registerManagedDatabaseRestoreApplyRoute(app,options);
 const {backupReceipt,maxBytes,...source}=f.preparation;
 const {projectId:_project,databaseId:_database,...selection}={...source,archiveId:backupReceipt.archiveId,destinationId:backupReceipt.destinationId,expectedArchiveSha256:backupReceipt.archiveSha256,expectedManifestSha256:backupReceipt.manifestSha256,maxBytes};
 const body={...selection,confirmationId:f.nonce.id};
 const call=(payload:unknown=body,key="restore-orders")=>app.inject({method:"POST",url:"/api/v1/projects/project-a/databases/orders/runtime/restore/apply",headers:{"idempotency-key":key},payload:payload as Record<string,unknown>});
 return {...f,app,routeOptions:options,grants,projects,body,call};
}
it.each(engines)("applies original %s confirmation through authenticated route with server-selected archive",async engine=>{
 const f=await routeFixture(engine),response=await f.call();expect(response.statusCode).toBe(200);const data=response.json().data;
 expect(data).toMatchObject({restored:true,command:{status:"completed"},receipt:{engine,confirmationId:f.nonce.id,status:"restored",storage:"original"}});
 expect(data.command).not.toHaveProperty("projectExecutionAuthority");expect(data.command).not.toHaveProperty("actorId");expect(data).not.toHaveProperty("preparation");
 expect(f.transport.dispatch).toHaveBeenCalledOnce();expect(f.audit).toHaveBeenCalledOnce();expect(f.controls.resolve).not.toHaveBeenCalled();expect(f.controls.resolveProjectUpdateConfirmation).not.toHaveBeenCalled();
});
it("requires grant before server inventory, protection or approval lookup",async()=>{const f=await routeFixture();f.grants.mockResolvedValue([]);expect((await f.call()).statusCode).toBe(403);expect(f.projects).not.toHaveBeenCalled();expect(f.inventory.list).not.toHaveBeenCalled();expect(f.controls.findProjectUpdateByIdempotency).not.toHaveBeenCalled();});
it("rejects private caller receipt/path and force flags before server reads",async()=>{for(const patch of [{backupReceipt:{}},{path:"private"},{password:"private"},{force:true},{confirmationId:""}]){const f=await routeFixture();expect((await f.call({...f.body,...patch})).statusCode).toBe(400);expect(f.projects).not.toHaveBeenCalled();expect(f.inventory.list).not.toHaveBeenCalled();}});
it("rejects detached original approval and changed server inventory without effects",async()=>{const f=await routeFixture();expect((await f.call({...f.body,confirmationId:"foreign"})).statusCode).toBe(503);expect(f.transport.dispatch).not.toHaveBeenCalled();expect(f.nonce.consumedAt).toBeNull();const g=await routeFixture();g.inventory.list.mockResolvedValue([]);expect((await g.call()).statusCode).toBe(503);expect(g.controls.claimConfirmedProjectUpdate).not.toHaveBeenCalled();});
it("recovers expired completion using server inventory and original signed cache without fresh archive or profile",async()=>{const f=await routeFixture(),first=await f.call();expect(first.statusCode).toBe(200);f.now.value=3000;f.archive.verify.mockClear();f.protection.assertProtected.mockClear();f.routeOptions.configuration.profiles.clear();const again=await f.call();expect(again.statusCode).toBe(200);expect(again.json().data.receipt).toEqual(first.json().data.receipt);expect(f.archive.verify).not.toHaveBeenCalled();expect(f.protection.assertProtected).not.toHaveBeenCalled();expect(f.transport.dispatch).toHaveBeenCalledOnce();expect(f.audit).toHaveBeenCalledOnce();});
it("redacts archive failures and rejects changed profiles before original approval consumption",async()=>{const f=await routeFixture();f.archive.verify.mockRejectedValue(new Error("password=private-fixture"));const response=await f.call();expect(response.statusCode).toBe(503);expect(response.body).not.toContain("private-fixture");expect(f.nonce.consumedAt).toBeNull();const g=await routeFixture();g.profile.image="registry.example.com/postgres@sha256:"+"f".repeat(64);expect((await g.call()).statusCode).toBe(503);expect(g.transport.dispatch).not.toHaveBeenCalled();});
it("registers authenticated confirmed restore in actual API bootstrap",async()=>{const f=await routeFixture(),app=await buildApiApp({env:{NODE_ENV:"test"}});apps.push(app);expect((await app.inject({method:"POST",url:"/api/v1/projects/project-a/databases/orders/runtime/restore/apply",headers:{"idempotency-key":"restore"},payload:f.body})).statusCode).toBe(401);});
