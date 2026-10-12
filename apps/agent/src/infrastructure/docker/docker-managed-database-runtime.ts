import {validateAgentTransportKey} from "@deploylite/config";
import {COMPOSE_RESOURCE_INSPECTION_CAPABILITY, MANAGED_DATABASE_RUNTIME_CAPABILITY, type CapabilityRegistry, type Clock, type ImageReferencePolicyV1} from "@deploylite/contracts";
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
    limits: Readonly<{deadlineMs: number; maxOutputBytes: number; maxContainers: number; pollIntervalMs: number; cpus: number; memoryBytes: number; pidsLimit: number}>;
}>) {
    try {
        const options = {...supplied, profiles: structuredClone(supplied.profiles), imagePolicy: structuredClone(supplied.imagePolicy), limits: {...supplied.limits}};
        validateAgentTransportKey(options.trustKey);
        function capabilities() {
            if (!options.capabilities.has(MANAGED_DATABASE_RUNTIME_CAPABILITY) || !options.capabilities.has(COMPOSE_RESOURCE_INSPECTION_CAPABILITY)) fail();
        }
        capabilities();
        const profiles = validateManagedDatabaseRuntimeProfiles(options.profiles, options.imagePolicy);
        const shared = {...options, profiles};
        const nativeInspector = createManagedDatabaseDockerInspector(shared);
        const resources = createManagedDatabaseResourceMaterializer(shared);
        const composeInspector = createDockerComposeResourceInspector(shared);
        const preparation = createManagedDatabaseStartupPreparation({...shared, imageInspector: nativeInspector});
        const storage = createManagedDatabaseStorageInitializer({...shared, nativeInspector, resourceVerifier: resources, composeInspector});
        const processIdentityReader = createManagedDatabaseProcessIdentityReader(shared);
        const verifier = createManagedDatabaseReadinessVerifier({...shared, nativeInspector, resourceVerifier: resources, composeInspector, processIdentityReader});
        const starter = createManagedDatabaseDaemonStarter({...shared, nativeInspector, verifier});
        const executor = createManagedDatabaseRuntimeExecutor({...shared, preparation, resources, storage, starter});
        return Object.freeze({apply: async (...args: Parameters<typeof executor.apply>) => executor.apply(args[0], {assertValid: async () => {
            capabilities(); await args[1].assertValid(); capabilities();
        }}, args[2])});
    } catch {return fail();}
}
