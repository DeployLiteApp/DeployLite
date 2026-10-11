import {createHash} from "node:crypto";
import {mkdtemp,realpath,rm,readFile,readdir,writeFile,chmod,symlink,rename,open} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,expect,it,vi} from "vitest";
import {composeRuntimeResourceName,managedDatabaseRuntimeExecutionDigest,managedDatabaseBackupExecutionDigest,managedDatabaseBackupSourceDigest} from "@deploylite/domain";
import {createPrivateNativeBackupArchive} from "./docker-managed-database-backup-archive.js";
import {createPrivateNativeRestoreArchive} from "./docker-managed-database-restore-archive.js";
const roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const engines=["postgres","mysql","mariadb","mongodb","redis"] as const;
async function fixture(engine:typeof engines[number]="postgres"){
 const root=await mkdtemp(join(await realpath(tmpdir()),"deploylite-restore-archive-"));roots.push(root);
 const source={schemaVersion:1,projectId:"project-a",databaseId:"orders",engine,profileId:"profile-a",planDigest:"a".repeat(64),environmentFingerprint:"b".repeat(32)};
 const {profileId:_profile,...originalSource}=source;
 const originalReceipt={...originalSource,action:"database.runtime",agentId:"agent-a",commandId:"original-a",inputDigest:managedDatabaseRuntimeExecutionDigest(source),correlationId:"original-correlation",containerId:"c".repeat(64),imageId:"sha256:"+"d".repeat(64),volumeName:composeRuntimeResourceName(source.projectId,"volume","db-orders"),networkName:composeRuntimeResourceName(source.projectId,"network","db-orders"),networkId:"e".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",observedAt:1000,status:"ready",health:"passed",storage:"verified",idempotent:false,redacted:true};
 const target={...source,originalReceipt,originalReplayFingerprint:"f".repeat(64)},capture={...target,destinationId:"destination-a",maxBytes:10000};
 const format={postgres:"postgres-custom-gzip",mysql:"mysql-sql-gzip",mariadb:"mariadb-sql-gzip",mongodb:"mongodb-archive-gzip",redis:"volume-tar"}[engine];
 const binding={projectId:source.projectId,commandId:"backup-a",inputDigest:managedDatabaseBackupExecutionDigest(capture),agentId:"agent-a",correlationId:"backup-correlation",destinationId:capture.destinationId,sourceDigest:managedDatabaseBackupSourceDigest(capture),format};
 const options={destinations:new Map([[capture.destinationId,root]]),expectedAgentId:"agent-a",clock:{now:Date.now},maxBytes:10000,maxDurationMs:1000};
 const data=Buffer.from("private-database-fixture"),sha256=createHash("sha256").update(data).digest("hex");
 const archive=await createPrivateNativeBackupArchive(options).write(binding,async write=>{await write(data);return {bytes:data.length,sha256};},{projectId:binding.projectId,commandId:binding.commandId,inputDigest:binding.inputDigest,assertValid:async()=>{}},new AbortController().signal);
 const {status:_status,health:_health,...physical}=originalReceipt;
 const backupReceipt={...physical,...binding,...archive,schemaVersion:1,profileId:source.profileId,action:"database.runtime.backup",originalCommandId:originalReceipt.commandId,observedAt:2000,volumeKey:"db-orders",consistency:{postgres:"native-snapshot",mysql:"global-read-lock",mariadb:"global-read-lock",mongodb:"quiesced-writes",redis:"all-consumers-stopped"}[engine],status:"created"};
 return {root,options,data,preparation:{...target,backupReceipt,maxBytes:10000},directory:join(root,archive.archiveId),signal:new AbortController().signal};
}
it.each(engines)("verifies immutable %s archive integrity without returning private bytes or paths",async engine=>{
 const f=await fixture(engine),pending=createPrivateNativeRestoreArchive(f.options).verify(f.preparation,f.signal);
 await expect(pending).resolves.toEqual({archiveId:f.preparation.backupReceipt.archiveId,archiveBytes:f.data.length,archiveSha256:f.preparation.backupReceipt.archiveSha256,manifestSha256:f.preparation.backupReceipt.manifestSha256,format:f.preparation.backupReceipt.format,integrity:"verified",redacted:true});
 const result=await pending;expect(JSON.stringify(result)).not.toContain(f.root);expect(JSON.stringify(result)).not.toContain(f.data.toString());expect(await readdir(f.directory)).toEqual(["archive.bin","manifest.json"]);
});

it("rejects changed bytes while preserving the existing archive",async()=>{
 const f=await fixture(),path=join(f.directory,"archive.bin"),changed=Buffer.alloc(f.data.length,120);await writeFile(path,changed);
 await expect(createPrivateNativeRestoreArchive(f.options).verify(f.preparation,f.signal)).rejects.toThrow("Native restore archive is unavailable.");expect(await readFile(path)).toEqual(changed);
});
it("rejects detached manifest and expected manifest digest",async()=>{
 const f=await fixture(),path=join(f.directory,"manifest.json");await writeFile(path,JSON.stringify({...JSON.parse((await readFile(path)).toString()),agentId:"foreign"}));
 await expect(createPrivateNativeRestoreArchive(f.options).verify(f.preparation,f.signal)).rejects.toThrow("Native restore archive is unavailable.");
 const g=await fixture();await expect(createPrivateNativeRestoreArchive(g.options).verify({...g.preparation,backupReceipt:{...g.preparation.backupReceipt,manifestSha256:"0".repeat(64)}},g.signal)).rejects.toThrow("Native restore archive is unavailable.");
});
it("refuses unknown destinations and a foreign configured agent",async()=>{
 const f=await fixture();for(const options of [{...f.options,destinations:new Map()},{...f.options,expectedAgentId:"foreign"}])await expect(createPrivateNativeRestoreArchive(options).verify(f.preparation,f.signal)).rejects.toThrow("Native restore archive is unavailable.");
});
it.each(["archive.bin","manifest.json"])("refuses the symlinked %s even when its target has matching bytes",async name=>{
 const f=await fixture(),path=join(f.directory,name);await rename(path,path+".original");await symlink(path+".original",path);
 await expect(createPrivateNativeRestoreArchive(f.options).verify(f.preparation,f.signal)).rejects.toThrow("Native restore archive is unavailable.");
});
it.each(["root","directory","archive.bin","manifest.json"])("refuses non-private %s permissions",async name=>{
 const f=await fixture(),path=name==="root"?f.root:name==="directory"?f.directory:join(f.directory,name);await chmod(path,name.endsWith(".bin")||name.endsWith(".json")?0o644:0o755);
 await expect(createPrivateNativeRestoreArchive(f.options).verify(f.preparation,f.signal)).rejects.toThrow("Native restore archive is unavailable.");
});
it("enforces configured byte budget and cancellation before reading",async()=>{
 const f=await fixture();await expect(createPrivateNativeRestoreArchive({...f.options,maxBytes:2}).verify(f.preparation,f.signal)).rejects.toThrow("Native restore archive is unavailable.");
 const cancelled=new AbortController();cancelled.abort();await expect(createPrivateNativeRestoreArchive(f.options).verify(f.preparation,cancelled.signal)).rejects.toThrow("Native restore archive is unavailable.");
});
it.each([{maxBytes:0},{maxDurationMs:0},{maxDurationMs:2147483648}])("rejects unusable configured limits $maxBytes/$maxDurationMs",async patch=>{
 const f=await fixture();expect(()=>createPrivateNativeRestoreArchive({...f.options,...patch})).toThrow("Native restore archive is unavailable.");
});
it("rejects an inode replacement during hashing even if the replacement bytes match",async()=>{
 const f=await fixture(),path=join(f.directory,"archive.bin"),probe=await open(path,"r"),prototype=Object.getPrototypeOf(probe),read=prototype.read;await probe.close();let replaced=false;
 vi.spyOn(prototype,"read").mockImplementation(async function(this:any,...args:any[]){const result=await read.apply(this,args);if(!replaced&&(await this.stat()).size===f.data.length){replaced=true;await rename(path,path+".original");await writeFile(path,f.data,{mode:0o600});}return result;});
 await expect(createPrivateNativeRestoreArchive(f.options).verify(f.preparation,f.signal)).rejects.toThrow("Native restore archive is unavailable.");expect(replaced).toBe(true);
});
it("bounds a private read that does not settle",async()=>{
 const f=await fixture(),probe=await open(join(f.directory,"archive.bin"),"r"),prototype=Object.getPrototypeOf(probe);await probe.close();vi.spyOn(prototype,"read").mockImplementation(()=>new Promise(()=>{}));
 await expect(createPrivateNativeRestoreArchive({...f.options,maxDurationMs:10}).verify(f.preparation,f.signal)).rejects.toThrow("Native restore archive is unavailable.");
},2000);

it("binds manifest fields even when a detached manifest has its own matching expected hash",async()=>{
 const f=await fixture(),path=join(f.directory,"manifest.json"),bytes=Buffer.from(JSON.stringify({...JSON.parse((await readFile(path)).toString()),correlationId:"detached-correlation"}));await writeFile(path,bytes);
 await expect(createPrivateNativeRestoreArchive(f.options).verify({...f.preparation,backupReceipt:{...f.preparation.backupReceipt,manifestSha256:createHash("sha256").update(bytes).digest("hex")}},f.signal)).rejects.toThrow("Native restore archive is unavailable.");
});
it("pins the configured destination map before a caller mutates its original map",async()=>{
 const f=await fixture(),verifier=createPrivateNativeRestoreArchive(f.options);f.options.destinations.clear();await expect(verifier.verify(f.preparation,f.signal)).resolves.toMatchObject({integrity:"verified"});
});
