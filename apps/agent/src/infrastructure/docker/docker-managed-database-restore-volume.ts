import {createHash} from "node:crypto";
import {composeResourceObservationSchema,protocolPayloadFingerprint,type Clock,type ImageReferencePolicyV1} from "@deploylite/contracts";
import {awaitAbortable,createManagedDatabaseComposePreview,digestComposeResourceObservation,digestControlInput,planManagedDatabaseProfile} from "@deploylite/domain";
import type {DockerCliRunner} from "./docker-cli-image-transport.js";
import type {DockerProcessRunner} from "./docker-process-runner.js";
import type {createDockerComposeResourceInspector} from "./docker-compose-resource-inspector.js";
import type {createManagedDatabaseDockerInspector} from "./docker-managed-database-inspection.js";
import type {createManagedDatabaseReadinessVerifier} from "./docker-managed-database-readiness.js";
import type {ManagedDatabaseRestoreVolumeWriter} from "./docker-managed-database-restore-executor.js";
import {validateManagedDatabaseRestoreTar} from "./docker-managed-database-restore-tar.js";
type Input=Parameters<ManagedDatabaseRestoreVolumeWriter["restore"]>[0];
type Resources=Parameters<ManagedDatabaseRestoreVolumeWriter["restore"]>[1];
export type ManagedDatabaseRestoreVolumeOptions=Readonly<{
 owner:string;agentId:string;imagePolicy:ImageReferencePolicyV1;clock:Clock;
 runner:DockerCliRunner & Pick<DockerProcessRunner,"runBinaryFromSource">;
 nativeInspector:Pick<ReturnType<typeof createManagedDatabaseDockerInspector>,"inspectContainer"|"inspectImage">;
 verifier:Pick<ReturnType<typeof createManagedDatabaseReadinessVerifier>,"verifyStopped">;
 composeInspector:Pick<ReturnType<typeof createDockerComposeResourceInspector>,"inspectAllConsumers">;
 limits:Readonly<{deadlineMs:number;maxBytes:number;maxOutputBytes:number;cpus:number;memoryBytes:number;pidsLimit:number}>;
}>;
function fail():never{throw new Error("Database restore volume is unavailable.");}
function helperArgv(input:Input,options:ManagedDatabaseRestoreVolumeOptions,commandId:string,deadline:number){
 const plan=planManagedDatabaseProfile(input.request,input.profile,options.imagePolicy),preview=createManagedDatabaseComposePreview(input.request,input.profile,options.imagePolicy),limits=options.limits;
 const name="dl-"+digestControlInput({projectId:plan.projectId,databaseId:plan.databaseId,commandId}).slice(0,32)+"-database-init";
 const script=`set -eu; stamp=$(date +%s%3N); [[ "$stamp" =~ ^[1-9][0-9]{0,15}$ ]] || exit 1; remaining=$((${deadline}-stamp-1000)); test "$remaining" -gt 0; test "$remaining" -le 60000; seconds=$(printf '%d.%03d' "$((remaining/1000))" "$((remaining%1000))"); exec timeout --signal=TERM --kill-after=1s "$seconds" bash -o pipefail -c 'set -eu; data=/data; test -d "$data"; test ! -L "$data"; find "$data" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; exec tar --extract --file=- --directory="$data" --no-same-owner'`;
 const argv=Object.freeze(["docker","create","--interactive","--pull=never","--name",name,"--label","com.deploylite.owner="+options.owner,"--label","com.deploylite.project="+plan.projectId,"--label","com.deploylite.database="+plan.databaseId,"--label","com.deploylite.database.engine=redis","--label","com.deploylite.database.command="+input.commandId,"--label","com.deploylite.database.plan="+plan.planDigest,"--label","com.deploylite.database.storage-init=v1","--label","com.deploylite.compose.managed=v1","--label","com.deploylite.compose.service="+plan.volume.key,"--label","com.deploylite.compose.config-digest="+preview.configDigest,"--read-only","--cap-drop=ALL","--security-opt=no-new-privileges","--user","redis","--cpus",String(limits.cpus),"--memory",String(limits.memoryBytes),"--pids-limit",String(limits.pidsLimit),"--restart=no","--no-healthcheck","--network","none","--mount",`type=volume,source=${plan.volume.runtimeName},target=/data,volume-nocopy`,"--entrypoint","/bin/bash",plan.image,"-o","pipefail","-c",script]);
 return {plan,preview,name,argv};
}
/** Existing helper lifecycle only. Its caller supplies the original confirmed authority wrapper. No daemon restart or retry here. */
export function createManagedDatabaseRestoreVolumeWriter(supplied:ManagedDatabaseRestoreVolumeOptions):ManagedDatabaseRestoreVolumeWriter{
 const options={...supplied,imagePolicy:structuredClone(supplied.imagePolicy),limits:{...supplied.limits}},limits=options.limits,clock=options.clock,now=clock.now;
 if(!/^[A-Za-z0-9_-]{1,200}$/.test(options.owner)||!/^[A-Za-z0-9_-]{1,200}$/.test(options.agentId)||!Number.isSafeInteger(limits.deadlineMs)||limits.deadlineMs<1||limits.deadlineMs>60000||!Number.isSafeInteger(limits.maxBytes)||limits.maxBytes<1024
  ||!Number.isSafeInteger(limits.maxOutputBytes)||limits.maxOutputBytes<1||limits.maxOutputBytes>1048576||!Number.isFinite(limits.cpus)||limits.cpus<0.1||limits.cpus>2||!Number.isSafeInteger(limits.memoryBytes)||limits.memoryBytes<67108864||limits.memoryBytes>4294967296||!Number.isSafeInteger(limits.pidsLimit)||limits.pidsLimit<16||limits.pidsLimit>1024)fail();
 return {async restore(raw:Input,evidence:Resources,source:Uint8Array,authority,external,suppliedDeadline,commandId){
  const controller=new AbortController(),cancel=()=>controller.abort();external.addEventListener("abort",cancel,{once:true});if(external.aborted)cancel();let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   const input=structuredClone(raw),resources=structuredClone(evidence),bytes=Buffer.from(source);validateManagedDatabaseRestoreTar(bytes,limits.maxBytes);
   const sha256=createHash("sha256").update(bytes).digest("hex"),start=now.call(clock),deadline=Math.min(suppliedDeadline,start+limits.deadlineMs);let lastNow=start;
   if(typeof authority?.assertValid!=="function"||!Number.isSafeInteger(suppliedDeadline)||!/^[A-Za-z0-9_-]{1,200}$/.test(commandId))fail();
   const valid=authority.assertValid,run=options.runner.run,binary=options.runner.runBinaryFromSource,inspect=options.nativeInspector.inspectContainer,image=options.nativeInspector.inspectImage,observe=options.composeInspector.inspectAllConsumers,stopped=options.verifier.verifyStopped;
   function current(){const time=now.call(clock);if(controller.signal.aborted||external.aborted||clock.now!==now||!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(time)||time<lastNow||!Number.isSafeInteger(deadline)||time>=deadline
    ||authority.assertValid!==valid||options.runner.run!==run||options.runner.runBinaryFromSource!==binary||options.nativeInspector.inspectContainer!==inspect||options.nativeInspector.inspectImage!==image||options.composeInspector.inspectAllConsumers!==observe||options.verifier.verifyStopped!==stopped)fail();lastNow=time;return time;}
   const call=async<T>(work:()=>Promise<T>)=>{current();const value=await awaitAbortable(work,controller.signal);current();return value;};
   const gate=()=>call(()=>valid.call(authority));
   const execute=async(argv:readonly string[])=>{await gate();const result=await call(()=>run.call(options.runner,Object.freeze([...argv]),controller.signal));if(result.exitCode!==0||result.signal!==null||Buffer.byteLength(result.stdout)+Buffer.byteLength(result.stderr)>limits.maxOutputBytes)fail();await gate();return result.stdout;};
   current();timer=setTimeout(cancel,deadline-start);
   const {plan,preview,name,argv}=helperArgv(input,options,commandId,deadline);
   if(plan.engine!=="redis"||plan.volume.target!=="/data"||input.containerId===undefined||!/^[a-f0-9]{64}$/.test(input.containerId)||!/^[A-Za-z0-9_-]{1,200}$/.test(input.commandId)
    ||resources.projectId!==plan.projectId||resources.databaseId!==plan.databaseId||resources.commandId!==input.commandId||resources.planDigest!==plan.planDigest||resources.volume.name!==plan.volume.runtimeName||resources.network.name!==plan.network.runtimeName)fail();
   await gate();if((await call(()=>stopped.call(options.verifier,input,resources,authority,controller.signal))).containerId!==input.containerId)fail();await gate();
   const original=await call(()=>inspect.call(options.nativeInspector,input.containerId!,controller.signal));if(original.id!==input.containerId||original.running||original.imageId!==input.imageId)fail();const originalFingerprint=protocolPayloadFingerprint(original);
   const baseline=new Map<string,unknown>();
   async function guard(helperId:string|null){
    const actual=await call(()=>inspect.call(options.nativeInspector,input.containerId!,controller.signal));if(protocolPayloadFingerprint(actual)!==originalFingerprint)fail();
    const pinned=await call(()=>image.call(options.nativeInspector,plan.image,controller.signal));if(pinned.imageId!==input.imageId||pinned.declaredVolumes.some(path=>path!=="/data"))fail();
    for(const kind of ["volume","network"] as const){
     const view=composeResourceObservationSchema.parse(await call(()=>observe.call(options.composeInspector,{preview,kind,key:plan.volume.key},controller.signal)));
     if(view.owner!==options.owner||view.agentId!==options.agentId||view.projectId!==plan.projectId||view.kind!==kind||view.key!==plan.volume.key||view.runtimeName!==(kind==="volume"?resources.volume.name:resources.network.name)||view.physicalIdentity!==(kind==="volume"?resources.volume.createdAt:resources.network.id)||view.configDigest!==preview.configDigest||view.observedAt<start||view.observedAt>current()||view.stateDigest!==digestComposeResourceObservation(view)||view.containers.length!==(helperId?2:1))fail();
     const existing=view.containers.find(value=>value.containerId===input.containerId);if(!existing||existing.running||!existing.attached)fail();
     if(!baseline.has(kind))baseline.set(kind,protocolPayloadFingerprint(existing));else if(baseline.get(kind)!==protocolPayloadFingerprint(existing))fail();
     if(helperId){const helper=view.containers.find(value=>value.containerId===helperId);if(!helper||helper.service!==plan.volume.key||helper.running||helper.attached!==(kind==="volume")||helper.composeConfigDigest!==preview.configDigest||helper.composeEnvironmentDigest!==undefined||helper.networks?.length!==0||JSON.stringify(helper.mounts)!==JSON.stringify(kind==="volume"?[{target:"/data",readOnly:false}]:[]))fail();}
    }
    if(helperId){const helper=await call(()=>inspect.call(options.nativeInspector,helperId,controller.signal));if(helper.id!==helperId||helper.name!=="/"+name||helper.imageId!==input.imageId||helper.image!==plan.image||helper.owner!==options.owner||helper.projectId!==plan.projectId||helper.databaseId!==plan.databaseId||helper.engine!=="redis"||helper.commandId!==input.commandId||helper.planDigest!==plan.planDigest||helper.environmentFingerprint!==null||helper.storageInitialization!=="v1"||helper.networkMode!=="none"||helper.running||helper.health!==null||helper.user!=="redis"||!helper.readOnly||helper.privileged||(helper.capAdd?.length??0)!==0||JSON.stringify(helper.capDrop)!=='["ALL"]'||JSON.stringify(helper.securityOpt)!=='["no-new-privileges"]'||helper.cpu!==Math.round(limits.cpus*1e9)||helper.memory!==limits.memoryBytes||helper.pids!==limits.pidsLimit||Object.values(helper.ports??{}).some(bindings=>bindings.length!==0))fail();}
    await gate();
   }
   await guard(null);const helperId=(await execute(argv)).trim();if(!/^[a-f0-9]{64}$/.test(helperId)||helperId===input.containerId)fail();await guard(helperId);
   await gate();const applied=await call(()=>binary.call(options.runner,Object.freeze(["docker","start","--attach","--interactive",helperId]),controller.signal,bytes));if(applied.bytes!==bytes.length||applied.sha256!==sha256)fail();await gate();
   if((await execute(["docker","wait",helperId])).trim()!=="0")fail();await guard(helperId);
   if((await execute(["docker","rm",helperId])).trim()!==helperId)fail();await guard(null);
   if((await call(()=>stopped.call(options.verifier,input,resources,authority,controller.signal))).containerId!==input.containerId)fail();await gate();return Object.freeze({bytes:bytes.length,sha256});
  }catch{return fail();}finally{controller.abort();if(timer)clearTimeout(timer);external.removeEventListener("abort",cancel);}
 }};
}
