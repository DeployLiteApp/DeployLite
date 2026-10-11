import {createHash} from "node:crypto";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import {expect,it,vi} from "vitest";
import {DockerProcessRunner,type SpawnedProcess} from "./docker-process-runner.js";
function fixture(options:{maxOutputBytes?:number;maxBinaryBytes?:number;timeoutMs?:number}={}){
 const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),kill:vi.fn()});
 const spawn=vi.fn(()=>child as unknown as SpawnedProcess),runner=new DockerProcessRunner({...options,spawn});
 const chunks:Buffer[]=[],signal=new AbortController();
 return {child,spawn,runner,chunks,signal,sink:async(chunk:Uint8Array)=>{chunks.push(Buffer.from(chunk));}};
}
it("streams exact non-UTF8 archive bytes privately and returns only count and SHA256",async()=>{
 const f=fixture(),data=Buffer.from([0,255,128,254,10]),pending=f.runner.runBinaryToSink(["docker","exec","a".repeat(64),"pg_dump","-Fc"],f.signal.signal,f.sink);
 f.child.stdout.end(data);f.child.emit("close",0,null);
 expect(await pending).toEqual({bytes:data.length,sha256:createHash("sha256").update(data).digest("hex")});expect(Buffer.concat(f.chunks)).toEqual(data);
 expect(f.spawn.mock.calls[0]).toEqual(["docker",["exec","a".repeat(64),"pg_dump","-Fc"],{shell:false,detached:true,stdio:["ignore","pipe","pipe"]}]);
});
it("waits for private sink settlement even after process close",async()=>{
 const f=fixture();let release!:()=>void,settled=false;const sink=vi.fn(()=>new Promise<void>(done=>{release=done;}));
 const pending=f.runner.runBinaryToSink(["docker","exec","a".repeat(64),"pg_dump"],f.signal.signal,sink).then(result=>{settled=true;return result;});
 f.child.stdout.write(Buffer.from([255]));await Promise.resolve();f.child.emit("close",0,null);await Promise.resolve();expect(settled).toBe(false);release();expect((await pending).bytes).toBe(1);
});
it("refuses empty argv and already cancelled callers before spawning",async()=>{
 const f=fixture();await expect(f.runner.runBinaryToSink([],f.signal.signal,f.sink)).rejects.toMatchObject({kind:"failed"});f.signal.abort();
 await expect(f.runner.runBinaryToSink(["docker"],f.signal.signal,f.sink)).rejects.toMatchObject({kind:"canceled"});expect(f.spawn).not.toHaveBeenCalled();expect(f.chunks).toEqual([]);
});
it("kills over-budget binary output without delivering excess bytes",async()=>{
 const f=fixture({maxOutputBytes:2}),pending=f.runner.runBinaryToSink(["docker"],f.signal.signal,f.sink);f.child.stdout.write(Buffer.from([0,255,128]));
 await expect(pending).rejects.toMatchObject({kind:"output-limit"});expect(f.child.kill).toHaveBeenCalledWith("SIGKILL");expect(f.chunks).toEqual([]);
});
it("does not publish dump bytes or diagnostics when the process fails",async()=>{
 const f=fixture(),pending=f.runner.runBinaryToSink(["docker"],f.signal.signal,f.sink);f.child.stderr.write("private-password=abcdef");f.child.emit("close",1,null);
 try{await pending;throw new Error("failure required");}catch(error){expect(error).toMatchObject({kind:"failed"});expect(JSON.stringify(error)).not.toContain("abcdef");expect(error).not.toHaveProperty("result");}
});
it("kills and withholds success on sink failure without leaking its private error",async()=>{
 const f=fixture(),pending=f.runner.runBinaryToSink(["docker"],f.signal.signal,async()=>{throw new Error("private archive path");});f.child.stdout.write(Buffer.from([255]));
 await expect(pending).rejects.toMatchObject({kind:"failed"});expect(f.child.kill).toHaveBeenCalled();await pending.catch(error=>expect(String(error)).not.toContain("private archive path"));
});
it("kills on cancellation during a blocked private write",async()=>{
 const f=fixture(),pending=f.runner.runBinaryToSink(["docker"],f.signal.signal,()=>new Promise<void>(()=>{}));f.child.stdout.write(Buffer.from([255]));f.signal.abort();
 await expect(pending).rejects.toMatchObject({kind:"canceled"});expect(f.child.kill).toHaveBeenCalled();
});
it("kills on the existing deadline rather than accepting an unclosed process",async()=>{
 const f=fixture({timeoutMs:5}),pending=f.runner.runBinaryToSink(["docker"],f.signal.signal,f.sink);
 await expect(pending).rejects.toMatchObject({kind:"timeout"});expect(f.child.kill).toHaveBeenCalled();
});
it("rejects diagnostics beyond their fixed bound without exposing them",async()=>{
 const f=fixture(),pending=f.runner.runBinaryToSink(["docker"],f.signal.signal,f.sink);f.child.stderr.write(Buffer.alloc(65537,65));
 await expect(pending).rejects.toMatchObject({kind:"output-limit"});expect(f.child.kill).toHaveBeenCalled();
});

