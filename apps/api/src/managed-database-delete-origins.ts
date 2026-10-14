import {MANAGED_DATABASE_RUNTIME_CAPABILITY,managedDatabaseDeletePreparationSchema,managedDatabaseStartPreparationSchema,managedDatabaseRuntimeReceiptSchema,projectControlAuthoritySchema,protocolPayloadFingerprint,type ManagedDatabaseDeletePreparationV1} from "@deploylite/contracts";
import {awaitAbortable,managedDatabaseDeleteExecutionDigest,managedDatabaseRuntimeReplayFingerprintDigest,type ProjectUpdateControlRepository} from "@deploylite/domain";
import {corroborateManagedDatabaseStartOrigins} from "./managed-database-start-origins.js";
import type {ManagedDatabaseRuntimeAgentTransport} from "./managed-database-runtime-transport.js";
import type {ManagedDatabaseStopAgentTransport} from "./managed-database-stop-transport.js";
export type ManagedDatabaseDeleteOriginsAccess=Readonly<{controls:ProjectUpdateControlRepository;originalTransport:ManagedDatabaseRuntimeAgentTransport;originalStopTransport?:ManagedDatabaseStopAgentTransport;agentId:string;deadlineMs:number}>;
function fail():never{throw new Error("Database deletion origins are unavailable.");}
/** Immutable historical selectors only; current project authorization precedes every private read. */
export async function corroborateManagedDatabaseDeleteOrigins(supplied:ManagedDatabaseDeleteOriginsAccess,raw:ManagedDatabaseDeletePreparationV1,
 suppliedContext:Readonly<{requestId:string;signal?:AbortSignal}>,fence:()=>Promise<void>):Promise<void>{
 const options={...supplied},context={...suppliedContext},controller=new AbortController(),cancel=()=>controller.abort();
 context.signal?.addEventListener("abort",cancel,{once:true});if(context.signal?.aborted)cancel();let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  if(!Number.isSafeInteger(options.deadlineMs)||options.deadlineMs<1||options.deadlineMs>60000||!context.requestId||!/^[A-Za-z0-9_-]{1,200}$/.test(options.agentId))fail();
  timer=setTimeout(cancel,options.deadlineMs);
  const preparation=managedDatabaseDeletePreparationSchema.parse(structuredClone(raw));managedDatabaseDeleteExecutionDigest(preparation);
  const bounded=<T>(work:()=>Promise<T>)=>awaitAbortable(work,controller.signal),reader=options.controls.findProjectUpdateById,read=options.originalTransport.readReceipt,stopRead=options.originalStopTransport?.readReceipt;
  const changed=()=>Object.entries(options).some(([key,value])=>supplied[key as keyof typeof supplied]!==value)||options.controls.findProjectUpdateById!==reader||options.originalTransport.readReceipt!==read||options.originalStopTransport?.readReceipt!==stopRead;
  async function check(){if(controller.signal.aborted||changed())fail();await bounded(fence);if(controller.signal.aborted||changed())fail();}
  await check();
  if(preparation.originalStopReceipt){
   if(!options.originalStopTransport)fail();
   await bounded(()=>corroborateManagedDatabaseStartOrigins({...options,originalStopTransport:options.originalStopTransport!},managedDatabaseStartPreparationSchema.parse(preparation),{...context,signal:controller.signal},check));
   await check();return;
  }
  const {originalReceipt,originalReplayFingerprint,...base}=preparation;
  if(!reader||originalReceipt.agentId!==options.agentId||!options.originalTransport.available())fail();
  await check();const row=await bounded(()=>reader!.call(options.controls,preparation.projectId,originalReceipt.commandId));await check();
  if(!row||row.action!=="project.update"||row.scope.kind!=="project"||row.scope.projectId!==preparation.projectId||row.status!=="completed"||row.id!==originalReceipt.commandId
    ||row.inputDigest!==originalReceipt.inputDigest||row.correlationId!==originalReceipt.correlationId||!(row.expiresAt instanceof Date)||!Number.isFinite(row.expiresAt.getTime()))fail();
  const command=structuredClone(row!),authority=projectControlAuthoritySchema.parse(structuredClone(command.projectExecutionAuthority));
  if(authority.projectId!==preparation.projectId||authority.commandId!==command.id||authority.inputDigest!==command.inputDigest||authority.projectLease.expiresAt>command.expiresAt.getTime())fail();
  const query={...base,action:"database.runtime",operation:"database.runtime.apply",agentId:options.agentId,commandId:command.id,idempotencyKey:command.idempotencyKey,inputDigest:command.inputDigest,
    authority,lease:authority.projectLease,requiredCapabilities:[MANAGED_DATABASE_RUNTIME_CAPABILITY],context:{requestId:context.requestId,correlationId:command.correlationId},timeoutMs:options.deadlineMs};
  if(managedDatabaseRuntimeReplayFingerprintDigest(query)!==originalReplayFingerprint)fail();await check();
  const ready=await bounded(()=>read.call(options.originalTransport,{command,input:base,agentId:options.agentId},authority,{requestId:context.requestId,correlationId:command.correlationId,signal:controller.signal}));await check();
  if(!ready||protocolPayloadFingerprint(managedDatabaseRuntimeReceiptSchema.parse(ready))!==protocolPayloadFingerprint(originalReceipt))fail();
 }catch{return fail();}finally{if(timer!==undefined)clearTimeout(timer);context.signal?.removeEventListener("abort",cancel);}
}
