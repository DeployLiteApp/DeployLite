import {signAgentTransport} from "@deploylite/config";
import {agentCapabilityHandshakeSchema,MANAGED_DATABASE_DELETE_CAPABILITY,MANAGED_DATABASE_DELETE_PATH,MANAGED_DATABASE_DELETE_RECEIPT_PATH,
  managedDatabaseDeletePreparationSchema,managedDatabaseDeleteAgentCommandSchema,managedDatabaseDeleteReceiptQuerySchema,managedDatabaseDeleteReceiptSchema,managedDatabaseDeleteCachedReceiptSchema,
  projectControlAuthoritySchema,TransportError,type ProjectControlAuthorityV1,type ManagedDatabaseDeleteReceiptV1} from "@deploylite/contracts";
import {awaitAbortable,managedDatabaseDeleteExecutionDigest,managedDatabaseDeleteReceiptMatches,type ControlCommand} from "@deploylite/domain";
import {markAgentPreDispatchRejection} from "./agent-transport.js";
import {AuthenticatedManagedDatabaseRuntimeTransport} from "./managed-database-runtime-transport.js";
export type PreparedManagedDatabaseDelete=Readonly<{command:ControlCommand;input:ReturnType<typeof managedDatabaseDeletePreparationSchema.parse>;agentId:string;confirmationId:string}>;
type Context=Readonly<{requestId:string;correlationId:string;signal?:AbortSignal}>;
export type ManagedDatabaseDeleteAgentTransport=Readonly<{
  available():boolean;
  dispatch(prepared:PreparedManagedDatabaseDelete,authority:ProjectControlAuthorityV1,context:Context):Promise<ManagedDatabaseDeleteReceiptV1>;
  readReceipt(prepared:PreparedManagedDatabaseDelete,authority:ProjectControlAuthorityV1,context:Context):Promise<ManagedDatabaseDeleteReceiptV1|null>;
}>;
type Options=ConstructorParameters<typeof AuthenticatedManagedDatabaseRuntimeTransport>[0];
function fail():never{throw new TransportError("Database deletion transport is unavailable.");}
/** Existing signed project command/cache protocol. Deletion transports only the original approval selector and no environment or secret envelope. */
export class AuthenticatedManagedDatabaseDeleteTransport implements ManagedDatabaseDeleteAgentTransport {
  readonly #options:Options;readonly #fetch:typeof fetch;readonly #admission:AuthenticatedManagedDatabaseRuntimeTransport;
  constructor(options:Options){this.#options={...options};this.#fetch=options.fetch??globalThis.fetch;this.#admission=new AuthenticatedManagedDatabaseRuntimeTransport(this.#options);}
  available(){return this.#admission.available();}
  private query(prepared:PreparedManagedDatabaseDelete,rawAuthority:ProjectControlAuthorityV1,context:Context){
    const input=managedDatabaseDeletePreparationSchema.parse(structuredClone(prepared.input)),authority=projectControlAuthoritySchema.parse(structuredClone(rawAuthority)),command=prepared.command;
    if(!this.available()||prepared.agentId!==this.#options.agentId||command.action!=="project.update"||command.scope.kind!=="project"||command.scope.projectId!==input.projectId
      ||command.inputDigest!==managedDatabaseDeleteExecutionDigest(input)||command.correlationId!==context.correlationId)fail();
    return managedDatabaseDeleteReceiptQuerySchema.parse({...input,action:"database.runtime.delete",operation:"database.runtime.delete",storagePolicy:"retain-original",stopPolicy:"if-running",confirmationId:prepared.confirmationId,agentId:prepared.agentId,commandId:command.id,idempotencyKey:command.idempotencyKey,
      inputDigest:command.inputDigest,requiredCapabilities:[MANAGED_DATABASE_DELETE_CAPABILITY],authority,lease:authority.projectLease,context:{requestId:context.requestId,correlationId:context.correlationId},timeoutMs:this.#options.timeoutMs??30000});
  }
  private async handshake(signal:AbortSignal,execution:boolean){
    const signature=signAgentTransport("GET /capabilities",this.#options.trustKey);
    const response=await awaitAbortable(()=>this.#fetch(this.#options.endpoint.replace(/\/$/,"")+"/capabilities",{headers:{"x-deploylite-signature":signature},redirect:"error",signal}),signal);
    if(!response.ok||response.headers.get("x-deploylite-request-signature")!==signature)fail();
    const handshake=agentCapabilityHandshakeSchema.parse(await awaitAbortable(()=>response.json(),signal));
    if(handshake.agentId!==this.#options.agentId||!handshake.protocolVersions.includes(1)||(execution&&!handshake.capabilities.includes(MANAGED_DATABASE_DELETE_CAPABILITY)))fail();
  }
  private async post(path:string,body:unknown,cache:boolean,signal:AbortSignal){
    const payload=JSON.stringify(body),response=await awaitAbortable(()=>this.#fetch(this.#options.endpoint.replace(/\/$/,"")+path,{method:"POST",headers:{"content-type":"application/json",
      "x-deploylite-signature":signAgentTransport(cache?`POST ${path}\n${payload}`:payload,this.#options.trustKey)},body:payload,redirect:"error",signal}),signal);
    if(!response.ok)fail();return await awaitAbortable(()=>response.json(),signal);
  }
  private async operate<T>(parent:AbortSignal|undefined,work:(signal:AbortSignal)=>Promise<T>):Promise<T>{
    const controller=new AbortController(),cancel=()=>controller.abort();parent?.addEventListener("abort",cancel,{once:true});if(parent?.aborted)cancel();
    const timer=setTimeout(cancel,this.#options.timeoutMs??30000);
    try{return await awaitAbortable(()=>work(controller.signal),controller.signal);}finally{clearTimeout(timer);parent?.removeEventListener("abort",cancel);}
  }
  async dispatch(prepared:PreparedManagedDatabaseDelete,authority:ProjectControlAuthorityV1,context:Context){
    let posted=false;
    try{
      const query=this.query(prepared,authority,context),body=managedDatabaseDeleteAgentCommandSchema.parse({...query,cancellationRequested:false});
      return await this.operate(context.signal,async signal=>{await this.handshake(signal,true);posted=true;
        const receipt=managedDatabaseDeleteReceiptSchema.parse(await this.post(MANAGED_DATABASE_DELETE_PATH,body,false,signal));if(!managedDatabaseDeleteReceiptMatches(query,receipt))fail();return receipt;});
    }catch{const error=new TransportError("Database deletion transport is unavailable.");throw posted?error:markAgentPreDispatchRejection(error);}
  }
  async readReceipt(prepared:PreparedManagedDatabaseDelete,authority:ProjectControlAuthorityV1,context:Context){
    try{
      const query=this.query(prepared,authority,context);
      return await this.operate(context.signal,async signal=>{await this.handshake(signal,false);
        const cached=managedDatabaseDeleteCachedReceiptSchema.parse(await this.post(MANAGED_DATABASE_DELETE_RECEIPT_PATH,query,true,signal));
        if(cached.confirmationId!==query.confirmationId||cached.agentId!==query.agentId||cached.commandId!==query.commandId||cached.correlationId!==query.context.correlationId||(cached.receipt&&!managedDatabaseDeleteReceiptMatches(query,cached.receipt)))fail();return cached.receipt;});
    }catch{return fail();}
  }
}
