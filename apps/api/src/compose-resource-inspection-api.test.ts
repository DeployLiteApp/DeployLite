import { afterEach,describe,expect,it,vi } from "vitest";
import { hashSessionToken } from "@deploylite/db";
import { InMemoryCapabilityRegistry, type ComposeResourceObservationV1, type Project } from "@deploylite/contracts";
import { createComposePreview,digestComposeResourceObservation,InMemoryEnvSecretValueRepository,type ProjectRepository,type CanonicalRoleName } from "@deploylite/domain";
import type { ComposeResourceInspectionAccess } from "./compose-resource-inspection-route.js";
import { buildApiApp,InMemoryAuditRepository,InMemoryAuthUserRepository,InMemorySessionRepository,type BuildApiAppOptions } from "./app.js";

const apps:Awaited<ReturnType<typeof buildApiApp>>[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(a=>a.close()));vi.restoreAllMocks();});
const policy={policyVersion:"inspection-test-1",trustedHosts:["registry.example.com"],allowTags:false,allowDigests:true};
const image=`registry.example.com/app@sha256:${"a".repeat(64)}`;
const document=JSON.stringify({services:{app:{image,networks:["app"],environment:{TOKEN:"${APP_TOKEN}"}}},networks:{app:{}}});
const preview=createComposePreview(document,"project-1",policy);
type Access={-readonly [P in keyof ComposeResourceInspectionAccess]:ComposeResourceInspectionAccess[P]};
async function fixture({role="operator",scope="project-1",action="project.deploy",configured=true,capability=true}:{role?:CanonicalRoleName;scope?:string;action?:string;configured?:boolean;capability?:boolean}={}){
  const records=new Map<string,Project>();const projects:ProjectRepository={save:async p=>{records.set(p.id,p);return p;},findById:async id=>records.get(id)??null,list:async()=>[...records.values()],remove:async id=>records.delete(id)};
  await projects.save({id:"project-1",name:"Inspect",repoUrl:"https://github.com/DeployLiteApp/DeployLite",defaultBranch:"main",buildCommand:null,runCommand:null,port:null,description:null,imageTag:null});
  const observation:ComposeResourceObservationV1={schemaVersion:1,owner:"deploylite",agentId:"agent-1",projectId:"project-1",kind:"network",key:"app",runtimeName:preview.networks[0]!.runtimeName,physicalIdentity:"b".repeat(64),configDigest:preview.configDigest,stateDigest:"0".repeat(64),observedAt:1_000,containers:[{containerId:"c".repeat(64),service:"app",running:false,attached:false,mounts:[]}]};
  const seal=()=>{observation.stateDigest=digestComposeResourceObservation(observation);};seal();
  const inspect=vi.fn(async (_input:unknown,_signal:AbortSignal,_context?:{requestId:string;correlationId:string})=>structuredClone(observation));
  const access:Access={owner:"deploylite",agentId:"agent-1",inspector:{inspect},clock:{now:()=>1_010},maxAgeMs:100,capabilities:new InMemoryCapabilityRegistry(capability?["compose.resource.inspect.v1"]:[]),deadlineMs:1_000};
  const audit=new InMemoryAuditRepository(),sessions=new InMemorySessionRepository(),secrets=new InMemoryEnvSecretValueRepository();
  const user={id:"inspect-user",email:"inspect@example.test",emailNormalized:"inspect@example.test",passwordHash:"unused-fixture-hash",role,status:"active" as const,createdAt:new Date(),updatedAt:new Date()};
  await sessions.create({userId:user.id,tokenHash:hashSessionToken("inspection-test-session"),expiresAt:new Date("2027-01-01T00:00:00Z")});
  const grants={listForActor:vi.fn(async(actorId:string)=>[{id:"inspect-grant",actorId,action:action as "project.deploy",scope:{kind:"project" as const,projectId:scope}}])};
  const options:BuildApiAppOptions={env:{NODE_ENV:"test",DEPLOYLITE_SECRET_KEY:"inspection_fixture_secret_key_1234567890"},corsOrigin:false,imagePolicy:policy,authConfig:{cookieName:"inspect_session",cookieSecure:false},auth:{users:new InMemoryAuthUserRepository([user]),sessions,audit},state:{projects,envSecretValues:secrets,controlGrants:grants},...(configured?{composeResourceInspection:new Map([["project-1",access]])}:{})};
  const app=await buildApiApp(options);apps.push(app);audit.inputs.length=0;audit.events.length=0;grants.listForActor.mockClear();
  const save=vi.spyOn(projects,"save"),remove=vi.spyOn(projects,"remove"),decrypt=vi.spyOn(secrets,"listEncryptedByProject");
  const body={document,kind:"network",key:"app",expectedConfigDigest:preview.configDigest};
  const post=(payload:unknown=body,endpoint="resources/inspect",project="project-1",session=true)=>app.inject({method:"POST",url:`/api/v1/projects/${project}/compose/${endpoint}`,headers:session?{cookie:"inspect_session=inspection-test-session"}:{},payload:payload as Record<string,unknown>});
  return {app,options,post,body,access,inspect,observation,seal,audit,save,remove,decrypt,grants};
}
describe("project-owned read-only Compose resource API",()=>{
  it("returns a scoped safe inspection view, correlated audit and no resource/secret writes",async()=>{
    const f=await fixture(),r=await f.post(),payload=r.json();expect(r.statusCode).toBe(200);
    expect(payload.data.inspection).toEqual({schemaVersion:1,status:"observed",executionAllowed:false,projectId:"project-1",kind:"network",key:"app",configDigest:preview.configDigest,stateDigest:f.observation.stateDigest,observedAt:1_000,containers:[{service:"app",running:false,attached:false}]});
    expect(f.inspect).toHaveBeenCalledOnce();expect(f.inspect.mock.calls[0]?.[2]).toEqual({requestId:payload.requestId,correlationId:r.headers["x-correlation-id"]});expect(f.save).not.toHaveBeenCalled();expect(f.remove).not.toHaveBeenCalled();expect(f.decrypt).not.toHaveBeenCalled();
    expect(f.audit.inputs).toEqual([expect.objectContaining({action:"compose.resource.inspect",targetType:"project",targetId:"project-1",requestId:payload.requestId,correlationId:r.headers["x-correlation-id"],metadata:expect.objectContaining({inputDigest:preview.configDigest,valueFingerprint:f.observation.stateDigest,key:"app",targetType:"network"})})]);
    expect(r.body+JSON.stringify(f.audit.inputs)).not.toContain("APP_TOKEN");expect(r.body+JSON.stringify(f.audit.inputs)).not.toContain(image);expect(r.body).not.toContain("c".repeat(64));
  });
  it("requires a session before reading any inspection source",async()=>{
    const f=await fixture(),r=await f.post(f.body,"resources/inspect","project-1",false);expect(r.statusCode).toBe(401);expect(r.json().error.code).toBe("UNAUTHENTICATED");expect(f.inspect).not.toHaveBeenCalled();
  });
  for(const role of ["read-only","auditor"] as const)it(`denies ${role} before port access even with a project grant`,async()=>{
    const f=await fixture({role}),r=await f.post();expect(r.statusCode).toBe(403);expect(f.inspect).not.toHaveBeenCalled();expect(f.audit.inputs).toEqual([expect.objectContaining({action:"protected.denied"})]);
  });
  for(const mode of ["wrong-project","wrong-action"] as const)it(`denies ${mode} using the existing policy path`,async()=>{
    const f=await fixture(mode==="wrong-project"?{scope:"foreign"}:{action:"project.update"}),r=await f.post();expect(r.statusCode).toBe(403);expect(f.inspect).not.toHaveBeenCalled();expect(f.audit.inputs).toEqual([expect.objectContaining({action:"compose.resource.inspect.denied"})]);
  });
  it("looks up a missing project only after authorization and never calls the port",async()=>{
    const f=await fixture({scope:"missing"}),r=await f.post(f.body,"resources/inspect","missing");expect(r.statusCode).toBe(404);expect(f.grants.listForActor).toHaveBeenCalledOnce();expect(r.json().error.code).toBe("NOT_FOUND");expect(f.inspect).not.toHaveBeenCalled();
  });
  for(const mode of ["missing","disabled"] as const)it(`rejects ${mode} inspection capability without a runtime fallback`,async()=>{
    const f=await fixture(mode==="missing"?{configured:false}:{capability:false}),r=await f.post();expect(r.statusCode).toBe(503);expect(r.json().error.code).toBe("COMPOSE_INSPECTION_UNSUPPORTED");expect(f.inspect).not.toHaveBeenCalled();
  });
  for(const extra of [{execute:true},{owner:"claimed-owner"},{projectId:"foreign"},{inspection:{password:"must-not-reflect"}}])it("rejects caller authority/ownership additions before observation",async()=>{
    const f=await fixture(),r=await f.post({...f.body,...extra});expect(r.statusCode).toBe(400);expect(r.json().error.code).toBe("VALIDATION_ERROR");expect(f.inspect).not.toHaveBeenCalled();expect(r.body+JSON.stringify(f.audit.inputs)).not.toContain("must-not-reflect");
  });
  it("does not inspect stale or unsafe Compose input and never reflects it",async()=>{
    const f=await fixture(),r=await f.post({...f.body,expectedConfigDigest:"f".repeat(64)});expect(r.statusCode).toBe(409);expect(r.json().error.code).toBe("COMPOSE_RESOURCE_STALE");expect(f.inspect).not.toHaveBeenCalled();
    const unsafe=await f.post({...f.body,document:"password=must-not-reflect"});expect(unsafe.statusCode).toBe(400);expect(unsafe.body+JSON.stringify(f.audit.inputs)).not.toContain("must-not-reflect");expect(f.inspect).not.toHaveBeenCalled();
  });
  it("refuses foreign and corrupt port records with fixed safe failures",async()=>{
    const f=await fixture();f.observation.projectId="foreign";f.seal();const r=await f.post();expect(r.statusCode).toBe(409);expect(r.json().error.code).toBe("COMPOSE_RESOURCE_FOREIGN");
    f.observation.projectId="project-1";f.seal();Object.assign(f.observation,{password:"must-not-reflect"});const corrupt=await f.post();expect(corrupt.statusCode).toBe(503);expect(corrupt.json().error.code).toBe("COMPOSE_INSPECTION_INVALID");expect(corrupt.body+JSON.stringify(f.audit.inputs)).not.toContain("must-not-reflect");
  });
  it("masks internal errors and bounds a noncooperating port with explicit injected deadline",async()=>{
    const f=await fixture();f.access.inspector.inspect=async()=>{throw Object.assign(new Error("password=must-not-reflect"),{statusCode:400});};const r=await f.post();expect(r.statusCode).toBe(503);expect(r.json().error.code).toBe("COMPOSE_INSPECTION_FAILED");expect(r.body).not.toContain("must-not-reflect");
    Object.assign(f.access,{deadlineMs:10});f.access.inspector.inspect=()=>new Promise(()=>undefined);const timeout=await f.post();expect(timeout.statusCode).toBe(503);expect(timeout.json().error.code).toBe("COMPOSE_INSPECTION_LIMIT");
  });
  it("propagates deadline cancellation to the injected read port",async()=>{
    const f=await fixture();Object.assign(f.access,{deadlineMs:10});let received:AbortSignal|undefined;
    f.access.inspector.inspect=(_input,signal)=>{received=signal;return new Promise(()=>undefined);};
    const r=await f.post();expect(r.statusCode).toBe(503);expect(r.json().error.code).toBe("COMPOSE_INSPECTION_LIMIT");expect(received?.aborted).toBe(true);
    expect(f.audit.inputs.some(a=>a.action==="compose.resource.inspect")).toBe(false);
  });
  it("checks capability revocation after observation before publishing success",async()=>{
    const f=await fixture();let active=true;f.access.capabilities={has:()=>active};f.access.inspector.inspect=async()=>{active=false;return structuredClone(f.observation);};
    const r=await f.post();expect(r.statusCode).toBe(503);expect(r.json().error.code).toBe("COMPOSE_INSPECTION_UNSUPPORTED");expect(f.audit.inputs.some(a=>a.action==="compose.resource.inspect")).toBe(false);
  });
  it("refuses a replaced project runtime selection before returning observation",async()=>{
    const f=await fixture();const selected=f.options.composeResourceInspection as Map<string,Access>;
    f.access.inspector.inspect=async()=>{selected.set("project-1",{...f.access,agentId:"agent-2"});return structuredClone(f.observation);};
    const r=await f.post();expect(r.statusCode).toBe(409);expect(r.json().error.code).toBe("COMPOSE_RESOURCE_STALE");expect(r.json().data).toBeNull();
  });
  it("does not expose a successful observation when its required audit write fails",async()=>{
    const f=await fixture();vi.spyOn(f.audit,"append").mockRejectedValueOnce(new Error("audit-private"));const r=await f.post();expect(r.statusCode).toBe(500);expect(r.json().data).toBeNull();expect(r.body).not.toContain("audit-private");
  });
  it("offers attachment preview through the same scoped capability without executing it",async()=>{
    const f=await fixture(),r=await f.post({...f.body,service:"app",action:"attach",expectedStateDigest:f.observation.stateDigest},"attachments/preview");expect(r.statusCode).toBe(200);
    expect(r.json().data.preview).toMatchObject({projectId:"project-1",kind:"network",key:"app",service:"app",action:"attach",status:"preview",executionAllowed:false,stateDigest:f.observation.stateDigest,alreadySatisfied:false});
    expect(f.audit.inputs).toEqual([expect.objectContaining({action:"compose.attachment.preview"})]);expect(f.save).not.toHaveBeenCalled();expect(f.remove).not.toHaveBeenCalled();expect(f.decrypt).not.toHaveBeenCalled();
  });
  it("refuses running or stale attachment intent and never grants apply authority",async()=>{
    const f=await fixture();f.observation.containers[0]!.running=true;f.seal();const r=await f.post({...f.body,service:"app",action:"attach"},"attachments/preview");expect(r.statusCode).toBe(409);expect(r.json().error.code).toBe("COMPOSE_RESOURCE_IN_USE");
    f.observation.containers[0]!.running=false;f.seal();const stale=await f.post({...f.body,service:"app",action:"attach",expectedStateDigest:"d".repeat(64)},"attachments/preview");expect(stale.statusCode).toBe(409);expect(stale.json().error.code).toBe("COMPOSE_RESOURCE_STALE");expect(stale.json().data).toBeNull();
  });
});
