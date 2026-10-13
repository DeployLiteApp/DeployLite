import {expect,it} from "vitest";
import {composeRuntimeResourceName} from "./compose-preview.js";
import {managedDatabaseRuntimeExecutionDigest} from "./managed-database-runtime-binding.js";
import {managedDatabaseStopExecutionDigest} from "./managed-database-stop-binding.js";
import {managedDatabaseStartExecutionDigest} from "./managed-database-start-binding.js";
import {digestControlInput,evaluateConfirmation} from "./control-plane.js";
import {managedDatabaseDeleteExecutionBinding,managedDatabaseDeleteExecutionDigest,prepareManagedDatabaseDeleteConfirmation} from "./managed-database-delete-binding.js";
function fixture(engine="postgres") {
 const base={schemaVersion:1,projectId:"p1",databaseId:"orders",engine,profileId:"approved",planDigest:"a".repeat(64),environmentFingerprint:"b".repeat(32)};
 const original={schemaVersion:1,projectId:base.projectId,databaseId:base.databaseId,engine,action:"database.runtime",agentId:"agent1",commandId:"create1",inputDigest:managedDatabaseRuntimeExecutionDigest(base),planDigest:base.planDigest,environmentFingerprint:base.environmentFingerprint,correlationId:"create-correlation",containerId:"c".repeat(64),imageId:"sha256:"+"d".repeat(64),volumeName:composeRuntimeResourceName(base.projectId,"volume","db-orders"),networkName:composeRuntimeResourceName(base.projectId,"network","db-orders"),networkId:"e".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",observedAt:1000,status:"ready",health:"passed",storage:"verified",idempotent:false,redacted:true};
 const source={...base,originalReceipt:original,originalReplayFingerprint:"f".repeat(64)}, {health:_health,idempotent:_idem,...physical}=original;
 const stopped={...physical,action:"database.runtime.stop",commandId:"stop1",originalCommandId:"create1",profileId:base.profileId,inputDigest:managedDatabaseStopExecutionDigest(source),correlationId:"stop-correlation",observedAt:2000,status:"stopped"};
 return {...source,originalStopReceipt:stopped,originalStopReplayFingerprint:"0".repeat(64)};
}
const request=(preparation=fixture())=>({preparation,actorId:"actor1",idempotencyKey:"delete-key",correlationId:"delete-correlation",now:3000,commandTtlMs:10000});
it.each(["postgres","mysql","mariadb","mongodb","redis"])("binds %s deletion to both original commands and retained storage",engine=>{
 const preparation=fixture(engine), before=structuredClone(preparation),binding=managedDatabaseDeleteExecutionBinding(preparation);
 expect(binding).toEqual({...preparation,action:"project.update",scope:{kind:"project",projectId:"p1"},operation:"database.runtime.delete",storagePolicy:"retain-original"});
 expect(managedDatabaseDeleteExecutionDigest(preparation)).toBe(digestControlInput(binding));expect(managedDatabaseDeleteExecutionDigest(preparation)).not.toBe(managedDatabaseStartExecutionDigest(preparation));expect(preparation).toEqual(before);
});
it("issues only an unconsumed destructive pending confirmation with exact actor command scope digest and expiry",()=>{
 const input=request(),result=prepareManagedDatabaseDeleteConfirmation(input),{command,confirmation}=result;
 expect(command).toMatchObject({actorId:input.actorId,action:"project.update",scope:{kind:"project",projectId:"p1"},inputDigest:managedDatabaseDeleteExecutionDigest(input.preparation),idempotencyKey:input.idempotencyKey,correlationId:input.correlationId,status:"pending_confirmation",expiresAt:new Date(13000)});
 expect(confirmation).toMatchObject({commandId:command.id,actorId:command.actorId,action:command.action,scope:command.scope,inputDigest:command.inputDigest,classification:"destructive",expiresAt:command.expiresAt,consumedAt:null});
 expect(evaluateConfirmation(command,confirmation,new Date(input.now))).toEqual({eligible:true});expect(command).not.toHaveProperty("projectExecutionAuthority");expect(command).not.toHaveProperty("result");
 const originalDigest=command.inputDigest;input.preparation.originalStopReceipt.containerId="0".repeat(64);expect(command.inputDigest).toBe(originalDigest);
});
it("refuses detached original sources names digests profile and private effect fields",()=>{
 const f=fixture();for(const patch of [{originalReceipt:{...f.originalReceipt,inputDigest:"0".repeat(64)}},{originalStopReceipt:{...f.originalStopReceipt,inputDigest:"0".repeat(64)}},{originalStopReceipt:{...f.originalStopReceipt,profileId:"foreign"}},{originalStopReplayFingerprint:"raw"},{projectId:"foreign"},{force:true},{deleteVolumes:true},{environment:{PASSWORD:"private"}}])expect(()=>managedDatabaseDeleteExecutionBinding({...f,...patch})).toThrow();
});
it("refuses invalid actor keys clocks TTLs and future stopped evidence before issuing confirmation",()=>{
 for(const patch of [{actorId:""},{idempotencyKey:"unsafe/key"},{correlationId:""},{now:1999},{now:NaN},{now:-1},{now:Number.MAX_SAFE_INTEGER},{commandTtlMs:0},{commandTtlMs:60001},{commandTtlMs:1.5}])expect(()=>prepareManagedDatabaseDeleteConfirmation({...request(),...patch})).toThrow();
});
it("never validates changed actor scope digest classification expiry or consumed confirmation",()=>{
 const {command,confirmation}=prepareManagedDatabaseDeleteConfirmation(request());
 for(const patch of [{actorId:"foreign"},{scope:{kind:"project" as const,projectId:"foreign"}},{inputDigest:"0".repeat(64)},{classification:"normal" as const},{expiresAt:new Date(3000)},{consumedAt:new Date(3000)}])expect(()=>evaluateConfirmation(command,{...confirmation,...patch} as typeof confirmation,new Date(3000))).toThrow();
});
