import {protocolPayloadFingerprint,managedDatabaseProfileRequestSchema,managedDatabaseHealthObservationSchema,type Clock} from "@deploylite/contracts";
import {awaitAbortable} from "@deploylite/domain";
import type {createManagedDatabaseHealthObserver} from "./docker-managed-database-health.js";
import {parseManagedDatabaseStats,type createManagedDatabaseStatsReader} from "./docker-managed-database-stats.js";
type Health=ReturnType<typeof createManagedDatabaseHealthObserver>;
type Args=Parameters<Health["observe"]>;
function fail():never{throw new Error("Database metrics are unavailable.");}
const healthSchema=managedDatabaseHealthObservationSchema.innerType().pick({schemaVersion:true,projectId:true,databaseId:true,engine:true,containerId:true,imageId:true,uid:true,state:true,health:true,observedAt:true,redacted:true}).strict();
/** Corroborate current original workload before and after a bounded public sample. */
export function createManagedDatabaseMetricsObserver(supplied:Readonly<{health:Health;stats:ReturnType<typeof createManagedDatabaseStatsReader>;clock:Clock;limits:Readonly<{deadlineMs:number}>}>){
 const options={...supplied,limits:{...supplied.limits}},deadline=options.limits.deadlineMs;
 if(!Number.isSafeInteger(deadline)||deadline<1||deadline>60000)fail();
 return {async observe(raw:Args[0],resources:Args[1],authority:Args[2],external:AbortSignal){
  const controller=new AbortController(),cancel=()=>controller.abort();external.addEventListener("abort",cancel,{once:true});if(external.aborted)cancel();const timer=setTimeout(cancel,deadline);
  try{
   const input=structuredClone(raw),original=structuredClone(resources),request=managedDatabaseProfileRequestSchema.parse(input.request),start=options.clock.now(),observe=options.health.observe,read=options.stats.read;
   function current(){const now=options.clock.now();if(controller.signal.aborted||external.aborted||!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(now)||now<start||now-start>=deadline||options.health.observe!==observe||options.stats.read!==read)fail();return now;}
   async function valid(){current();await awaitAbortable(()=>authority.assertValid(),controller.signal);current();}
   async function call<T>(work:()=>Promise<T>){await valid();const value=await awaitAbortable(work,controller.signal);await valid();return value;}
   function view(value:unknown){const parsed=healthSchema.parse(value),now=current();if(parsed.projectId!==request.projectId||parsed.databaseId!==request.databaseId||parsed.engine!==request.engine||parsed.containerId!==input.containerId||parsed.imageId!==input.imageId||parsed.observedAt<start||parsed.observedAt>now|| (parsed.state==="running"?(parsed.uid===null||parsed.uid<1||parsed.health==="not-running"):(parsed.uid!==null||parsed.health!=="not-running")))fail();return parsed;}
   const before=view(await call(()=>observe.call(options.health,input,original,authority,controller.signal)));
   let metrics:ReturnType<typeof parseManagedDatabaseStats>|null=null,metricsObservedAt:number|null=null;
   if(before.state==="running"){
    const value=await call(()=>read.call(options.stats,input.containerId,controller.signal)),keys=["cpuPercent","memoryUsage","memoryPercent","networkIO","blockIO","pids"];
    if(!value||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key))||typeof value.cpuPercent!=="number"||typeof value.memoryPercent!=="number"||typeof value.pids!=="number")fail();
    metrics=parseManagedDatabaseStats(JSON.stringify({id:input.containerId,cpu:String(value.cpuPercent)+"%",memory:value.memoryUsage,memoryPercent:String(value.memoryPercent)+"%",network:value.networkIO,block:value.blockIO,pids:String(value.pids)}),input.containerId);metricsObservedAt=current();
   }
   const after=view(await call(()=>observe.call(options.health,input,original,authority,controller.signal)));
   const {observedAt:_beforeTime,...first}=before,{observedAt:_afterTime,...last}=after;
   if(protocolPayloadFingerprint(first)!==protocolPayloadFingerprint(last)||after.observedAt<before.observedAt||metricsObservedAt!==null&&after.observedAt<metricsObservedAt)fail();
   return Object.freeze({...after,observedAt:current(),metrics,metricsObservedAt});
  }catch{return fail();}finally{clearTimeout(timer);external.removeEventListener("abort",cancel);}
 }};
}
