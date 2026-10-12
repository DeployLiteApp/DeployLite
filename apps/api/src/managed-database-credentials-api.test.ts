import Fastify, {type FastifyReply} from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { createEnvSecretCipher } from "@deploylite/config";
import type { ApprovedManagedDatabaseProfileV1, ManagedDatabaseEngineV1 } from "@deploylite/contracts";
import type { EncryptedEnvSecretValueRecord, EnvSecretValueInput } from "@deploylite/domain";
import { registerManagedDatabaseCredentialRoute } from "./managed-database-credentials-route.js";
const apps:ReturnType<typeof Fastify>[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()))});
async function fixture(settings:{allowed?:boolean;anonymous?:boolean;auditFails?:boolean;role?:string;deadlineMs?:number}={}) {
  const app=Fastify();apps.push(app);const rows=new Map<string,EncryptedEnvSecretValueRecord>();
  const profiles=new Map<ManagedDatabaseEngineV1,ApprovedManagedDatabaseProfileV1>();
  for (const engine of ["postgres","mysql","mariadb","mongodb","redis"] as const) profiles.set(engine,{schemaVersion:1,profileId:"profile-"+engine,engine,
    image:`registry.example.com/${engine}@sha256:${"a".repeat(64)}`,dataPath:"/database/data",containerPort:({postgres:5432,mysql:3306,mariadb:3306,mongodb:27017,redis:6379})[engine],
    credentialKeys:["DATABASE_PASSWORD"],backupStrategy:engine==="redis"?"volume-quiesced":"engine-native"});
  const secrets={find:vi.fn(async(projectId:string,key:string)=>rows.get(projectId+key)),
    createIfAbsent:vi.fn(async(record:EnvSecretValueInput)=>{const id=record.projectId+record.key; if(!rows.has(id))rows.set(id,{...record,id:"secret-a",valuePresent:true,createdAt:new Date(0).toISOString(),updatedAt:new Date(0).toISOString()});return rows.get(id)!})};
  const audit=vi.fn(async()=>{if(settings.auditFails)throw new Error("private-fixture-audit");return {} as never});
  const findProject=vi.fn(async(id:string)=>({id,name:"fixture",repoUrl:"https://example.test/repo",defaultBranch:"main",buildCommand:null,runCommand:null,port:null,description:null,imageTag:null}));
  const listGrants=vi.fn(async()=>settings.allowed===false?[]:[{id:"grant",actorId:"actor",action:"project.update" as const,scope:{kind:"project" as const,projectId:"project-1"}}]);
  const configuration={profiles,deadlineMs:settings.deadlineMs??1000};
  registerManagedDatabaseCredentialRoute(app,{prefix:"/api/v1",configuration,secrets,cipher:createEnvSecretCipher(Buffer.alloc(32,11)),
    imagePolicy:{policyVersion:"images-1",trustedHosts:["registry.example.com"],allowTags:false,allowDigests:true},projects:{findById:findProject},grants:{listForActor:listGrants},audit:{append:audit},
    requireAuth:async(r:unknown,reply:FastifyReply)=>{if(settings.anonymous)return reply.code(401).send({error:{code:"UNAUTHENTICATED"}});Object.assign(r as object,{auth:{user:{id:"actor",role:settings.role??"operator"}},correlationContext:{requestId:"request",correlationId:"correlation"}})},
    requireRole:async(_r:unknown,reply:FastifyReply)=>{if(settings.role==="viewer")return reply.code(403).send({error:{code:"FORBIDDEN"}})},
    ok:(_r:unknown,data:unknown)=>({data,error:null}),error:(_r:unknown,code:string)=>({data:null,error:{code}})});
  return {app,rows,secrets,audit,findProject,listGrants,profiles,configuration,post:(payload:Record<string,unknown>={schemaVersion:1,engine:"postgres"},project="project-1")=>app.inject({method:"POST",url:`/api/v1/projects/${project}/databases/orders/credentials`,payload})};
}
it.each(["postgres","mysql","mariadb","mongodb","redis"])("configures generated %s credentials with scoped policy and correlated audit",async engine=>{
 const f=await fixture();const response=await f.post({schemaVersion:1,engine});expect(response.statusCode).toBe(200);
 expect(response.json().data.credentials).toMatchObject({projectId:"project-1",databaseId:"orders",engine,credentialsConfigured:true,redacted:true});
 expect(f.audit).toHaveBeenCalledWith(expect.objectContaining({action:"database.credentials.write_authorized",targetId:"project-1",correlationId:"correlation"}));expect(f.rows.size).toBe(1);
});
it("replays without replacing the original secret",async()=>{const f=await fixture();const first=await f.post();expect(first.statusCode).toBe(200);f.secrets.createIfAbsent.mockClear();const second=await f.post();expect(second.json()).toEqual(first.json());expect(f.secrets.createIfAbsent).not.toHaveBeenCalled()});
it("denies anonymous, viewer and foreign project access before secret reads",async()=>{
 for(const settings of [{anonymous:true},{role:"viewer"},{allowed:false}]){const f=await fixture(settings);expect((await f.post()).statusCode).toBe(settings.anonymous?401:403);expect(f.secrets.find).not.toHaveBeenCalled();expect(f.secrets.createIfAbsent).not.toHaveBeenCalled()}
 const f=await fixture();expect((await f.post(undefined,"project-other")).statusCode).toBe(403);expect(f.findProject).not.toHaveBeenCalled();
});
it.each([{password:"private-fixture"},{image:"registry.example.com/db:latest"},{publishedPort:5432}])("rejects caller-controlled configuration %j",async extra=>{const f=await fixture();expect((await f.post({schemaVersion:1,engine:"postgres",...extra})).statusCode).toBe(400);expect(f.secrets.find).not.toHaveBeenCalled()});
it("withholds the secret write on failed authorization audit without reflecting private errors",async()=>{const f=await fixture({auditFails:true});const r=await f.post();expect(r.statusCode).toBe(503);expect(r.body).not.toContain("private-fixture");expect(f.rows.size).toBe(0)});
it("fences a changed server profile during authorization audit",async()=>{const f=await fixture();f.audit.mockImplementation(async()=>{f.profiles.delete("postgres");return {} as never});expect((await f.post()).statusCode).toBe(503);expect(f.rows.size).toBe(0)});
it("bounds a hung authority lookup",async()=>{const f=await fixture({deadlineMs:10});f.listGrants.mockImplementation(()=>new Promise(()=>{}));expect((await f.post()).statusCode).toBe(503);expect(f.secrets.find).not.toHaveBeenCalled()});

it("recovers a lost completion audit through stored credentials without replacing them",async()=>{
 const f=await fixture();let fail=true;
 f.audit.mockImplementation(async(event?:unknown)=>{if(fail && (event as {action?:string})?.action==="database.credentials.configured")throw new Error("private-fixture-completion");return {} as never});
 expect((await f.post()).statusCode).toBe(503);expect(f.rows.size).toBe(1);
 const original=[...f.rows.values()][0]!.encryptedValue;f.secrets.createIfAbsent.mockClear();fail=false;
 expect((await f.post()).statusCode).toBe(200);expect(f.secrets.createIfAbsent).not.toHaveBeenCalled();expect([...f.rows.values()][0]!.encryptedValue).toEqual(original);
});
