import {signAgentTransport,verifyAgentTransport} from "@deploylite/config";
import {agentCapabilityHandshakeSchema,MANAGED_DATABASE_RESTORE_CAPABILITY,MANAGED_DATABASE_RESTORE_PATH,MANAGED_DATABASE_RESTORE_RECEIPT_PATH,
 managedDatabaseRestorePreparationSchema,managedDatabaseRestoreAgentCommandSchema,managedDatabaseRestoreReceiptQuerySchema,managedDatabaseRestoreReceiptSchema,managedDatabaseRestoreCachedReceiptSchema,
 projectControlAuthoritySchema,protocolPayloadFingerprint,TransportError,type ProjectControlAuthorityV1,type ManagedDatabaseRestoreReceiptV1} from "@deploylite/contracts";
import {awaitAbortable,managedDatabaseRestoreExecutionDigest,managedDatabaseRestoreReceiptMatches,type ControlCommand} from "@deploylite/domain";
import {markAgentPreDispatchRejection,type AgentTransportOptions} from "./agent-transport.js";
import {AuthenticatedManagedDatabaseRuntimeTransport} from "./managed-database-runtime-transport.js";
export type PreparedManagedDatabaseRestore=Readonly<{command:ControlCommand;input:ReturnType<typeof managedDatabaseRestorePreparationSchema.parse>;agentId:string;confirmationId:string}>;
type Context=Readonly<{requestId:string;correlationId:string;signal?:AbortSignal}>;
export type ManagedDatabaseRestoreAgentTransport=Readonly<{
 available():boolean;
 dispatch(prepared:PreparedManagedDatabaseRestore,authority:ProjectControlAuthorityV1,context:Context):Promise<ManagedDatabaseRestoreReceiptV1>;
 readReceipt(prepared:PreparedManagedDatabaseRestore,authority:ProjectControlAuthorityV1,context:Context):Promise<ManagedDatabaseRestoreReceiptV1|null>;
}>;
function fail():never{throw new TransportError("Database restore transport is unavailable.");}
/** Existing signed channel; original consumed confirmation is validated by the receiver, never fabricated here. */
export class AuthenticatedManagedDatabaseRestoreTransport implements ManagedDatabaseRestoreAgentTransport {
 readonly #options:AgentTransportOptions;readonly #fetch:typeof fetch;readonly #admission:AuthenticatedManagedDatabaseRuntimeTransport;
 constructor(options:AgentTransportOptions){this.#options={...options};this.#fetch=options.fetch??globalThis.fetch;this.#admission=new AuthenticatedManagedDatabaseRuntimeTransport(this.#options);}
 available(){return this.#admission.available();}
 private query(prepared:PreparedManagedDatabaseRestore,rawAuthority:ProjectControlAuthorityV1,context:Context){
  const input=managedDatabaseRestorePreparationSchema.parse(structuredClone(prepared.input)),authority=projectControlAuthoritySchema.parse(structuredClone(rawAuthority)),command=structuredClone(prepared.command);
  if((command.status!=="dispatching"&&command.status!=="completed")||protocolPayloadFingerprint(projectControlAuthoritySchema.parse(command.projectExecutionAuthority))!==protocolPayloadFingerprint(authority))fail();
  if(!this.available()||prepared.agentId!==this.#options.agentId||command.action!=="project.update"||command.scope.kind!=="project"||command.scope.projectId!==input.projectId
   ||command.inputDigest!==managedDatabaseRestoreExecutionDigest(input)||command.correlationId!==context.correlationId||!(command.expiresAt instanceof Date)||command.expiresAt.getTime()!==authority.projectLease.expiresAt)fail();
  return managedDatabaseRestoreReceiptQuerySchema.parse({...input,action:"database.runtime.restore",operation:"database.runtime.restore",confirmationId:prepared.confirmationId,agentId:prepared.agentId,commandId:command.id,idempotencyKey:command.idempotencyKey,inputDigest:command.inputDigest,requiredCapabilities:[MANAGED_DATABASE_RESTORE_CAPABILITY],authority,lease:authority.projectLease,context:{requestId:context.requestId,correlationId:context.correlationId},timeoutMs:this.#options.timeoutMs??30000});
 }
 private async operate<T>(parent:AbortSignal|undefined,work:(signal:AbortSignal,current:()=>number)=>Promise<T>):Promise<T>{
  const controller=new AbortController(),cancel=()=>controller.abort(),clock=this.#options.now??Date.now,start=clock(),deadline=start+(this.#options.timeoutMs??30000);let lastNow=start;
  const current=()=>{const value=clock();if(controller.signal.aborted||!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(deadline)||!Number.isSafeInteger(value)||value<lastNow||value>=deadline)fail();lastNow=value;return value;};
  parent?.addEventListener("abort",cancel,{once:true});if(parent?.aborted)cancel();const timer=setTimeout(cancel,this.#options.timeoutMs??30000);
  try{current();return await awaitAbortable(()=>work(controller.signal,current),controller.signal);}finally{clearTimeout(timer);parent?.removeEventListener("abort",cancel);controller.abort();}
 }
 private async handshake(signal:AbortSignal,current:()=>number,execution:boolean){
  current();const signature=signAgentTransport("GET /capabilities",this.#options.trustKey);
  const response=await awaitAbortable(()=>this.#fetch(this.#options.endpoint.replace(/\/$/,"")+"/capabilities",{headers:{"x-deploylite-signature":signature},redirect:"error",signal}),signal);current();
  if(!response.ok||response.headers.get("x-deploylite-request-signature")!==signature)fail();
  const handshake=agentCapabilityHandshakeSchema.parse(await awaitAbortable(()=>response.json(),signal));current();
  if(handshake.agentId!==this.#options.agentId||!handshake.protocolVersions.includes(1)||(execution&&!handshake.capabilities.includes(MANAGED_DATABASE_RESTORE_CAPABILITY)))fail();
 }
 private async post(path:string,body:unknown,signal:AbortSignal,current:()=>number){
  current();const payload=JSON.stringify(body),response=await awaitAbortable(()=>this.#fetch(this.#options.endpoint.replace(/\/$/,"")+path,{method:"POST",headers:{"content-type":"application/json","x-deploylite-signature":signAgentTransport(`POST ${path}\n${payload}`,this.#options.trustKey)},body:payload,redirect:"error",signal}),signal);current();
  if(!response.ok)fail();const text=await awaitAbortable(()=>response.text(),signal);current();
  if(Buffer.byteLength(text,"utf8")>1048576||!verifyAgentTransport(`POST ${path}\n${payload}\n${text}`,response.headers.get("x-deploylite-response-signature")??undefined,this.#options.trustKey))fail();
  return JSON.parse(text);
 }
 async dispatch(prepared:PreparedManagedDatabaseRestore,authority:ProjectControlAuthorityV1,context:Context){
  let posted=false;
  try{
   if(prepared.command.status!=="dispatching")fail();
   const query=this.query(prepared,authority,context),body=managedDatabaseRestoreAgentCommandSchema.parse({...query,cancellationRequested:false});
   return await this.operate(context.signal,async(signal,current)=>{
    if(current()>=query.lease.expiresAt)fail();await this.handshake(signal,current,true);if(current()>=query.lease.expiresAt)fail();posted=true;
    const receipt=managedDatabaseRestoreReceiptSchema.parse(await this.post(MANAGED_DATABASE_RESTORE_PATH,body,signal,current));
    if(receipt.observedAt>current()||receipt.observedAt>=query.lease.expiresAt||!managedDatabaseRestoreReceiptMatches(query,receipt))fail();return receipt;
   });
  }catch{const error=new TransportError("Database restore transport is unavailable.");throw posted?error:markAgentPreDispatchRejection(error);}
 }
 async readReceipt(prepared:PreparedManagedDatabaseRestore,authority:ProjectControlAuthorityV1,context:Context){
  try{
   const query=this.query(prepared,authority,context);
   return await this.operate(context.signal,async(signal,current)=>{
    await this.handshake(signal,current,false);const cached=managedDatabaseRestoreCachedReceiptSchema.parse(await this.post(MANAGED_DATABASE_RESTORE_RECEIPT_PATH,query,signal,current));
    if(cached.agentId!==query.agentId||cached.commandId!==query.commandId||cached.confirmationId!==query.confirmationId||cached.correlationId!==query.context.correlationId
     ||(cached.receipt&&(cached.receipt.observedAt>current()||cached.receipt.observedAt>=query.lease.expiresAt||!managedDatabaseRestoreReceiptMatches(query,cached.receipt))))fail();return cached.receipt;
   });
  }catch{return fail();}
 }
}
