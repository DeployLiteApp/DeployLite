import {MANAGED_DATABASE_RESTORE_CAPABILITY,managedDatabaseBackupReceiptSchema,managedDatabaseDeletePreparationSchema,managedDatabaseRestorePreparationSchema,managedDatabaseRestoreReceiptQuerySchema,managedDatabaseRestoreReceiptSchema,projectControlAuthoritySchema,protocolPayloadFingerprint,type ProjectControlAuthorityV1} from "@deploylite/contracts";
import {awaitAbortable,managedDatabaseRestoreExecutionDigest,managedDatabaseRestoreReceiptMatches,type ControlCommand,type ControlConfirmation} from "@deploylite/domain";
import {corroborateManagedDatabaseDeleteOrigins,type ManagedDatabaseDeleteOriginsAccess} from "./managed-database-delete-origins.js";
import type {ManagedDatabaseRestoreAgentTransport,PreparedManagedDatabaseRestore} from "./managed-database-restore-transport.js";
import type {ManagedDatabaseRestorePreparationAccess,ManagedDatabaseRestorePreparationInput} from "./managed-database-restore-prepare.js";
export type ManagedDatabaseRestoreApplyAccess=Omit<ManagedDatabaseRestorePreparationAccess,"protection"> & Readonly<{transport:ManagedDatabaseRestoreAgentTransport;protection:ManagedDatabaseRestorePreparationAccess["protection"] & {assertProtected(preparation:unknown,command:ControlCommand,confirmationId:string):Promise<void>}}>;
export type ManagedDatabaseRestoreApplyInput=Omit<ManagedDatabaseRestorePreparationInput,"selection"> & Readonly<{preparation:ReturnType<typeof managedDatabaseRestorePreparationSchema.parse>;confirmationId:string}>;
function fail():never{throw new Error("Database restore application is unavailable.");}
/** Existing original nonce and atomic claim own one effect. Uncertain attempts reconcile only from signed cache. */
export async function applyManagedDatabaseRestore(options:ManagedDatabaseRestoreApplyAccess,input:ManagedDatabaseRestoreApplyInput){
 const snapshot={...options},request={...input,context:{...input.context}},controls=options.controls,transport=options.transport;
 const find=controls.findProjectUpdateByIdempotency,claim=controls.claimConfirmedProjectUpdate,complete=controls.completeManagedDatabaseRestore;
 const validate=controls.validateProjectUpdateAuthority,confirmed=controls.validateConfirmedProjectUpdateAuthority,read=transport.readReceipt,dispatch=transport.dispatch;
 const list=options.inventory.list,available=options.inventory.available,verify=options.archive.verify,protectedSource=options.protection.assertProtected;
 const controller=new AbortController(),cancel=()=>controller.abort();input.signal?.addEventListener("abort",cancel,{once:true});if(input.signal?.aborted)cancel();let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  if(!claim||!complete||!confirmed||typeof protectedSource!=="function"||!Number.isSafeInteger(options.deadlineMs)||options.deadlineMs<1||options.deadlineMs>60000
   ||![request.actorId,request.idempotencyKey,request.confirmationId].every(value=>/^[A-Za-z0-9_-]{1,200}$/.test(value))||!request.context.requestId||!request.context.correlationId)fail();
  timer=setTimeout(cancel,options.deadlineMs);const bounded=<T>(work:()=>Promise<T>)=>awaitAbortable(work,controller.signal);
  const start=snapshot.now(),deadline=start+snapshot.deadlineMs;let lastNow=start;
  const now=()=>{const value=snapshot.now();if(!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(deadline)||!Number.isSafeInteger(value)||value<lastNow||value>=deadline)fail();lastNow=value;return value;};
  const changed=()=>Object.entries(snapshot).some(([key,value])=>options[key as keyof typeof options]!==value)||controls.findProjectUpdateByIdempotency!==find
   ||controls.claimConfirmedProjectUpdate!==claim||controls.completeManagedDatabaseRestore!==complete||controls.validateProjectUpdateAuthority!==validate||controls.validateConfirmedProjectUpdateAuthority!==confirmed
   ||transport.readReceipt!==read||transport.dispatch!==dispatch||options.inventory.list!==list||options.inventory.available!==available||options.archive.verify!==verify||options.protection.assertProtected!==protectedSource;
  const fence=async()=>{now();if(changed()||controller.signal.aborted||!request.current())fail();if(!await bounded(request.authorize)||changed()||controller.signal.aborted||!request.current())fail();};
  const preparation=managedDatabaseRestorePreparationSchema.parse(structuredClone(request.preparation)),digest=managedDatabaseRestoreExecutionDigest(preparation);
  const commandFor=(raw:ControlCommand)=>{
   const command=structuredClone(raw);
   if(command.actorId!==request.actorId||command.action!=="project.update"||command.scope.kind!=="project"||command.scope.projectId!==preparation.projectId
    ||command.inputDigest!==digest||command.idempotencyKey!==request.idempotencyKey||!command.id||!command.correlationId||!(command.expiresAt instanceof Date)||!Number.isFinite(command.expiresAt.getTime()))fail();return command;
  };
  const authorityFor=(command:ControlCommand)=>{
   const authority=projectControlAuthoritySchema.parse(structuredClone(command.projectExecutionAuthority));
   if(authority.commandId!==command.id||authority.projectId!==preparation.projectId||authority.inputDigest!==digest||authority.projectLease.expiresAt!==command.expiresAt.getTime())fail();return authority;
  };
  const preparedFor=(command:ControlCommand):PreparedManagedDatabaseRestore=>({command:structuredClone(command),input:structuredClone(preparation),agentId:snapshot.agentId,confirmationId:request.confirmationId});
  const contextFor=(command:ControlCommand)=>({requestId:request.context.requestId,correlationId:command.correlationId,signal:controller.signal});
  const queryFor=(command:ControlCommand,authority:ProjectControlAuthorityV1)=>managedDatabaseRestoreReceiptQuerySchema.parse({...preparation,action:"database.runtime.restore",operation:"database.runtime.restore",
   confirmationId:request.confirmationId,agentId:snapshot.agentId,commandId:command.id,idempotencyKey:command.idempotencyKey,inputDigest:digest,requiredCapabilities:[MANAGED_DATABASE_RESTORE_CAPABILITY],authority,lease:authority.projectLease,context:{requestId:request.context.requestId,correlationId:command.correlationId},timeoutMs:snapshot.deadlineMs});
  const finish=async(command:ControlCommand,authority:ProjectControlAuthorityV1,raw:unknown,idempotent:boolean)=>{
   const query=queryFor(command,authority),receipt=managedDatabaseRestoreReceiptSchema.parse(structuredClone(raw));if(receipt.observedAt>now()||receipt.observedAt>=query.lease.expiresAt||!managedDatabaseRestoreReceiptMatches(query,receipt))fail();await fence();
   const completed=commandFor(await bounded(()=>complete.call(controls,{command,query,receipt,now:now(),audit:{actorUserId:request.actorId,action:"database.runtime.restored",targetType:"project",targetId:preparation.projectId,
    requestId:request.context.requestId,correlationId:command.correlationId,metadata:{receipt,redacted:true}}})));await fence();
   if(completed.id!==command.id||completed.status!=="completed"||!completed.result||protocolPayloadFingerprint(managedDatabaseRestoreReceiptSchema.parse(completed.result))!==protocolPayloadFingerprint(receipt))fail();
   return {command:completed,receipt,restored:true as const,idempotent};
  };
  await fence();if(!transport.available())fail();let found=await bounded(()=>find.call(controls,request.actorId,preparation.projectId,request.idempotencyKey));await fence();if(!found)fail();let command=commandFor(found!);
  if(command.projectExecutionAuthority){
   if(command.status!=="dispatching"&&command.status!=="completed")fail();const authority=authorityFor(command),cached=await bounded(()=>read.call(transport,preparedFor(command),authority,contextFor(command)));await fence();if(!cached)fail();return await finish(command,authority,cached,true);
  }
  if(command.status!=="pending_confirmation"||command.expiresAt.getTime()<=now())fail();
  await bounded(request.admit);await fence();
  const {backupReceipt,maxBytes:_max,...source}=preparation;
  await bounded(()=>corroborateManagedDatabaseDeleteOrigins(snapshot,managedDatabaseDeletePreparationSchema.parse(source),{requestId:request.context.requestId,signal:controller.signal},fence));await fence();
  // Fresh readonly source/protection observations bind the original approval before its atomic consumption.
  for(let observation=0;observation<2;observation++){
   await bounded(()=>protectedSource.call(options.protection,structuredClone(preparation),structuredClone(command),request.confirmationId));await fence();
   if(!available.call(options.inventory))fail();const records=await bounded(()=>list.call(options.inventory,preparation.projectId,backupReceipt.volumeKey,backupReceipt.destinationId));await fence();
   if(!available.call(options.inventory)||records.length>10000)fail();const matches=records.filter(row=>row.receipt.archiveId===backupReceipt.archiveId);if(matches.length!==1)fail();const record=matches[0]!;
   if(record.schemaVersion!==1||!Number.isSafeInteger(record.createdAtMs)||record.createdAtMs<backupReceipt.observedAt||record.createdAtMs>now()||protocolPayloadFingerprint(managedDatabaseBackupReceiptSchema.parse(record.receipt))!==protocolPayloadFingerprint(backupReceipt))fail();
   const view=await bounded(()=>verify.call(options.archive,structuredClone(preparation),controller.signal,{requestId:request.context.requestId,correlationId:command.correlationId}));await fence();
   const expected={archiveId:backupReceipt.archiveId,archiveBytes:backupReceipt.archiveBytes,archiveSha256:backupReceipt.archiveSha256,manifestSha256:backupReceipt.manifestSha256,format:backupReceipt.format,integrity:"verified",redacted:true},keys=Object.keys(expected);
   if(!view||typeof view!=="object"||Reflect.ownKeys(view).length!==keys.length)fail();
   for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(view,key);if(!descriptor||!("value" in descriptor)||descriptor.value!==expected[key as keyof typeof expected])fail();}
   await bounded(()=>protectedSource.call(options.protection,structuredClone(preparation),structuredClone(command),request.confirmationId));await fence();
  }
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