it("hashes accepted bytes before a sink can mutate its private copy",async()=>{
 const f=fixture(),data=Buffer.from([0,255,128]),expected=createHash("sha256").update(data).digest("hex");
 const pending=f.runner.runBinaryToSink(["docker"],f.signal.signal,async chunk=>{chunk.fill(65);});f.child.stdout.end(data);f.child.emit("close",0,null);
 expect((await pending).sha256).toBe(expected);expect(data).toEqual(Buffer.from([0,255,128]));
});

it("refuses successful process exit with an empty archive",async()=>{
 const f=fixture(),pending=f.runner.runBinaryToSink(["docker"],f.signal.signal,f.sink);f.child.emit("close",0,null);await expect(pending).rejects.toMatchObject({kind:"failed"});expect(f.chunks).toEqual([]);
});

it("pauses a real injected stream until each private write settles in order",async()=>{
 const f=fixture(),writes:Buffer[]=[],releases:Array<()=>void>=[];
 const pending=f.runner.runBinaryToSink(["docker"],f.signal.signal,chunk=>{writes.push(Buffer.from(chunk));return new Promise<void>(done=>releases.push(done));});
 f.child.stdout.write(Buffer.from([0,255]));f.child.stdout.write(Buffer.from([128]));await Promise.resolve();expect(writes).toEqual([Buffer.from([0,255])]);expect(f.child.stdout.isPaused()).toBe(true);
 releases[0]!();await new Promise<void>(done=>setImmediate(done));expect(writes).toEqual([Buffer.from([0,255]),Buffer.from([128])]);releases[1]!();f.child.stdout.end();f.child.emit("close",0,null);
 expect((await pending).bytes).toBe(3);
});
it("uses generic binary errors for spawn exceptions, signal exit and stream errors",async()=>{
 const secret="private child error";const broken=new DockerProcessRunner({spawn:()=>{throw new Error(secret);}});
 await broken.runBinaryToSink(["docker"],new AbortController().signal,async()=>{}).catch(error=>{expect(error).toMatchObject({kind:"failed"});expect(String(error)).not.toContain(secret);});
 for(const mode of ["signal","stream"]){const f=fixture(),pending=f.runner.runBinaryToSink(["docker"],f.signal.signal,f.sink);if(mode==="signal")f.child.emit("close",0,"SIGTERM");else f.child.stdout.emit("error",new Error(secret));await expect(pending).rejects.toMatchObject({kind:"failed"});}
});
it("refuses invalid budgets and NUL argv before touching the injected process",async()=>{
 for(const options of [{timeoutMs:0},{maxOutputBytes:0},{maxOutputBytes:NaN}]){const f=fixture(options);await expect(f.runner.runBinaryToSink(["docker"],f.signal.signal,f.sink)).rejects.toMatchObject({kind:"failed"});expect(f.spawn).not.toHaveBeenCalled();}
 const f=fixture();await expect(f.runner.runBinaryToSink(["docker","bad\u0000argument"],f.signal.signal,f.sink)).rejects.toMatchObject({kind:"failed"});expect(f.spawn).not.toHaveBeenCalled();
});
it("keeps an explicit archive byte budget separate from the original text output bound",async()=>{
 const f=fixture({maxOutputBytes:2,maxBinaryBytes:4}),pending=f.runner.runBinaryToSink(["docker"],f.signal.signal,f.sink);
 f.child.stdout.end(Buffer.from([0,255,128]));f.child.emit("close",0,null);expect((await pending).bytes).toBe(3);
});
it("rejects archive output over the smaller explicit binary budget before private delivery",async()=>{
 const f=fixture({maxOutputBytes:4,maxBinaryBytes:1}),pending=f.runner.runBinaryToSink(["docker"],f.signal.signal,f.sink);
 f.child.stdout.end(Buffer.from([0,255]));f.child.emit("close",0,null);await expect(pending).rejects.toMatchObject({kind:"output-limit"});expect(f.chunks).toEqual([]);
});
it("rejects a malformed explicit binary budget before the process exists",async()=>{
 const f=fixture({maxBinaryBytes:0}),pending=f.runner.runBinaryToSink(["docker"],f.signal.signal,f.sink);
 f.child.stdout.end(Buffer.from([255]));f.child.emit("close",0,null);await expect(pending).rejects.toMatchObject({kind:"failed"});expect(f.spawn).not.toHaveBeenCalled();
});
