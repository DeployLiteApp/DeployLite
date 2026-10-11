import {afterEach,expect,it,vi} from "vitest";
import {createHash} from "node:crypto";
import {mkdtemp,realpath,mkdir,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {gzipSync} from "node:zlib";
import {nativeDumpFixture} from "./p5-native-backup-fixture.js";
const parents:string[]=[];
afterEach(async()=>{await Promise.all(parents.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function fixture(engine:"postgres"|"mysql"|"mariadb"="postgres") {
  const parent=await mkdtemp(join(await realpath(tmpdir()),"deploylite-native-fixture-unit-"));parents.push(parent);
  const root=join(parent,"private"),dump=nativeDumpFixture(root);await dump.open();
  const bytes=gzipSync(Buffer.from(engine==="postgres"?"PGDMPfixture":"CREATE TABLE `p5_probe` (value varchar(64)); INSERT INTO `p5_probe` VALUES (\'p5-persistent-value\'); CREATE TABLE `p5_nontransactional` (value varchar(64)) ENGINE=MyISAM; INSERT INTO `p5_nontransactional` VALUES (\'p5-nontransactional-value\');")),manifest=Buffer.from('{"fixture":true}'),hash=(value:Buffer)=>createHash("sha256").update(value).digest("hex");
  const receipt={schemaVersion:1,projectId:"project-a",databaseId:"orders",engine,action:"database.runtime.backup",agentId:"agent-a",commandId:"66666666-6666-4666-8666-666666666666",originalCommandId:"original-a",profileId:"profile-a",inputDigest:"a".repeat(64),planDigest:"b".repeat(64),environmentFingerprint:"c".repeat(32),correlationId:"backup-correlation",containerId:"d".repeat(64),imageId:"sha256:"+"e".repeat(64),volumeName:"dl-"+"f".repeat(32)+"-vol-db-orders",networkName:"dl-"+"f".repeat(32)+"-net-db-orders",networkId:"a".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",volumeKey:"db-orders",observedAt:2000,destinationId:"private-native",sourceDigest:"b".repeat(64),format:engine==="postgres"?"postgres-custom-gzip":engine+"-sql-gzip",consistency:engine==="postgres"?"native-snapshot":"global-read-lock",status:"created",storage:"verified",archiveId:"backup_"+"c".repeat(32),archiveBytes:bytes.length,archiveSha256:hash(bytes),manifestSha256:hash(manifest),idempotent:false,redacted:true};
  const archive=join(root,receipt.archiveId);await mkdir(archive,{mode:0o700});await writeFile(join(archive,"archive.bin"),bytes,{mode:0o600});await writeFile(join(archive,"manifest.json"),manifest,{mode:0o600});
  let calls=0;
  const call=vi.fn(async()=>{const data={receipt,command:{id:receipt.commandId},backupCreated:true,idempotent:calls++>0};return {statusCode:200,body:JSON.stringify({data}),json:()=>({data})};});
  const run=vi.fn(async(_bytes:Buffer)=>{});
  const records=[{schemaVersion:1 as const,receipt,createdAtMs:2000}];
  const input={call,reopen:vi.fn(async()=>{}),inventory:()=>({list:async()=>records}) as any,verify:vi.fn(async()=>({uid:999})),decode:run,signal:new AbortController().signal,captures:()=>1,maxBytes:2097152,originalContainerId:receipt.containerId,uid:999,writerProbe:vi.fn(async()=>{})};
  return {dump,input,run,directory:archive,copied:"/tmp/dl-native-backup-"+receipt.commandId+".gz"};
}
it("gives private bytes only to the corroborated non-root decoder",async()=>{
 const f=await fixture();await f.dump.prove(f.input);
 expect(f.run).toHaveBeenCalledTimes(1);expect(f.run.mock.calls[0]![0]).toBeInstanceOf(Buffer);
 expect(f.input.verify).toHaveBeenCalledTimes(2);await f.dump.close();
});
it("refuses a missing or root decoder UID before API or Docker effects",async()=>{
 for(const uid of [undefined,0,-1,1.2,4294967295]){const f=await fixture();
  await expect(f.dump.prove({...f.input,uid} as any)).rejects.toThrow();expect(f.input.call).not.toHaveBeenCalled();expect(f.run).not.toHaveBeenCalled();await f.dump.close();
 }
});

it("bounds a failing restore without reflecting private diagnostics",async()=>{
 const f=await fixture();f.run.mockImplementation(async()=>{throw new Error("password=fake-private");});
 await expect(f.dump.prove(f.input)).rejects.toThrow("Private native dump fixture failed at restore.");
 await f.dump.close();
});
it.each(["archive.bin","manifest.json"])("rejects changed private %s using a bounded error without reflecting bytes",async file=>{
 const f=await fixture();f.input.reopen.mockImplementation(async()=>{await writeFile(join(f.directory,file),Buffer.from("private-fixture-data"));});
 await expect(f.dump.prove(f.input)).rejects.toThrow(file==="archive.bin"?"Private native archive changed.":"Private native manifest changed.");await f.dump.close();
});

it.each(["mysql","mariadb"] as const)("verifies private %s transactional and MyISAM rows and actual writer resume",async engine=>{
 const f=await fixture(engine),proof=await f.dump.prove(f.input);expect(proof.writersResumed).toBe("passed");expect(f.input.writerProbe).toHaveBeenCalledOnce();expect(f.run).not.toHaveBeenCalled();await f.dump.close();
});
it("withholds SQL proof if the post-dump write probe fails without reflecting private output",async()=>{
 const f=await fixture("mysql");f.input.writerProbe.mockRejectedValue(new Error("password=fake-private"));await expect(f.dump.prove(f.input)).rejects.toThrow("Native SQL writers did not resume.");await f.dump.close();
});
