import {expect,it,vi} from "vitest";
import {createManagedDatabaseComposePreview,digestComposeResourceObservation,digestControlInput,planManagedDatabaseProfile} from "@deploylite/domain";
import {createManagedDatabaseReadinessVerifier} from "./docker-managed-database-readiness.js";
import type {ManagedDatabaseContainerObservation} from "./docker-managed-database-inspection.js";
import {managedDatabaseContainerName} from "./docker-managed-database-argv.js";
import {createManagedDatabaseHealthObserver} from "./docker-managed-database-health.js";
const containerId = "b".repeat(64), imageId = "sha256:" + "c".repeat(64), environmentFingerprint = "d".repeat(32);
function fixture(engine: "postgres" | "mysql" | "mariadb" | "mongodb" | "redis" = "postgres") {
    const imagePolicy = { policyVersion: "images-1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true };
    const request = { schemaVersion: 1, projectId: "project-a", databaseId: "orders", engine };
    const profile = { schemaVersion: 1, profileId: "profile-a", engine, image: `registry.example.com/${engine}@sha256:${"a".repeat(64)}`, dataPath: {postgres:"/var/lib/postgresql/data",mysql:"/var/lib/mysql",mariadb:"/var/lib/mysql",mongodb:"/data/db",redis:"/data"}[engine], containerPort: {postgres:5432,mysql:3306,mariadb:3306,mongodb:27017,redis:6379}[engine], credentialKeys: ["DATABASE_PASSWORD"], backupStrategy: engine === "redis" ? "volume-quiesced" : "engine-native" };
    const plan = planManagedDatabaseProfile(request, profile, imagePolicy), preview = createManagedDatabaseComposePreview(request, profile, imagePolicy);
    const original = { projectId: request.projectId, databaseId: request.databaseId, commandId: "command-a", planDigest: plan.planDigest, volume: { name: plan.volume.runtimeName, createdAt: "2026-10-10T00:00:00Z" }, network: { name: plan.network.runtimeName, id: "e".repeat(64) } };
    const input = { request, profile, commandId: "command-a", imageId, containerId, environmentFingerprint };
    const metadata: ManagedDatabaseContainerObservation = { id: containerId, name: "/" + managedDatabaseContainerName(request.projectId, request.databaseId), imageId, image: profile.image, owner: "deploylite", projectId: request.projectId, databaseId: request.databaseId, engine, commandId: "command-a", planDigest: plan.planDigest, environmentFingerprint,
        networkMode: plan.network.runtimeName, storageInitialization: null, running: true, health: "healthy", user: {postgres:"postgres",mysql:"mysql",mariadb:"mysql",mongodb:"mongodb",redis:"redis"}[engine], readOnly: true, privileged: false, capAdd: null, capDrop: ["ALL"], securityOpt: ["no-new-privileges"], cpu: 1000000000, memory: 536870912, pids: 256, ports: null };
    let extra = false;
    const resourceVerifier = { verifyFresh: vi.fn(async () => structuredClone(original)) };
    const nativeInspector = { inspectImage: vi.fn(async () => ({ imageId, declaredVolumes: [profile.dataPath] })), inspectContainer: vi.fn(async () => structuredClone(metadata)) };
    const composeInspector = { inspect: vi.fn(async ({ kind }: any) => {
            const consumer = { containerId, service: plan.volume.key, running: metadata.running, attached: true, composeConfigDigest: preview.configDigest, composeEnvironmentDigest: digestControlInput({ environmentFingerprint }), networks: [{ name: plan.network.runtimeName, networkId: original.network.id }], mounts: kind === "volume" ? [{ target: plan.volume.target, readOnly: false }] : [] };
            const value: any = { schemaVersion: 1, owner: "deploylite", agentId: "agent-a", projectId: request.projectId, kind, key: plan.volume.key, runtimeName: kind === "volume" ? plan.volume.runtimeName : plan.network.runtimeName, physicalIdentity: kind === "volume" ? original.volume.createdAt : original.network.id, configDigest: preview.configDigest, observedAt: 1000, stateDigest: "0".repeat(64), containers: [consumer, ...(extra ? [{ ...consumer, containerId: "f".repeat(64) }] : [])] };
            value.stateDigest = digestComposeResourceObservation(value);
            return value;
        }) };
    const processIdentityReader = { verify: vi.fn(async () => ({ uid: 999, daemon: {postgres:"postgres",mysql:"mysqld",mariadb:"mariadbd",mongodb:"mongod",redis:"redis-server"}[engine] })) }, authority = { assertValid: vi.fn(async () => { }) };
    const options = { owner: "deploylite", agentId: "agent-a", imagePolicy, resourceVerifier, nativeInspector, composeInspector, processIdentityReader, clock: { now: () => 1000 }, limits: { deadlineMs: 1000, cpus: 1, memoryBytes: 536870912, pidsLimit: 256 } };
    return { input, original, metadata, options, nativeInspector, composeInspector, resourceVerifier, processIdentityReader, authority, addConsumer: () => { extra = true; }, verifier: createManagedDatabaseReadinessVerifier(options) };
}
function observe(f:ReturnType<typeof fixture>,deadlineMs=1000){return createManagedDatabaseHealthObserver({nativeInspector:f.nativeInspector,verifier:f.verifier,imagePolicy:f.options.imagePolicy,clock:f.options.clock,limits:{deadlineMs}}).observe(f.input,f.original,f.authority,new AbortController().signal);}
for(const engine of ["postgres","mysql","mariadb","mongodb","redis"] as const)it(`observes scoped ${engine} nonroot health without secrets or lifecycle effects`,async()=>{
 const f=fixture(engine);expect(await observe(f)).toEqual({schemaVersion:1,projectId:"project-a",databaseId:"orders",engine,containerId,imageId,uid:999,state:"running",health:"healthy",observedAt:1000,redacted:true});
 expect(f.processIdentityReader.verify).toHaveBeenCalledOnce();expect(f.resourceVerifier.verifyFresh).toHaveBeenCalledTimes(2);
});
it("reports unhealthy, starting and absent running health without claiming readiness",async()=>{
 for(const health of ["unhealthy","starting",null] as const){const f=fixture();f.metadata.health=health;expect(await observe(f)).toMatchObject({state:"running",health:health??"unknown",uid:999});}
});
it("corroborates stopped storage without executing PID1 or claiming health",async()=>{
 const f=fixture();f.metadata.running=false;f.metadata.health=null;expect(await observe(f)).toMatchObject({state:"stopped",health:"not-running",uid:null});expect(f.processIdentityReader.verify).not.toHaveBeenCalled();
});
it("withholds a changed observation across physical verification",async()=>{
 const f=fixture();f.processIdentityReader.verify.mockImplementation(async()=>{f.metadata.health="unhealthy";return {uid:999,daemon:"postgres"};});
 await expect(observe(f)).rejects.toThrow(/^Database health is unavailable\.$/);
});
it("rejects foreign scope, mutated storage and current authorization",async()=>{
 for(const patch of [{owner:"foreign"},{projectId:"foreign"},{privileged:true},{user:"0:0"}]){const f=fixture();Object.assign(f.metadata,patch);await expect(observe(f)).rejects.toThrow(/^Database health is unavailable\.$/);}
 const f=fixture();f.authority.assertValid.mockRejectedValue(new Error("private-credential"));await expect(observe(f)).rejects.toThrow(/^Database health is unavailable\.$/);expect(f.nativeInspector.inspectContainer).not.toHaveBeenCalled();
});
it("bounds stalled observation and verifier ports and pre-cancellation",async()=>{
 for(const port of ["inspect","authority"] as const){const f=fixture();if(port==="inspect")f.nativeInspector.inspectContainer.mockImplementation(()=>new Promise<never>(()=>{}));else f.authority.assertValid.mockImplementation(()=>new Promise<never>(()=>{}));await expect(observe(f,5)).rejects.toThrow(/^Database health is unavailable\.$/);}
 const f=fixture(),controller=new AbortController();controller.abort();const reader=createManagedDatabaseHealthObserver({nativeInspector:f.nativeInspector,verifier:f.verifier,imagePolicy:f.options.imagePolicy,clock:f.options.clock,limits:{deadlineMs:1000}});
 await expect(reader.observe(f.input,f.original,f.authority,controller.signal)).rejects.toThrow();expect(f.nativeInspector.inspectContainer).not.toHaveBeenCalled();
});
it("withholds an invalid final observation timestamp",async()=>{
 const f=fixture();let finalReads=0,final=false;
 f.authority.assertValid.mockImplementation(async()=>{if(f.authority.assertValid.mock.calls.length===7)final=true;});
 f.options.clock.now=()=>final&&finalReads++>0?Number.NaN:1000;
 await expect(observe(f)).rejects.toThrow(/^Database health is unavailable\.$/);
});
