import {Script} from "node:vm";
import {spawnSync} from "node:child_process";
import {expect,it,vi} from "vitest";
import {buildMongoNativeDumpArgv,MONGO_BACKUP_LOCK_SCRIPT,MONGO_BACKUP_UNLOCK_SCRIPT} from "./docker-managed-database-mongo-dump.js";
function fixture(asyncConnection=false){
 let count=0,id="a".repeat(24);const printed:string[]=[];
 const runCommand=vi.fn(async(command:Record<string,unknown>):Promise<Record<string,unknown>>=>{
  if(command.hello)return {ok:1,isWritablePrimary:true,topologyVersion:{processId:{toHexString:()=>id}}};
  if(command.currentOp)return {ok:1,fsyncLock:count>0};
  if(command.fsync)return {ok:1,lockCount:++count};
  if(command.fsyncUnlock)return {ok:1,lockCount:--count};
  throw new Error("unknown fixture command");
 });
 const Mongo=asyncConnection?async function(){return {getDB:()=>({runCommand})};}:function(){return {getDB:()=>({runCommand})};};
 const process={env:{MONGO_INITDB_ROOT_USERNAME:"root",MONGO_INITDB_ROOT_PASSWORD:"b".repeat(64),DEPLOYLITE_MONGO_BACKUP_PROCESS_ID:id}};
 const print=vi.fn((value:string)=>{printed.push(value);return Promise.resolve();});
 const quit=vi.fn((_code:number)=>{throw new Error("Mongo dump refused.");});
 const execute=async(script:string)=>new Script(script).runInNewContext({Mongo,process,print,quit});
 return {print,quit,execute,runCommand,printed,process,getCount:()=>count,setCount:(value:number)=>{count=value;},replace:()=>{id="c".repeat(24);}};
}
it("balances exactly one freshly acknowledged lock on the same standalone process",async()=>{
 const f=fixture();await f.execute(MONGO_BACKUP_LOCK_SCRIPT);expect(f.printed).toEqual(["a".repeat(24)]);expect(f.getCount()).toBe(1);
 await f.execute(MONGO_BACKUP_UNLOCK_SCRIPT);expect(f.getCount()).toBe(0);expect(f.runCommand.mock.calls.filter(([v])=>v.fsyncUnlock)).toHaveLength(1);
});
it("refuses an existing lock without acquiring or unlocking it",async()=>{
 const f=fixture();f.setCount(1);await expect(f.execute(MONGO_BACKUP_LOCK_SCRIPT)).rejects.toThrow("Mongo dump refused.");expect(f.getCount()).toBe(1);expect(f.runCommand.mock.calls.some(([v])=>v.fsync||v.fsyncUnlock)).toBe(false);
});
it("never guesses an unlock after ambiguous acquisition",async()=>{
 const f=fixture(),base=f.runCommand.getMockImplementation()!;f.runCommand.mockImplementation(async v=>{if(v.fsync){f.setCount(1);throw new Error("private-driver-fault");}return base(v);});
 await expect(f.execute(MONGO_BACKUP_LOCK_SCRIPT)).rejects.toThrow("Mongo dump refused.");expect(f.runCommand.mock.calls.some(([v])=>v.fsyncUnlock)).toBe(false);
});
it("refuses cleanup on a replacement server process",async()=>{
 const f=fixture();await f.execute(MONGO_BACKUP_LOCK_SCRIPT);f.replace();await expect(f.execute(MONGO_BACKUP_UNLOCK_SCRIPT)).rejects.toThrow("Mongo dump refused.");expect(f.getCount()).toBe(1);expect(f.runCommand.mock.calls.some(([v])=>v.fsyncUnlock)).toBe(false);
});
it("releases its one acknowledged increment while preserving another locker",async()=>{
 const f=fixture();await f.execute(MONGO_BACKUP_LOCK_SCRIPT);f.setCount(2);await expect(f.execute(MONGO_BACKUP_UNLOCK_SCRIPT)).rejects.toThrow("Mongo dump refused.");expect(f.getCount()).toBe(1);expect(f.runCommand.mock.calls.filter(([v])=>v.fsyncUnlock)).toHaveLength(1);
});

it("attempts cleanup only once when unlock fails after a successful dump",()=>{
 const script=buildMongoNativeDumpArgv("a".repeat(64),Date.now()+10000).at(-1)!;
 const injected=`DEPLOYLITE_MONGO_BACKUP_PROCESS_ID=""; date(){ printf '%s\\n' '${Date.now()}'; }; mongosh(){ if test -n "$DEPLOYLITE_MONGO_BACKUP_PROCESS_ID"; then printf 'unlock-attempt\\n' >&2; return 1; fi; printf '%s\\n' '${"a".repeat(24)}'; }; timeout(){ return 0; }; `;
 const result=spawnSync("bash",["-c",injected+script],{encoding:"utf8",timeout:2000});
 expect(result.status).not.toBe(0);
 expect(result.stderr.split("unlock-attempt").length-1).toBe(1);
});

it("refuses an insufficient authority deadline before acquiring any lock",()=>{
 const now=Date.now(),script=buildMongoNativeDumpArgv("a".repeat(64),now+1000).at(-1)!;
 const injected=`date(){ printf '%s\\n' '${now}'; }; mongosh(){ printf 'live-effect\\n' >&2; printf '%s\\n' '${"a".repeat(24)}'; }; `;
 const result=spawnSync("bash",["-c",injected+script],{encoding:"utf8",timeout:2000});
 expect(result.status).not.toBe(0);expect(result.stderr).not.toContain("live-effect");
});

