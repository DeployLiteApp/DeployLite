import {expect, it, vi} from "vitest";
import {prepareManagedDatabaseDeletion, applyManagedDatabaseDeletion} from "./managed-database-deletion";
function fixture(engine: "postgres" | "mysql" | "mariadb" | "mongodb" | "redis" = "postgres") {
  const base = {schemaVersion:1 as const,projectId:"project-a",databaseId:"orders",engine,profileId:"profile-a",planDigest:"a".repeat(64),environmentFingerprint:"b".repeat(32)};
  const {profileId:_profile,...physicalBase}=base;
  const originalReceipt={...physicalBase,action:"database.runtime",agentId:"agent-a",commandId:"create-a",inputDigest:"c".repeat(64),correlationId:"original",containerId:"d".repeat(64),imageId:"sha256:"+"e".repeat(64),volumeName:"dl-"+"1".repeat(32)+"-vol-db-orders",networkName:"dl-"+"1".repeat(32)+"-net-db-orders",networkId:"f".repeat(64),volumeCreatedAt:"2026-01-01T00:00:00Z",observedAt:1000,status:"ready",health:"passed",storage:"verified",idempotent:false,redacted:true};
  const source={...base,originalReceipt,originalReplayFingerprint:"2".repeat(64)},key="remove-a",expiry=new Date(Date.now()+60000).toISOString();
  const command={id:"delete-a",status:"pending_confirmation",action:"project.update",scope:{kind:"project",projectId:base.projectId},inputDigest:"3".repeat(64),idempotencyKey:key,correlationId:"delete",expiresAt:expiry};
  const confirmation={id:"nonce-a",classification:"destructive",expiresAt:expiry,consumedAt:null};
  const prepared={preparation:source,idempotencyKey:key,command,confirmation};
  const {health:_health,idempotent:_idempotent,...physical}=originalReceipt;
  const receipt={...physical,action:"database.runtime.delete",profileId:base.profileId,commandId:command.id,inputDigest:command.inputDigest,correlationId:command.correlationId,originalCommandId:originalReceipt.commandId,originalStopCommandId:null,confirmationId:confirmation.id,observedAt:2000,status:"removed",storage:"retained"};
  const preparationResponse={storagePolicy:"retain-original",idempotent:false,command,confirmation},applyResponse={command:{...command,status:"completed"},receipt,removed:true,idempotent:false};
  const response=(data:unknown)=>new Response(JSON.stringify({data,error:null,requestId:"request-a"}));
  const fetchImpl=vi.fn(async (_input:RequestInfo|URL,_init?:RequestInit)=>response(preparationResponse));
  return {source,key,prepared,command,confirmation,receipt,preparationResponse,applyResponse,response,fetchImpl,options:{apiBaseUrl:"https://api.example.test",fetchImpl}};
}
it.each(["postgres","mysql","mariadb","mongodb","redis"] as const)("prepares %s original confirmation and applies only its explicit selector",async engine=>{
  const f=fixture(engine);expect(await prepareManagedDatabaseDeletion(f.source,f.options,f.key)).toEqual({kind:"ready",prepared:f.prepared});
  expect(f.fetchImpl).toHaveBeenCalledTimes(1);const first=f.fetchImpl.mock.calls[0]!;expect(String(first[0])).toContain("/runtime/delete/prepare");
  expect(JSON.parse(first[1]!.body as string)).not.toHaveProperty("confirmationId");
  f.fetchImpl.mockResolvedValueOnce(f.response(f.applyResponse));expect(await applyManagedDatabaseDeletion(f.prepared,f.options)).toEqual({kind:"ready",receipt:f.receipt});
  const second=f.fetchImpl.mock.calls[1]!;expect(String(second[0])).toContain("/runtime/delete/apply");expect(JSON.parse(second[1]!.body as string).confirmationId).toBe(f.confirmation.id);
  for(const call of f.fetchImpl.mock.calls)expect(new Headers(call[1]?.headers).get("idempotency-key")).toBe(f.key);
});
it("rejects private inputs, invalid keys and malformed original confirmation before network",async()=>{
  const f=fixture();for(const key of ["","bad key"])expect((await prepareManagedDatabaseDeletion(f.source,f.options,key)).kind).toBe("error");
  expect((await prepareManagedDatabaseDeletion({...f.source,password:"private"},f.options,f.key)).kind).toBe("error");
  expect((await applyManagedDatabaseDeletion({...f.prepared,confirmation:{...f.confirmation,id:""}},f.options)).kind).toBe("error");expect(f.fetchImpl).not.toHaveBeenCalled();
});
it("rejects foreign scope/key, private authority and consumed, non-destructive or extended nonce replies",async()=>{
  const f=fixture();for(const patch of [{command:{...f.command,scope:{kind:"project",projectId:"foreign"}}},{command:{...f.command,idempotencyKey:"foreign"}},{command:{...f.command,projectExecutionAuthority:{private:true}}},{confirmation:{...f.confirmation,consumedAt:1}},{confirmation:{...f.confirmation,classification:"safe"}},{confirmation:{...f.confirmation,expiresAt:new Date(Date.now()+120000).toISOString()}},{storagePolicy:"remove"}]){
    f.fetchImpl.mockResolvedValueOnce(f.response({...f.preparationResponse,...patch}));expect((await prepareManagedDatabaseDeletion(f.source,f.options,f.key)).kind).toBe("error");
  }
});
it("rejects detached approval, source, physical identity and completed command on apply",async()=>{
  const f=fixture();for(const patch of [{receipt:{...f.receipt,confirmationId:"foreign"}},{receipt:{...f.receipt,originalCommandId:"foreign"}},{receipt:{...f.receipt,containerId:"0".repeat(64)}},{receipt:{...f.receipt,storage:"removed"}},{receipt:{...f.receipt,observedAt:999}},{command:{...f.applyResponse.command,id:"foreign"}},{command:{...f.applyResponse.command,idempotencyKey:"foreign"}}]){
    f.fetchImpl.mockResolvedValueOnce(f.response({...f.applyResponse,...patch}));expect((await applyManagedDatabaseDeletion(f.prepared,f.options)).kind).toBe("error");
  }
});
it("never retries an ambiguous apply automatically and explicitly reuses the exact nonce/key after expiry",async()=>{
  const f=fixture();f.fetchImpl.mockRejectedValueOnce(new Error("private lost reply"));expect((await applyManagedDatabaseDeletion(f.prepared,f.options)).kind).toBe("error");expect(f.fetchImpl).toHaveBeenCalledOnce();
  const expiry="2026-01-01T00:00:00Z",prepared={...f.prepared,command:{...f.command,expiresAt:expiry},confirmation:{...f.confirmation,expiresAt:expiry}};
  f.fetchImpl.mockResolvedValueOnce(f.response({...f.applyResponse,idempotent:true,command:{...f.applyResponse.command,expiresAt:expiry}}));expect((await applyManagedDatabaseDeletion(prepared,f.options)).kind).toBe("ready");
  expect(f.fetchImpl).toHaveBeenCalledTimes(2);expect(f.fetchImpl.mock.calls.map(call=>new Headers(call[1]?.headers).get("idempotency-key"))).toEqual([f.key,f.key]);
});
