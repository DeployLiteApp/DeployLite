import {expect,it} from "vitest";
import {managedDatabaseRuntimeReceiptSchema,managedDatabaseDeleteReceiptQuerySchema,managedDatabaseDeleteReceiptSchema} from "@deploylite/contracts";
import {composeRuntimeResourceName,managedDatabaseRuntimeExecutionDigest,managedDatabaseDeleteExecutionDigest} from "@deploylite/domain";
import {fixture} from "./control-plane-project-confirmation.fixture.js";
async function deletion(){
 const f=fixture(),base={schemaVersion:1 as const,projectId:"project1",databaseId:"orders",engine:"postgres" as const,profileId:"profile1",planDigest:"a".repeat(64),environmentFingerprint:"b".repeat(32)};
 const {profileId:_profile,...originalBase}=base;
 const original=managedDatabaseRuntimeReceiptSchema.parse({...originalBase,action:"database.runtime",agentId:"agent1",commandId:"create1",inputDigest:managedDatabaseRuntimeExecutionDigest(base),correlationId:"create-correlation",containerId:"c".repeat(64),imageId:"sha256:"+"d".repeat(64),volumeName:composeRuntimeResourceName(base.projectId,"volume","db-orders"),networkName:composeRuntimeResourceName(base.projectId,"network","db-orders"),networkId:"e".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",observedAt:500,status:"ready",storage:"verified",health:"passed",idempotent:false,redacted:true});
 const preparation={...base,originalReceipt:original,originalReplayFingerprint:"f".repeat(64)},inputDigest=managedDatabaseDeleteExecutionDigest(preparation);f.command.inputDigest=inputDigest;f.row.inputDigest=inputDigest;
 const nonce=f.seed(),claimed=await f.repository().claimConfirmedProjectUpdate(f.command,nonce,new Date(1000)),authority=claimed.authority!;
 const query=managedDatabaseDeleteReceiptQuerySchema.parse({...preparation,action:"database.runtime.delete",operation:"database.runtime.delete",storagePolicy:"retain-original",stopPolicy:"if-running",confirmationId:nonce.id,agentId:"agent1",commandId:f.command.id,inputDigest,idempotencyKey:f.command.idempotencyKey,requiredCapabilities:["database.runtime.delete.v1"],authority,lease:authority.projectLease,context:{requestId:"delete-request",correlationId:f.command.correlationId},timeoutMs:1000});
 const receipt=managedDatabaseDeleteReceiptSchema.parse({...base,action:query.action,agentId:query.agentId,commandId:query.commandId,inputDigest,originalCommandId:original.commandId,originalStopCommandId:null,confirmationId:nonce.id,correlationId:query.context.correlationId,containerId:original.containerId,imageId:original.imageId,volumeName:original.volumeName,networkName:original.networkName,networkId:original.networkId,volumeCreatedAt:original.volumeCreatedAt,observedAt:1100,status:"removed",storage:"retained",redacted:true});
 const input={command:claimed.command,query,receipt,now:1200,audit:{actorUserId:f.command.actorId,action:"database.runtime.removed",targetType:"project",targetId:base.projectId,requestId:"delete-request",correlationId:f.command.correlationId,metadata:{receipt,redacted:true}}};
 return {...f,nonce,input};
}
it("atomically stores original confirmed removal receipt and one completion audit without changing approval",async()=>{
 const f=await deletion(),nonce=structuredClone(f.confirmations),accepted=structuredClone(f.audits),result=await f.repository().completeManagedDatabaseDelete(f.input);
 expect(result).toMatchObject({id:f.command.id,status:"completed",result:f.input.receipt});expect(f.confirmations).toEqual(nonce);expect(f.audits).toEqual(accepted);expect(f.events).toHaveLength(1);expect(f.events[0]!.metadata.receipt.containerId).toBe("[REDACTED]");
 expect(f.queries.filter(q=>q.text.startsWith('insert into "audit_events"'))).toHaveLength(1);
 const rows=structuredClone(f.row),again=await f.repository().completeManagedDatabaseDelete({...f.input,now:9000});expect(again).toEqual(result);expect(f.row).toEqual(rows);expect(f.queries.filter(q=>q.text.startsWith('insert into "audit_events"'))).toHaveLength(1);
});
it("rolls back receipt completion and audit on injected transaction failure",async()=>{
 const f=await deletion(),before=structuredClone(f.row);
 await expect(f.repository(stage=>{if(stage==="command-completed")throw new Error("injected completion rollback");}).completeManagedDatabaseDelete(f.input)).rejects.toThrow("injected completion rollback");
 expect(f.row).toEqual(before);expect(f.row.status).toBe("dispatching");expect(f.row.result).toBeNull();expect(f.events).toHaveLength(0);
});
it("rejects foreign source approval audit future receipt and expired current authority",async()=>{
 for(const mode of ["source","approval","audit","future","expired","nonce","superseded"]){const f=await deletion(),input=structuredClone(f.input);
 if(mode==="source")input.receipt.containerId="0".repeat(64);if(mode==="approval")input.query.confirmationId="foreign";if(mode==="audit")input.audit.actorUserId="foreign";if(mode==="future")input.now=1099;if(mode==="expired")input.now=8000;if(mode==="nonce")f.confirmations[0]!.consumedAt=null;
 if(mode==="superseded")f.related.push({...f.row,id:"successor",executionAuthority:{...input.query.authority,commandId:"successor",projectLease:{...input.query.lease,fence:3}}});
 await expect(f.repository().completeManagedDatabaseDelete(input)).rejects.toThrow();expect(f.row.status).toBe("dispatching");expect(f.row.result).toBeNull();expect(f.queries.filter(q=>q.text.startsWith('insert into "audit_events"'))).toHaveLength(0);
 }
});
it("refuses a changed stored completed receipt rather than replacing or rerunning it",async()=>{
 const f=await deletion();await f.repository().completeManagedDatabaseDelete(f.input);f.row.result={...f.input.receipt,confirmationId:"foreign"};
 await expect(f.repository().completeManagedDatabaseDelete(f.input)).rejects.toThrow();expect(f.row.result.confirmationId).toBe("foreign");
});

it("reads completed removals by project after repository recreation without changing ledger",async()=>{
 const f=await deletion();await f.repository().completeManagedDatabaseDelete(f.input);const before=structuredClone(f.row),writes=f.queries.filter(q=>q.text.startsWith("update")||q.text.startsWith("insert")).length;
 const found=await f.repository().findManagedDatabaseRemovals("project1");expect(found).toHaveLength(1);expect(found[0]).toMatchObject({status:"completed",result:f.input.receipt});
 expect(f.row).toEqual(before);expect(f.queries.filter(q=>q.text.startsWith("update")||q.text.startsWith("insert"))).toHaveLength(writes);
 expect(await f.repository().findManagedDatabaseRemovals("foreign")).toEqual([]);
});

it("refuses malformed detached stored retirement rather than hiding unrelated creation",async()=>{
 for(const patch of [{originalCommandId:""},{projectId:"foreign"},{commandId:"foreign"},{inputDigest:"0".repeat(64)},{correlationId:"foreign"},{storage:"removed"}]){
  const f=await deletion();await f.repository().completeManagedDatabaseDelete(f.input);f.row.result={...f.input.receipt,...patch};
  await expect(f.repository().findManagedDatabaseRemovals("project1")).rejects.toThrow();
 }
});
