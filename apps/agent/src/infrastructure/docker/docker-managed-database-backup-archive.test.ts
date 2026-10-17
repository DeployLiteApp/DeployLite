import {existsSync} from "node:fs";
import {createHash} from "node:crypto";
import {mkdtemp,realpath,readFile,readdir,rm,stat,writeFile,mkdir,symlink,chmod} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,expect,it,vi} from "vitest";
import {createPrivateNativeBackupArchive} from "./docker-managed-database-backup-archive.js";
const nativeCleanup = vi.hoisted(() => ({afterPath: undefined as ((path: string) => void) | undefined}));
vi.mock("node:fs/promises", async () => {
  const filesystem = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {...filesystem, realpath: async (...paths: Parameters<typeof filesystem.realpath>) => {
    const canonical = await filesystem.realpath(...paths);
    nativeCleanup.afterPath?.(String(paths[0]));
    return canonical;
  }};
});
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(){
 const root=await mkdtemp(join(await realpath(tmpdir()),"deploylite-native-archive-"));roots.push(root);
 const options={destinations:new Map([["destination-a",root]]),clock:{now:Date.now},maxBytes:10000,maxDurationMs:1000};
 const binding={projectId:"project-a",commandId:"command-a",inputDigest:"a".repeat(64),agentId:"agent-a",correlationId:"request-a",destinationId:"destination-a",sourceDigest:"b".repeat(64),format:"postgres-custom-gzip"};
 const data=Buffer.from([0,255,128,10]),sha256=createHash("sha256").update(data).digest("hex"),producer=vi.fn(async(write:(bytes:Uint8Array)=>Promise<void>)=>{await write(data);return {bytes:data.length,sha256};});
 const authority={projectId:binding.projectId,commandId:binding.commandId,inputDigest:binding.inputDigest,assertValid:vi.fn(async()=>{})};
 return {root,options,binding,data,sha256,producer,authority,archive:createPrivateNativeBackupArchive(options),signal:new AbortController()};
}
it("persists exact private binary data and bound integrity manifest without returning paths",async()=>{
 const f=await fixture(),receipt=await f.archive.write(f.binding,f.producer,f.authority,f.signal.signal);
 expect(receipt).toMatchObject({archiveBytes:4,archiveSha256:f.sha256,idempotent:false,redacted:true});
 const dir=join(f.root,receipt.archiveId);expect(await readFile(join(dir,"archive.bin"))).toEqual(f.data);expect((await stat(dir)).mode&0o777).toBe(0o700);expect((await stat(join(dir,"archive.bin"))).mode&0o777).toBe(0o600);
 const manifest=await readFile(join(dir,"manifest.json"));expect(JSON.parse(manifest.toString())).toMatchObject({...f.binding,archiveBytes:4,archiveSha256:f.sha256});expect(receipt.manifestSha256).toBe(createHash("sha256").update(manifest).digest("hex"));expect(JSON.stringify(receipt)).not.toContain(f.root);
});
it("recovers immutable archive after reopening without another producer",async()=>{
 const f=await fixture(),first=await f.archive.write(f.binding,f.producer,f.authority,f.signal.signal),reopened=createPrivateNativeBackupArchive(f.options);
 expect(await reopened.write(f.binding,f.producer,f.authority,f.signal.signal)).toEqual({...first,idempotent:true});expect(f.producer).toHaveBeenCalledOnce();
});
it("rejects unknown destinations, detached authority and caller paths before producing",async()=>{
 const f=await fixture();for(const patch of [{destinationId:"foreign"},{root:"/tmp"},{inputDigest:"c".repeat(64)}])await expect(f.archive.write({...f.binding,...patch},f.producer,f.authority,f.signal.signal)).rejects.toThrow("Native archive is unavailable.");
 await expect(f.archive.write(f.binding,f.producer,{...f.authority,projectId:"foreign"},f.signal.signal)).rejects.toThrow("Native archive is unavailable.");expect(f.producer).not.toHaveBeenCalled();expect(await readdir(f.root)).toEqual([]);
});
it("does not publish partial output when the producer fails or lies about its hash",async()=>{
 const f=await fixture();await expect(f.archive.write(f.binding,async write=>{await write(f.data);throw new Error("private path/password");},f.authority,f.signal.signal)).rejects.toThrow("Native archive is unavailable.");expect(await readdir(f.root)).toEqual([]);
 await expect(f.archive.write(f.binding,async write=>{await write(f.data);return {bytes:4,sha256:"c".repeat(64)};},f.authority,f.signal.signal)).rejects.toThrow("Native archive is unavailable.");expect(await readdir(f.root)).toEqual([]);
});
it("rejects byte-budget overflow and empty output without publishing",async()=>{
 const f=await fixture(),small=createPrivateNativeBackupArchive({...f.options,maxBytes:2});await expect(small.write(f.binding,f.producer,f.authority,f.signal.signal)).rejects.toThrow("Native archive is unavailable.");expect(await readdir(f.root)).toEqual([]);
 await expect(f.archive.write(f.binding,async()=>({bytes:0,sha256:createHash("sha256").digest("hex")}),f.authority,f.signal.signal)).rejects.toThrow("Native archive is unavailable.");expect(await readdir(f.root)).toEqual([]);
});
it("withholds publication when project authority is revoked after private writes",async()=>{
 const f=await fixture();await expect(f.archive.write(f.binding,async write=>{await write(f.data);f.authority.assertValid.mockRejectedValue(new Error("revoked"));return {bytes:4,sha256:f.sha256};},f.authority,f.signal.signal)).rejects.toThrow("Native archive is unavailable.");expect(await readdir(f.root)).toEqual([]);
});
it("rejects unsafe root permissions and symlink destinations before producer",async()=>{
 const f=await fixture();await chmod(f.root,0o755);await expect(f.archive.write(f.binding,f.producer,f.authority,f.signal.signal)).rejects.toThrow("Native archive is unavailable.");await chmod(f.root,0o700);
 const link=join(f.root,"link");await symlink(f.root,link);const linked=createPrivateNativeBackupArchive({...f.options,destinations:new Map([["destination-a",link]])});await expect(linked.write(f.binding,f.producer,f.authority,f.signal.signal)).rejects.toThrow("Native archive is unavailable.");expect(f.producer).not.toHaveBeenCalled();
});
it("refuses corrupted data or a detached manifest without overwriting or rerunning",async()=>{
 const f=await fixture(),receipt=await f.archive.write(f.binding,f.producer,f.authority,f.signal.signal),path=join(f.root,receipt.archiveId,"archive.bin");await writeFile(path,Buffer.from([1,2,3,4]));await expect(f.archive.write(f.binding,f.producer,f.authority,f.signal.signal)).rejects.toThrow("Native archive is unavailable.");expect(await readFile(path)).toEqual(Buffer.from([1,2,3,4]));expect(f.producer).toHaveBeenCalledOnce();
});
it("refuses an existing incomplete directory without adopting it",async()=>{
 const f=await fixture(),archiveId="backup_"+createHash("sha256").update(f.binding.projectId+"\0"+f.binding.commandId+"\0"+f.binding.destinationId).digest("hex").slice(0,32);await mkdir(join(f.root,archiveId),{mode:0o700});
 await expect(f.archive.write(f.binding,f.producer,f.authority,f.signal.signal)).rejects.toThrow("Native archive is unavailable.");expect(f.producer).not.toHaveBeenCalled();expect(await readdir(join(f.root,archiveId))).toEqual([]);
});
it("bounds cancellation and an uncooperative producer without publishing",async()=>{
 const f=await fixture(),short=createPrivateNativeBackupArchive({...f.options,maxDurationMs:10});await expect(short.write(f.binding,()=>new Promise(()=>{}),f.authority,f.signal.signal)).rejects.toThrow("Native archive is unavailable.");expect(await readdir(f.root)).toEqual([]);f.signal.abort();await expect(f.archive.write(f.binding,f.producer,f.authority,f.signal.signal)).rejects.toThrow("Native archive is unavailable.");expect(f.producer).not.toHaveBeenCalled();
});

