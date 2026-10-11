import {createManagedDatabaseMetricsObserver} from "./docker-managed-database-metrics.js";
import {createManagedDatabaseStatsReader} from "./docker-managed-database-stats.js";
import {createManagedDatabaseMetricsExecutor} from "./docker-managed-database-metrics-executor.js";
import {createManagedDatabaseHealthObserver} from "./docker-managed-database-health.js";
import {createManagedDatabaseHealthExecutor} from "./docker-managed-database-health-executor.js";
import {createManagedDatabaseStartExecutor} from "./docker-managed-database-start-executor.js";
import {createManagedDatabaseDaemonStopper} from "./docker-managed-database-daemon-stop.js";
import {createManagedDatabaseStopExecutor} from "./docker-managed-database-stop-executor.js";
import {validateAgentTransportKey} from "@deploylite/config";
import {COMPOSE_RESOURCE_INSPECTION_CAPABILITY, MANAGED_DATABASE_METRICS_CAPABILITY, MANAGED_DATABASE_HEALTH_CAPABILITY, MANAGED_DATABASE_RUNTIME_CAPABILITY, MANAGED_DATABASE_START_CAPABILITY, MANAGED_DATABASE_STOP_CAPABILITY, type CapabilityRegistry, type Clock, type ImageReferencePolicyV1} from "@deploylite/contracts";
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
        if(stopGrace!==undefined && (!Number.isSafeInteger(stopGrace)||stopGrace<1||stopGrace>30||!options.capabilities.has(MANAGED_DATABASE_STOP_CAPABILITY)))fail();
        const profiles = validateManagedDatabaseRuntimeProfiles(options.profiles, options.imagePolicy);
        const shared = {...options, profiles};
        const nativeInspector = createManagedDatabaseDockerInspector(shared);
        const resources = createManagedDatabaseResourceMaterializer(shared);
        const composeInspector = createDockerComposeResourceInspector(shared);
        const preparation = createManagedDatabaseStartupPreparation({...shared, imageInspector: nativeInspector});
        const storage = createManagedDatabaseStorageInitializer({...shared, nativeInspector, resourceVerifier: resources, composeInspector});
        const processIdentityReader = createManagedDatabaseProcessIdentityReader(shared);
        const verifier = createManagedDatabaseReadinessVerifier({...shared, nativeInspector, resourceVerifier: resources, composeInspector, processIdentityReader});
        const health=options.capabilities.has(MANAGED_DATABASE_HEALTH_CAPABILITY)?createManagedDatabaseHealthExecutor({agentId:options.agentId,profiles,
            imagePolicy:options.imagePolicy,capabilities:options.capabilities,clock:options.clock,limits:{deadlineMs:options.limits.deadlineMs},
            observer:createManagedDatabaseHealthObserver({nativeInspector,verifier,imagePolicy:options.imagePolicy,clock:options.clock,limits:{deadlineMs:options.limits.deadlineMs}})}):undefined;
        const metrics=options.capabilities.has(MANAGED_DATABASE_METRICS_CAPABILITY)?createManagedDatabaseMetricsExecutor({agentId:options.agentId,profiles,
            imagePolicy:options.imagePolicy,capabilities:options.capabilities,clock:options.clock,limits:{deadlineMs:options.limits.deadlineMs},
            observer:createManagedDatabaseMetricsObserver({health:createManagedDatabaseHealthObserver({nativeInspector,verifier,imagePolicy:options.imagePolicy,clock:options.clock,limits:{deadlineMs:options.limits.deadlineMs}}),
                stats:createManagedDatabaseStatsReader({runner:options.runner,clock:options.clock,limits:{deadlineMs:options.limits.deadlineMs,maxOutputBytes:options.limits.maxOutputBytes}}),clock:options.clock,limits:{deadlineMs:options.limits.deadlineMs}})}):undefined;
        const starter = createManagedDatabaseDaemonStarter({...shared, nativeInspector, verifier});
        const start=options.capabilities.has(MANAGED_DATABASE_START_CAPABILITY)?createManagedDatabaseStartExecutor({...shared,starter}):undefined;
        const executor = createManagedDatabaseRuntimeExecutor({...shared, preparation, resources, storage, starter});
        const stop=stopGrace===undefined?undefined:createManagedDatabaseStopExecutor({...shared,stopper:createManagedDatabaseDaemonStopper({
            runner:options.runner,verifier,clock:options.clock,limits:{deadlineMs:options.limits.deadlineMs,maxOutputBytes:options.limits.maxOutputBytes,stopGraceSeconds:stopGrace}})});
        return Object.freeze({apply: async (...args: Parameters<typeof executor.apply>) => executor.apply(args[0], {assertValid: async () => {
            capabilities(); await args[1].assertValid(); capabilities();
        }}, args[2]),...(stop?{stop:async(...args:Parameters<typeof stop.stop>)=>stop.stop(args[0],{assertValid:async()=>{
            capabilities();if(!options.capabilities.has(MANAGED_DATABASE_STOP_CAPABILITY))fail();await args[1].assertValid();capabilities();
            if(!options.capabilities.has(MANAGED_DATABASE_STOP_CAPABILITY))fail();
        }},args[2])}:{}),...(start?{start:async(...args:Parameters<typeof start.start>)=>start.start(args[0],{assertValid:async()=>{
            capabilities();if(!options.capabilities.has(MANAGED_DATABASE_START_CAPABILITY))fail();await args[1].assertValid();capabilities();
            if(!options.capabilities.has(MANAGED_DATABASE_START_CAPABILITY))fail();
        }},args[2])}:{}),...(health?{health:async(...args:Parameters<typeof health.observe>)=>health.observe(args[0],{assertValid:async()=>{
            capabilities();if(!options.capabilities.has(MANAGED_DATABASE_HEALTH_CAPABILITY))fail();await args[1].assertValid();capabilities();
            if(!options.capabilities.has(MANAGED_DATABASE_HEALTH_CAPABILITY))fail();
        }},args[2])}:{}),...(metrics?{metrics:async(...args:Parameters<typeof metrics.observe>)=>metrics.observe(args[0],{assertValid:async()=>{
            capabilities();if(!options.capabilities.has(MANAGED_DATABASE_METRICS_CAPABILITY))fail();await args[1].assertValid();capabilities();
            if(!options.capabilities.has(MANAGED_DATABASE_METRICS_CAPABILITY))fail();
        }},args[2])}:{})});
    } catch {return fail();}
}
