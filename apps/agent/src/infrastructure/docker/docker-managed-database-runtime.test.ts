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
it("composes readonly health only with its explicit capability without Docker effects",()=>{
 const f=fixture(),capabilities=new InMemoryCapabilityRegistry(["database.runtime.v1","compose.resource.inspect.v1","database.runtime.health.v1"]);
 const runtime=createManagedDatabaseRuntime({...f.options,capabilities});
 expect(typeof (runtime as typeof runtime&{health?:unknown}).health).toBe("function");expect(Object.keys(runtime)).toEqual(["apply","health"]);
 expect(createManagedDatabaseRuntime(f.options)).not.toHaveProperty("health");expect(f.runner.run).not.toHaveBeenCalled();
});
it("composes scoped readonly metrics only with its explicit capability without Docker effects",()=>{const f=fixture(),capabilities=new InMemoryCapabilityRegistry(["database.runtime.v1","compose.resource.inspect.v1","database.runtime.metrics.v1"]);const runtime=createManagedDatabaseRuntime({...f.options,capabilities});expect(typeof (runtime as typeof runtime&{metrics?:unknown}).metrics).toBe("function");expect(Object.keys(runtime)).toEqual(["apply","metrics"]);expect(createManagedDatabaseRuntime(f.options)).not.toHaveProperty("metrics");expect(f.runner.run).not.toHaveBeenCalled();});
it("composes retained scoped logs only with explicit capability and no Docker effects", () => {
  const f = fixture(), capabilities = new InMemoryCapabilityRegistry(["database.runtime.v1", "compose.resource.inspect.v1", "database.runtime.logs.v1"]);
  const runtime = createManagedDatabaseRuntime({...f.options, capabilities});
  expect(typeof (runtime as typeof runtime & {logs?: unknown}).logs).toBe("function");
  expect(Object.keys(runtime)).toEqual(["apply", "logs"]);
  expect(createManagedDatabaseRuntime(f.options)).not.toHaveProperty("logs");
  expect(f.runner.run).not.toHaveBeenCalled();
});

it("composes confirmed removal only with explicit deletion and STOP capabilities and grace",()=>{
 const f=fixture(),capabilities=new InMemoryCapabilityRegistry(["database.runtime.v1","compose.resource.inspect.v1","database.runtime.stop.v1","database.runtime.delete.v1"]);
 const runtime=createManagedDatabaseRuntime({...f.options,capabilities,limits:{...f.options.limits,stopGraceSeconds:10}});
 expect(typeof (runtime as typeof runtime&{delete?:unknown}).delete).toBe("function");expect(createManagedDatabaseRuntime(f.options)).not.toHaveProperty("delete");
 expect(()=>createManagedDatabaseRuntime({...f.options,capabilities})).toThrow();expect(f.runner.run).not.toHaveBeenCalled();
});

it("rejects deletion capability without explicitly configured STOP grace before effects",()=>{
 const f=fixture(),capabilities=new InMemoryCapabilityRegistry(["database.runtime.v1","compose.resource.inspect.v1","database.runtime.stop.v1","database.runtime.delete.v1"]);
 expect(()=>createManagedDatabaseRuntime({...f.options,capabilities})).toThrow();expect(f.runner.run).not.toHaveBeenCalled();
});

