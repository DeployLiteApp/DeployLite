import type {Clock} from "@deploylite/contracts";
import {redactLogMessage} from "@deploylite/config";
import {awaitAbortable} from "@deploylite/domain";
import type {DockerCliRunner} from "./docker-cli-image-transport.js";
export type ManagedDatabaseLogReadOptions=Readonly<{tail:number;since?:string}>;
function fail():never{throw new Error("Database logs are unavailable.");}
/** Low-level bounded batch. Caller must corroborate original workload/resources/current access. */
export function createManagedDatabaseLogReader(supplied:Readonly<{runner:DockerCliRunner;clock:Clock;limits:Readonly<{deadlineMs:number;maxOutputBytes:number}>}>){
 const options={...supplied,limits:{...supplied.limits}};
 if(!Number.isSafeInteger(options.limits.deadlineMs)||options.limits.deadlineMs<1||options.limits.deadlineMs>60000||!Number.isSafeInteger(options.limits.maxOutputBytes)||options.limits.maxOutputBytes<1||options.limits.maxOutputBytes>1048576)fail();
 return {async read(id:string,raw:ManagedDatabaseLogReadOptions,external:AbortSignal):Promise<Readonly<{stdout:string;stderr:string;redacted:true}>>{
  const controller=new AbortController(),cancel=()=>controller.abort();external.addEventListener("abort",cancel,{once:true});if(external.aborted)cancel();const timer=setTimeout(cancel,options.limits.deadlineMs);
  try{
   const selection=structuredClone(raw),start=options.clock.now(),run=options.runner.run;
   function current(){const now=options.clock.now();if(controller.signal.aborted||external.aborted||options.runner.run!==run||!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(now)||now<start||now-start>=options.limits.deadlineMs)fail();}
   current();if(!/^[a-f0-9]{64}$/.test(id)||!selection||Object.keys(selection).some(key=>key!=="tail"&&key!=="since")||!Number.isSafeInteger(selection.tail)||selection.tail<1||selection.tail>5000)fail();
   if(selection.since!==undefined){if(typeof selection.since!=="string")fail();const time=Date.parse(selection.since);if(!Number.isSafeInteger(time)||time<0||time>start||new Date(time).toISOString()!==selection.since)fail();}
   const argv=Object.freeze(["docker","logs","--timestamps","--tail",String(selection.tail),...(selection.since===undefined?[]:["--since",selection.since]),id]);
   const result=await awaitAbortable(()=>run.call(options.runner,argv,controller.signal),controller.signal);current();
   if(result.exitCode!==0||result.signal!==null||Buffer.byteLength(result.stdout)+Buffer.byteLength(result.stderr)>options.limits.maxOutputBytes)fail();
   const projection=Object.freeze({stdout:redactLogMessage(result.stdout),stderr:redactLogMessage(result.stderr),redacted:true as const});current();return projection;
  }catch{return fail();}finally{clearTimeout(timer);external.removeEventListener("abort",cancel);}
 }};
}
