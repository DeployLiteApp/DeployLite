import {protocolPayloadFingerprint,type Clock,type ImageReferencePolicyV1} from "@deploylite/contracts";
import {awaitAbortable,planManagedDatabaseProfile} from "@deploylite/domain";
import type {createManagedDatabaseDockerInspector} from "./docker-managed-database-inspection.js";
import type {createManagedDatabaseReadinessVerifier} from "./docker-managed-database-readiness.js";
type Verifier=ReturnType<typeof createManagedDatabaseReadinessVerifier>;
type Input=Parameters<Verifier["verify"]>[0];
type Resources=Parameters<Verifier["verify"]>[1];
type Authority=Parameters<Verifier["verify"]>[2];
function fail():never {throw new Error("Database health is unavailable.");}
/** Read-only current observation; immutable execution receipts never become live health. */
export function createManagedDatabaseHealthObserver(supplied:Readonly<{
 nativeInspector:Pick<ReturnType<typeof createManagedDatabaseDockerInspector>,"inspectContainer">;
 verifier:Pick<Verifier,"verifyRunning"|"verifyStopped">;imagePolicy:ImageReferencePolicyV1;clock:Clock;limits:Readonly<{deadlineMs:number}>;
}>){
 const options={...supplied,imagePolicy:structuredClone(supplied.imagePolicy),limits:{...supplied.limits}},deadline=options.limits.deadlineMs;
 if(!Number.isSafeInteger(deadline)||deadline<1||deadline>60000)fail();
 return {async observe(raw:Input,evidence:Resources,authority:Authority,external:AbortSignal){
  const controller=new AbortController(),cancel=()=>controller.abort();external.addEventListener("abort",cancel,{once:true});if(external.aborted)cancel();
  const timer=setTimeout(cancel,deadline);
  try {
   const input=structuredClone(raw),original=structuredClone(evidence),start=options.clock.now();
   const plan=planManagedDatabaseProfile(input.request,input.profile,options.imagePolicy);
   if(!/^[a-f0-9]{64}$/.test(input.containerId)||!/^sha256:[a-f0-9]{64}$/.test(input.imageId)
    ||!/^[a-f0-9]{32}$/.test(input.environmentFingerprint)||original.projectId!==plan.projectId||original.databaseId!==plan.databaseId
    ||original.commandId!==input.commandId||original.planDigest!==plan.planDigest||original.volume.name!==plan.volume.runtimeName||original.network.name!==plan.network.runtimeName)fail();
   function current(){const now=options.clock.now();if(controller.signal.aborted||external.aborted||!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(now)||now<start||now-start>=deadline)fail();return now;}
   async function call<T>(work:()=>Promise<T>){current();const value=await awaitAbortable(work,controller.signal);current();return value;}
   await call(()=>authority.assertValid());
   const before=await call(()=>options.nativeInspector.inspectContainer(input.containerId,controller.signal));
   if(before.id!==input.containerId||before.imageId!==input.imageId||typeof before.running!=="boolean"
    ||!["healthy","unhealthy","starting",null].includes(before.health))fail();
   let uid:number|null=null;
   if(before.running){const verified=await call(()=>options.verifier.verifyRunning(input,original,authority,controller.signal));
    if(verified.containerId!==input.containerId||!Number.isSafeInteger(verified.uid)||verified.uid<1||verified.uid>4294967294)fail();uid=verified.uid;
   }else {const verified=await call(()=>options.verifier.verifyStopped(input,original,authority,controller.signal));if(verified.containerId!==input.containerId)fail();}
   await call(()=>authority.assertValid());
   const after=await call(()=>options.nativeInspector.inspectContainer(input.containerId,controller.signal));
   if(protocolPayloadFingerprint(before)!==protocolPayloadFingerprint(after))fail();
   await call(()=>authority.assertValid());
   const observedAt=current();
   return Object.freeze({schemaVersion:1 as const,projectId:plan.projectId,databaseId:plan.databaseId,engine:plan.engine,
    containerId:input.containerId,imageId:input.imageId,uid,state:before.running?"running" as const:"stopped" as const,
    health:before.running?before.health??"unknown" as const:"not-running" as const,observedAt,redacted:true as const});
  }catch{return fail();}finally{clearTimeout(timer);external.removeEventListener("abort",cancel);}
 }};
}
