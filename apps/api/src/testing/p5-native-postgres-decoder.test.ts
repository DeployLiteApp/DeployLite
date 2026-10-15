import {expect,it} from "vitest";
import {spawn} from "node:child_process";
import {decodeNativePostgresFixture} from "./p5-native-postgres-decoder.js";
const input={containerId:"a".repeat(64),uid:999,bytes:Buffer.from("private-fixture"),signal:new AbortController().signal};
it("streams privately to an interactive non-root restore in the original daemon",async()=>{
 let selected:readonly string[]=[];
 await decodeNativePostgresFixture(input,(_file,argv,options)=>{selected=argv;return spawn(process.execPath,["-e","process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('p5-persistent-value\\n'))"],options);});
 expect(selected.slice(0,5)).toEqual(["exec","--interactive","--user","999",input.containerId]);
 expect(selected.join(" ")).toContain("pg_restore");expect(selected.join(" ")).toContain("createdb");expect(selected.join(" ")).toContain("dropdb");
});
it("rejects changed scope, oversized input and cancellation before starting a process",async()=>{
 for(const patch of [{uid:0},{containerId:"foreign"},{bytes:Buffer.alloc(2097153)},{signal:AbortSignal.abort()}]){
 let calls=0;await expect(decodeNativePostgresFixture({...input,...patch},()=>{calls++;throw new Error("started");})).rejects.toThrow();expect(calls).toBe(0);
 }
});
it("bounds failed restore diagnostics without exposing private input",async()=>{
 await expect(decodeNativePostgresFixture(input,(_file,_argv,options)=>spawn(process.execPath,["-e","process.stderr.write('private-fixture');process.exit(1)"],options))).rejects.toThrow("Private PostgreSQL restore fixture failed.");
});
it("rejects unexpected restored rows",async()=>{
 await expect(decodeNativePostgresFixture(input,(_file,_argv,options)=>spawn(process.execPath,["-e","process.stdout.write('different-row')"],options))).rejects.toThrow("Private PostgreSQL restore fixture failed.");
});
