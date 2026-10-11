import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import { managedDatabaseProfileRequestSchema, type ApprovedManagedDatabaseProfileV1, type ManagedDatabaseEngineV1, type ImageReferencePolicyV1 } from "@deploylite/contracts";
import type { EnvSecretCipher } from "@deploylite/config";
import { PolicyEvaluator, awaitAbortable, ensureManagedDatabaseCredentials, planManagedDatabaseProfile,
  type ManagedDatabaseCredentialCreationRepository, type ProjectRepository, type ControlGrantRepository, type AuditRepository } from "@deploylite/domain";
export type ManagedDatabaseCredentialConfiguration = Readonly<{profiles:ReadonlyMap<ManagedDatabaseEngineV1,ApprovedManagedDatabaseProfileV1>;deadlineMs:number;projectIds?:ReadonlySet<string>;store?:ManagedDatabaseCredentialCreationRepository}>;
type Options=Readonly<{prefix:string;configuration?:ManagedDatabaseCredentialConfiguration;secrets?:ManagedDatabaseCredentialCreationRepository;cipher?:EnvSecretCipher;
  imagePolicy:ImageReferencePolicyV1;projects:Pick<ProjectRepository,"findById">;grants:Pick<ControlGrantRepository,"listForActor">;audit:Pick<AuditRepository,"append">;
  requireAuth:preHandlerAsyncHookHandler;requireRole:preHandlerAsyncHookHandler;ok(request:unknown,data:unknown):unknown;error(request:unknown,code:string,message:string):unknown}>;
const bodySchema=managedDatabaseProfileRequestSchema.pick({schemaVersion:true,engine:true}).strict();
const paramsSchema=managedDatabaseProfileRequestSchema.pick({projectId:true,databaseId:true}).strict();
export function registerManagedDatabaseCredentialRoute(app:FastifyInstance,options:Options):void {
  app.post(`${options.prefix}/projects/:projectId/databases/:databaseId/credentials`,{bodyLimit:16_384,preHandler:[options.requireAuth,options.requireRole]},async(request,reply)=>{
    const params=paramsSchema.safeParse(request.params),body=bodySchema.safeParse(request.body);
    const fail=(status:number,code:string)=>reply.code(status).send(options.error(request,code,"Database credentials are unavailable or outside policy."));
    if (!params.success || !body.success) return fail(400,"VALIDATION_ERROR");
    const user=request.auth?.user,context=request.correlationContext;if(!user || !context)return fail(401,"UNAUTHENTICATED");
    const input={...params.data,...body.data},configuration=options.configuration,deadlineMs=configuration?.deadlineMs;
    const validDeadline=Number.isSafeInteger(deadlineMs) && deadlineMs!>0 && deadlineMs!<=60_000;
    const controller=new AbortController(),cancel=()=>controller.abort(),timer=setTimeout(cancel,validDeadline?deadlineMs:60_000);
    request.raw.once("aborted",cancel);if(request.raw.aborted)cancel();
    const bounded=<T>(action:()=>Promise<T>)=>awaitAbortable(action,controller.signal);
    const authorized=async()=>new PolicyEvaluator().evaluate({actorId:user.id,role:user.role,action:"project.update",scope:{kind:"project",projectId:input.projectId},
      correlationId:context.correlationId,grants:await bounded(()=>options.grants.listForActor(user.id))}).allowed;
    try {
      if(!await authorized())return fail(403,"FORBIDDEN");
      const project=await bounded(()=>options.projects.findById(input.projectId));if(!project)return fail(404,"NOT_FOUND");
      const profile=configuration?.profiles.get(input.engine),secrets=configuration?.store??options.secrets,cipher=options.cipher,configuredStore=configuration?.store,projectIds=configuration?.projectIds;
      if(project.id!==input.projectId || !configuration || !validDeadline || (projectIds!==undefined && !projectIds.has(input.projectId)) || !profile || !secrets || !cipher)return fail(503,"DATABASE_CREDENTIALS_UNAVAILABLE");
      const plan=planManagedDatabaseProfile(input,profile,options.imagePolicy);
      const current=()=>{
        try{return !controller.signal.aborted && options.configuration===configuration && configuration.deadlineMs===deadlineMs
          && configuration.projectIds===projectIds && (projectIds===undefined || projectIds.has(input.projectId)) && configuration.store===configuredStore && configuration.profiles.get(input.engine)===profile && (configuration.store??options.secrets)===secrets && options.cipher===cipher
          && planManagedDatabaseProfile(input,profile,options.imagePolicy).planDigest===plan.planDigest;}catch{return false;}
      };
      const credentials=await bounded(()=>ensureManagedDatabaseCredentials(input,profile,{imagePolicy:options.imagePolicy,cipher,
        authorize:async()=>current() && await authorized() && current(),
        secrets:{find:(projectId,key)=>bounded(()=>secrets.find(projectId,key)),createIfAbsent:async(record)=>{
          if(!current())throw new Error("Unavailable");
          await bounded(()=>options.audit.append({actorUserId:user.id,action:"database.credentials.write_authorized",targetType:"project",targetId:input.projectId,
            ...context,metadata:{projectId:input.projectId,databaseId:input.databaseId,engine:input.engine,planDigest:plan.planDigest,redacted:true}}));
          if(!current() || !await authorized() || !current())throw new Error("Unavailable");
          return bounded(()=>secrets.createIfAbsent(record));
        }}}));
      if(!current() || !await authorized() || !current())return fail(503,"DATABASE_CREDENTIALS_UNAVAILABLE");
      await bounded(()=>options.audit.append({actorUserId:user.id,action:"database.credentials.configured",targetType:"project",targetId:input.projectId,
        ...context,metadata:{projectId:input.projectId,databaseId:input.databaseId,engine:input.engine,planDigest:plan.planDigest,credentialsConfigured:true,redacted:true}}));
      if(!current() || !await authorized() || !current())return fail(503,"DATABASE_CREDENTIALS_UNAVAILABLE");
      return options.ok(request,{credentials});
    }catch{return fail(503,"DATABASE_CREDENTIALS_UNAVAILABLE");}
    finally{clearTimeout(timer);request.raw.off("aborted",cancel);}
  });
}
