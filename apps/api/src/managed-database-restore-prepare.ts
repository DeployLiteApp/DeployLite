import {managedDatabaseDeletePreparationSchema,managedDatabaseRestoreSelectionSchema} from "@deploylite/contracts";
import {awaitAbortable,evaluateConfirmation,managedDatabaseRestoreExecutionDigest,prepareVerifiedManagedDatabaseRestoreConfirmation,type ControlCommand,type ControlConfirmation} from "@deploylite/domain";
import {corroborateManagedDatabaseDeleteOrigins} from "./managed-database-delete-origins.js";
import type {BackupInventoryReader} from "@deploylite/domain";
import type {ManagedDatabaseDeleteOriginsAccess} from "./managed-database-delete-origins.js";
export type ManagedDatabaseRestorePreparationAccess = ManagedDatabaseDeleteOriginsAccess & Readonly<{
 inventory: BackupInventoryReader;
 protection:Readonly<{protect(preparation:unknown,command:ControlCommand,confirmation:ControlConfirmation):Promise<void>}>;
 archive: Readonly<{verify(preparation:unknown,signal:AbortSignal,context?:Readonly<{requestId:string;correlationId:string}>):Promise<unknown>}>;
 now():number;
 commandTtlMs:number;
}>;
export type ManagedDatabaseRestorePreparationInput = Readonly<{
 selection:unknown;
 actorId:string;
 idempotencyKey:string;
 context:Readonly<{requestId:string;correlationId:string}>;
 signal?:AbortSignal;
 authorize():Promise<boolean>;
 current():boolean;
 admit():Promise<void>;
}>;
function unavailable():never {throw new Error("Database restore preparation is unavailable.");}
type VerifiedIntent = Awaited<ReturnType<typeof prepareVerifiedManagedDatabaseRestoreConfirmation>>;
/** Persist pending intent and recover its original nonce. Never claim authority or execute a restore. */
export async function prepareManagedDatabaseRestore(
 supplied:ManagedDatabaseRestorePreparationAccess,input:ManagedDatabaseRestorePreparationInput
):Promise<VerifiedIntent & {idempotent:boolean}> {
 const controller=new AbortController(),cancel=()=>controller.abort();let timer:ReturnType<typeof setTimeout>|undefined;
 try {
  input.signal?.addEventListener("abort",cancel,{once:true});if(input.signal?.aborted)cancel();
  const options={...supplied},request={...input,context:{...input.context}},controls=options.controls;
  const find=controls.findProjectUpdateByIdempotency,resolve=controls.resolve,recover=controls.resolveProjectUpdateConfirmation;
  const originalRead=options.originalTransport.readReceipt,originalFind=controls.findProjectUpdateById;
  const list=options.inventory.list,available=options.inventory.available,verify=options.archive.verify,protect=options.protection?.protect;
  if(!protect||!recover||!Number.isSafeInteger(options.deadlineMs)||options.deadlineMs<1||options.deadlineMs>60000)unavailable();
  const start=options.now(),deadline=start+options.deadlineMs;let lastNow=start;
  const changed=()=>Object.entries(options).some(([key,value])=>supplied[key as keyof typeof supplied]!==value)
   ||controls.findProjectUpdateByIdempotency!==find||controls.resolve!==resolve||controls.resolveProjectUpdateConfirmation!==recover
   ||controls.findProjectUpdateById!==originalFind||options.originalTransport.readReceipt!==originalRead
   ||options.inventory.list!==list||options.inventory.available!==available||options.archive.verify!==verify||options.protection.protect!==protect;
  const now=()=>{
   const value=options.now();if(!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(deadline)
    ||!Number.isSafeInteger(value)||value<lastNow||value>=deadline)unavailable();lastNow=value;return value;
  };
  const bounded=<T>(work:()=>Promise<T>)=>awaitAbortable(work,controller.signal);
  const current=()=>{now();if(controller.signal.aborted||changed()||!request.current())unavailable();};
  const fence=async()=>{current();if(!await bounded(request.authorize))unavailable();current();};
  current();timer=setTimeout(cancel,options.deadlineMs);await fence();
  const selection=managedDatabaseRestoreSelectionSchema.parse(structuredClone(request.selection));
  const {archiveId:_archive,destinationId:_destination,expectedArchiveSha256:_content,expectedManifestSha256:_manifest,maxBytes:_bytes,...source}=selection;
  const original=managedDatabaseDeletePreparationSchema.parse(source);
  await bounded(request.admit);await fence();
  await bounded(()=>corroborateManagedDatabaseDeleteOrigins(options,original,{requestId:request.context.requestId,signal:controller.signal},fence));await fence();
  const selected=await bounded(()=>prepareVerifiedManagedDatabaseRestoreConfirmation({selection,actorId:request.actorId,
   idempotencyKey:request.idempotencyKey,correlationId:request.context.correlationId,commandTtlMs:options.commandTtlMs},
   {expectedAgentId:options.agentId,maxDurationMs:options.deadlineMs,clock:{now},
    inventory:{available:()=>{current();return available.call(options.inventory);},list:async(...args)=>{await fence();const rows=await bounded(()=>list.call(options.inventory,...args));await fence();return rows;}},
    archive:{verify:async(preparation,signal)=>{await fence();const view=await bounded(()=>verify.call(options.archive,preparation,signal,{...request.context}));await fence();return view;}}},controller.signal));await fence();
  const digest=managedDatabaseRestoreExecutionDigest(selected.preparation);
  const validate=(raw:ControlCommand)=>{
   const command=structuredClone(raw);
   if(command.actorId!==request.actorId||command.action!=="project.update"||command.scope.kind!=="project"||command.scope.projectId!==selection.projectId
    ||command.inputDigest!==digest||command.idempotencyKey!==request.idempotencyKey||!command.id||!command.correlationId||command.status!=="pending_confirmation"
    ||command.projectExecutionAuthority||!(command.expiresAt instanceof Date)||!Number.isFinite(command.expiresAt.getTime())||command.expiresAt.getTime()<=now())unavailable();
   return command;
  };
  let command=await bounded(()=>find.call(controls,request.actorId,selection.projectId,request.idempotencyKey));await fence();
  let created=false;
  if(command)command=validate(command);
  else {const resolved=await bounded(()=>resolve.call(controls,selected.command));await fence();command=validate(resolved.command);created=resolved.created;}
  const confirmation=await bounded(()=>recover.call(controls,structuredClone(command!),new Date(now())));await fence();
  if(!confirmation||!/^[A-Za-z0-9_-]{1,200}$/.test(confirmation.id))unavailable();
  evaluateConfirmation(command,confirmation,new Date(now()));validate(command);
  await bounded(()=>protect.call(options.protection,structuredClone(selected.preparation),structuredClone(command),structuredClone(confirmation)));await fence();
  evaluateConfirmation(command,confirmation,new Date(now()));validate(command);
  return {preparation:selected.preparation,command,confirmation:structuredClone(confirmation),idempotent:!created};
 }catch{return unavailable();}
 finally {controller.abort();if(timer!==undefined)clearTimeout(timer);input.signal?.removeEventListener("abort",cancel);}
}
