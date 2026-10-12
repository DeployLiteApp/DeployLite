import {MANAGED_DATABASE_START_CAPABILITY,managedDatabaseStartAgentCommandSchema,managedDatabaseStartReceiptSchema,type CapabilityRegistry,type Clock,type ImageReferencePolicyV1,type ManagedDatabaseEngineV1} from "@deploylite/contracts";
import {awaitAbortable,managedDatabaseStartExecutionDigest,planManagedDatabaseProfile} from "@deploylite/domain";
import type {createManagedDatabaseDaemonStarter} from "./docker-managed-database-daemon-start.js";
import type {ManagedDatabaseFreshResources} from "./docker-managed-database-resources.js";
function fail():never {throw new Error("Database start execution is unavailable.");}
/** Both original receipt/cache admissions precede this executor. No credential access or resource creation. */
export function createManagedDatabaseStartExecutor(supplied:Readonly<{
    agentId:string;profiles:Readonly<Partial<Record<ManagedDatabaseEngineV1,unknown>>>;imagePolicy:ImageReferencePolicyV1;
    capabilities:CapabilityRegistry;clock:Clock;starter:ReturnType<typeof createManagedDatabaseDaemonStarter>;
    limits:Readonly<{deadlineMs:number}>;
}>) {
    const options={...supplied,profiles:structuredClone(supplied.profiles),imagePolicy:structuredClone(supplied.imagePolicy),limits:{...supplied.limits}};
    if(!/^[A-Za-z0-9_-]{1,200}$/.test(options.agentId)||!Number.isSafeInteger(options.limits.deadlineMs)||options.limits.deadlineMs<1||options.limits.deadlineMs>60000)fail();
    return {async start(raw:unknown,authority:Readonly<{assertValid():Promise<void>}>,external:AbortSignal){
        const controller=new AbortController(),cancel=()=>controller.abort();external.addEventListener("abort",cancel,{once:true});
        let timer:ReturnType<typeof setTimeout>|undefined;
        try {
            const command=managedDatabaseStartAgentCommandSchema.parse(structuredClone(raw)),start=options.clock.now();
            if(!Number.isSafeInteger(start)||start<0||start<command.originalStopReceipt.observedAt)fail();
            const deadline=Math.min(start+options.limits.deadlineMs,start+command.timeoutMs,command.lease.expiresAt);
            function current(){const now=options.clock.now();if(external.aborted||controller.signal.aborted||!Number.isSafeInteger(now)||now<start||now>=deadline||command.agentId!==options.agentId||!options.capabilities.has(MANAGED_DATABASE_START_CAPABILITY))fail();}
            async function call<T>(work:()=>Promise<T>){current();const result=await awaitAbortable(work,controller.signal);current();return result;}
            current();timer=setTimeout(cancel,deadline-start);await call(()=>authority.assertValid());
            const request={schemaVersion:1,projectId:command.projectId,databaseId:command.databaseId,engine:command.engine},profile=options.profiles[command.engine];
            const plan=planManagedDatabaseProfile(request,profile,options.imagePolicy),original=command.originalReceipt;
            const preparation={...request,profileId:command.profileId,planDigest:command.planDigest,environmentFingerprint:command.environmentFingerprint,originalReceipt:original,originalReplayFingerprint:command.originalReplayFingerprint,originalStopReceipt:command.originalStopReceipt,originalStopReplayFingerprint:command.originalStopReplayFingerprint};
            if(plan.profileId!==command.profileId||plan.planDigest!==command.planDigest||command.inputDigest!==managedDatabaseStartExecutionDigest(preparation))fail();
            const resources:ManagedDatabaseFreshResources={projectId:command.projectId,databaseId:command.databaseId,commandId:original.commandId,planDigest:command.planDigest,
                volume:{name:original.volumeName,createdAt:original.volumeCreatedAt!},network:{name:original.networkName,id:original.networkId!}};
            const input={request,profile,commandId:original.commandId,imageId:original.imageId!,containerId:original.containerId!,environmentFingerprint:command.environmentFingerprint};
            const boundedAuthority={assertValid:async()=>{await call(()=>authority.assertValid());}};
            const started=await call(()=>options.starter.start(input,resources,boundedAuthority,controller.signal));
            if(started.containerId!==original.containerId||!Number.isSafeInteger(started.uid)||started.uid<1||started.uid>4294967294)fail();await boundedAuthority.assertValid();
            const observedAt=options.clock.now();if(observedAt<command.originalStopReceipt.observedAt)fail();
            return Object.freeze(managedDatabaseStartReceiptSchema.parse({...request,action:command.action,agentId:command.agentId,commandId:command.commandId,originalCommandId:original.commandId,originalStopCommandId:command.originalStopReceipt.commandId,
                profileId:command.profileId,inputDigest:command.inputDigest,planDigest:command.planDigest,environmentFingerprint:command.environmentFingerprint,correlationId:command.context.correlationId,
                containerId:original.containerId,imageId:original.imageId,volumeName:original.volumeName,networkName:original.networkName,networkId:original.networkId,volumeCreatedAt:original.volumeCreatedAt,observedAt,status:"ready",health:"passed",storage:"verified",idempotent:false,redacted:true}));
        }catch{return fail();}
        finally{if(timer!==undefined)clearTimeout(timer);external.removeEventListener("abort",cancel);}
    }};
}
