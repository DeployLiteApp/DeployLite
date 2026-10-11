import {mkdtemp,realpath,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,expect,it} from "vitest";
import {composeRuntimeResourceName} from "@deploylite/domain";
import {captureComposeVolumeBackupToSink,createLocalDirectoryComposeVolumeBackupSource} from "./docker-compose-volume-backup.js";
import {validateManagedDatabaseRestoreTar} from "./docker-managed-database-restore-tar.js";
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(){
 const root=await mkdtemp(join(await realpath(tmpdir()),"deploylite-restore-tar-"));roots.push(root);
 await writeFile(join(root,"dump.rdb"),Buffer.from([0,255,128,10]),{mode:0o600});await writeFile(join(root,"extra.aof"),"private-fixture",{mode:0o600});
 const volume=composeRuntimeResourceName("project-a","volume","db-orders"),chunks:Buffer[]=[];
 await captureComposeVolumeBackupToSink(createLocalDirectoryComposeVolumeBackupSource(new Map([[volume,root]])),volume,10000,async bytes=>{chunks.push(Buffer.from(bytes));},new AbortController().signal,()=>{});
 return Buffer.concat(chunks);
}
function checksum(bytes:Buffer,offset=0){bytes.fill(32,offset+148,offset+156);let sum=0;for(const byte of bytes.subarray(offset,offset+512))sum+=byte;bytes.write(sum.toString(8).padStart(6,"0"),offset+148,6,"ascii");bytes[offset+154]=0;bytes[offset+155]=32;}
it("accepts exactly the existing safe native volume tar writer without disclosing private paths or contents",async()=>{const bytes=await fixture();expect(validateManagedDatabaseRestoreTar(bytes,10000)).toEqual({bytes:bytes.length,entries:2});expect(JSON.stringify(validateManagedDatabaseRestoreTar(bytes,10000))).not.toContain("dump.rdb");});
it("accepts existing safe nested directory and regular-file entries",async()=>{const bytes=await fixture();bytes[156]=53;bytes.fill(0,0,100);bytes.write("a/");bytes.fill(0,1024,1124);bytes.write("a/extra.aof",1024);checksum(bytes,1024);bytes.fill(0,124,136);bytes.write("00000000000",124,11,"ascii");bytes.fill(0,512,1024);checksum(bytes);const directory=Buffer.concat([bytes.subarray(0,512),bytes.subarray(1024)]);expect(validateManagedDatabaseRestoreTar(directory,10000)).toMatchObject({entries:2});});
it.each(["traversal","absolute","backslash","symlink","hardlink","checksum","setuid","duplicate","padding","truncated","trailing","pax","uid"])("refuses unsafe %s before any volume write",async mode=>{
 const bytes=await fixture();let raw=bytes;
 if(["traversal","absolute","backslash"].includes(mode)){bytes.fill(0,0,100);bytes.write(({traversal:"../escape",absolute:"/escape",backslash:"a\\b"} as Record<string,string>)[mode]!);checksum(bytes);}
 if(mode==="symlink"||mode==="hardlink"||mode==="pax"){bytes[156]=mode==="symlink"?50:mode==="hardlink"?49:120;checksum(bytes);}
 if(mode==="checksum")bytes[0]=bytes[0]!^1;
 if(mode==="setuid"){bytes.write("0004600",100,7,"ascii");checksum(bytes);}
 if(mode==="uid"){bytes.write("0000001",108,7,"ascii");checksum(bytes);}
 if(mode==="duplicate"){bytes.subarray(0,100).copy(bytes,1024);checksum(bytes,1024);}
 if(mode==="padding")bytes[520]=1;
 if(mode==="truncated")raw=bytes.subarray(0,bytes.length-512);
 if(mode==="trailing"){raw=Buffer.concat([bytes,Buffer.alloc(512)]);raw[raw.length-1]=1;}
 expect(()=>validateManagedDatabaseRestoreTar(raw,10000)).toThrow("Database restore volume archive is unavailable.");
});
it("bounds total bytes and entry count and refuses unusable limits",async()=>{const bytes=await fixture();for(const [max,count] of [[bytes.length-1,10000],[10000,1],[0,10000],[10000,0]])expect(()=>validateManagedDatabaseRestoreTar(bytes,max!,count!)).toThrow();});
