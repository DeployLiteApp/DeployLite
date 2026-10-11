import {expect,it} from "vitest";
import {managedDatabaseRuntimeReceiptSchema,type ManagedDatabaseEngineV1} from "@deploylite/contracts";
import {planManagedDatabaseProfile,managedDatabaseRuntimeExecutionDigest} from "@deploylite/domain";
import {buildManagedDatabaseBackupSource,buildConsistentManagedDatabaseBackupArgv} from "./docker-managed-database-backup-source.js";
const engines=["postgres","mysql","mariadb","mongodb","redis"] as const;
function fixture(engine:ManagedDatabaseEngineV1="postgres"){
 const imagePolicy={policyVersion:"images-1",trustedHosts:["registry.example.com"],allowTags:false,allowDigests:true};
 const request={schemaVersion:1 as const,projectId:"project-a",databaseId:"orders",engine};
 const profile={schemaVersion:1,profileId:"profile-"+engine,engine,image:`registry.example.com/${engine}@sha256:${"a".repeat(64)}`,dataPath:{postgres:"/var/lib/postgresql",mysql:"/var/lib/mysql",mariadb:"/var/lib/mysql",mongodb:"/data/db",redis:"/data"}[engine],containerPort:{postgres:5432,mysql:3306,mariadb:3306,mongodb:27017,redis:6379}[engine],credentialKeys:["DATABASE_PASSWORD"],backupStrategy:engine==="redis"?"volume-quiesced":"engine-native"};
 const plan=planManagedDatabaseProfile(request,profile,imagePolicy),input={...request,profileId:profile.profileId,planDigest:plan.planDigest,environmentFingerprint:"b".repeat(32)};
 const originalReceipt=managedDatabaseRuntimeReceiptSchema.parse({...request,action:"database.runtime",agentId:"agent-a",commandId:"origin-a",inputDigest:managedDatabaseRuntimeExecutionDigest(input),planDigest:plan.planDigest,environmentFingerprint:input.environmentFingerprint,correlationId:"origin-correlation",containerId:"c".repeat(64),imageId:"sha256:"+"d".repeat(64),volumeName:plan.volume.runtimeName,networkName:plan.network.runtimeName,networkId:"e".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",observedAt:1000,status:"ready",health:"passed",storage:"verified",idempotent:false,redacted:true});
 return {source:{...input,originalReceipt,originalReplayFingerprint:"f".repeat(64)},options:{agentId:"agent-a",profile,imagePolicy},plan};
}
it.each(engines)("prepares only original approved %s backup source and explicit strategy",engine=>{
 const f=fixture(engine),value=buildManagedDatabaseBackupSource(f.source,f.options);
 expect(value).toMatchObject({engine,projectId:"project-a",databaseId:"orders",containerId:f.source.originalReceipt.containerId,imageId:f.source.originalReceipt.imageId,volumeName:f.plan.volume.runtimeName,volumeCreatedAt:f.source.originalReceipt.volumeCreatedAt,executionAllowed:false});
 expect(Object.isFrozen(value)).toBe(true);
 if(engine==="redis")expect(value).toMatchObject({strategy:"volume-quiesced",format:"volume-tar",consistencyRequirement:"all-consumers-stopped",argv:null});
 else {expect(value).toMatchObject({strategy:"engine-native"});expect(value!.argv?.slice(0,4)).toEqual(["docker","exec",f.source.originalReceipt.containerId,"bash"]);expect(Object.isFrozen(value!.argv)).toBe(true);}
});
it("rejects detached source scope, original digest, physical names and caller secrets",()=>{
 const f=fixture();for(const patch of [{projectId:"other"},{password:"private"},{originalReceipt:{...f.source.originalReceipt,inputDigest:"0".repeat(64)}},{originalReceipt:{...f.source.originalReceipt,volumeName:f.source.originalReceipt.volumeName.replace("orders","other")}}, {originalReceipt:{...f.source.originalReceipt,networkName:f.source.originalReceipt.networkName.replace("orders","other")}}])expect(()=>buildManagedDatabaseBackupSource({...f.source,...patch},f.options)).toThrow("Backup source is unavailable.");
});
it("rejects foreign agent, withdrawn image policy and changed configured profile",()=>{
 const f=fixture();for(const patch of [{agentId:"foreign"},{imagePolicy:{...f.options.imagePolicy,trustedHosts:[]}},{profile:{...f.options.profile,profileId:"replacement"}},{profile:{...f.options.profile,backupStrategy:"volume-quiesced"}}])expect(()=>buildManagedDatabaseBackupSource(f.source,{...f.options,...patch})).toThrow("Backup source is unavailable.");
});
it("keeps database credentials out of host argv and requires real dump pipeline failure",()=>{
 for(const engine of engines.filter(x=>x!=="redis")){const f=fixture(engine),value=buildManagedDatabaseBackupSource(f.source,f.options)!;
  expect(value.argv).toContain("pipefail");expect(value.argv).not.toContain("--password");expect(value.argv?.join(" ")).not.toContain(" -p ");
 }
 const m=buildManagedDatabaseBackupSource(fixture("mongodb").source,fixture("mongodb").options)!;expect(m.argv?.at(-1)).toContain("--config=/dev/stdin");
});
it("does not turn native dump metadata into a database consistency claim",()=>{
 const expected={postgres:"native-snapshot",mysql:"global-read-lock",mariadb:"global-read-lock",mongodb:"quiesced-writes",redis:"all-consumers-stopped"};
 for(const engine of engines){const f=fixture(engine);expect(buildManagedDatabaseBackupSource(f.source,f.options)).toMatchObject({consistencyRequirement:expected[engine],executionAllowed:false});}
});

it.each(["mysql","mariadb"] as const)("requires %s whole dump read lock and container-owned authority deadline",engine=>{
 const f=fixture(engine),source=buildManagedDatabaseBackupSource(f.source,f.options);
 expect(source.consistencyRequirement).toBe("global-read-lock");
 const argv=buildConsistentManagedDatabaseBackupArgv(source,5000),script=argv.at(-1)!;
 expect(argv.slice(0,-1)).toEqual(source.argv!.slice(0,-1));expect(script).toContain("--lock-all-tables");expect(script).not.toContain("--single-transaction");
 expect(script).toContain("date +%s%3N");expect(script).toContain("5000");expect(script).toContain("timeout --signal=TERM --kill-after=1s");expect(script).toContain("pipefail");
 expect(script).toContain("remaining");expect(script).toContain("1000");expect(script).toContain("exec timeout");
});
it("refuses a SQL capture with an invalid authority deadline before process dispatch",()=>{
 const f=fixture("mysql"),source=buildManagedDatabaseBackupSource(f.source,f.options);
 for(const deadline of [0,-1,1.2,NaN,Number.MAX_SAFE_INTEGER+1])expect(()=>buildConsistentManagedDatabaseBackupArgv(source,deadline)).toThrow();
});

it("keeps MariaDB native archive database-neutral for isolated restore",()=>{const f=fixture("mariadb");expect(buildManagedDatabaseBackupSource(f.source,f.options).argv!.at(-1)).not.toContain("--databases");});

it("omits global GTID mutation from scoped MySQL restore archive",()=>{const f=fixture("mysql");expect(buildManagedDatabaseBackupSource(f.source,f.options).argv!.at(-1)).toContain("--set-gtid-purged=OFF");});
