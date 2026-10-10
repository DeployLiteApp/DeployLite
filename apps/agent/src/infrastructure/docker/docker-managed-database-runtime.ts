import {validateAgentTransportKey} from "@deploylite/config";
import {approvedManagedDatabaseProfileSchema, COMPOSE_RESOURCE_INSPECTION_CAPABILITY, MANAGED_DATABASE_RUNTIME_CAPABILITY, type CapabilityRegistry, type Clock, type ImageReferencePolicyV1} from "@deploylite/contracts";
import {planManagedDatabaseProfile} from "@deploylite/domain";
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
const engines = ["postgres", "mysql", "mariadb", "mongodb", "redis"] as const;
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
        if (!options.profiles || typeof options.profiles !== "object" || Array.isArray(options.profiles)
            || JSON.stringify(Object.keys(options.profiles).sort()) !== JSON.stringify([...engines].sort())) fail();
        const profiles = {} as Record<typeof engines[number], ReturnType<typeof approvedManagedDatabaseProfileSchema.parse>>;
        const paths = {postgres: ["/var/lib/postgresql", "/var/lib/postgresql/data"], mysql: ["/var/lib/mysql"], mariadb: ["/var/lib/mysql"], mongodb: ["/data/db"], redis: ["/data"]};
        for (const engine of engines) {
            const profile = approvedManagedDatabaseProfileSchema.parse((options.profiles as Record<string, unknown>)[engine]);
            if (profile.engine !== engine || !paths[engine].includes(profile.dataPath) || !profile.credentialKeys.includes("DATABASE_PASSWORD")
                || profile.credentialKeys.some(key => key !== "DATABASE_PASSWORD" && !(key === "DATABASE_ROOT_PASSWORD" && ["mysql", "mariadb"].includes(engine)))) fail();
            // Pure profile validation only; this probe creates no project, resource or receipt.
            planManagedDatabaseProfile({schemaVersion: 1, projectId: "profile-validation", databaseId: "validate", engine}, profile, options.imagePolicy);
            profiles[engine] = profile;
        }
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
