import {spawnSync} from "node:child_process";
import {expect,it,vi} from "vitest";
import {buildMongoNativeDumpArgv,MONGO_BACKUP_LOCK_SCRIPT,MONGO_BACKUP_UNLOCK_SCRIPT} from "./docker-managed-database-mongo-dump.js";
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor as new(...args:string[])=> (...args:unknown[])=>Promise<unknown>;
function fixture(){
 let count=0,id="a".repeat(24);const printed:string[]=[];
 const runCommand=vi.fn(async(command:Record<string,unknown>)=>{
  if(command.hello)return {ok:1,isWritablePrimary:true,topologyVersion:{processId:{toHexString:()=>id}}};
  if(command.currentOp)return {ok:1,fsyncLock:count>0};
  if(command.fsync)return {ok:1,lockCount:++count};
  if(command.fsyncUnlock)return {ok:1,lockCount:--count};
  throw new Error("unknown fixture command");
 });
 const Mongo=function(){return {getDB:()=>({runCommand})};};
 const process={env:{MONGO_INITDB_ROOT_USERNAME:"root",MONGO_INITDB_ROOT_PASSWORD:"b".repeat(64),DEPLOYLITE_MONGO_BACKUP_PROCESS_ID:id}};
 const execute=(script:string)=>new AsyncFunction("Mongo","process","print","quit",script)(Mongo,process,(value:string)=>printed.push(value),()=>{throw new Error("Mongo dump refused.");});
 return {execute,runCommand,printed,process,getCount:()=>count,setCount:(value:number)=>{count=value;},replace:()=>{id="c".repeat(24);}};
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
