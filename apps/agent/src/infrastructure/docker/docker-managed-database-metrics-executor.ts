import {MANAGED_DATABASE_METRICS_CAPABILITY,managedDatabaseMetricsObservationSchema,type CapabilityRegistry,type Clock,type ImageReferencePolicyV1,type ManagedDatabaseEngineV1} from "@deploylite/contracts";
import {awaitAbortable,managedDatabaseMetricsSourceBinding,managedDatabaseMetricsObservationMatches,planManagedDatabaseProfile} from "@deploylite/domain";
import type {createManagedDatabaseMetricsObserver} from "./docker-managed-database-metrics.js";
function fail():never {throw new Error("Database metrics execution is unavailable.");}
/** Immutable source-cache admission precedes live readonly observation; no credentials, initialization or lifecycle effects. */
export function createManagedDatabaseMetricsExecutor(supplied:Readonly<{
 agentId:string;profiles:Readonly<Partial<Record<ManagedDatabaseEngineV1,unknown>>>;imagePolicy:ImageReferencePolicyV1;
 capabilities:CapabilityRegistry;clock:Clock;observer:Pick<ReturnType<typeof createManagedDatabaseMetricsObserver>,"observe">;limits:Readonly<{deadlineMs:number}>;
}>){
 const options={...supplied,profiles:structuredClone(supplied.profiles),imagePolicy:structuredClone(supplied.imagePolicy),limits:{...supplied.limits}};
 if(!/^[A-Za-z0-9_-]{1,200}$/.test(options.agentId)||!Number.isSafeInteger(options.limits.deadlineMs)||options.limits.deadlineMs<1||options.limits.deadlineMs>60000)fail();
 return {async observe(raw:unknown,authority:Readonly<{assertValid():Promise<void>}>,external:AbortSignal){
  const controller=new AbortController(),cancel=()=>controller.abort();external.addEventListener("abort",cancel,{once:true});if(external.aborted)cancel();
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
   const query=managedDatabaseMetricsSourceBinding(structuredClone(raw)),start=options.clock.now(),original=query.originalReceipt,observe=options.observer.observe;
   if(!Number.isSafeInteger(start)||start<0||start<original.observedAt)fail();
   const deadline=start+Math.min(options.limits.deadlineMs,query.timeoutMs);if(!Number.isSafeInteger(deadline))fail();
   function current(){const now=options.clock.now();if(controller.signal.aborted||external.aborted||!Number.isSafeInteger(now)||now<start||now>=deadline||options.observer.observe!==observe||query.agentId!==options.agentId||!options.capabilities.has(MANAGED_DATABASE_METRICS_CAPABILITY))fail();return now;}
   async function call<T>(work:()=>Promise<T>){current();const value=await awaitAbortable(work,controller.signal);current();return value;}
   current();timer=setTimeout(cancel,deadline-start);await call(()=>authority.assertValid());
   const request={schemaVersion:1 as const,projectId:query.projectId,databaseId:query.databaseId,engine:query.engine},profile=options.profiles[query.engine];
   const plan=planManagedDatabaseProfile(request,profile,options.imagePolicy);if(plan.profileId!==query.profileId||plan.planDigest!==query.planDigest)fail();
   const resources={projectId:query.projectId,databaseId:query.databaseId,commandId:original.commandId,planDigest:query.planDigest,
    volume:{name:original.volumeName,createdAt:original.volumeCreatedAt!},network:{name:original.networkName,id:original.networkId!}};
   const input={request,profile:structuredClone(profile),commandId:original.commandId,imageId:original.imageId!,containerId:original.containerId!,environmentFingerprint:query.environmentFingerprint};
   const boundedAuthority={assertValid:async()=>{await call(()=>authority.assertValid());}};
   const view=await call(()=>observe.call(options.observer,input,resources,boundedAuthority,controller.signal));
   const observation=managedDatabaseMetricsObservationSchema.parse({action:query.action,agentId:query.agentId,originalCommandId:original.commandId,
    profileId:query.profileId,planDigest:query.planDigest,environmentFingerprint:query.environmentFingerprint,context:query.context,
    volumeName:original.volumeName,networkName:original.networkName,networkId:original.networkId,volumeCreatedAt:original.volumeCreatedAt,storage:"verified",...view});
   await boundedAuthority.assertValid();if(!managedDatabaseMetricsObservationMatches(query,observation,start,current()))fail();
   return Object.freeze(observation);
  }catch{return fail();}finally{if(timer!==undefined)clearTimeout(timer);external.removeEventListener("abort",cancel);}
 }};
}
