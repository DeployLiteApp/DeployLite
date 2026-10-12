import {awaitAbortable} from "@deploylite/domain";
import type {Clock} from "@deploylite/contracts";
import type {DockerCliRunner} from "./docker-cli-image-transport.js";
export const MANAGED_DATABASE_STATS_FORMAT='{"id":{{json .ID}},"cpu":{{json .CPUPerc}},"memory":{{json .MemUsage}},"memoryPercent":{{json .MemPerc}},"network":{{json .NetIO}},"block":{{json .BlockIO}},"pids":{{json .PIDs}}}';
function fail():never{throw new Error("Database metrics are unavailable.");}
const decimal="[0-9]{1,16}(?:\\.[0-9]{1,6})?";
const percent=new RegExp("^"+decimal+"%$"),quantity="(?:"+decimal+")(?:B|kB|MB|GB|TB|PB|EB|KiB|MiB|GiB|TiB|PiB|EiB)";
const pair=new RegExp("^"+quantity+" / "+quantity+"$");
/** Docker CLI quantities are rounded display values; do not relabel them as precise byte counters. */
export function parseManagedDatabaseStats(stdout:string,id:string):Readonly<{cpuPercent:number;memoryUsage:string;memoryPercent:number;networkIO:string;blockIO:string;pids:number}>{
 try {
  if(!/^[a-f0-9]{64}$/.test(id)||Buffer.byteLength(stdout)>1048576)fail();
  const row:unknown=JSON.parse(stdout);
  if(!row||typeof row!=="object"||Array.isArray(row))fail();
  const value=row as Record<string,unknown>,keys=["id","cpu","memory","memoryPercent","network","block","pids"];
  if(Object.keys(value).length!==keys.length||keys.some(key=>typeof value[key]!=="string")||value.id!==id)fail();
  const string=value as Record<string,string>;
  if(!percent.test(string.cpu!)||!percent.test(string.memoryPercent!)||!pair.test(string.memory!)||!pair.test(string.network!)||!pair.test(string.block!)||!/^[1-9][0-9]{0,15}$/.test(string.pids!))fail();
  const cpuPercent=Number(string.cpu!.slice(0,-1)),memoryPercent=Number(string.memoryPercent!.slice(0,-1)),pids=Number(string.pids);
  if(!Number.isFinite(cpuPercent)||!Number.isFinite(memoryPercent)||!Number.isSafeInteger(pids))fail();
  return Object.freeze({cpuPercent,memoryUsage:string.memory!,memoryPercent,networkIO:string.network!,blockIO:string.block!,pids});
 }catch{return fail();}
}
/** Low-level injected read; its caller must corroborate original workload/resources/current authority. */
export function createManagedDatabaseStatsReader(supplied:Readonly<{runner:DockerCliRunner;clock:Clock;limits:Readonly<{deadlineMs:number;maxOutputBytes:number}>}>){
 const options={...supplied,limits:{...supplied.limits}};
 if(!Number.isSafeInteger(options.limits.deadlineMs)||options.limits.deadlineMs<1||options.limits.deadlineMs>60000||!Number.isSafeInteger(options.limits.maxOutputBytes)||options.limits.maxOutputBytes<1||options.limits.maxOutputBytes>1048576)fail();
 return {async read(id:string,external:AbortSignal):Promise<ReturnType<typeof parseManagedDatabaseStats>>{
  const controller=new AbortController(),cancel=()=>controller.abort();external.addEventListener("abort",cancel,{once:true});if(external.aborted)cancel();
  const timer=setTimeout(cancel,options.limits.deadlineMs);
  try {
   const start=options.clock.now();
   function current(){const now=options.clock.now();if(controller.signal.aborted||external.aborted||!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(now)||now<start||now-start>=options.limits.deadlineMs)fail();}
   current();if(!/^[a-f0-9]{64}$/.test(id))fail();
   const result=await awaitAbortable(()=>options.runner.run(Object.freeze(["docker","stats","--no-stream","--no-trunc","--format",MANAGED_DATABASE_STATS_FORMAT,id]),controller.signal),controller.signal);current();
   if(result.exitCode!==0||result.signal!==null||Buffer.byteLength(result.stdout)+Buffer.byteLength(result.stderr)>options.limits.maxOutputBytes)fail();
   return parseManagedDatabaseStats(result.stdout,id);
  }catch{return fail();}finally{clearTimeout(timer);external.removeEventListener("abort",cancel);}
 }};
}
