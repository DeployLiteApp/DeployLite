import {MANAGED_DATABASE_DELETE_CAPABILITY,managedDatabaseDeletePreparationSchema,managedDatabaseDeleteReceiptQuerySchema,managedDatabaseDeleteReceiptSchema,projectControlAuthoritySchema,protocolPayloadFingerprint,type ProjectControlAuthorityV1} from "@deploylite/contracts";
import {awaitAbortable,managedDatabaseDeleteExecutionDigest,managedDatabaseDeleteReceiptMatches,type ControlCommand,type ControlConfirmation} from "@deploylite/domain";
import {corroborateManagedDatabaseDeleteOrigins,type ManagedDatabaseDeleteOriginsAccess} from "./managed-database-delete-origins.js";
import type {ManagedDatabaseDeleteAgentTransport,PreparedManagedDatabaseDelete} from "./managed-database-delete-transport.js";
import type {ManagedDatabaseDeletePreparationInput} from "./managed-database-delete-prepare.js";
export type ManagedDatabaseDeleteApplyAccess=ManagedDatabaseDeleteOriginsAccess & Readonly<{transport:ManagedDatabaseDeleteAgentTransport;now():number}>;
export type ManagedDatabaseDeleteApplyInput=ManagedDatabaseDeletePreparationInput & Readonly<{confirmationId:string}>;
function fail():never{throw new Error("Database deletion application is unavailable.");}
/** Existing original nonce and atomic claim own one effect. Uncertain attempts reconcile only from signed cache. */
export async function applyManagedDatabaseDelete(options:ManagedDatabaseDeleteApplyAccess,input:ManagedDatabaseDeleteApplyInput){
 const snapshot={...options},request={...input,context:{...input.context}},controls=options.controls,transport=options.transport;
 const find=controls.findProjectUpdateByIdempotency,claim=controls.claimConfirmedProjectUpdate,complete=controls.completeManagedDatabaseDelete;
 const validate=controls.validateProjectUpdateAuthority,confirmed=controls.validateConfirmedProjectUpdateAuthority,read=transport.readReceipt,dispatch=transport.dispatch;
 const controller=new AbortController(),cancel=()=>controller.abort();input.signal?.addEventListener("abort",cancel,{once:true});if(input.signal?.aborted)cancel();let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  if(!claim||!complete||!confirmed||!Number.isSafeInteger(options.deadlineMs)||options.deadlineMs<1||options.deadlineMs>60000
   ||![request.actorId,request.idempotencyKey,request.confirmationId].every(value=>/^[A-Za-z0-9_-]{1,200}$/.test(value))||!request.context.requestId||!request.context.correlationId)fail();
  timer=setTimeout(cancel,options.deadlineMs);const bounded=<T>(work:()=>Promise<T>)=>awaitAbortable(work,controller.signal);
  const changed=()=>Object.entries(snapshot).some(([key,value])=>options[key as keyof typeof options]!==value)||controls.findProjectUpdateByIdempotency!==find
   ||controls.claimConfirmedProjectUpdate!==claim||controls.completeManagedDatabaseDelete!==complete||controls.validateProjectUpdateAuthority!==validate||controls.validateConfirmedProjectUpdateAuthority!==confirmed
   ||transport.readReceipt!==read||transport.dispatch!==dispatch;
  const fence=async()=>{if(changed()||controller.signal.aborted||!request.current())fail();if(!await bounded(request.authorize)||changed()||controller.signal.aborted||!request.current())fail();};
  const now=()=>{const value=snapshot.now();if(!Number.isSafeInteger(value)||value<0)fail();return value;};
  const preparation=managedDatabaseDeletePreparationSchema.parse(structuredClone(request.preparation)),digest=managedDatabaseDeleteExecutionDigest(preparation);
  const commandFor=(raw:ControlCommand)=>{
   const command=structuredClone(raw);
   if(command.actorId!==request.actorId||command.action!=="project.update"||command.scope.kind!=="project"||command.scope.projectId!==preparation.projectId
    ||command.inputDigest!==digest||command.idempotencyKey!==request.idempotencyKey||!command.id||!command.correlationId||!(command.expiresAt instanceof Date)||!Number.isFinite(command.expiresAt.getTime()))fail();return command;
  };
  const authorityFor=(command:ControlCommand)=>{
   const authority=projectControlAuthoritySchema.parse(structuredClone(command.projectExecutionAuthority));
   if(authority.commandId!==command.id||authority.projectId!==preparation.projectId||authority.inputDigest!==digest||authority.projectLease.expiresAt!==command.expiresAt.getTime())fail();return authority;
  };
  const preparedFor=(command:ControlCommand):PreparedManagedDatabaseDelete=>({command:structuredClone(command),input:structuredClone(preparation),agentId:snapshot.agentId,confirmationId:request.confirmationId});
  const contextFor=(command:ControlCommand)=>({requestId:request.context.requestId,correlationId:command.correlationId,signal:controller.signal});
  const queryFor=(command:ControlCommand,authority:ProjectControlAuthorityV1)=>managedDatabaseDeleteReceiptQuerySchema.parse({...preparation,action:"database.runtime.delete",operation:"database.runtime.delete",storagePolicy:"retain-original",stopPolicy:"if-running",
   confirmationId:request.confirmationId,agentId:snapshot.agentId,commandId:command.id,idempotencyKey:command.idempotencyKey,inputDigest:digest,requiredCapabilities:[MANAGED_DATABASE_DELETE_CAPABILITY],authority,lease:authority.projectLease,context:{requestId:request.context.requestId,correlationId:command.correlationId},timeoutMs:snapshot.deadlineMs});
  const finish=async(command:ControlCommand,authority:ProjectControlAuthorityV1,raw:unknown,idempotent:boolean)=>{
   const query=queryFor(command,authority),receipt=managedDatabaseDeleteReceiptSchema.parse(structuredClone(raw));if(!managedDatabaseDeleteReceiptMatches(query,receipt))fail();await fence();
   const completed=commandFor(await bounded(()=>complete.call(controls,{command,query,receipt,now:now(),audit:{actorUserId:request.actorId,action:"database.runtime.removed",targetType:"project",targetId:preparation.projectId,
    requestId:request.context.requestId,correlationId:command.correlationId,metadata:{receipt,redacted:true}}})));await fence();
   if(completed.id!==command.id||completed.status!=="completed"||!completed.result||protocolPayloadFingerprint(managedDatabaseDeleteReceiptSchema.parse(completed.result))!==protocolPayloadFingerprint(receipt))fail();
   return {command:completed,receipt,removed:true as const,idempotent};
  };
  await fence();if(!transport.available())fail();let found=await bounded(()=>find.call(controls,request.actorId,preparation.projectId,request.idempotencyKey));await fence();if(!found)fail();let command=commandFor(found!);
  if(command.projectExecutionAuthority){
   if(command.status!=="dispatching"&&command.status!=="completed")fail();const authority=authorityFor(command),cached=await bounded(()=>read.call(transport,preparedFor(command),authority,contextFor(command)));await fence();if(!cached)fail();return await finish(command,authority,cached,true);
  }
  if(command.status!=="pending_confirmation"||command.expiresAt.getTime()<=now())fail();
  await bounded(request.admit);await fence();await bounded(()=>corroborateManagedDatabaseDeleteOrigins(snapshot,preparation,{requestId:request.context.requestId,signal:controller.signal},fence));await fence();
  // Selector only: the repository must load and validate the original persisted nonce; none is resolved, created or renewed here.
  const confirmation:ControlConfirmation={id:request.confirmationId,commandId:command.id,actorId:command.actorId,action:command.action,scope:command.scope,inputDigest:command.inputDigest,classification:"destructive",expiresAt:new Date(command.expiresAt),consumedAt:null};
  const original=structuredClone(command),claimed=await bounded(()=>claim.call(controls,structuredClone(command),confirmation,new Date(now())));await fence();command=commandFor(claimed.command);
  if(command.id!==original.id||command.correlationId!==original.correlationId||command.expiresAt.getTime()!==original.expiresAt.getTime()||command.status!=="dispatching"||!command.projectExecutionAuthority)fail();
  const authority=authorityFor(command);if(claimed.claimed&&(!claimed.accepted||!claimed.authority||protocolPayloadFingerprint(claimed.authority)!==protocolPayloadFingerprint(authority)))fail();
  let receipt=await bounded(()=>read.call(transport,preparedFor(command),authority,contextFor(command)));await fence();
  if(!receipt){
   if(!claimed.claimed)fail();await bounded(()=>validate.call(controls,authority,now()));await fence();await bounded(()=>confirmed.call(controls,authority,request.confirmationId,now()));await fence();
   try{receipt=await bounded(()=>dispatch.call(transport,preparedFor(command),authority,contextFor(command)));}
   catch{await fence();receipt=await bounded(()=>read.call(transport,preparedFor(command),authority,contextFor(command)));if(!receipt)fail();}
  }
  return await finish(command,authority,receipt,!claimed.claimed);
 }catch{return fail();}finally{if(timer!==undefined)clearTimeout(timer);input.signal?.removeEventListener("abort",cancel);}
}
