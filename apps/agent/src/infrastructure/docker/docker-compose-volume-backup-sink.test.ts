import {createHash} from "node:crypto";
import {mkdtemp,realpath,writeFile,rm,symlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,expect,it} from "vitest";
import {captureComposeVolumeBackupToSink,createLocalDirectoryComposeVolumeBackupSource} from "./docker-compose-volume-backup.js";
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function fixture(){const root=await mkdtemp(join(await realpath(tmpdir()),"deploylite-volume-sink-"));roots.push(root);await writeFile(join(root,"dump.rdb"),"owned-data");return {root,source:createLocalDirectoryComposeVolumeBackupSource(new Map([["owned-volume",root]]))};}
it("streams existing safe tar bytes privately with an exact bounded hash",async()=>{
 const f=await fixture(),parts:Buffer[]=[];
 const result=await captureComposeVolumeBackupToSink(f.source,"owned-volume",4096,async bytes=>{parts.push(Buffer.from(bytes));},new AbortController().signal,()=>{});
 const bytes=Buffer.concat(parts);expect(result).toEqual({bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")});expect(bytes.subarray(0,8).toString()).toBe("dump.rdb");expect(bytes.subarray(512,522).toString()).toBe("owned-data");
});
it("rejects unmapped and symlink sources without accepting private capture",async()=>{
 const f=await fixture();await symlink("dump.rdb",join(f.root,"linked"));
 for(const name of ["foreign","owned-volume"])await expect(captureComposeVolumeBackupToSink(f.source,name,4096,async()=>{},new AbortController().signal,()=>{})).rejects.toThrow();
});
it("withholds success at the byte budget and on cancelled authority",async()=>{
 const f=await fixture();for(const [budget,signal] of [[1024,new AbortController().signal],[4096,AbortSignal.abort()]] as const)await expect(captureComposeVolumeBackupToSink(f.source,"owned-volume",budget,async()=>{},signal,()=>{})).rejects.toThrow();
});
it("returns accepted-byte hashes even if an injected sink mutates its private chunk",async()=>{
 const f=await fixture(),parts:Buffer[]=[];
 const result=await captureComposeVolumeBackupToSink(f.source,"owned-volume",4096,async bytes=>{parts.push(Buffer.from(bytes));bytes.fill(0);},new AbortController().signal,()=>{});
 expect(result.sha256).toBe(createHash("sha256").update(Buffer.concat(parts)).digest("hex"));
});
