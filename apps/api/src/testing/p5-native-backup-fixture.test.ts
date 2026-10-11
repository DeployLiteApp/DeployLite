import * as captureFixture from "./p5-native-backup-fixture.js";
import {afterEach,expect,it,vi} from "vitest";
import {createHash} from "node:crypto";
import {mkdtemp,realpath,mkdir,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {gzipSync} from "node:zlib";
import {nativeDumpFixture} from "./p5-native-backup-fixture.js";
const parents:string[]=[];
afterEach(async()=>{await Promise.all(parents.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function fixture(engine:"postgres"|"mysql"|"mariadb"|"mongodb"|"redis"="postgres") {
  const parent=await mkdtemp(join(await realpath(tmpdir()),"deploylite-native-fixture-unit-"));parents.push(parent);
  const root=join(parent,"private"),dump=nativeDumpFixture(root);await dump.open();
  const bytes=gzipSync(engine==="mongodb"?Buffer.from([0x6d,0xe2,0x99,0x81]):Buffer.from(engine==="postgres"?"PGDMPfixture":"CREATE TABLE `p5_probe` (value varchar(64)); INSERT INTO `p5_probe` VALUES (\'p5-persistent-value\'); CREATE TABLE `p5_nontransactional` (value varchar(64)) ENGINE=MyISAM; INSERT INTO `p5_nontransactional` VALUES (\'p5-nontransactional-value\');")),manifest=Buffer.from('{"fixture":true}'),hash=(value:Buffer)=>createHash("sha256").update(value).digest("hex");
  const receipt={schemaVersion:1,projectId:"project-a",databaseId:"orders",engine,action:"database.runtime.backup",agentId:"agent-a",commandId:"66666666-6666-4666-8666-666666666666",originalCommandId:"original-a",profileId:"profile-a",inputDigest:"a".repeat(64),planDigest:"b".repeat(64),environmentFingerprint:"c".repeat(32),correlationId:"backup-correlation",containerId:"d".repeat(64),imageId:"sha256:"+"e".repeat(64),volumeName:"dl-"+"f".repeat(32)+"-vol-db-orders",networkName:"dl-"+"f".repeat(32)+"-net-db-orders",networkId:"a".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",volumeKey:"db-orders",observedAt:2000,destinationId:"private-native",sourceDigest:"b".repeat(64),format:engine==="mongodb"?"mongodb-archive-gzip":engine==="postgres"?"postgres-custom-gzip":engine+"-sql-gzip",consistency:engine==="mongodb"?"quiesced-writes":engine==="postgres"?"native-snapshot":"global-read-lock",status:"created",storage:"verified",archiveId:"backup_"+"c".repeat(32),archiveBytes:bytes.length,archiveSha256:hash(bytes),manifestSha256:hash(manifest),idempotent:false,redacted:true};
  if(engine==="redis"){const tar=Buffer.alloc(2048);tar.write("dump.rdb");tar.write("ustar",257);Object.assign(receipt,{format:"volume-tar",consistency:"all-consumers-stopped",archiveBytes:tar.length,archiveSha256:hash(tar)});}
  const stored=engine==="redis"?Buffer.alloc(2048):bytes;if(engine==="redis"){stored.write("dump.rdb");stored.write("ustar",257);}
  const archive=join(root,receipt.archiveId);await mkdir(archive,{mode:0o700});await writeFile(join(archive,"archive.bin"),stored,{mode:0o600});await writeFile(join(archive,"manifest.json"),manifest,{mode:0o600});
  let calls=0;
  const call=vi.fn(async()=>{const data={receipt,command:{id:receipt.commandId},backupCreated:true,idempotent:calls++>0};return {statusCode:200,body:JSON.stringify({data}),json:()=>({data})};});
  const run=vi.fn(async(_bytes:Buffer)=>{});
  const records=[{schemaVersion:1 as const,receipt,createdAtMs:2000}];
  const input={call,reopen:vi.fn(async()=>{}),inventory:()=>({list:async()=>records}) as any,verify:vi.fn(async()=>({uid:999})),decode:run,signal:new AbortController().signal,captures:()=>1,maxBytes:2097152,originalContainerId:receipt.containerId,uid:999,stoppedSource:engine==="redis",writerProbe:vi.fn(async()=>{})};
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
 const f=await fixture(engine),proof=await f.dump.prove(f.input);expect(proof.writersResumed).toBe("passed");expect(f.input.writerProbe).toHaveBeenCalledOnce();expect(f.run).toHaveBeenCalledOnce();expect(proof).toMatchObject({restoredData:"passed",restoreCleanup:"passed"});await f.dump.close();
});
it("withholds SQL proof if the post-dump write probe fails without reflecting private output",async()=>{
 const f=await fixture("mysql");f.input.writerProbe.mockRejectedValue(new Error("password=fake-private"));await expect(f.dump.prove(f.input)).rejects.toThrow("Native SQL writers did not resume.");await f.dump.close();
});

it("proves private Redis tar restore, reopen and one-capture replay",async()=>{const f=await fixture("redis"),proof=await f.dump.prove(f.input);expect(proof).toMatchObject({stoppedSource:"passed",restoredData:"passed",restoreCleanup:"passed",sourceCleanup:"pending"});expect(f.run).toHaveBeenCalledOnce();await f.dump.close();});

it("requires Mongo archive magic, restored equality and resumed writers",async()=>{
 const f=await fixture("mongodb"),proof=await f.dump.prove(f.input);expect(proof).toMatchObject({writersResumed:"passed",restoredData:"passed",restoreCleanup:"passed"});expect(f.input.writerProbe).toHaveBeenCalledOnce();expect(f.run).toHaveBeenCalledOnce();await f.dump.close();
});
it("withholds Mongo proof if writes remain locked without private diagnostics",async()=>{
 const f=await fixture("mongodb");f.input.writerProbe.mockRejectedValue(new Error("password=fake-private"));await expect(f.dump.prove(f.input)).rejects.toThrow("Native Mongo writers did not resume.");await f.dump.close();
});

it("reports only an allowlisted capture stage when the authenticated backup fails",async()=>{
 const f=await fixture();f.input.call.mockResolvedValue({statusCode:503,body:"private-output",json:()=>({data:{}})} as any);
 await expect(f.dump.prove({...f.input,captureFailure:()=>"acquisition" as const})).rejects.toThrow("Private native capture failed at acquisition.");await f.dump.close();
});

it("reports a bounded numeric process exit without private command output",async()=>{
 const f=await fixture();f.input.call.mockResolvedValue({statusCode:503,body:"password=fake-private",json:()=>({data:{}})} as any);
 await expect(f.dump.prove({...f.input,captureFailure:()=>"unknown" as const,captureExit:()=>({code:137,signal:null})})).rejects.toThrow("Private native capture failed at unknown (exit=137, signal=none).");await f.dump.close();
});

it("classifies bounded private shell diagnostics into fixed identifiers only",()=>{
 expect(typeof captureFixture.nativeCaptureErrorKind).toBe("function");
 expect(captureFixture.nativeCaptureErrorKind(Buffer.from("SyntaxError: password=fake-private"))).toBe("syntax");
 expect(captureFixture.nativeCaptureErrorKind(Buffer.from("private-command-output"))).toBe("unknown");
 expect(captureFixture.nativeCaptureErrorKind(Buffer.alloc(4097))).toBe("unknown");
});
it("reports a fixed shell diagnostic class without reflecting private output",async()=>{
 const f=await fixture();f.input.call.mockResolvedValue({statusCode:503,body:"password=fake-private",json:()=>({data:{}})} as any);
 await expect(f.dump.prove({...f.input,captureFailure:()=>"shell" as const,captureExit:()=>({code:31,signal:null}),captureError:()=>"syntax" as const})).rejects.toThrow("Private native capture failed at shell (exit=31, signal=none) [shell=syntax].");await f.dump.close();
});

it("observes diagnostic kind once so a changing reader cannot reflect private text",async()=>{
 const f=await fixture();f.input.call.mockResolvedValue({statusCode:503,body:"private",json:()=>({data:{}})} as any);const captureError=vi.fn().mockReturnValueOnce("syntax").mockReturnValue("password=fake-private");
 await expect(f.dump.prove({...f.input,captureFailure:()=>"shell" as const,captureExit:()=>({code:31,signal:null}),captureError})).rejects.toThrow("Private native capture failed at shell (exit=31, signal=none) [shell=syntax].");expect(captureError).toHaveBeenCalledOnce();await f.dump.close();
});