it("identifies a preexisting lock with a fixed safe exit code and no private diagnostics",async()=>{
 const f=fixture();f.setCount(1);await expect(f.execute(MONGO_BACKUP_LOCK_SCRIPT)).rejects.toThrow("Mongo dump refused.");expect(f.quit).toHaveBeenCalledWith(23);
});

it("releases its confirmed increment when asynchronous acknowledgement output fails",async()=>{
 const f=fixture(),failure=Promise.reject(new Error("private-print-fault"));void failure.catch(()=>{});f.print.mockReturnValueOnce(failure);
 await expect(f.execute(MONGO_BACKUP_LOCK_SCRIPT)).rejects.toThrow("Mongo dump refused.");expect(f.getCount()).toBe(0);expect(f.runCommand.mock.calls.filter(([v])=>v.fsyncUnlock)).toHaveLength(1);
});

it("uses the actual asynchronous shell Mongo connection API without assuming a JavaScript constructor",async()=>{
 const f=fixture(true);await f.execute(MONGO_BACKUP_LOCK_SCRIPT);expect(f.getCount()).toBe(1);await f.execute(MONGO_BACKUP_UNLOCK_SCRIPT);expect(f.getCount()).toBe(0);
});

it.each([{mode:"clock",expected:29},{mode:"token",expected:28},{mode:"shell",expected:31}])("identifies $mode wrapper failure without private output",({mode,expected})=>{
 const now=Date.now(),script=buildMongoNativeDumpArgv("a".repeat(64),now+10000).at(-1)!;
 const injected=`date(){ printf '%s\\n' '${mode==="clock"?"invalid":now}'; }; mongosh(){ ${mode==="shell"?"return 1;":"printf 'invalid-token\\n';"} }; `;
 const result=spawnSync("bash",["-c",injected+script],{encoding:"utf8",timeout:2000});expect(result.status).toBe(expected);expect(result.stdout).toBe("");
});

it("does not retry shell cleanup after failed acknowledgement emitted a partial process token",()=>{
 const now=Date.now(),script=buildMongoNativeDumpArgv("a".repeat(64),now+10000).at(-1)!;
 const injected=`DEPLOYLITE_MONGO_BACKUP_PROCESS_ID=""; date(){ printf '%s\\n' '${now}'; }; mongosh(){ if test -n "$DEPLOYLITE_MONGO_BACKUP_PROCESS_ID"; then printf 'foreign-unlock-attempt\\n' >&2; return 0; fi; printf '%s\\n' '${"a".repeat(24)}'; return 25; }; `;
 const result=spawnSync("bash",["-c",injected+script],{encoding:"utf8",timeout:2000});expect(result.status).toBe(25);expect(result.stderr).not.toContain("foreign-unlock-attempt");
});

it.each([["acquire",MONGO_BACKUP_LOCK_SCRIPT],["cleanup",MONGO_BACKUP_UNLOCK_SCRIPT]])("parses the %s CLI input as an ECMAScript script before shell rewriting",(_phase,script)=>{
 expect(()=>new Script(script)).not.toThrow();
});

it.each([{hello:{ok:0},code:33},{hello:{ok:1,isWritablePrimary:false},code:34},{hello:{ok:1,isWritablePrimary:true,setName:"private"},code:35},{hello:{ok:1,isWritablePrimary:true},code:36}])("refuses invalid server identity with bounded substage $code before lock effects",async({hello,code})=>{
 const f=fixture(),base=f.runCommand.getMockImplementation()!;f.runCommand.mockImplementation(async v=>v.hello?hello:base(v));
 await expect(f.execute(MONGO_BACKUP_LOCK_SCRIPT)).rejects.toThrow("Mongo dump refused.");expect(f.quit).toHaveBeenCalledWith(code);expect(f.runCommand.mock.calls.some(([v])=>v.fsync||v.fsyncUnlock)).toBe(false);
});

it("awaits process-token conversion before same-server lock and cleanup checks",async()=>{
 const f=fixture(),base=f.runCommand.getMockImplementation()!;f.runCommand.mockImplementation(async v=>v.hello?{ok:1,isWritablePrimary:true,topologyVersion:{processId:{toHexString:async()=>"a".repeat(24)}}}:base(v));
 await f.execute(MONGO_BACKUP_LOCK_SCRIPT);expect(f.printed).toEqual(["a".repeat(24)]);await f.execute(MONGO_BACKUP_UNLOCK_SCRIPT);expect(f.getCount()).toBe(0);
});

it("retains the native process-token method receiver during acquire and cleanup",async()=>{
 const f=fixture(),base=f.runCommand.getMockImplementation()!,processId={value:"a".repeat(24),toHexString(){if(this!==processId)throw new Error("Unavailable.");return this.value;}};
 f.runCommand.mockImplementation(async v=>v.hello?{ok:1,isWritablePrimary:true,topologyVersion:{processId}}:base(v));await f.execute(MONGO_BACKUP_LOCK_SCRIPT);await f.execute(MONGO_BACKUP_UNLOCK_SCRIPT);expect(f.getCount()).toBe(0);
});
