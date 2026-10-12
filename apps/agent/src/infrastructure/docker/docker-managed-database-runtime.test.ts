import {expect,it,vi} from "vitest";
import {InMemoryCapabilityRegistry} from "@deploylite/contracts";
import {createManagedDatabaseRuntime} from "./docker-managed-database-runtime.js";
function fixture(){
    const profiles=Object.fromEntries((["postgres","mysql","mariadb","mongodb","redis"] as const).map(engine=>[engine,{schemaVersion:1,profileId:"profile-"+engine,engine,image:`registry.example.com/${engine}@sha256:${"a".repeat(64)}`,
        dataPath:{postgres:"/var/lib/postgresql",mysql:"/var/lib/mysql",mariadb:"/var/lib/mysql",mongodb:"/data/db",redis:"/data"}[engine],containerPort:{postgres:5432,mysql:3306,mariadb:3306,mongodb:27017,redis:6379}[engine],credentialKeys:["DATABASE_PASSWORD"],backupStrategy:engine==="redis"?"volume-quiesced":"engine-native"}]));
    const runner={run:vi.fn(async()=>{throw new Error("no runtime access expected");})};
    const options={agentId:"agent-a",owner:"deploylite",trustKey:"test-agent-key-"+"x".repeat(64),profiles,imagePolicy:{policyVersion:"images-1",trustedHosts:["registry.example.com"],allowTags:false,allowDigests:true},
        capabilities:new InMemoryCapabilityRegistry(["database.runtime.v1","compose.resource.inspect.v1"]),clock:{now:()=>1000},runner,limits:{deadlineMs:60000,maxOutputBytes:131072,maxContainers:64,pollIntervalMs:100,cpus:1,memoryBytes:536870912,pidsLimit:256}};
    return {profiles,runner,options};
}
it("composes all five approved native engines without opening Docker or exposing configuration",()=>{
    const f=fixture(), runtime=createManagedDatabaseRuntime(f.options);
    expect(typeof runtime.apply).toBe("function");expect(Object.isFrozen(runtime)).toBe(true);expect(Object.keys(runtime)).toEqual(["apply"]);expect(f.runner.run).not.toHaveBeenCalled();
});
it("refuses missing, mismatched or extra engine profiles before any runtime access",()=>{
    const f=fixture();
    const {redis:_,...missing}=f.profiles;
    for(const profiles of [missing,{...f.profiles,redis:{...f.profiles.redis,engine:"postgres"}},{...f.profiles,extra:f.profiles.postgres}])expect(()=>createManagedDatabaseRuntime({...f.options,profiles})).toThrow();
    expect(f.runner.run).not.toHaveBeenCalled();
});
it("requires explicit immutable approved images and native storage/credential policy",()=>{
    const f=fixture();
    for(const patch of [{image:"registry.example.com/postgres:latest"},{dataPath:"/private"},{containerPort:1234},{credentialKeys:["UNAPPROVED"]},{backupStrategy:"volume-quiesced"}])expect(()=>createManagedDatabaseRuntime({...f.options,profiles:{...f.profiles,postgres:{...f.profiles.postgres,...patch}}})).toThrow();
    expect(f.runner.run).not.toHaveBeenCalled();
});
it("requires the declared native and existing read-only inspection capabilities",()=>{
    const f=fixture();
    for(const capabilities of [[],["database.runtime.v1"],["compose.resource.inspect.v1"]])expect(()=>createManagedDatabaseRuntime({...f.options,capabilities:new InMemoryCapabilityRegistry(capabilities)})).toThrow();
    expect(f.runner.run).not.toHaveBeenCalled();
});

it("composes stop only with an explicit bounded grace and capability without runtime effects",()=>{
    const f=fixture(),options={...f.options,capabilities:new InMemoryCapabilityRegistry(["database.runtime.v1","compose.resource.inspect.v1","database.runtime.stop.v1"]),limits:{...f.options.limits,stopGraceSeconds:10}};
    const runtime=createManagedDatabaseRuntime(options);expect(typeof runtime.stop).toBe("function");expect(typeof runtime.apply).toBe("function");expect(f.runner.run).not.toHaveBeenCalled();
    expect(createManagedDatabaseRuntime(f.options)).not.toHaveProperty("stop");
    expect(()=>createManagedDatabaseRuntime({...options,capabilities:f.options.capabilities})).toThrow();
    for(const grace of [0,31,1.5])expect(()=>createManagedDatabaseRuntime({...options,limits:{...options.limits,stopGraceSeconds:grace}})).toThrow();
});

it("composes original-daemon start only with its explicit capability without runtime effects",()=>{
    const f=fixture(),capabilities=new InMemoryCapabilityRegistry(["database.runtime.v1","compose.resource.inspect.v1","database.runtime.start.v1"]);
    const runtime=createManagedDatabaseRuntime({...f.options,capabilities});
    expect(typeof (runtime as typeof runtime & {start?:unknown}).start).toBe("function");
    expect(Object.keys(runtime)).toEqual(["apply","start"]);expect(Object.isFrozen(runtime)).toBe(true);
    expect(createManagedDatabaseRuntime(f.options)).not.toHaveProperty("start");expect(f.runner.run).not.toHaveBeenCalled();
});
