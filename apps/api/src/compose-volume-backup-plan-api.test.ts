import { afterEach,describe,expect,it,vi } from "vitest";
import { hashSessionToken } from "@deploylite/db";
import { InMemoryCapabilityRegistry,type ComposeResourceObservationV1,type ComposeVolumeBackupPlanningProfile,type ComposeVolumeBackupPlanReceiptV1,type Project } from "@deploylite/contracts";
import { createComposePreview,digestComposeResourceObservation,InMemoryComposeVolumeBackupPlanStore,InMemoryEnvSecretValueRepository,type AuditEventInput,type CanonicalRoleName,type PreparedComposeVolumeBackupPlan,type ComposeVolumeBackupPlanStore as Port,type ProjectRepository } from "@deploylite/domain";
import type { ComposeResourceInspectionAccess } from "./compose-resource-inspection-route.js";
import type { ComposeVolumeBackupPlanAccess as Planning } from "./compose-volume-backup-plan-route.js";
import { buildApiApp,createInMemoryExecutionRepositories,InMemoryAuditRepository,InMemoryAuthUserRepository,InMemorySessionRepository,type BuildApiAppOptions } from "./app.js";
type Access={-readonly[P in keyof ComposeResourceInspectionAccess]:ComposeResourceInspectionAccess[P]};
type Options=BuildApiAppOptions;
const apps:Awaited<ReturnType<typeof buildApiApp>>[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));vi.restoreAllMocks();});
const policy={policyVersion:"backup-api-test",trustedHosts:["registry.example.com"],allowTags:false,allowDigests:true};
const image="registry.example.com/app@sha256:"+"a".repeat(64);
const document=JSON.stringify({services:{app:{image,volumes:[{type:"volume",source:"data",target:"/data"}],environment:{TOKEN:"${APP_TOKEN}"}}},volumes:{data:{}}});
const preview=createComposePreview(document,"project-1",policy);
async function fixture({role="operator",scope="project-1",action="project.deploy",inspection=true,planning=true,capability=true}:{role?:CanonicalRoleName;scope?:string;action?:string;inspection?:boolean;planning?:boolean;capability?:boolean}={}){
  const records=new Map<string,Project>();const projects:ProjectRepository={save:async p=>{records.set(p.id,p);return p;},findById:async id=>records.get(id)??null,list:async()=>[...records.values()],remove:async id=>records.delete(id)};
  await projects.save({id:"project-1",name:"Backup plan",repoUrl:"https://github.com/DeployLiteApp/DeployLite",defaultBranch:"main",buildCommand:null,runCommand:null,port:null,description:null,imageTag:null});
  const observation:ComposeResourceObservationV1={schemaVersion:1,owner:"deploylite",agentId:"agent-1",projectId:"project-1",kind:"volume",key:"data",runtimeName:preview.volumes[0]!.runtimeName,physicalIdentity:"2026-10-08T00:00:00Z",configDigest:preview.configDigest,stateDigest:"0".repeat(64),observedAt:1000,containers:[{containerId:"c".repeat(64),service:"app",running:false,attached:true,mounts:[{target:"/data",readOnly:false}]}]};
  const seal=()=>{observation.stateDigest=digestComposeResourceObservation(observation);};seal();let now=1010;
  const inspect=vi.fn(async(_input:unknown,_signal:AbortSignal)=>structuredClone(observation));
  const access:Access={owner:"deploylite",agentId:"agent-1",inspector:{inspect},clock:{now:()=>now},maxAgeMs:100,capabilities:new InMemoryCapabilityRegistry(capability?["compose.resource.inspect.v1"]:[]),deadlineMs:1000};
  const profile:ComposeVolumeBackupPlanningProfile={owner:"deploylite",agentId:"agent-1",projectId:"project-1",profileId:"profile-1",destinationId:"destination-1",maxBytes:1_000_000,maxEntries:1000,maxDurationMs:30_000,planTtlMs:60_000};const profiles=new Map([[profile.destinationId,profile]]);
  const audit=new InMemoryAuditRepository(),sessions=new InMemorySessionRepository(),secrets=new InMemoryEnvSecretValueRepository(),memory=createInMemoryExecutionRepositories(projects,audit),plannedAudit:AuditEventInput[]=[];
  let auditFails=false;const inner=new InMemoryComposeVolumeBackupPlanStore({ledger:memory.completion,clock:()=>now,appendAudit:entry=>{if(auditFails)throw new Error("private-audit-error");plannedAudit.push(structuredClone(entry));}});
  const port={available:vi.fn(()=>true),save:vi.fn<Port["save"]>((input,_signal)=>inner.save(input))};const plans:Planning={profiles,store:port};
  const user={id:"backup-user",email:"backup@example.test",emailNormalized:"backup@example.test",passwordHash:"unused-fixture-hash",role,status:"active" as const,createdAt:new Date(),updatedAt:new Date()};
  await sessions.create({userId:user.id,tokenHash:hashSessionToken("backup-test-session"),expiresAt:new Date("2027-01-01T00:00:00Z")});
  const grants={listForActor:vi.fn(async(actorId:string)=>[{id:"backup-grant",actorId,action:action as "project.deploy",scope:{kind:"project" as const,projectId:scope}}])};
  const options:Options={env:{NODE_ENV:"test",DEPLOYLITE_SECRET_KEY:"backup_fixture_secret_key_1234567890"},corsOrigin:false,imagePolicy:policy,authConfig:{cookieName:"backup_session",cookieSecure:false},auth:{users:new InMemoryAuthUserRepository([user]),sessions,audit},state:{projects,envSecretValues:secrets,controlGrants:grants,controlDeletes:memory.controls,controlRedeploy:memory.controls,controlRollback:memory.controls,executionCompletion:memory.completion},...(inspection?{composeResourceInspection:new Map([["project-1",access]])}:{}),...(planning?{composeVolumeBackupPlans:new Map([["project-1",plans]])}:{})};
  const app=await buildApiApp(options);apps.push(app);audit.inputs.length=0;audit.events.length=0;grants.listForActor.mockClear();
  const lookup=vi.spyOn(projects,"findById"),saveProject=vi.spyOn(projects,"save"),removeProject=vi.spyOn(projects,"remove"),decrypt=vi.spyOn(secrets,"listEncryptedByProject");
  const body={document,key:"data",expectedConfigDigest:preview.configDigest,expectedStateDigest:observation.stateDigest,destinationId:"destination-1"};
  const post=(payload:unknown=body,{project="project-1",key="backup-key-1",session=true}:{project?:string;key?:string|null;session?:boolean}={})=>app.inject({method:"POST",url:`/api/v1/projects/${project}/compose/volumes/backup/preview`,headers:{...(session?{cookie:"backup_session=backup-test-session"}:{}),...(key===null?{}:{"idempotency-key":key})},payload:payload as Record<string,unknown>});
  return{app,post,body,access,port,inner,profile,profiles,plans,options,observation,seal,inspect,audit,plannedAudit,memory,lookup,saveProject,removeProject,decrypt,setAuditFailure:()=>{auditFails=true;},advance:(value:number)=>{now=value;observation.observedAt=value-10;}};
}
describe("scoped effect-free volume backup planning API",()=>{
  it("returns the closed metadata receipt and records one correlated shared-ledger audit",async()=>{
    const f=await fixture(),r=await f.post();expect(r.statusCode).toBe(200);const receipt=r.json().data.backupPlan;
    expect(receipt).toMatchObject({idempotent:false,plan:{operation:"compose.volume.backup.plan",executionAllowed:false,archiveCreated:false,projectId:"project-1",volumeKey:"data",destinationId:"destination-1",stateDigest:f.observation.stateDigest}});expect(f.memory.completion.commands.size).toBe(1);expect(f.plannedAudit).toEqual([expect.objectContaining({action:"compose.volume.backup.planned",actorUserId:"backup-user",targetId:"project-1",requestId:r.json().requestId,correlationId:r.headers["x-correlation-id"]})]);
    expect(f.saveProject).not.toHaveBeenCalled();expect(f.removeProject).not.toHaveBeenCalled();expect(f.decrypt).not.toHaveBeenCalled();for(const secret of [image,"APP_TOKEN","/data","c".repeat(64)])expect(r.body+JSON.stringify(f.plannedAudit)).not.toContain(secret);
  });
  it("replays the original command on identical and concurrent request keys",async()=>{
    const f=await fixture(),[a,b]=await Promise.all([f.post(),f.post()]);expect(a.statusCode).toBe(200);expect(b.statusCode).toBe(200);expect(b.json().data.backupPlan).toEqual({...a.json().data.backupPlan,idempotent:true});expect(f.plannedAudit).toHaveLength(1);expect(f.memory.completion.commands.size).toBe(1);
  });
  it("conflicts on changed limits under the original idempotency key",async()=>{
    const f=await fixture();expect((await f.post()).statusCode).toBe(200);f.profile.maxBytes++;const r=await f.post();expect(r.statusCode).toBe(409);expect(r.json().error.code).toBe("IDEMPOTENCY_CONFLICT");expect(f.plannedAudit).toHaveLength(1);
  });
  it("requires a session before project lookup or inspection",async()=>{const f=await fixture(),r=await f.post(f.body,{session:false});expect(r.statusCode).toBe(401);expect(f.lookup).not.toHaveBeenCalled();expect(f.inspect).not.toHaveBeenCalled();expect(f.port.save).not.toHaveBeenCalled();});
  for(const role of ["read-only","auditor"] as const)it(`denies ${role} through existing role guards`,async()=>{const f=await fixture({role}),r=await f.post();expect(r.statusCode).toBe(403);expect(f.lookup).not.toHaveBeenCalled();expect(f.inspect).not.toHaveBeenCalled();expect(f.audit.inputs).toEqual([expect.objectContaining({action:"protected.denied"})]);});
  for(const mode of ["scope","action"] as const)it(`denies a mismatched ${mode} grant and audits safely`,async()=>{
    const f=await fixture(mode==="scope"?{scope:"foreign"}:{action:"project.update"}),r=await f.post();expect(r.statusCode).toBe(403);expect(f.lookup).not.toHaveBeenCalled();expect(f.inspect).not.toHaveBeenCalled();expect(f.audit.inputs).toEqual([expect.objectContaining({action:"compose.volume.backup.plan.denied",metadata:expect.objectContaining({reason:expect.any(String)})})]);
  });
  it("checks a missing project only after authorization and never observes it",async()=>{
    const f=await fixture({scope:"missing"}),r=await f.post(f.body,{project:"missing"});expect(r.statusCode).toBe(404);expect(f.lookup).toHaveBeenCalledWith("missing");expect(f.inspect).not.toHaveBeenCalled();
  });
  for(const key of [null,"bad key"] as const)it(`requires a valid explicit retry key ${key}`,async()=>{const f=await fixture(),r=await f.post(f.body,{key});expect(r.statusCode).toBe(400);expect(r.json().error.code).toBe("VALIDATION_ERROR");expect(f.inspect).not.toHaveBeenCalled();});
  it.each([{execute:true},{owner:"claimed"},{projectId:"foreign"},{maxBytes:123},{destinationId:"/tmp/private"},{kind:"network"}])("rejects caller authority, paths and policy overrides %#",async extra=>{
    const f=await fixture(),r=await f.post({...f.body,...extra});expect(r.statusCode).toBe(400);expect(r.json().error.code).toBe("VALIDATION_ERROR");expect(f.inspect).not.toHaveBeenCalled();expect(f.port.save).not.toHaveBeenCalled();
  });
  for(const mode of ["inspection","planning","capability","profile"] as const)it(`has no fallback for missing ${mode}`,async()=>{
    const f=await fixture({inspection:mode!=="inspection",planning:mode!=="planning",capability:mode!=="capability"});if(mode==="profile")f.profiles.clear();const r=await f.post();expect(r.statusCode).toBe(503);expect(r.json().error.code).toBe("COMPOSE_BACKUP_UNAVAILABLE");expect(f.inspect).not.toHaveBeenCalled();expect(f.port.save).not.toHaveBeenCalled();
  });
  it("rejects disabled storage before any observation",async()=>{const f=await fixture();f.port.available.mockReturnValue(false);const r=await f.post();expect(r.statusCode).toBe(503);expect(f.inspect).not.toHaveBeenCalled();expect(f.port.save).not.toHaveBeenCalled();});
  for(const field of ["expectedConfigDigest","expectedStateDigest"] as const)it(`refuses stale ${field} before committing a plan`,async()=>{
    const f=await fixture(),r=await f.post({...f.body,[field]:"f".repeat(64)});expect(r.statusCode).toBe(409);expect(r.json().error.code).toBe("COMPOSE_BACKUP_STALE");expect(f.port.save).not.toHaveBeenCalled();
  });
  it("rejects foreign and running attached volume observations without effects",async()=>{
    const f=await fixture();f.observation.owner="foreign";f.seal();const foreign=await f.post({...f.body,expectedStateDigest:f.observation.stateDigest});expect(foreign.statusCode).toBe(409);expect(foreign.json().error.code).toBe("COMPOSE_BACKUP_FOREIGN");
    f.observation.owner="deploylite";f.observation.containers[0]!.running=true;f.seal();const busy=await f.post({...f.body,expectedStateDigest:f.observation.stateDigest});expect(busy.statusCode).toBe(409);expect(busy.json().error.code).toBe("COMPOSE_BACKUP_IN_USE");expect(f.port.save).not.toHaveBeenCalled();
  });
  it("masks internal store failures and keeps command/audit unpublished on audit failure",async()=>{
    const f=await fixture();f.setAuditFailure();const r=await f.post();expect(r.statusCode).toBe(503);expect(r.json().error.code).toBe("COMPOSE_BACKUP_FAILED");expect(r.body).not.toContain("private-audit-error");expect(f.memory.completion.commands.size).toBe(0);expect(f.plannedAudit).toHaveLength(0);
    f.port.save.mockRejectedValueOnce(Object.assign(new Error("must-not-reflect"),{statusCode:400}));const raw=await f.post();expect(raw.statusCode).toBe(503);expect(raw.body).not.toContain("must-not-reflect");
  });
  it.each([{executionAllowed:true},{archiveCreated:true},{projectId:"foreign"},{volumeKey:"other"},{destinationId:"foreign"},{stateDigest:"e".repeat(64)},{planDigest:"f".repeat(64)}])("refuses corrupt or mismatched store projections %#",async extra=>{
    const f=await fixture();f.port.save.mockImplementationOnce(async input=>({commandId:input.command.id,expiresAt:input.command.expiresAt.toISOString(),idempotent:false,plan:{...input.plan,...extra}} as ComposeVolumeBackupPlanReceiptV1));const r=await f.post();expect(r.statusCode).toBe(503);expect(r.json().error.code).toBe("COMPOSE_BACKUP_INVALID");expect(r.json().data).toBeNull();
  });
  for(const mode of ["inspection","planning"] as const)it(`refuses changed project ${mode} selection before save`,async()=>{
    const f=await fixture();f.access.inspector.inspect=async()=>{if(mode==="inspection")(f.options.composeResourceInspection as Map<string,Access>).set("project-1",{...f.access,agentId:"agent-2"});else(f.options.composeVolumeBackupPlans as Map<string,Planning>).set("project-1",{...f.plans});return structuredClone(f.observation);};const r=await f.post();expect(r.statusCode).toBe(409);expect(r.json().error.code).toBe("COMPOSE_BACKUP_STALE");expect(f.port.save).not.toHaveBeenCalled();
  });
  it("rejects revocation before a successful plan is exposed",async()=>{
    const f=await fixture();let active=true;f.access.capabilities={has:()=>active};f.access.inspector.inspect=async()=>{active=false;return structuredClone(f.observation);};const r=await f.post();expect(r.statusCode).toBe(503);expect(f.port.save).not.toHaveBeenCalled();
  });
  for(const stage of ["inspection","storage"] as const)it(`bounds noncooperating ${stage} and forwards cancellation`,async()=>{
    const f=await fixture();f.access.deadlineMs=10;let signal:AbortSignal|undefined;if(stage==="inspection")f.access.inspector.inspect=async(_input,s)=>{signal=s;return new Promise(()=>undefined);};else f.port.save.mockImplementationOnce(async(_input,s)=>{signal=s;return new Promise(()=>undefined);});
    const r=await f.post();expect(r.statusCode).toBe(503);expect(r.json().error.code).toBe("COMPOSE_BACKUP_FAILED");expect(signal?.aborted).toBe(true);expect(f.memory.completion.commands.size).toBe(0);
  });
  it("cancels a disconnected request and discards a late metadata read",async()=>{
    const f=await fixture();let raw:{emit:(name:string)=>unknown}|undefined;f.app.addHook("preHandler",async request=>{raw=request.raw;});let signal:AbortSignal|undefined;f.access.inspector.inspect=async(_input,s)=>{signal=s;raw!.emit("aborted");return structuredClone(f.observation);};const r=await f.post();expect(r.statusCode).toBe(503);expect(signal?.aborted).toBe(true);expect(f.port.save).not.toHaveBeenCalled();
  });
  it("reconciles an ambiguous postcommit reply with the original key and no duplicate audit",async()=>{
    const f=await fixture();f.port.save.mockImplementationOnce(async input=>{await f.inner.save(input);throw new Error("reply-lost-private");});const first=await f.post();expect(first.statusCode).toBe(503);expect(f.memory.completion.commands.size).toBe(1);const again=await f.post();expect(again.statusCode).toBe(200);expect(again.json().data.backupPlan.idempotent).toBe(true);expect(f.plannedAudit).toHaveLength(1);
  });
  it("refuses an expired original plan without changing its receipt",async()=>{
    const f=await fixture();expect((await f.post()).statusCode).toBe(200);const command=structuredClone([...f.memory.completion.commands.values()][0]);f.advance(100_000);const r=await f.post();expect(r.statusCode).toBe(409);expect(r.json().error.code).toBe("COMPOSE_BACKUP_EXPIRED");expect([...f.memory.completion.commands.values()][0]).toEqual(command);expect(f.plannedAudit).toHaveLength(1);
  });
  it("does not return success if required rejection audit is unavailable",async()=>{
    const f=await fixture();vi.spyOn(f.audit,"append").mockRejectedValueOnce(new Error("audit-must-not-reflect"));const r=await f.post({...f.body,execute:true});expect(r.statusCode).toBe(500);expect(r.json().data).toBeNull();expect(r.body).not.toContain("audit-must-not-reflect");expect(f.inspect).not.toHaveBeenCalled();
  });
  it("rejects a request already disconnected before installing the abort listener",async()=>{
    const f=await fixture();f.app.addHook("preHandler",async request=>{Object.defineProperty(request.raw,"aborted",{value:true,configurable:true});request.raw.emit("aborted");});
    const r=await f.post();expect(r.statusCode).toBe(503);expect(r.json().error.code).toBe("COMPOSE_BACKUP_FAILED");expect(f.inspect).not.toHaveBeenCalled();expect(f.port.save).not.toHaveBeenCalled();expect(f.memory.completion.commands.size).toBe(0);
  });
});
