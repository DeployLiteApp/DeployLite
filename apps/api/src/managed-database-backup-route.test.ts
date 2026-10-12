import {afterEach,beforeEach,expect,it,vi} from "vitest";
import Fastify from "fastify";
import {planManagedDatabaseProfile,composeRuntimeResourceName} from "@deploylite/domain";
import {registerManagedDatabaseBackupRoute,type ManagedDatabaseBackupRouteOptions} from "./managed-database-backup-route.js";
import type {ManagedDatabaseBackupAccess,ManagedDatabaseBackupInput} from "./managed-database-backup.js";
const core=vi.hoisted(()=>({run:vi.fn(),hook:()=>{},replay:false}));
vi.mock("./managed-database-backup.js",()=>({backupManagedDatabaseRuntime:core.run}));
const apps:ReturnType<typeof Fastify>[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
beforeEach(()=>{core.hook=()=>{};core.replay=false;core.run.mockReset();core.run.mockImplementation(async(_options:ManagedDatabaseBackupAccess,input:ManagedDatabaseBackupInput)=>{
  if(!await input.authorize())throw new Error("private authority");
  if(!core.replay)await input.admit();core.hook();if(!input.current())throw new Error("private stale profile");
  return {command:{id:"backup-command",status:"completed",action:"project.update",scope:{kind:"project",projectId:"project-a"},inputDigest:"a".repeat(64),idempotencyKey:input.idempotencyKey,correlationId:"correlation",expiresAt:new Date(2000),projectExecutionAuthority:{private:"lease-secret"}},receipt:{redacted:true},backupCreated:true,idempotent:core.replay};
});});
async function fixture() {
 const app=Fastify();apps.push(app);
 const profile={schemaVersion:1 as const,profileId:"postgres-profile",engine:"postgres" as const,image:"registry.example.com/postgres@sha256:"+"a".repeat(64),dataPath:"/var/lib/postgresql",containerPort:5432,credentialKeys:["DATABASE_PASSWORD"],backupStrategy:"engine-native" as const};
 const policy={policyVersion:"images-1",trustedHosts:["registry.example.com"],allowTags:false,allowDigests:true};
 const base={schemaVersion:1 as const,projectId:"project-a",databaseId:"orders",engine:"postgres" as const};
 const plan=planManagedDatabaseProfile(base,profile,policy);
 const receipt={...base,planDigest:plan.planDigest,environmentFingerprint:"b".repeat(32),action:"database.runtime",agentId:"agent-a",commandId:"original-command",inputDigest:"a".repeat(64),correlationId:"original-correlation",containerId:"c".repeat(64),imageId:"sha256:"+"d".repeat(64),volumeName:composeRuntimeResourceName(base.projectId,"volume","db-orders"),networkName:composeRuntimeResourceName(base.projectId,"network","db-orders"),networkId:"e".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",observedAt:1000,status:"ready",health:"passed",storage:"verified",idempotent:false,redacted:true};
 const body={schemaVersion:1,engine:"postgres",profileId:profile.profileId,planDigest:plan.planDigest,environmentFingerprint:receipt.environmentFingerprint,originalReceipt:receipt,originalReplayFingerprint:"e".repeat(64),destinationId:"private-a",maxBytes:64};
 const destination={owner:"deploylite",agentId:"agent-a",projectId:"project-a",profileId:"private-profile",destinationId:"private-a",maxBytes:128,maxEntries:100,maxDurationMs:1000,planTtlMs:2000};
 const projects=vi.fn(async()=>({id:"project-a"}));
 const grants=vi.fn(async()=>[{actorId:"operator",action:"project.update",scope:{kind:"project",projectId:"project-a"}}]);
 const execution={agentId:"agent-a",deadlineMs:1000} as ManagedDatabaseBackupAccess;
 const options={prefix:"/api/v1",configuration:{profiles:new Map([["postgres",profile]]),projectIds:new Set(["project-a"]),deadlineMs:1000},imagePolicy:policy,projects:{findById:projects},grants:{listForActor:grants},executions:new Map([["project-a",execution]]),planning:new Map([["project-a",{profiles:new Map([["private-a",destination]]),store:{available:()=>true}}]]),requireAuth:async()=>{},requireRole:async()=>{},ok:(_request:unknown,data:unknown)=>({data}),error:(_request:unknown,code:string,message:string)=>({error:{code,message}})} as unknown as ManagedDatabaseBackupRouteOptions;
 app.addHook("onRequest",async request=>{Reflect.set(request,"auth",{user:{id:"operator",role:"operator"}});Reflect.set(request,"correlationContext",{requestId:"request",correlationId:"correlation"});});
 registerManagedDatabaseBackupRoute(app,options);
 return {body,options,destination,projects,grants,call:(payload:unknown=body,headers:Record<string,string>={})=>app.inject({method:"POST",url:"/api/v1/projects/project-a/databases/orders/runtime/backup",headers:{...headers,"idempotency-key":"backup-key"},payload:payload as object})};
}
it.each(["foreign", "operator, foreign"])("refuses a stale or ambiguous client actor %s before creating another actor-scoped backup",async actor=>{
 const f=await fixture();expect((await f.call(undefined,{"x-deploylite-expected-actor-id":actor})).statusCode).toBe(409);
 expect(f.projects).not.toHaveBeenCalled();expect(f.grants).not.toHaveBeenCalled();expect(core.run).not.toHaveBeenCalled();
});
it("admits an explicit matching current actor without changing the original command key",async()=>{
 const f=await fixture();expect((await f.call(undefined,{"x-deploylite-expected-actor-id":"operator"})).statusCode).toBe(200);
 expect(core.run).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({actorId:"operator",idempotencyKey:"backup-key"}));
});
it("admits a scoped private backup and strips project lease from HTTP success",async()=>{
 const f=await fixture(),r=await f.call();expect(r.statusCode).toBe(200);expect(r.json().data.backupCreated).toBe(true);expect(r.body).not.toContain("lease-secret");expect(core.run).toHaveBeenCalledOnce();
});
it("blocks a foreign project grant before reading project or control",async()=>{
 const f=await fixture();f.grants.mockResolvedValue([]);expect((await f.call()).statusCode).toBe(403);expect(f.projects).not.toHaveBeenCalled();expect(core.run).not.toHaveBeenCalled();
});
it("rejects destination scope, budget, deadline and stale image before capture admission",async()=>{
 for(const mode of ["agent","project","key","bytes","duration","plan","absent"]){const f=await fixture();
  if(mode==="agent")f.destination.agentId="foreign";if(mode==="project")f.destination.projectId="foreign";if(mode==="key")f.destination.destinationId="foreign";if(mode==="bytes")f.body.maxBytes=129;if(mode==="duration")f.destination.maxDurationMs=999;if(mode==="plan")f.body.profileId="stale-profile";if(mode==="absent")Reflect.set(f.options,"planning",undefined);
  expect((await f.call()).statusCode).toBe(503);
 }
});
it("withholds success when the captured destination changes and redacts private errors",async()=>{
 const f=await fixture();core.hook=()=>{f.destination.maxBytes=1;};const r=await f.call();expect(r.statusCode).toBe(503);expect(r.body).not.toMatch(/private stale profile|lease-secret/);
});
it("permits original completed cache repair after fresh execution configuration is withdrawn",async()=>{
 const f=await fixture();core.replay=true;Reflect.set(f.options.executions!.get("project-a")!,"maxBytes",0);Reflect.set(f.options,"configuration",undefined);Reflect.set(f.options,"planning",undefined);expect((await f.call()).statusCode).toBe(200);expect(core.run).toHaveBeenCalledOnce();
});
it("rejects private-path fields and malformed preparation before control",async()=>{
 const f=await fixture();expect((await f.call({...f.body,path:"/private/archive"})).statusCode).toBe(400);expect(core.run).not.toHaveBeenCalled();
});
it("rejects a destination owned by another runtime before admission",async()=>{
 const f=await fixture();f.destination.owner="foreign-owner";expect((await f.call()).statusCode).toBe(503);
});
it("registers authenticated native backup in the actual API bootstrap",async()=>{
 const {buildApiApp}=await import("./app.js");const app=await buildApiApp({env:{NODE_ENV:"test"}});apps.push(app);
 const f=await fixture();expect((await app.inject({method:"POST",url:"/api/v1/projects/project-a/databases/orders/runtime/backup",headers:{"idempotency-key":"backup-key"},payload:f.body})).statusCode).toBe(401);
});
it("rejects a requested archive above the configured native byte cap before capture admission",async()=>{
 const f=await fixture();Reflect.set(f.options.executions!.get("project-a")!,"maxBytes",63);expect((await f.call()).statusCode).toBe(503);
});
