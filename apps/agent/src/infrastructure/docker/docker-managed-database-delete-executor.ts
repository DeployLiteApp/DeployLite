import {MANAGED_DATABASE_DELETE_CAPABILITY,managedDatabaseDeleteAgentCommandSchema,managedDatabaseDeleteReceiptSchema,type ProjectControlAuthorityV1,type CapabilityRegistry,type Clock,type ImageReferencePolicyV1,type ManagedDatabaseEngineV1} from "@deploylite/contracts";
import {awaitAbortable,managedDatabaseDeleteExecutionDigest,planManagedDatabaseProfile} from "@deploylite/domain";
import type {createManagedDatabaseDaemonStopper} from "./docker-managed-database-daemon-stop.js";
import type {createManagedDatabaseDaemonRemover} from "./docker-managed-database-daemon-remove.js";
import type {ManagedDatabaseFreshResources} from "./docker-managed-database-resources.js";
function fail():never {throw new Error("Database deletion execution is unavailable.");}
/** Original receipt/cache admission precedes this executor. No credential access or resource creation. */
export function createManagedDatabaseDeleteExecutor(supplied:Readonly<{
    agentId:string;profiles:Readonly<Partial<Record<ManagedDatabaseEngineV1,unknown>>>;imagePolicy:ImageReferencePolicyV1;
    capabilities:CapabilityRegistry;clock:Clock;stopper:Pick<ReturnType<typeof createManagedDatabaseDaemonStopper>,"stop">;
    remover:Pick<ReturnType<typeof createManagedDatabaseDaemonRemover>,"remove">;inspector:{inspectContainer(id:string,signal:AbortSignal):Promise<{id:string;running:boolean}>};
    limits:Readonly<{deadlineMs:number}>;
}>) {
    const options={...supplied,profiles:structuredClone(supplied.profiles),imagePolicy:structuredClone(supplied.imagePolicy),limits:{...supplied.limits}};
    if(!/^[A-Za-z0-9_-]{1,200}$/.test(options.agentId)||!Number.isSafeInteger(options.limits.deadlineMs)||options.limits.deadlineMs<1||options.limits.deadlineMs>60000)fail();
    const now=options.clock.now.bind(options.clock),has=options.capabilities.has.bind(options.capabilities);
    const inspect=options.inspector.inspectContainer.bind(options.inspector),stop=options.stopper.stop.bind(options.stopper),remove=options.remover.remove.bind(options.remover);
    return {async delete(raw:unknown,authorityInput:unknown,external:AbortSignal){
        const controller=new AbortController(),cancel=()=>controller.abort();external.addEventListener("abort",cancel,{once:true});
        let timer:ReturnType<typeof setTimeout>|undefined;
        try {
            const authority=authorityInput as {assertValid?:()=>Promise<void>;assertConfirmed?:(authority:ProjectControlAuthorityV1,id:string)=>Promise<void>}|null;
            if(typeof authority?.assertValid!=="function"||typeof authority.assertConfirmed!=="function")fail();
            const valid=authority.assertValid.bind(authority),confirmed=authority.assertConfirmed.bind(authority);
            const command=managedDatabaseDeleteAgentCommandSchema.parse(structuredClone(raw)),start=now();
            if(!Number.isSafeInteger(start)||start<0)fail();
            const deadline=Math.min(start+options.limits.deadlineMs,start+command.timeoutMs,command.lease.expiresAt);
            function current(){const time=now();if(external.aborted||controller.signal.aborted||!Number.isSafeInteger(time)||time<start||time>=deadline||command.agentId!==options.agentId||!has(MANAGED_DATABASE_DELETE_CAPABILITY))fail();}
            async function call<T>(work:()=>Promise<T>){current();const result=await awaitAbortable(work,controller.signal);current();return result;}
            current();timer=setTimeout(cancel,deadline-start);await call(()=>valid());await call(()=>confirmed(command.authority,command.confirmationId));
            const request={schemaVersion:1,projectId:command.projectId,databaseId:command.databaseId,engine:command.engine},profile=options.profiles[command.engine];
            const plan=planManagedDatabaseProfile(request,profile,options.imagePolicy),original=command.originalReceipt;
            const preparation={...request,profileId:command.profileId,planDigest:command.planDigest,environmentFingerprint:command.environmentFingerprint,originalReceipt:original,originalReplayFingerprint:command.originalReplayFingerprint,...(command.originalStopReceipt?{originalStopReceipt:command.originalStopReceipt,originalStopReplayFingerprint:command.originalStopReplayFingerprint}:{})};
            if(plan.profileId!==command.profileId||plan.planDigest!==command.planDigest||command.inputDigest!==managedDatabaseDeleteExecutionDigest(preparation))fail();
            const resources:ManagedDatabaseFreshResources={projectId:command.projectId,databaseId:command.databaseId,commandId:original.commandId,planDigest:command.planDigest,
                volume:{name:original.volumeName,createdAt:original.volumeCreatedAt!},network:{name:original.networkName,id:original.networkId!}};
            const input={request,profile,commandId:original.commandId,imageId:original.imageId!,containerId:original.containerId!,environmentFingerprint:command.environmentFingerprint};
            const boundedAuthority={assertValid:async()=>{await call(()=>valid());await call(()=>confirmed(command.authority,command.confirmationId));}};
            if(original.observedAt>start||(command.originalStopReceipt?.observedAt??0)>start)fail();
            await boundedAuthority.assertValid();
            const observed=await call(()=>inspect(original.containerId!,controller.signal));
            if(observed.id!==original.containerId||typeof observed.running!=="boolean")fail();
            await boundedAuthority.assertValid();
            if(observed.running){const stopped=await call(()=>stop(input,resources,boundedAuthority,controller.signal));if(stopped.containerId!==original.containerId)fail();await boundedAuthority.assertValid();}
            const removed=await call(()=>remove(input,resources,boundedAuthority,controller.signal));
            if(removed.containerId!==original.containerId||removed.storage!=="retained")fail();await boundedAuthority.assertValid();
            const observedAt=now();if(observedAt<original.observedAt)fail();
            return Object.freeze(managedDatabaseDeleteReceiptSchema.parse({...request,action:command.action,agentId:command.agentId,commandId:command.commandId,originalCommandId:original.commandId,originalStopCommandId:command.originalStopReceipt?.commandId??null,confirmationId:command.confirmationId,
                profileId:command.profileId,inputDigest:command.inputDigest,planDigest:command.planDigest,environmentFingerprint:command.environmentFingerprint,correlationId:command.context.correlationId,
                containerId:original.containerId,imageId:original.imageId,volumeName:original.volumeName,networkName:original.networkName,networkId:original.networkId,volumeCreatedAt:original.volumeCreatedAt,observedAt,status:"removed",storage:"retained",redacted:true}));
        }catch{return fail();}
        finally{if(timer!==undefined)clearTimeout(timer);external.removeEventListener("abort",cancel);}
    }};
}
