import {expect,it} from "vitest";
import {spawn} from "node:child_process";
import {restoreNativeSqlFixture} from "./p5-native-sql-decoder.js";
it.each(["mysql","mariadb"] as const)("restores %s privately into a disposable database and compares both table engines",async engine=>{
 let argv:readonly string[]=[];
 await restoreNativeSqlFixture({engine,containerId:"a".repeat(64),uid:999,bytes:Buffer.from("private-fixture"),signal:new AbortController().signal},(_file,args,options)=>{argv=args;return spawn(process.execPath,["-e","process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('p5-persistent-value\\n'))"],options);});
 expect(argv.slice(0,5)).toEqual(["exec","--interactive","--user","999","a".repeat(64)]);
 const script=argv.at(-1)!;expect(script).toContain("CREATE DATABASE");expect(script).toContain("DROP DATABASE");expect(script).toContain("p5_nontransactional");expect(script).toContain(engine==="mysql"?"MYSQL_ROOT_PASSWORD":"MARIADB_ROOT_PASSWORD");expect(script).not.toContain("private-fixture");
});
