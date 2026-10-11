import {MANAGED_DATABASE_RUNTIME_CAPABILITY,MANAGED_DATABASE_STOP_CAPABILITY,managedDatabaseStartPreparationSchema,
  managedDatabaseRuntimeReceiptSchema,managedDatabaseStopReceiptSchema,projectControlAuthoritySchema,protocolPayloadFingerprint,
  type ManagedDatabaseStartPreparationV1} from "@deploylite/contracts";
import {awaitAbortable,managedDatabaseStartExecutionBinding,managedDatabaseRuntimeReplayFingerprintDigest,managedDatabaseStopReplayFingerprintDigest,
  type ProjectUpdateControlRepository} from "@deploylite/domain";
import type {ManagedDatabaseRuntimeAgentTransport} from "./managed-database-runtime-transport.js";
import type {ManagedDatabaseStopAgentTransport} from "./managed-database-stop-transport.js";
export type ManagedDatabaseStartOriginsAccess=Readonly<{controls:ProjectUpdateControlRepository;originalTransport:ManagedDatabaseRuntimeAgentTransport;
  originalStopTransport:ManagedDatabaseStopAgentTransport;agentId:string;deadlineMs:number}>;
function fail():never {throw new Error("Database start origins are unavailable.");}
/** Historical authorities identify immutable evidence; only the caller's current project fence grants access. */
export async function corroborateManagedDatabaseStartOrigins(supplied:ManagedDatabaseStartOriginsAccess,raw:ManagedDatabaseStartPreparationV1,
  context:Readonly<{requestId:string;signal?:AbortSignal}>,fence:()=>Promise<void>):Promise<void>{
  const options={...supplied},controller=new AbortController(),cancel=()=>controller.abort();
  context.signal?.addEventListener("abort",cancel,{once:true});if(context.signal?.aborted)cancel();
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    if(!Number.isSafeInteger(options.deadlineMs)||options.deadlineMs<1||options.deadlineMs>60000||!context.requestId
      ||!/^[A-Za-z0-9_-]{1,200}$/.test(options.agentId))fail();
    timer=setTimeout(cancel,options.deadlineMs);
    const preparation=managedDatabaseStartPreparationSchema.parse(structuredClone(raw));managedDatabaseStartExecutionBinding(preparation);
    const {originalStopReceipt,originalStopReplayFingerprint,...stopPreparation}=preparation;
    const {originalReceipt,originalReplayFingerprint,...base}=stopPreparation;
    const bounded=<T>(work:()=>Promise<T>)=>awaitAbortable(work,controller.signal);
    const changed=()=>Object.entries(options).some(([key,value])=>supplied[key as keyof typeof supplied]!==value);
    async function check(){
      if(controller.signal.aborted||changed())fail();await bounded(fence);if(controller.signal.aborted||changed())fail();
    }
    await check();
    const reader=options.controls.findProjectUpdateById;
    if(!reader||originalReceipt.agentId!==options.agentId||!options.originalTransport.available()||!options.originalStopTransport.available())fail();
    async function load(receipt:typeof originalReceipt|typeof originalStopReceipt){
      await check();const row=await bounded(()=>reader!.call(options.controls,preparation.projectId,receipt.commandId));await check();
      if(!row||row.action!=="project.update"||row.scope.kind!=="project"||row.scope.projectId!==preparation.projectId||row.status!=="completed"
        ||row.id!==receipt.commandId||row.inputDigest!==receipt.inputDigest||row.correlationId!==receipt.correlationId
        ||!(row.expiresAt instanceof Date)||!Number.isFinite(row.expiresAt.getTime()))fail();
      const command=structuredClone(row),authority=projectControlAuthoritySchema.parse(structuredClone(row.projectExecutionAuthority));
      if(authority.projectId!==preparation.projectId||authority.commandId!==command.id||authority.inputDigest!==command.inputDigest
        ||authority.projectLease.expiresAt>command.expiresAt.getTime())fail();
      return {command,authority};
    }
    const creation=await load(originalReceipt),stop=await load(originalStopReceipt);
    const identity=(source:typeof creation)=>({agentId:options.agentId,commandId:source.command.id,idempotencyKey:source.command.idempotencyKey,
      inputDigest:source.command.inputDigest,authority:source.authority,lease:source.authority.projectLease,
      context:{requestId:context.requestId,correlationId:source.command.correlationId},timeoutMs:options.deadlineMs});
    const readyQuery={...base,action:"database.runtime",operation:"database.runtime.apply",...identity(creation),requiredCapabilities:[MANAGED_DATABASE_RUNTIME_CAPABILITY]};
    const stoppedQuery={...stopPreparation,action:"database.runtime.stop",operation:"database.runtime.stop",...identity(stop),requiredCapabilities:[MANAGED_DATABASE_STOP_CAPABILITY]};
    if(managedDatabaseRuntimeReplayFingerprintDigest(readyQuery)!==originalReplayFingerprint
      ||managedDatabaseStopReplayFingerprintDigest(stoppedQuery)!==originalStopReplayFingerprint)fail();
    await check();
    const ready=await bounded(()=>options.originalTransport.readReceipt({command:creation.command,input:base,agentId:options.agentId},creation.authority,
      {requestId:context.requestId,correlationId:creation.command.correlationId,signal:controller.signal}));await check();
    if(!ready||protocolPayloadFingerprint(managedDatabaseRuntimeReceiptSchema.parse(ready))!==protocolPayloadFingerprint(originalReceipt))fail();
    const stopped=await bounded(()=>options.originalStopTransport.readReceipt({command:stop.command,input:stopPreparation,agentId:options.agentId},stop.authority,
      {requestId:context.requestId,correlationId:stop.command.correlationId,signal:controller.signal}));await check();
    if(!stopped||protocolPayloadFingerprint(managedDatabaseStopReceiptSchema.parse(stopped))!==protocolPayloadFingerprint(originalStopReceipt))fail();
  }catch{return fail();}
  finally{if(timer!==undefined)clearTimeout(timer);context.signal?.removeEventListener("abort",cancel);}
}
