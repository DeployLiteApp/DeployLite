import {protocolPayloadFingerprint} from "@deploylite/contracts";
import {expect,it} from "vitest";
import {managedDatabaseStopExecutionBinding,managedDatabaseStopExecutionDigest,managedDatabaseStopReceiptMatches,managedDatabaseStopReplayFingerprint,managedDatabaseStopReplayFingerprintDigest} from "./managed-database-stop-binding.js";
import {managedDatabaseRuntimeExecutionDigest} from "./managed-database-runtime-binding.js";
import {composeRuntimeResourceName} from "./compose-preview.js";
const input={schemaVersion:1,projectId:"project-a",databaseId:"orders",engine:"postgres",profileId:"profile-a",planDigest:"a".repeat(64),environmentFingerprint:"b".repeat(32)};
const original={schemaVersion:1,projectId:input.projectId,databaseId:input.databaseId,engine:input.engine,action:"database.runtime",agentId:"agent-a",commandId:"origin-a",inputDigest:managedDatabaseRuntimeExecutionDigest(input),planDigest:input.planDigest,environmentFingerprint:input.environmentFingerprint,correlationId:"origin-correlation",
    containerId:"c".repeat(64),imageId:"sha256:"+"d".repeat(64),volumeName:composeRuntimeResourceName(input.projectId,"volume","db-orders"),networkName:composeRuntimeResourceName(input.projectId,"network","db-orders"),networkId:"e".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",observedAt:1000,status:"ready",health:"passed",storage:"verified",idempotent:false,redacted:true};
const preparation={...input,originalReceipt:original,originalReplayFingerprint:"f".repeat(64)};
it("prepares stop using existing project update scope and a distinct immutable operation",()=>{
    expect(managedDatabaseStopExecutionBinding(preparation)).toEqual({...preparation,action:"project.update",scope:{kind:"project",projectId:input.projectId},operation:"database.runtime.stop"});
    expect(managedDatabaseStopExecutionDigest(preparation)).not.toBe(managedDatabaseRuntimeExecutionDigest(input));
});
it.each(["containerId","networkId","volumeCreatedAt","originalReplayFingerprint"] as const)("binds original %s substitution to a different stop digest",field=>{
    const changed=field==="originalReplayFingerprint"?{...preparation,originalReplayFingerprint:"1".repeat(64)}:{...preparation,originalReceipt:{...original,[field]:field==="volumeCreatedAt"?"2026-10-09T00:00:00Z":"1".repeat(64)}};
    expect(managedDatabaseStopExecutionDigest(changed)).not.toBe(managedDatabaseStopExecutionDigest(preparation));
});
it("rejects detached creation digest, foreign resource names, secrets and malformed preparation",()=>{
    for(const change of [{originalReceipt:{...original,inputDigest:"1".repeat(64)}},{originalReceipt:{...original,volumeName:composeRuntimeResourceName("foreign","volume","db-orders")}},{originalReceipt:{...original,networkName:composeRuntimeResourceName("foreign","network","db-orders")}},{password:"private"},{originalReplayFingerprint:"short"}])
        expect(()=>managedDatabaseStopExecutionBinding({...preparation,...change})).toThrow("Database stop preparation is unavailable.");
});
const digest=()=>managedDatabaseStopExecutionDigest(preparation);
function query(){const inputDigest=digest(),lease={projectId:input.projectId,leaseId:"stop-lease",fence:2,expiresAt:10000};return {...preparation,action:"database.runtime.stop",operation:"database.runtime.stop",agentId:"agent-a",commandId:"stop-a",inputDigest,idempotencyKey:"stop-once",requiredCapabilities:["database.runtime.stop.v1"],authority:{schemaVersion:1,projectId:input.projectId,commandId:"stop-a",action:"project.update",inputDigest,projectLease:lease},lease,context:{requestId:"request-a",correlationId:"stop-correlation"},timeoutMs:5000};}
function receipt(){return {...input,action:"database.runtime.stop",agentId:"agent-a",commandId:"stop-a",originalCommandId:original.commandId,inputDigest:digest(),correlationId:"stop-correlation",containerId:original.containerId,imageId:original.imageId,volumeName:original.volumeName,networkName:original.networkName,networkId:original.networkId,volumeCreatedAt:original.volumeCreatedAt,observedAt:2000,status:"stopped",storage:"verified",redacted:true};}
it("matches only stopped evidence for the exact new command and original persistent pair",()=>{
    expect(managedDatabaseStopReceiptMatches(query(),receipt())).toBe(true);
    for(const change of [{containerId:"1".repeat(64)},{imageId:"sha256:"+"1".repeat(64)},{networkId:"1".repeat(64)},{volumeCreatedAt:"2026-10-09T00:00:00Z"},{originalCommandId:"foreign"},{correlationId:"foreign"},{profileId:"foreign"},{observedAt:999},{status:"ready"}])
        expect(managedDatabaseStopReceiptMatches(query(),{...receipt(),...change})).toBe(false);
});

it("preserves stable stop identity across object insertion order while rejecting a forged query digest",()=>{
    expect(managedDatabaseStopExecutionDigest(Object.fromEntries(Object.entries(preparation).reverse()))).toBe(digest());
    const forged={...query(),inputDigest:"1".repeat(64),authority:{...query().authority,inputDigest:"1".repeat(64)}};
    expect(managedDatabaseStopReceiptMatches(forged,{...receipt(),inputDigest:"1".repeat(64)})).toBe(false);
});

it("preserves the existing receiver canonical stop replay bytes as an opaque selector",()=>{
    const value=query(),expected=protocolPayloadFingerprint({...preparation,action:value.action,agentId:value.agentId,commandId:value.commandId,
        idempotencyKey:value.idempotencyKey,inputDigest:value.inputDigest,correlationId:value.context.correlationId,authority:value.authority,lease:value.lease});
    expect(managedDatabaseStopReplayFingerprint(value)).toBe(expected);expect(managedDatabaseStopReplayFingerprintDigest(value)).toMatch(/^[a-f0-9]{64}$/);
});
it("ignores receipt read request/timeout while preserving every original proof and stop authority dimension",()=>{
    const value=query(),fingerprint=managedDatabaseStopReplayFingerprint(value);
    expect(managedDatabaseStopReplayFingerprint({...value,context:{...value.context,requestId:"new-read"},timeoutMs:1})).toBe(fingerprint);
    expect(managedDatabaseStopReplayFingerprint({...value,context:{...value.context,correlationId:"foreign"}})).not.toBe(fingerprint);
    expect(managedDatabaseStopReplayFingerprint({...value,originalReplayFingerprint:"0".repeat(64)})).not.toBe(fingerprint);
    expect(()=>managedDatabaseStopReplayFingerprint({...value,password:"private"})).toThrow();
});
