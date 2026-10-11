import {spawn} from "node:child_process";
import {expect,it} from "vitest";
import {restoreNativeRedisFixture} from "./p5-native-redis-decoder.js";
it("restores Redis privately into a scoped socket server and compares the original key",async()=>{
 let selected:readonly string[]=[];
 await restoreNativeRedisFixture({containerId:"a".repeat(64),uid:999,bytes:Buffer.from("private-tar"),signal:new AbortController().signal},(_file,args,options)=>{selected=args;return spawn(process.execPath,["-e","process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('p5-persistent-value\\n'))"],options);});
 expect(selected.slice(0,5)).toEqual(["exec","--interactive","--user","999","a".repeat(64)]);
 const script=selected.at(-1)!;expect(script).toContain("mktemp -d /tmp/p5-restore.");expect(script).toContain("port 0");expect(script).toContain("unixsocket");expect(script).toContain("tar -xf -");expect(script).toContain("GET p5_probe");expect(script).toContain('kill "$pid"');expect(script).not.toContain("private-tar");
});
