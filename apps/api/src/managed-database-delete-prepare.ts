import {managedDatabaseDeletePreparationSchema,type ManagedDatabaseDeletePreparationV1} from "@deploylite/contracts";
import {awaitAbortable,evaluateConfirmation,managedDatabaseDeleteExecutionDigest,prepareManagedDatabaseDeleteConfirmation,type ControlCommand} from "@deploylite/domain";
import {corroborateManagedDatabaseDeleteOrigins,type ManagedDatabaseDeleteOriginsAccess} from "./managed-database-delete-origins.js";
export type ManagedDatabaseDeletePreparationAccess=ManagedDatabaseDeleteOriginsAccess & Readonly<{now():number;commandTtlMs:number}>;
export type ManagedDatabaseDeletePreparationInput=Readonly<{
 preparation:ManagedDatabaseDeletePreparationV1;actorId:string;idempotencyKey:string;context:Readonly<{requestId:string;correlationId:string}>;
 signal?:AbortSignal;authorize():Promise<boolean>;current():boolean;admit():Promise<void>;
}>;
function fail():never{throw new Error("Database deletion preparation is unavailable.");}
/** Pending intent and original nonce only. No claim, authority or execution is issued. */
export async function prepareManagedDatabaseDelete(options:ManagedDatabaseDeletePreparationAccess,input:ManagedDatabaseDeletePreparationInput){
 const snapshot={...options},request={...input,context:{...input.context}},controls=options.controls;
 const find=controls.findProjectUpdateByIdempotency,resolve=controls.resolve,recover=controls.resolveProjectUpdateConfirmation;
 const controller=new AbortController(),cancel=()=>controller.abort();input.signal?.addEventListener("abort",cancel,{once:true});if(input.signal?.aborted)cancel();
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  if(!recover||!Number.isSafeInteger(options.deadlineMs)||options.deadlineMs<1||options.deadlineMs>60000)fail();
  timer=setTimeout(cancel,options.deadlineMs);
  const bounded=<T>(work:()=>Promise<T>)=>awaitAbortable(work,controller.signal);
  const changed=()=>Object.entries(snapshot).some(([key,value])=>options[key as keyof typeof options]!==value)
   ||controls.findProjectUpdateByIdempotency!==find||controls.resolve!==resolve||controls.resolveProjectUpdateConfirmation!==recover;
  const fence=async()=>{if(changed()||controller.signal.aborted||!request.current())fail();if(!await bounded(request.authorize)||changed()||controller.signal.aborted||!request.current())fail();};
  const now=()=>{const value=snapshot.now();if(!Number.isSafeInteger(value)||value<0)fail();return value;};
  const preparation=managedDatabaseDeletePreparationSchema.parse(structuredClone(request.preparation)),digest=managedDatabaseDeleteExecutionDigest(preparation);
  await fence();
  const candidate=prepareManagedDatabaseDeleteConfirmation({preparation,actorId:request.actorId,idempotencyKey:request.idempotencyKey,correlationId:request.context.correlationId,now:now(),commandTtlMs:snapshot.commandTtlMs}).command;
  const validate=(raw:ControlCommand)=>{
   const command=structuredClone(raw);
   if(command.actorId!==request.actorId||command.action!=="project.update"||command.scope.kind!=="project"||command.scope.projectId!==preparation.projectId
    ||command.inputDigest!==digest||command.idempotencyKey!==request.idempotencyKey||!command.id||!command.correlationId||command.status!=="pending_confirmation"
    ||command.projectExecutionAuthority||!(command.expiresAt instanceof Date)||!Number.isFinite(command.expiresAt.getTime())||command.expiresAt.getTime()<=now())fail();return command;
  };
  let command=await bounded(()=>find.call(controls,request.actorId,preparation.projectId,request.idempotencyKey));await fence();
  if(command)command=validate(command);
  await bounded(request.admit);await fence();
  await bounded(()=>corroborateManagedDatabaseDeleteOrigins(snapshot,preparation,{requestId:request.context.requestId,signal:controller.signal},fence));await fence();
  let created=false;
  if(!command){const resolved=await bounded(()=>resolve.call(controls,candidate));await fence();command=validate(resolved.command);created=resolved.created;}
  const confirmation=await bounded(()=>recover.call(controls,structuredClone(command!),new Date(now())));await fence();
  if(!confirmation||!/^[A-Za-z0-9_-]{1,200}$/.test(confirmation.id))fail();
  evaluateConfirmation(command,confirmation,new Date(now()));validate(command);
  return {command,confirmation:structuredClone(confirmation),idempotent:!created};
 }catch{return fail();}finally{if(timer!==undefined)clearTimeout(timer);input.signal?.removeEventListener("abort",cancel);}
}
