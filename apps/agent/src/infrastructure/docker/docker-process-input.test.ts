import {createHash} from "node:crypto";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import {expect,it,vi} from "vitest";
import {DockerProcessRunner,type SpawnedProcess,type SpawnProcess} from "./docker-process-runner.js";
function fixture(options:{timeoutMs?:number;maxOutputBytes?:number;maxBinaryBytes?:number}={}){
 const stdin=new PassThrough(),child=Object.assign(new EventEmitter(),{stdin,stdout:new PassThrough(),stderr:new PassThrough(),kill:vi.fn()}),written:Buffer[]=[];
 stdin.on("data",chunk=>written.push(Buffer.from(chunk)));stdin.on("error",()=>{});const spawn=vi.fn((..._args:Parameters<SpawnProcess>)=>child as unknown as SpawnedProcess);
 const runner=new DockerProcessRunner({spawn,timeoutMs:1000,maxOutputBytes:128,maxBinaryBytes:1024,...options}),controller=new AbortController();
 return {stdin,child,written,spawn,runner,controller};
}
const observed=<T>(promise:Promise<T>)=>{void promise.catch(()=>{});return promise;};
const settle=()=>new Promise<void>(done=>setImmediate(done));
it("writes an immutable private binary snapshot through stdin and returns only its public hash and length",async()=>{
 const f=fixture(),bytes=Buffer.from([0,255,128,10]),expected=createHash("sha256").update(bytes).digest("hex"),pending=observed(f.runner.runBinaryFromSource(["docker","exec","--interactive","owned"],f.controller.signal,bytes));bytes.fill(65);
 await settle();f.child.emit("close",0,null);expect(await pending).toEqual({bytes:4,sha256:expected});expect(Buffer.concat(f.written)).toEqual(Buffer.from([0,255,128,10]));expect(f.spawn.mock.calls[0]![2]).toMatchObject({shell:false,detached:true,stdio:["pipe","pipe","pipe"]});
});
it("keeps arbitrary private diagnostics and failed native exit out of the result and error",async()=>{
 const f=fixture(),pending=observed(f.runner.runBinaryFromSource(["docker"],f.controller.signal,Buffer.from("private-fixture")));await settle();f.child.stdout.write("password=private-fixture");f.child.stderr.write("token=private-fixture");f.child.emit("close",1,null);
 await expect(pending).rejects.toMatchObject({kind:"failed"});try{await pending;}catch(error){expect(JSON.stringify(error)).not.toContain("private-fixture");expect(error).not.toHaveProperty("result");}expect(f.child.kill).toHaveBeenCalled();
});
it("rejects premature successful process close before stdin finishes",async()=>{const f=fixture(),pending=observed(f.runner.runBinaryFromSource(["docker"],f.controller.signal,Buffer.from([0,255])));f.child.emit("close",0,null);await expect(pending).rejects.toMatchObject({kind:"failed"});});
it.each(["stdout","stderr"])("bounds private %s without exposing partial content",async stream=>{const f=fixture(),pending=observed(f.runner.runBinaryFromSource(["docker"],f.controller.signal,Buffer.from([0,255])));f.child[stream as "stdout"|"stderr"].write(Buffer.alloc(129,65));await expect(pending).rejects.toMatchObject({kind:"output-limit"});expect(f.child.kill).toHaveBeenCalled();});
it("does not spawn for canceled input and kills only its owned process after cancellation",async()=>{const f=fixture();f.controller.abort();await expect(f.runner.runBinaryFromSource(["docker"],f.controller.signal,Buffer.from([1]))).rejects.toMatchObject({kind:"canceled"});expect(f.spawn).not.toHaveBeenCalled();const g=fixture(),pending=observed(g.runner.runBinaryFromSource(["docker"],g.controller.signal,Buffer.from([1])));g.controller.abort();await expect(pending).rejects.toMatchObject({kind:"canceled"});expect(g.child.kill).toHaveBeenCalledOnce();});
it("bounds a native input process that never exits",async()=>{const f=fixture({timeoutMs:5}),pending=observed(f.runner.runBinaryFromSource(["docker"],f.controller.signal,Buffer.from([1])));await expect(pending).rejects.toMatchObject({kind:"timeout"});expect(f.child.kill).toHaveBeenCalled();});
it.each(["empty","large","argv","nul","timeout","output"])("refuses invalid %s before spawning",async kind=>{const f=fixture(kind==="timeout"?{timeoutMs:0}:kind==="output"?{maxOutputBytes:0}:{}),bytes=kind==="empty"?Buffer.alloc(0):kind==="large"?Buffer.alloc(1025):Buffer.from([1]),argv=kind==="argv"?[]:kind==="nul"?["docker\u0000"]:["docker"];await expect(f.runner.runBinaryFromSource(argv,f.controller.signal,bytes)).rejects.toMatchObject({kind:"failed"});expect(f.spawn).not.toHaveBeenCalled();});
it("rejects unavailable stdin or its asynchronous failure without exposing bytes",async()=>{const f=fixture();Object.assign(f.child,{stdin:null});await expect(f.runner.runBinaryFromSource(["docker"],f.controller.signal,Buffer.from([1]))).rejects.toMatchObject({kind:"failed"});const g=fixture(),pending=observed(g.runner.runBinaryFromSource(["docker"],g.controller.signal,Buffer.from([1])));g.stdin.emit("error",new Error("password=private-fixture"));await expect(pending).rejects.toMatchObject({kind:"failed"});});
