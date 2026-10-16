import {MANAGED_DATABASE_RESTORE_CAPABILITY} from "@deploylite/contracts";
import {createManagedDatabaseRestoreExecutor} from "./docker-managed-database-restore-executor.js";
import {createManagedDatabaseRestoreVolumeWriter} from "./docker-managed-database-restore-volume.js";
import {createPrivateNativeRestoreArchive} from "./docker-managed-database-restore-archive.js";
import type {ComposeVolumeBackupSource} from "./docker-compose-volume-backup.js";
import {MANAGED_DATABASE_BACKUP_CAPABILITY} from "@deploylite/contracts";
import type {AgentReplayStore} from "../../agent-transport.js";
import type {DockerProcessRunner} from "./docker-process-runner.js";
import {createPrivateNativeBackupArchive} from "./docker-managed-database-backup-archive.js";
import {createManagedDatabaseBackupExecutor} from "./docker-managed-database-backup-executor.js";
import {createManagedDatabaseDeleteExecutor} from "./docker-managed-database-delete-executor.js";
import {createManagedDatabaseDaemonRemover} from "./docker-managed-database-daemon-remove.js";
import {createManagedDatabaseLogsExecutor} from "./docker-managed-database-logs-executor.js";
import {createManagedDatabaseLogsObserver} from "./docker-managed-database-log-observer.js";
import {createManagedDatabaseLogReader} from "./docker-managed-database-logs.js";
import {createManagedDatabaseMetricsObserver} from "./docker-managed-database-metrics.js";
import {createManagedDatabaseStatsReader} from "./docker-managed-database-stats.js";
import {createManagedDatabaseMetricsExecutor} from "./docker-managed-database-metrics-executor.js";
import {createManagedDatabaseHealthObserver} from "./docker-managed-database-health.js";
import {createManagedDatabaseHealthExecutor} from "./docker-managed-database-health-executor.js";
import {createManagedDatabaseStartExecutor} from "./docker-managed-database-start-executor.js";
import {createManagedDatabaseDaemonStopper} from "./docker-managed-database-daemon-stop.js";
import {createManagedDatabaseStopExecutor} from "./docker-managed-database-stop-executor.js";
import {validateAgentTransportKey} from "@deploylite/config";
import {MANAGED_DATABASE_DELETE_CAPABILITY, type ProjectControlAuthorityV1, COMPOSE_RESOURCE_INSPECTION_CAPABILITY, MANAGED_DATABASE_LOGS_CAPABILITY, MANAGED_DATABASE_METRICS_CAPABILITY, MANAGED_DATABASE_HEALTH_CAPABILITY, MANAGED_DATABASE_RUNTIME_CAPABILITY, MANAGED_DATABASE_START_CAPABILITY, MANAGED_DATABASE_STOP_CAPABILITY, type CapabilityRegistry, type Clock, type ImageReferencePolicyV1} from "@deploylite/contracts";
import {validateManagedDatabaseRuntimeProfiles} from "@deploylite/domain";
import type {DockerCliRunner} from "./docker-cli-image-transport.js";
import {createDockerComposeResourceInspector} from "./docker-compose-resource-inspector.js";
import {createManagedDatabaseDockerInspector} from "./docker-managed-database-inspection.js";
import {createManagedDatabaseResourceMaterializer} from "./docker-managed-database-resources.js";
import {createManagedDatabaseStorageInitializer} from "./docker-managed-database-storage-initializer.js";
import {createManagedDatabaseStartupPreparation} from "./docker-managed-database-startup-preparation.js";
import {createManagedDatabaseProcessIdentityReader} from "./docker-managed-database-process-identity.js";
import {createManagedDatabaseReadinessVerifier} from "./docker-managed-database-readiness.js";
import {createManagedDatabaseDaemonStarter} from "./docker-managed-database-daemon-start.js";
import {createManagedDatabaseRuntimeExecutor} from "./docker-managed-database-runtime-executor.js";
function fail(): never {throw new Error("Database runtime composition is unavailable.");}
/** Explicit injected composition only. No environment discovery, default profiles, process creation or capability activation. */
export function createManagedDatabaseRuntime(supplied: Readonly<{
    agentId: string;
    owner: string;
    trustKey: string;
    profiles: unknown;
    imagePolicy: ImageReferencePolicyV1;
    capabilities: CapabilityRegistry;
    clock: Clock;
    runner: DockerCliRunner;
    backup?:Readonly<{volumeSource?:ComposeVolumeBackupSource;destinations:ReadonlyMap<string,string>;runner:Pick<DockerProcessRunner,"runBinaryToSink"> & Partial<Pick<DockerProcessRunner,"runBinaryFromSource">>;replayStore:Pick<AgentReplayStore,"durable"|"lookupByFingerprintDigest">;maxBytes:number}>;
    limits: Readonly<{deadlineMs: number; maxOutputBytes: number; maxContainers: number; pollIntervalMs: number; cpus: number; memoryBytes: number; pidsLimit: number; stopGraceSeconds?: number}>;
}>) {
    try {
        const options = {...supplied, profiles: structuredClone(supplied.profiles), imagePolicy: structuredClone(supplied.imagePolicy), limits: {...supplied.limits}};
        validateAgentTransportKey(options.trustKey);
        function capabilities() {
            if (!options.capabilities.has(MANAGED_DATABASE_RUNTIME_CAPABILITY) || !options.capabilities.has(COMPOSE_RESOURCE_INSPECTION_CAPABILITY)) fail();
        }
        capabilities();
        const stopGrace=options.limits.stopGraceSeconds;
        if(options.capabilities.has(MANAGED_DATABASE_DELETE_CAPABILITY)&&stopGrace===undefined)fail();
        if(stopGrace!==undefined && (!Number.isSafeInteger(stopGrace)||stopGrace<1||stopGrace>30||!options.capabilities.has(MANAGED_DATABASE_STOP_CAPABILITY)))fail();
        const backupConfig=options.backup;
        if(Boolean(backupConfig)!==options.capabilities.has(MANAGED_DATABASE_BACKUP_CAPABILITY))fail();
        if(backupConfig && (!(backupConfig.destinations instanceof Map) || backupConfig.destinations.size<1
            || backupConfig.replayStore.durable!==true || typeof backupConfig.replayStore.lookupByFingerprintDigest!=="function"
            || typeof backupConfig.runner.runBinaryToSink!=="function" || !Number.isSafeInteger(backupConfig.maxBytes) || backupConfig.maxBytes<1))fail();
        const restoreEnabled=options.capabilities.has(MANAGED_DATABASE_RESTORE_CAPABILITY),restoreInput=backupConfig?.runner.runBinaryFromSource;
        if(restoreEnabled && (!backupConfig||backupConfig.maxBytes<1024||typeof restoreInput!=="function"||stopGrace===undefined||!options.capabilities.has(MANAGED_DATABASE_STOP_CAPABILITY)||!options.capabilities.has(MANAGED_DATABASE_START_CAPABILITY)))fail();
        const profiles = validateManagedDatabaseRuntimeProfiles(options.profiles, options.imagePolicy);
        const shared = {...options, profiles};
        const nativeInspector = createManagedDatabaseDockerInspector(shared);
        const resources = createManagedDatabaseResourceMaterializer(shared);
        const composeInspector = createDockerComposeResourceInspector(shared);
        const preparation = createManagedDatabaseStartupPreparation({...shared, imageInspector: nativeInspector});
        const storage = createManagedDatabaseStorageInitializer({...shared, nativeInspector, resourceVerifier: resources, composeInspector});
        const processIdentityReader = createManagedDatabaseProcessIdentityReader(shared);
        const verifier = createManagedDatabaseReadinessVerifier({...shared, nativeInspector, resourceVerifier: resources, composeInspector, processIdentityReader});
        const backup=backupConfig?createManagedDatabaseBackupExecutor({agentId:options.agentId,profiles,imagePolicy:options.imagePolicy,
            capabilities:options.capabilities,clock:options.clock,replayStore:backupConfig.replayStore,verifier,volumeSource:backupConfig.volumeSource,runner:backupConfig.runner,
            archive:createPrivateNativeBackupArchive({destinations:backupConfig.destinations,clock:options.clock,maxBytes:backupConfig.maxBytes,maxDurationMs:options.limits.deadlineMs}),
            limits:{deadlineMs:options.limits.deadlineMs,maxBytes:backupConfig.maxBytes}}):undefined;
        const health=options.capabilities.has(MANAGED_DATABASE_HEALTH_CAPABILITY)?createManagedDatabaseHealthExecutor({agentId:options.agentId,profiles,
            imagePolicy:options.imagePolicy,capabilities:options.capabilities,clock:options.clock,limits:{deadlineMs:options.limits.deadlineMs},
            observer:createManagedDatabaseHealthObserver({nativeInspector,verifier,imagePolicy:options.imagePolicy,clock:options.clock,limits:{deadlineMs:options.limits.deadlineMs}})}):undefined;
        const metrics=options.capabilities.has(MANAGED_DATABASE_METRICS_CAPABILITY)?createManagedDatabaseMetricsExecutor({agentId:options.agentId,profiles,
            imagePolicy:options.imagePolicy,capabilities:options.capabilities,clock:options.clock,limits:{deadlineMs:options.limits.deadlineMs},
            observer:createManagedDatabaseMetricsObserver({health:createManagedDatabaseHealthObserver({nativeInspector,verifier,imagePolicy:options.imagePolicy,clock:options.clock,limits:{deadlineMs:options.limits.deadlineMs}}),
                stats:createManagedDatabaseStatsReader({runner:options.runner,clock:options.clock,limits:{deadlineMs:options.limits.deadlineMs,maxOutputBytes:options.limits.maxOutputBytes}}),clock:options.clock,limits:{deadlineMs:options.limits.deadlineMs}})}):undefined;
        const logs = options.capabilities.has(MANAGED_DATABASE_LOGS_CAPABILITY) ? createManagedDatabaseLogsExecutor({
            agentId: options.agentId, profiles, imagePolicy: options.imagePolicy, capabilities: options.capabilities,
            clock: options.clock, limits: {deadlineMs: options.limits.deadlineMs},
            observer: createManagedDatabaseLogsObserver({
                health: createManagedDatabaseHealthObserver({nativeInspector, verifier, imagePolicy: options.imagePolicy, clock: options.clock, limits: {deadlineMs: options.limits.deadlineMs}}),
                logs: createManagedDatabaseLogReader({runner: options.runner, clock: options.clock, limits: options.limits}),
                clock: options.clock, limits: options.limits
            })
        }) : undefined;
        const starter = createManagedDatabaseDaemonStarter({...shared, nativeInspector, verifier});
        const start=options.capabilities.has(MANAGED_DATABASE_START_CAPABILITY)?createManagedDatabaseStartExecutor({...shared,starter}):undefined;
        const executor = createManagedDatabaseRuntimeExecutor({...shared, preparation, resources, storage, starter});
        const stopper=stopGrace===undefined?undefined:createManagedDatabaseDaemonStopper({runner:options.runner,verifier,clock:options.clock,limits:{deadlineMs:options.limits.deadlineMs,maxOutputBytes:options.limits.maxOutputBytes,stopGraceSeconds:stopGrace}});
        const stop=stopper?createManagedDatabaseStopExecutor({...shared,stopper}):undefined;
        const deletion=options.capabilities.has(MANAGED_DATABASE_DELETE_CAPABILITY)&&stopper?createManagedDatabaseDeleteExecutor({...shared,stopper,inspector:nativeInspector,
            remover:createManagedDatabaseDaemonRemover({runner:options.runner,verifier,clock:options.clock,limits:{deadlineMs:options.limits.deadlineMs,maxOutputBytes:options.limits.maxOutputBytes}})}):undefined;
        const restoreBinary={runBinaryFromSource:(...args:Parameters<DockerProcessRunner["runBinaryFromSource"]>)=>{
            if(!backupConfig||typeof restoreInput!=="function"||backupConfig.runner.runBinaryFromSource!==restoreInput)fail();return restoreInput!.call(backupConfig.runner,...args);
        }};
        const originalRun=options.runner.run,restoreRunner={...restoreBinary,run:(...args:Parameters<DockerCliRunner["run"]>)=>{if(options.runner.run!==originalRun)fail();return originalRun.call(options.runner,...args);}};
        const restore=restoreEnabled && backupConfig && stopper?createManagedDatabaseRestoreExecutor({agentId:options.agentId,profiles,imagePolicy:options.imagePolicy,capabilities:options.capabilities,clock:options.clock,replayStore:backupConfig.replayStore,verifier,runner:restoreBinary,
            archive:createPrivateNativeRestoreArchive({destinations:backupConfig.destinations,expectedAgentId:options.agentId,clock:options.clock,maxBytes:backupConfig.maxBytes,maxDurationMs:options.limits.deadlineMs}),
            redis:{inspector:nativeInspector,stopper,starter,volumeWriter:createManagedDatabaseRestoreVolumeWriter({...shared,runner:restoreRunner,nativeInspector,verifier,composeInspector,limits:{...options.limits,maxBytes:backupConfig.maxBytes}})},limits:{deadlineMs:options.limits.deadlineMs,maxBytes:backupConfig.maxBytes}}):undefined;
        return Object.freeze({apply: async (...args: Parameters<typeof executor.apply>) => executor.apply(args[0], {assertValid: async () => {
            capabilities(); await args[1].assertValid(); capabilities();
        }}, args[2]),...(restore?{restore:async(...args:Parameters<typeof restore.restore>)=>{
            const authority=args[1];if(typeof authority?.assertValid!=="function"||typeof authority.assertConfirmed!=="function")fail();const valid=authority.assertValid,confirmed=authority.assertConfirmed;
            const check=()=>{capabilities();if(!options.capabilities.has(MANAGED_DATABASE_RESTORE_CAPABILITY)||!options.capabilities.has(MANAGED_DATABASE_STOP_CAPABILITY)||!options.capabilities.has(MANAGED_DATABASE_START_CAPABILITY))fail();};
            check();return restore.restore(args[0],{assertValid:async()=>{check();await valid.call(authority);check();},assertConfirmed:async(value,id)=>{check();await confirmed.call(authority,value,id);check();}},args[2]);
        }}:{}),...(backup?{backup:async(...args:Parameters<typeof backup.execute>)=>{
            const check=()=>{capabilities();if(!options.capabilities.has(MANAGED_DATABASE_BACKUP_CAPABILITY))fail();};
            check();return backup.execute(args[0],{...args[1],assertValid:async()=>{check();await args[1].assertValid();check();}},args[2]);
        }}:{}),...(stop?{stop:async(...args:Parameters<typeof stop.stop>)=>stop.stop(args[0],{assertValid:async()=>{
            capabilities();if(!options.capabilities.has(MANAGED_DATABASE_STOP_CAPABILITY))fail();await args[1].assertValid();capabilities();
            if(!options.capabilities.has(MANAGED_DATABASE_STOP_CAPABILITY))fail();
        }},args[2])}:{}),...(start?{start:async(...args:Parameters<typeof start.start>)=>start.start(args[0],{assertValid:async()=>{
            capabilities();if(!options.capabilities.has(MANAGED_DATABASE_START_CAPABILITY))fail();await args[1].assertValid();capabilities();
            if(!options.capabilities.has(MANAGED_DATABASE_START_CAPABILITY))fail();
        }},args[2])}:{}),...(health?{health:async(...args:Parameters<typeof health.observe>)=>health.observe(args[0],{assertValid:async()=>{
            capabilities();if(!options.capabilities.has(MANAGED_DATABASE_HEALTH_CAPABILITY))fail();await args[1].assertValid();capabilities();
            if(!options.capabilities.has(MANAGED_DATABASE_HEALTH_CAPABILITY))fail();
        }},args[2])}:{}),...(logs ? {logs: async (...args: Parameters<typeof logs.observe>) => logs.observe(args[0], {assertValid: async () => {
            capabilities(); if (!options.capabilities.has(MANAGED_DATABASE_LOGS_CAPABILITY)) fail();
            await args[1].assertValid(); capabilities();
            if (!options.capabilities.has(MANAGED_DATABASE_LOGS_CAPABILITY)) fail();
        }}, args[2])} : {}), ...(metrics?{metrics:async(...args:Parameters<typeof metrics.observe>)=>metrics.observe(args[0],{assertValid:async()=>{
            capabilities();if(!options.capabilities.has(MANAGED_DATABASE_METRICS_CAPABILITY))fail();await args[1].assertValid();capabilities();
            if(!options.capabilities.has(MANAGED_DATABASE_METRICS_CAPABILITY))fail();
        }},args[2])}:{}),...(deletion?{delete:async(...args:Parameters<typeof deletion.delete>)=>{
            const authority=args[1] as {assertValid?:()=>Promise<void>;assertConfirmed?:(authority:ProjectControlAuthorityV1,id:string)=>Promise<void>}|null;
            if(typeof authority?.assertValid!=="function"||typeof authority.assertConfirmed!=="function")fail();
            const valid=authority.assertValid.bind(authority),confirmed=authority.assertConfirmed.bind(authority);
            const check=()=>{capabilities();if(!options.capabilities.has(MANAGED_DATABASE_DELETE_CAPABILITY)||!options.capabilities.has(MANAGED_DATABASE_STOP_CAPABILITY))fail();};
            check();return deletion.delete(args[0],{assertValid:async()=>{check();await valid();check();},assertConfirmed:async(authority:ProjectControlAuthorityV1,id:string)=>{check();await confirmed(authority,id);check();}},args[2]);
        }}:{})});
    } catch {return fail();}
}