it("reserves the byte budget before concurrent private writes can overrun it",async()=>{
 const f=await fixture(),archive=createPrivateNativeBackupArchive({...f.options,maxBytes:6});
 await expect(archive.write(f.binding,async write=>{await Promise.all([write(f.data),write(f.data)]);return {bytes:8,sha256:createHash("sha256").update(Buffer.concat([f.data,f.data])).digest("hex")};},f.authority,f.signal.signal)).rejects.toThrow("Native archive is unavailable.");
 expect(await readdir(f.root)).toEqual([]);
});
it("settles already accepted private writes before checking producer completion",async()=>{
 const f=await fixture(),receipt=await f.archive.write(f.binding,async write=>{void write(f.data).catch(()=>undefined);return {bytes:4,sha256:f.sha256};},f.authority,f.signal.signal);
 expect(receipt).toMatchObject({archiveBytes:4,archiveSha256:f.sha256});expect(await readFile(join(f.root,receipt.archiveId,"archive.bin"))).toEqual(f.data);
});

for (const identity of ["root", "foreign"] as const) it(`refuses ${identity} effective UID before native producer or filesystem mutation`, async () => {
 const f=await fixture(),owner=process.geteuid!(),uid=vi.spyOn(process as {geteuid: () => number},"geteuid").mockReturnValue(identity==="root"?0:owner+1);
 try {await expect(f.archive.write(f.binding,f.producer,f.authority,f.signal.signal)).rejects.toThrow("Native archive is unavailable.");expect(f.producer).not.toHaveBeenCalled();expect(await readdir(f.root)).toEqual([]);}finally{uid.mockRestore();}
});
for (const phase of ["before-data","before-manifest","mode"] as const) it(`rechecks native private root ${phase} after the final awaited grant and preserves uncertain pending evidence`,async()=>{
 const f=await fixture(),owner=process.geteuid!(),uid=vi.spyOn(process as {geteuid: () => number},"geteuid").mockReturnValue(owner);let changed=false;
 f.authority.assertValid.mockImplementation(async()=>{
  for(const name of await readdir(f.root))if(name.startsWith(".pending-")){
   const ready=await readFile(join(f.root,name,"manifest.json")).then(()=>true,()=>false),published=await readdir(f.root).then(names=>names.find(value=>value.startsWith("backup_")));
   const linked=published?await readFile(join(f.root,published,"archive.bin")).then(()=>true,()=>false):false;
   if(ready&&(phase!=="before-manifest"||linked)){changed=true;if(phase==="mode")await chmod(f.root,0o707);else uid.mockReturnValue(owner+1);}
  }
 });
 try {await expect(f.archive.write(f.binding,f.producer,f.authority,f.signal.signal)).rejects.toThrow("Native archive is unavailable.");expect(changed).toBe(true);expect(f.producer).toHaveBeenCalledOnce();
  const names=await readdir(f.root);expect(names.some(name=>name.startsWith(".pending-"))).toBe(true);
  for(const name of names.filter(value=>value.startsWith("backup_")))expect(await readdir(join(f.root,name))).not.toContain("manifest.json");
 }finally{uid.mockRestore();await chmod(f.root,0o700);}
});

