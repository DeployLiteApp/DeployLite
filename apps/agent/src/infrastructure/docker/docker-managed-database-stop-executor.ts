import {MANAGED_DATABASE_STOP_CAPABILITY,managedDatabaseStopAgentCommandSchema,managedDatabaseStopReceiptSchema,type CapabilityRegistry,type Clock,type ImageReferencePolicyV1,type ManagedDatabaseEngineV1} from "@deploylite/contracts";
import {awaitAbortable,managedDatabaseStopExecutionDigest,planManagedDatabaseProfile} from "@deploylite/domain";
import type {createManagedDatabaseDaemonStopper} from "./docker-managed-database-daemon-stop.js";
import type {ManagedDatabaseFreshResources} from "./docker-managed-database-resources.js";
function fail():never {throw new Error("Database stop execution is unavailable.");}
/** Original receipt/cache admission precedes this executor. No credential access or resource creation. */
export function createManagedDatabaseStopExecutor(supplied:Readonly<{
    agentId:string;profiles:Readonly<Partial<Record<ManagedDatabaseEngineV1,unknown>>>;imagePolicy:ImageReferencePolicyV1;
    capabilities:CapabilityRegistry;clock:Clock;stopper:ReturnType<typeof createManagedDatabaseDaemonStopper>;
    limits:Readonly<{deadlineMs:number}>;
}>) {
    const options={...supplied,profiles:structuredClone(supplied.profiles),imagePolicy:structuredClone(supplied.imagePolicy),limits:{...supplied.limits}};
    if(!/^[A-Za-z0-9_-]{1,200}$/.test(options.agentId)||!Number.isSafeInteger(options.limits.deadlineMs)||options.limits.deadlineMs<1||options.limits.deadlineMs>60000)fail();
    return {async stop(raw:unknown,authority:Readonly<{assertValid():Promise<void>}>,external:AbortSignal){
        const controller=new AbortController(),cancel=()=>controller.abort();external.addEventListener("abort",cancel,{once:true});
        let timer:ReturnType<typeof setTimeout>|undefined;
        try {
            const command=managedDatabaseStopAgentCommandSchema.parse(structuredClone(raw)),start=options.clock.now();
            if(!Number.isSafeInteger(start)||start<0)fail();
            const deadline=Math.min(start+options.limits.deadlineMs,start+command.timeoutMs,command.lease.expiresAt);
            function current(){const now=options.clock.now();if(external.aborted||controller.signal.aborted||!Number.isSafeInteger(now)||now<start||now>=deadline||command.agentId!==options.agentId||!options.capabilities.has(MANAGED_DATABASE_STOP_CAPABILITY))fail();}
            async function call<T>(work:()=>Promise<T>){current();const result=await awaitAbortable(work,controller.signal);current();return result;}
            current();timer=setTimeout(cancel,deadline-start);await call(()=>authority.assertValid());
            const request={schemaVersion:1,projectId:command.projectId,databaseId:command.databaseId,engine:command.engine},profile=options.profiles[command.engine];
            const plan=planManagedDatabaseProfile(request,profile,options.imagePolicy),original=command.originalReceipt;
            const preparation={...request,profileId:command.profileId,planDigest:command.planDigest,environmentFingerprint:command.environmentFingerprint,originalReceipt:original,originalReplayFingerprint:command.originalReplayFingerprint};
            if(plan.profileId!==command.profileId||plan.planDigest!==command.planDigest||command.inputDigest!==managedDatabaseStopExecutionDigest(preparation))fail();
            const resources:ManagedDatabaseFreshResources={projectId:command.projectId,databaseId:command.databaseId,commandId:original.commandId,planDigest:command.planDigest,
                volume:{name:original.volumeName,createdAt:original.volumeCreatedAt!},network:{name:original.networkName,id:original.networkId!}};
            const input={request,profile,commandId:original.commandId,imageId:original.imageId!,containerId:original.containerId!,environmentFingerprint:command.environmentFingerprint};
            const boundedAuthority={assertValid:async()=>{await call(()=>authority.assertValid());}};
            const stopped=await call(()=>options.stopper.stop(input,resources,boundedAuthority,controller.signal));
            if(stopped.containerId!==original.containerId)fail();await boundedAuthority.assertValid();
            const observedAt=options.clock.now();if(observedAt<original.observedAt)fail();
            return Object.freeze(managedDatabaseStopReceiptSchema.parse({...request,action:command.action,agentId:command.agentId,commandId:command.commandId,originalCommandId:original.commandId,
                profileId:command.profileId,inputDigest:command.inputDigest,planDigest:command.planDigest,environmentFingerprint:command.environmentFingerprint,correlationId:command.context.correlationId,
                containerId:original.containerId,imageId:original.imageId,volumeName:original.volumeName,networkName:original.networkName,networkId:original.networkId,volumeCreatedAt:original.volumeCreatedAt,observedAt,status:"stopped",storage:"verified",redacted:true}));
        }catch{return fail();}
        finally{if(timer!==undefined)clearTimeout(timer);external.removeEventListener("abort",cancel);}
    }};
}
