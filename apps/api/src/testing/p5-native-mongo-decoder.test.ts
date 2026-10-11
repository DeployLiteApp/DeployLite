import {expect,it} from "vitest";
import {spawn} from "node:child_process";
import {restoreNativeMongoFixture} from "./p5-native-mongo-decoder.js";
it("restores only into a unique Mongo namespace through original non-root stdin",async()=>{
 let argv:readonly string[]=[];
 await restoreNativeMongoFixture({containerId:"a".repeat(64),uid:999,bytes:Buffer.from("private-fixture"),signal:new AbortController().signal},(_file,args,options)=>{argv=args;return spawn(process.execPath,["-e","process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('p5-persistent-value\\n'))"],options);});
 expect(argv.slice(0,5)).toEqual(["exec","--interactive","--user","999","a".repeat(64)]);
 const script=argv.at(-1)!;expect(script).toContain("--nsFrom=");expect(script).toContain("--nsTo=");expect(script).toContain("dropDatabase");expect(script).toContain("p5_restore_");expect(script).toContain("--config=<(");expect(script).not.toContain("private-fixture");
});
it("refuses foreign scope before any restore process",async()=>{
 let effects=0;await expect(restoreNativeMongoFixture({containerId:"foreign",uid:999,bytes:Buffer.from("data"),signal:new AbortController().signal},()=>{effects++;throw new Error("unexpected");})).rejects.toThrow();expect(effects).toBe(0);
});
