import {expect,it} from "vitest";
import {MANAGED_DATABASE_RUNTIME_CAPABILITY,type ManagedDatabaseEngineV1,type ManagedDatabaseDeleteReceiptV1} from "@deploylite/contracts";
import {composeRuntimeResourceName,createControlCommand,createConfirmation,managedDatabaseRuntimeExecutionBinding,managedDatabaseRuntimeReplayFingerprintDigest,managedDatabaseDeleteExecutionBinding,type ControlCommand} from "@deploylite/domain";
import {validateManagedDatabaseRemovalHistory,isOriginalManagedDatabaseRemoved} from "./managed-database-inventory-removals.js";
function fixture(engine:ManagedDatabaseEngineV1="postgres"){
 const base={schemaVersion:1 as const,projectId:"project-a",databaseId:"orders",engine,profileId:"profile-a",planDigest:"a".repeat(64),environmentFingerprint:"b".repeat(32)};
 const authorityFor=(command:ControlCommand)=>({schemaVersion:1 as const,projectId:base.projectId,commandId:command.id,action:"project.update" as const,inputDigest:command.inputDigest,projectLease:{leaseId:"lease-"+command.id,projectId:base.projectId,fence:1,expiresAt:command.expiresAt.getTime()}});
 const original=createControlCommand({actorId:"creator",action:"project.update",scope:{kind:"project",projectId:base.projectId},input:managedDatabaseRuntimeExecutionBinding(base),idempotencyKey:"create",correlationId:"original",expiresAt:new Date(2000)});
 const {profileId:_profile,...receiptBase}=base;
 const originalReceipt={...receiptBase,action:"database.runtime" as const,agentId:"agent-a",commandId:original.id,inputDigest:original.inputDigest,correlationId:original.correlationId,containerId:"c".repeat(64),imageId:"sha256:"+"d".repeat(64),volumeName:composeRuntimeResourceName(base.projectId,"volume","db-orders"),networkName:composeRuntimeResourceName(base.projectId,"network","db-orders"),networkId:"e".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",observedAt:500,status:"ready" as const,health:"passed" as const,storage:"verified" as const,idempotent:false,redacted:true as const};
 const originalAuthority=authorityFor(original),query={...base,action:"database.runtime",operation:"database.runtime.apply",agentId:"agent-a",commandId:original.id,inputDigest:original.inputDigest,idempotencyKey:original.idempotencyKey,requiredCapabilities:[MANAGED_DATABASE_RUNTIME_CAPABILITY],authority:originalAuthority,lease:originalAuthority.projectLease,context:{requestId:"original-request",correlationId:original.correlationId},timeoutMs:1000};
 const source={...base,originalReceipt,originalReplayFingerprint:managedDatabaseRuntimeReplayFingerprintDigest(query)};
 const command=createControlCommand({actorId:"deleter",action:"project.update",scope:{kind:"project",projectId:base.projectId},input:managedDatabaseDeleteExecutionBinding(source),idempotencyKey:"remove",correlationId:"removal",expiresAt:new Date(2000)}),nonce=createConfirmation({command,classification:"destructive"});
 const {health:_health,idempotent:_idempotent,...physical}=originalReceipt;
 const removed:ManagedDatabaseDeleteReceiptV1={...physical,action:"database.runtime.delete",profileId:base.profileId,commandId:command.id,originalCommandId:original.id,originalStopCommandId:null,confirmationId:nonce.id,inputDigest:command.inputDigest,correlationId:command.correlationId,observedAt:1000,status:"removed",storage:"retained"};
 const completed:ControlCommand={...command,status:"completed",projectExecutionAuthority:authorityFor(command),result:removed};
 return {completed,source};
}
it.each(["postgres","mysql","mariadb","mongodb","redis"] as const)("hides only completed %s retirement of the exact original source",engine=>{
 const f=fixture(engine),history=validateManagedDatabaseRemovalHistory("project-a",[f.completed]),before=structuredClone(f);
 expect(isOriginalManagedDatabaseRemoved(f.source,history.receipts)).toBe(true);expect(history.fingerprint).toMatch(/^[a-f0-9]{64}$/);expect(f).toEqual(before);
});
it("keeps a different original creation visible even with identical logical database identity",()=>{
 const f=fixture(),history=validateManagedDatabaseRemovalHistory("project-a",[f.completed]);expect(isOriginalManagedDatabaseRemoved({...f.source,originalReceipt:{...f.source.originalReceipt,commandId:"new-original"}},history.receipts)).toBe(false);
});
it("rejects foreign project, unfinished or detached receipt/authority instead of empty history",()=>{
 const f=fixture();for(const patch of [{scope:{kind:"project" as const,projectId:"foreign"}},{status:"dispatching" as const},{result:{...f.completed.result,commandId:"foreign"}},{projectExecutionAuthority:{...f.completed.projectExecutionAuthority!,commandId:"foreign"}},{expiresAt:new Date(500)}])expect(()=>validateManagedDatabaseRemovalHistory("project-a",[{...f.completed,...patch} as ControlCommand])).toThrow();
});
it("rejects duplicate original retirement and detects history changes",()=>{
 const f=fixture();expect(()=>validateManagedDatabaseRemovalHistory("project-a",[f.completed,f.completed])).toThrow();expect(validateManagedDatabaseRemovalHistory("project-a",[]).fingerprint).not.toBe(validateManagedDatabaseRemovalHistory("project-a",[f.completed]).fingerprint);
});
it("rejects different physical identity for a matching original command instead of hiding another resource",()=>{
 const f=fixture(),history=validateManagedDatabaseRemovalHistory("project-a",[f.completed]);for(const patch of [{containerId:"0".repeat(64)},{networkId:"0".repeat(64)},{volumeCreatedAt:"2026-10-09T00:00:00Z"}])expect(()=>isOriginalManagedDatabaseRemoved({...f.source,originalReceipt:{...f.source.originalReceipt,...patch}},history.receipts)).toThrow();
});
