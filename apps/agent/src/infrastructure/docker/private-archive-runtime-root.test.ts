import type {Stats} from "node:fs";
import {beforeEach,afterEach,expect,it,vi} from "vitest";
const filesystem = vi.hoisted(() => ({nodes: new Map<string,Stats>(), change: false, reads: 0}));
vi.mock("node:fs/promises", async () => ({...await vi.importActual("node:fs/promises"),lstat: vi.fn(async (path: string) => {
  const value = filesystem.nodes.get(path); if (!value) throw new Error("missing fixture"); return value;
})}));
vi.mock("./docker-compose-volume-backup.js", async () => {
  const actual = await vi.importActual<typeof import("./docker-compose-volume-backup.js")>("./docker-compose-volume-backup.js");
  return {...actual,composeBackupFilesystem:{...actual.composeBackupFilesystem,safeDirectory:async(path:string) => {
    const info = filesystem.nodes.get(path); if (!info) throw new Error("missing fixture");
    if (filesystem.change && ++filesystem.reads > 1) return {path,info:{...info,ino:999}};
    return {path,info};
  }}};
});
import {validatePrivateArchiveRuntimeRoots} from "./private-archive-runtime-root.js";
const anchor = "/var/lib/deploylite-agent/backups";
function node(uid:number,mode:number,ino=1){return {uid,gid:uid,mode:0o040000|mode,dev:1,ino,isDirectory:()=>true,isSymbolicLink:()=>false} as unknown as Stats;}
beforeEach(() => {
  filesystem.nodes.clear();filesystem.change=false;filesystem.reads=0;
  for(const path of ["/","/var","/var/lib","/var/lib/deploylite-agent"])filesystem.nodes.set(path,node(0,0o755));
  filesystem.nodes.set(anchor,node(10001,0o700));filesystem.nodes.set(anchor+"/child",node(10001,0o700,2));
  vi.spyOn(process as {geteuid:()=>number},"geteuid").mockReturnValue(10001);
});
afterEach(()=>vi.restoreAllMocks());
it("accepts all configured private writable destinations and explicit descendants",async()=>{
  await expect(validatePrivateArchiveRuntimeRoots(new Map([["a",anchor],["b",anchor+"/child"]]))).resolves.toBeUndefined();
});
for(const [name,mutate] of Object.entries({
  "root process":()=>vi.mocked(process.geteuid!).mockReturnValue(0),
  "other nonzero identity":()=>vi.mocked(process.geteuid!).mockReturnValue(1000),
  "foreign root":()=>filesystem.nodes.set(anchor,node(10002,0o700)),
  "foreign group":()=>filesystem.nodes.set(anchor,{...node(10001,0o700),gid:10002}),
  "read-only root":()=>filesystem.nodes.set(anchor,node(10001,0o500)),
  "public root":()=>filesystem.nodes.set(anchor,node(10001,0o755)),
  "special root mode":()=>filesystem.nodes.set(anchor,node(10001,0o4700)),
  "writable ancestor":()=>filesystem.nodes.set("/var/lib",node(0,0o777)),
  "foreign ancestor":()=>filesystem.nodes.set("/var/lib",node(10002,0o755)),
  "ancestor symlink":()=>filesystem.nodes.set("/var/lib",{...node(0,0o755),isSymbolicLink:()=>true}),
  "root symlink":()=>filesystem.nodes.set(anchor,{...node(10001,0o700),isSymbolicLink:()=>true}),
  "foreign descendant":()=>filesystem.nodes.set(anchor+"/child",node(10002,0o700)),
  "permissive descendant":()=>filesystem.nodes.set(anchor+"/child",node(10001,0o750)),
  "changed identity":()=>{filesystem.change=true;}
}))it(`rejects ${name} without repairing paths`,async()=>{mutate();await expect(validatePrivateArchiveRuntimeRoots(new Map([["a",anchor],["b",anchor+"/child"]]))).rejects.toThrow();});
for(const path of ["/tmp/backups",anchor+"/../outside","relative",anchor+"-other"])
  it(`rejects destination outside the exact packaged anchor: ${path}`,async()=>{await expect(validatePrivateArchiveRuntimeRoots(new Map([["a",path]]))).rejects.toThrow();});
