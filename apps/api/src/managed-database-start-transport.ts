import {signAgentTransport} from "@deploylite/config";
import {agentCapabilityHandshakeSchema,MANAGED_DATABASE_START_CAPABILITY,MANAGED_DATABASE_START_PATH,MANAGED_DATABASE_START_RECEIPT_PATH,
  managedDatabaseStartPreparationSchema,managedDatabaseStartAgentCommandSchema,managedDatabaseStartReceiptQuerySchema,managedDatabaseStartReceiptSchema,managedDatabaseStartCachedReceiptSchema,
  projectControlAuthoritySchema,TransportError,type ProjectControlAuthorityV1,type ManagedDatabaseStartReceiptV1} from "@deploylite/contracts";
import {awaitAbortable,managedDatabaseStartExecutionDigest,managedDatabaseStartReceiptMatches,type ControlCommand} from "@deploylite/domain";
import {markAgentPreDispatchRejection} from "./agent-transport.js";
import {AuthenticatedManagedDatabaseRuntimeTransport} from "./managed-database-runtime-transport.js";
export type PreparedManagedDatabaseStart=Readonly<{command:ControlCommand;input:ReturnType<typeof managedDatabaseStartPreparationSchema.parse>;agentId:string}>;
type Context=Readonly<{requestId:string;correlationId:string;signal?:AbortSignal}>;
export type ManagedDatabaseStartAgentTransport=Readonly<{
  available():boolean;
  dispatch(prepared:PreparedManagedDatabaseStart,authority:ProjectControlAuthorityV1,context:Context):Promise<ManagedDatabaseStartReceiptV1>;
  readReceipt(prepared:PreparedManagedDatabaseStart,authority:ProjectControlAuthorityV1,context:Context):Promise<ManagedDatabaseStartReceiptV1|null>;
}>;
type Options=ConstructorParameters<typeof AuthenticatedManagedDatabaseRuntimeTransport>[0];
function fail():never{throw new TransportError("Database start transport is unavailable.");}
/** Existing signed project command/cache protocol. Start transports no environment or secret envelope. */
export class AuthenticatedManagedDatabaseStartTransport implements ManagedDatabaseStartAgentTransport {
  readonly #options:Options;readonly #fetch:typeof fetch;readonly #admission:AuthenticatedManagedDatabaseRuntimeTransport;
  constructor(options:Options){this.#options={...options};this.#fetch=options.fetch??globalThis.fetch;this.#admission=new AuthenticatedManagedDatabaseRuntimeTransport(this.#options);}
  available(){return this.#admission.available();}
  private query(prepared:PreparedManagedDatabaseStart,rawAuthority:ProjectControlAuthorityV1,context:Context){
    const input=managedDatabaseStartPreparationSchema.parse(structuredClone(prepared.input)),authority=projectControlAuthoritySchema.parse(structuredClone(rawAuthority)),command=prepared.command;
    if(!this.available()||prepared.agentId!==this.#options.agentId||command.action!=="project.update"||command.scope.kind!=="project"||command.scope.projectId!==input.projectId
      ||command.inputDigest!==managedDatabaseStartExecutionDigest(input)||command.correlationId!==context.correlationId)fail();
    return managedDatabaseStartReceiptQuerySchema.parse({...input,action:"database.runtime.start",operation:"database.runtime.start",agentId:prepared.agentId,commandId:command.id,idempotencyKey:command.idempotencyKey,
      inputDigest:command.inputDigest,requiredCapabilities:[MANAGED_DATABASE_START_CAPABILITY],authority,lease:authority.projectLease,context:{requestId:context.requestId,correlationId:context.correlationId},timeoutMs:this.#options.timeoutMs??30000});
  }
  private async handshake(signal:AbortSignal,execution:boolean){
    const signature=signAgentTransport("GET /capabilities",this.#options.trustKey);
    const response=await awaitAbortable(()=>this.#fetch(this.#options.endpoint.replace(/\/$/,"")+"/capabilities",{headers:{"x-deploylite-signature":signature},redirect:"error",signal}),signal);
    if(!response.ok||response.headers.get("x-deploylite-request-signature")!==signature)fail();
    const handshake=agentCapabilityHandshakeSchema.parse(await awaitAbortable(()=>response.json(),signal));
    if(handshake.agentId!==this.#options.agentId||!handshake.protocolVersions.includes(1)||(execution&&!handshake.capabilities.includes(MANAGED_DATABASE_START_CAPABILITY)))fail();
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
  async dispatch(prepared:PreparedManagedDatabaseStart,authority:ProjectControlAuthorityV1,context:Context){
    let posted=false;
    try{
      const query=this.query(prepared,authority,context),body=managedDatabaseStartAgentCommandSchema.parse({...query,cancellationRequested:false});
      return await this.operate(context.signal,async signal=>{await this.handshake(signal,true);posted=true;
        const receipt=managedDatabaseStartReceiptSchema.parse(await this.post(MANAGED_DATABASE_START_PATH,body,false,signal));if(!managedDatabaseStartReceiptMatches(query,receipt))fail();return receipt;});
    }catch{const error=new TransportError("Database start transport is unavailable.");throw posted?error:markAgentPreDispatchRejection(error);}
  }
  async readReceipt(prepared:PreparedManagedDatabaseStart,authority:ProjectControlAuthorityV1,context:Context){
    try{
      const query=this.query(prepared,authority,context);
      return await this.operate(context.signal,async signal=>{await this.handshake(signal,false);
        const cached=managedDatabaseStartCachedReceiptSchema.parse(await this.post(MANAGED_DATABASE_START_RECEIPT_PATH,query,true,signal));
        if(cached.agentId!==query.agentId||cached.commandId!==query.commandId||cached.correlationId!==query.context.correlationId||(cached.receipt&&!managedDatabaseStartReceiptMatches(query,cached.receipt)))fail();return cached.receipt;});
    }catch{return fail();}
  }
}