for (const change of ["cancellation", "expiry"] as const) {
  it(`refuses native success when ${change} arrives during awaited pending cleanup and preserves the published original`, async () => {
    const f = await fixture();
    let now = 100, changed = false;
    f.options.clock.now = () => now;
    Object.assign(f.authority, {expiresAt: 10_000});
    const archive = createPrivateNativeBackupArchive({...f.options, maxDurationMs: 100_000});
    const archiveId = "backup_" + createHash("sha256").update(f.binding.projectId + "\0" + f.binding.commandId + "\0" + f.binding.destinationId).digest("hex").slice(0, 32);
    const archivePath = join(f.root, archiveId, "archive.bin"), manifestPath = join(f.root, archiveId, "manifest.json");
    nativeCleanup.afterPath = path => {
      if (path.includes(".pending-") && existsSync(manifestPath)) {
        changed = true;
        if (change === "cancellation") f.signal.abort(); else now = 10_001;
      }
    };
    try {
      await expect(archive.write(f.binding, f.producer, f.authority, f.signal.signal)).rejects.toThrow("Native archive is unavailable.");
      expect(changed).toBe(true);
      const manifest = await readFile(manifestPath);
      expect(await readFile(archivePath)).toEqual(f.data);
      expect(f.producer).toHaveBeenCalledOnce();
      nativeCleanup.afterPath = undefined;
      now = 100;
      expect(await archive.write(f.binding, f.producer, f.authority, new AbortController().signal)).toMatchObject({idempotent: true});
      expect(f.producer).toHaveBeenCalledOnce();
      expect(await readFile(archivePath)).toEqual(f.data);
      expect(await readFile(manifestPath)).toEqual(manifest);
    } finally {nativeCleanup.afterPath = undefined;}
  });
}
