import { expect, it, vi } from "vitest";
import { DockerProcessRunner, DockerProcessError, type SpawnedProcess } from "./docker-process-runner.js";
import { MANAGED_DATABASE_CONTAINER_INSPECT_FORMAT, MANAGED_DATABASE_IMAGE_INSPECT_FORMAT } from "./docker-managed-database-inspection-argv.js";
function fakeProcess() {
    const callbacks = new Map<string, (...args: unknown[]) => void>();
    const stdout = { on: vi.fn() }, stderr = { on: vi.fn() };
    const child = { stdout, stderr, once: vi.fn((name: string, callback: (...args: unknown[]) => void) => { callbacks.set(name, callback); return child; }), kill: vi.fn() } as unknown as SpawnedProcess;
    return { child, callbacks, stdout };
}
it("preserves only native projection identities and public keyed fingerprints while redacting unknown secrets", async () => {
    const id = "a".repeat(64), imageId = "sha256:" + "b".repeat(64), name = "/dl-" + "c".repeat(32) + "-database", planDigest = "d".repeat(64), environmentFingerprint = "e".repeat(32);
    for (const format of [MANAGED_DATABASE_CONTAINER_INSPECT_FORMAT, MANAGED_DATABASE_IMAGE_INSPECT_FORMAT]) {
        const native = format === MANAGED_DATABASE_CONTAINER_INSPECT_FORMAT;
        const value = native ? { id, name, imageId, planDigest, environmentFingerprint, note: { planDigest }, password: "private-password" } : { id: imageId, volumes: { "/var/lib/postgresql/data": {} }, note: { planDigest }, password: "private-password" };
        const f = fakeProcess(), promise = new DockerProcessRunner({ spawn: () => f.child }).run(["docker", native ? "container" : "image", "inspect", "--format", format, native ? id : "registry.example.com/postgres@sha256:" + id], new AbortController().signal);
        f.stdout.on.mock.calls[0]![1](JSON.stringify(value));
        f.callbacks.get("close")!(0, null);
        const parsed = JSON.parse((await promise).stdout);
        expect(parsed.id).toBe(native ? id : imageId);
        expect(parsed.password).toBe("[REDACTED]");
        expect(parsed.note.planDigest).toBe("[REDACTED]");
        if (native) {
            expect(parsed.name).toBe(name);
            expect(parsed.imageId).toBe(imageId);
            expect(parsed.planDigest).toBe(planDigest);
            expect(parsed.environmentFingerprint).toBe(environmentFingerprint);
        }
    }
});

it("preserves only an exact labelled initializer name in the native container projection",async()=>{
 const name="/dl-"+"a".repeat(32)+"-database-init",f=fakeProcess();
 const promise=new DockerProcessRunner({spawn:()=>f.child}).run(["docker","container","inspect","--format",MANAGED_DATABASE_CONTAINER_INSPECT_FORMAT,"b".repeat(64)],new AbortController().signal);
 f.stdout.on.mock.calls[0]![1](JSON.stringify({name,note:{name}}));f.callbacks.get("close")!(0,null);
 const value=JSON.parse((await promise).stdout);expect(value.name).toBe(name);expect(value.note.name).not.toBe(name);
});

it("preserves a labelled native initializer create ID while retaining generic redaction",async()=>{
 const id="a".repeat(64);
 for(const native of [true,false]){
  const f=fakeProcess(),argv=native?["docker","create","--name","dl-"+"b".repeat(32)+"-database-init","--label","com.deploylite.database.storage-init=v1","image"]:["docker","create","image"];
  const promise=new DockerProcessRunner({spawn:()=>f.child}).run(argv,new AbortController().signal);f.stdout.on.mock.calls[0]![1](id);f.callbacks.get("close")!(0,null);
  if(native)expect((await promise).stdout).toBe(id);else expect((await promise).stdout).not.toBe(id);
 }
});

it.each(["create", "start"] as const)("preserves only the exact native %s public ID reply", async operation => {
    const id = "a".repeat(64), name = "dl-" + "b".repeat(32) + "-database";
    const argv = operation === "create" ? ["docker", "create", "--name", name, "--label", "com.deploylite.database.engine=postgres", "image"] : ["docker", "start", id];
    const f = fakeProcess(), pending = new DockerProcessRunner({spawn: () => f.child}).run(argv, new AbortController().signal);
    f.stdout.on.mock.calls[0]![1](id + "\n"); f.callbacks.get("close")!(0, null);
    expect((await pending).stdout).toBe(id + "\n");
});
it("retains diagnostic redaction for unlabelled create, different start IDs and secret-bearing replies", async () => {
    const id = "a".repeat(64);
    for (const [argv, output] of [
        [["docker", "create", "image"], id],
        [["docker", "start", id], "b".repeat(64)],
        [["docker", "start", id], id + "\npassword=private"]
    ] as const) {
        const f = fakeProcess(), pending = new DockerProcessRunner({spawn: () => f.child}).run(argv, new AbortController().signal);
        f.stdout.on.mock.calls[0]![1](output); f.callbacks.get("close")!(0, null);
        expect((await pending).stdout).not.toBe(output);
    }
});

it("preserves only the exact bounded stop reply for the caller's public original ID",async()=>{
    const id="a".repeat(64),f=fakeProcess();
    const pending=new DockerProcessRunner({spawn:()=>f.child}).run(["docker","stop","--time","10",id],new AbortController().signal);
    f.stdout.on.mock.calls[0]![1](id+"\n");f.callbacks.get("close")!(0,null);
    expect((await pending).stdout).toBe(id+"\n");
});

it("retains stop diagnostic redaction for foreign IDs, extra options, failed exits and secret output",async()=>{
    const id="a".repeat(64);
    for(const [argv,output,exit] of [
        [["docker","stop","--time","10",id],"b".repeat(64),0],
        [["docker","stop","--time","0",id],id,0],
        [["docker","stop","--time","31",id],id,0],
        [["docker","stop","--time","10",id,"foreign"],id,0],
        [["docker","stop","--time","10",id],id+"\npassword=private",0],
        [["docker","stop","--time","10",id],id,1]
    ] as const){
        const f=fakeProcess(),pending=new DockerProcessRunner({spawn:()=>f.child}).run(argv,new AbortController().signal);
        f.stdout.on.mock.calls[0]![1](output);f.callbacks.get("close")!(exit,null);
        if (exit !== 0) {
            const error = await pending.catch(error => error);
            expect(error).toBeInstanceOf(DockerProcessError);
            expect((error as DockerProcessError).result?.stdout).not.toBe(output);
        } else expect((await pending).stdout).not.toBe(output);
    }
});

it("preserves only a canonical bounded timeout stop reply and keeps unsafe variants redacted",async()=>{
    const id="a".repeat(64);
    for (const [grace,output,valid] of [["10",id+"\n",true],["0",id,false],["31",id,false],["10","b".repeat(64),false],["10",id+"\npassword=private",false]] as const) {
        const f=fakeProcess(),pending=new DockerProcessRunner({spawn:()=>f.child}).run(["docker","stop","--timeout",grace,id],new AbortController().signal);
        f.stdout.on.mock.calls[0]![1](output);f.callbacks.get("close")!(0,null);
        if(valid)expect((await pending).stdout).toBe(output);else expect((await pending).stdout).not.toBe(output);
    }
});
