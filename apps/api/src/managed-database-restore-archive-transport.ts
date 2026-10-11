import {signAgentTransport,verifyAgentTransport} from "@deploylite/config";
import {agentCapabilityHandshakeSchema,MANAGED_DATABASE_RESTORE_ARCHIVE_CAPABILITY,MANAGED_DATABASE_RESTORE_ARCHIVE_PATH,managedDatabaseRestoreArchiveAgentQuerySchema,managedDatabaseRestoreArchiveObservationSchema,TransportError,type ManagedDatabaseRestoreArchiveAgentQueryV1,type ManagedDatabaseRestoreArchiveObservationV1} from "@deploylite/contracts";
import {awaitAbortable,managedDatabaseRestoreArchiveSourceBinding,managedDatabaseRestoreArchiveObservationMatches} from "@deploylite/domain";
import type {AgentTransportOptions} from "./agent-transport.js";
import {AuthenticatedManagedDatabaseRuntimeTransport} from "./managed-database-runtime-transport.js";
type ManagedDatabaseRestoreArchivePreparationV1=Omit<ManagedDatabaseRestoreArchiveAgentQueryV1,"action"|"agentId"|"requiredCapabilities"|"context"|"timeoutMs">;
export type ManagedDatabaseRestoreArchiveTransport=Readonly<{
 available():boolean;
 observe(input:ManagedDatabaseRestoreArchivePreparationV1,context:Readonly<{requestId:string;correlationId:string;signal?:AbortSignal}>):Promise<ManagedDatabaseRestoreArchiveObservationV1>;
}>;
function fail():never{throw new TransportError("Database restore archive transport is unavailable.");}
/** Signed metadata only; no archive bytes or restore execution authority. */
export class AuthenticatedManagedDatabaseRestoreArchiveTransport implements ManagedDatabaseRestoreArchiveTransport {
 readonly #options:AgentTransportOptions;readonly #fetch:typeof fetch;readonly #admission:AuthenticatedManagedDatabaseRuntimeTransport;
 constructor(options:AgentTransportOptions){this.#options={...options};this.#fetch=options.fetch??globalThis.fetch;this.#admission=new AuthenticatedManagedDatabaseRuntimeTransport(this.#options);}
 available(){return this.#admission.available();}
 async verify(input:unknown,signal:AbortSignal,context?:Readonly<{requestId:string;correlationId:string}>){
  if(!context)fail();
  const observation=await this.observe(input as ManagedDatabaseRestoreArchivePreparationV1,{...context,signal});
  const {archiveId,archiveBytes,archiveSha256,manifestSha256,format,integrity,redacted}=observation;
  return Object.freeze({archiveId,archiveBytes,archiveSha256,manifestSha256,format,integrity,redacted});
 }
 async observe(input:ManagedDatabaseRestoreArchivePreparationV1,context:Readonly<{requestId:string;correlationId:string;signal?:AbortSignal}>){
  const controller=new AbortController(),cancel=()=>controller.abort();
  context.signal?.addEventListener("abort",cancel,{once:true});if(context.signal?.aborted)cancel();
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
   if(!this.available())fail();
   const query=managedDatabaseRestoreArchiveSourceBinding(managedDatabaseRestoreArchiveAgentQuerySchema.parse({...structuredClone(input),action:"database.runtime.restore.archive",agentId:this.#options.agentId,requiredCapabilities:[MANAGED_DATABASE_RESTORE_ARCHIVE_CAPABILITY],context:{requestId:context.requestId,correlationId:context.correlationId},timeoutMs:this.#options.timeoutMs??30000}));
   const clock=this.#options.now??Date.now,start=clock(),deadline=start+query.timeoutMs;let lastNow=start;
   const current=()=>{const now=clock();if(controller.signal.aborted||!Number.isSafeInteger(start)||start<query.backupReceipt.observedAt||!Number.isSafeInteger(deadline)||!Number.isSafeInteger(now)||now<lastNow||now>=deadline)fail();lastNow=now;return now;};
   current();timer=setTimeout(cancel,query.timeoutMs);
   const bounded=<T>(work:()=>Promise<T>)=>awaitAbortable(work,controller.signal);
   const handshakeSignature=signAgentTransport("GET /capabilities",this.#options.trustKey);
   const handshakeResponse=await bounded(()=>this.#fetch(this.#options.endpoint.replace(/\/$/,"")+"/capabilities",{headers:{"x-deploylite-signature":handshakeSignature},redirect:"error",signal:controller.signal}));current();
   if(!handshakeResponse.ok||handshakeResponse.headers.get("x-deploylite-request-signature")!==handshakeSignature)fail();
   const handshake=agentCapabilityHandshakeSchema.parse(await bounded(()=>handshakeResponse.json()));current();
   if(handshake.agentId!==query.agentId||!handshake.protocolVersions.includes(1)||!handshake.capabilities.includes(MANAGED_DATABASE_RESTORE_ARCHIVE_CAPABILITY))fail();
   const payload=JSON.stringify(query),response=await bounded(()=>this.#fetch(this.#options.endpoint.replace(/\/$/,"")+MANAGED_DATABASE_RESTORE_ARCHIVE_PATH,{method:"POST",headers:{"content-type":"application/json","x-deploylite-signature":signAgentTransport(`POST ${MANAGED_DATABASE_RESTORE_ARCHIVE_PATH}\n${payload}`,this.#options.trustKey)},body:payload,redirect:"error",signal:controller.signal}));current();
   if(!response.ok)fail();
   const text=await bounded(()=>response.text());current();
   if(Buffer.byteLength(text,"utf8")>1048576||!verifyAgentTransport(`POST ${MANAGED_DATABASE_RESTORE_ARCHIVE_PATH}\n${payload}\n${text}`,response.headers.get("x-deploylite-response-signature")??undefined,this.#options.trustKey))fail();
   const observation=managedDatabaseRestoreArchiveObservationSchema.parse(JSON.parse(text));
   if(!managedDatabaseRestoreArchiveObservationMatches(query,observation,start,current()))fail();
   return observation;
  }catch{return fail();}finally{if(timer!==undefined)clearTimeout(timer);context.signal?.removeEventListener("abort",cancel);}
 }
}