it("requires explicit private archive and durable origin ports for the backup capability before effects",()=>{
  const f=fixture(),capabilities=new InMemoryCapabilityRegistry(["database.runtime.v1","compose.resource.inspect.v1","database.runtime.backup.v1"]);
  expect(()=>createManagedDatabaseRuntime({...f.options,capabilities})).toThrow();expect(f.runner.run).not.toHaveBeenCalled();
});
it("composes backup only from explicit existing destination/source/binary ports without touching paths",()=>{
  const f=fixture(),capabilities=new InMemoryCapabilityRegistry(["database.runtime.v1","compose.resource.inspect.v1","database.runtime.backup.v1"]);
  const runner={runBinaryToSink:vi.fn(async()=>{throw new Error("no capture expected");})};
  const replayStore={durable:true,lookupByFingerprintDigest:vi.fn(async()=>null)};
  const backup={destinations:new Map([["destination-a","/private/configured-archive"]]),runner,replayStore,maxBytes:10000};
  const runtime=createManagedDatabaseRuntime({...f.options,capabilities,backup} as any);
  expect(typeof (runtime as any).backup).toBe("function");expect(Object.keys(runtime)).toEqual(["apply","backup"]);
  expect(f.runner.run).not.toHaveBeenCalled();expect(runner.runBinaryToSink).not.toHaveBeenCalled();expect(replayStore.lookupByFingerprintDigest).not.toHaveBeenCalled();
});
it("rejects malformed backup ports/budgets or absent capability without discovering a destination",()=>{
  const f=fixture(),capabilities=new InMemoryCapabilityRegistry(["database.runtime.v1","compose.resource.inspect.v1","database.runtime.backup.v1"]);
  const backup={destinations:new Map([["destination-a","/private/configured-archive"]]),runner:{runBinaryToSink:vi.fn(async()=>{throw new Error("no capture expected");})},replayStore:{durable:true,lookupByFingerprintDigest:vi.fn(async()=>null)},maxBytes:10000};
  for(const patch of [{maxBytes:0},{replayStore:{...backup.replayStore,durable:false}},{replayStore:{durable:true}},{runner:{}}])
    expect(()=>createManagedDatabaseRuntime({...f.options,capabilities,backup:{...backup,...patch}} as any)).toThrow();
  expect(()=>createManagedDatabaseRuntime({...f.options,backup} as any)).toThrow();expect(f.runner.run).not.toHaveBeenCalled();
});


function confirmedRestoreRuntime(){const f=fixture(),capabilities=new InMemoryCapabilityRegistry(["database.runtime.v1","compose.resource.inspect.v1","database.runtime.backup.v1","database.runtime.stop.v1","database.runtime.start.v1","database.runtime.restore.v1"]),binary={runBinaryToSink:vi.fn(async()=>{throw new Error("Unexpected backup");}),runBinaryFromSource:vi.fn(async()=>{throw new Error("Unexpected restore");})},replayStore={durable:true,lookupByFingerprintDigest:vi.fn(async()=>null)};
 const options={...f.options,capabilities,limits:{...f.options.limits,stopGraceSeconds:10},backup:{destinations:new Map([["destination-a","/private/configured-archive"]]),runner:binary,replayStore,maxBytes:10000}};return {...f,options,binary,replayStore};}
it("composes confirmed five-engine restore only from explicit original backup/readiness/helper ports without runtime effects",()=>{const f=confirmedRestoreRuntime(),runtime=createManagedDatabaseRuntime(f.options);expect(runtime).toHaveProperty("restore",expect.any(Function));expect(Object.isFrozen(runtime)).toBe(true);expect(f.runner.run).not.toHaveBeenCalled();expect(f.binary.runBinaryFromSource).not.toHaveBeenCalled();expect(f.replayStore.lookupByFingerprintDigest).not.toHaveBeenCalled();});
it.each(["binary","stop","start","budget"])("refuses requested restore without %s prerequisite before runtime access",mode=>{const f=confirmedRestoreRuntime();if(mode==="binary")Object.assign(f.options.backup.runner,{runBinaryFromSource:undefined});if(mode==="stop")Object.assign(f.options.limits,{stopGraceSeconds:undefined});if(mode==="start")f.options.capabilities=new InMemoryCapabilityRegistry(["database.runtime.v1","compose.resource.inspect.v1","database.runtime.backup.v1","database.runtime.stop.v1","database.runtime.restore.v1"]);if(mode==="budget")f.options.backup.maxBytes=100;expect(()=>createManagedDatabaseRuntime(f.options)).toThrow();expect(f.runner.run).not.toHaveBeenCalled();});
it("leaves existing backup-only runtime without restore effects when capability is absent",()=>{const f=confirmedRestoreRuntime();f.options.capabilities=new InMemoryCapabilityRegistry(["database.runtime.v1","compose.resource.inspect.v1","database.runtime.backup.v1","database.runtime.stop.v1","database.runtime.start.v1"]);expect(createManagedDatabaseRuntime(f.options)).not.toHaveProperty("restore");expect(f.binary.runBinaryFromSource).not.toHaveBeenCalled();});
