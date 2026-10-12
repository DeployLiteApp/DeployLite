import { expect, it, vi } from "vitest";
import { createManagedDatabaseDaemonStopper } from "./docker-managed-database-daemon-stop.js";
import type { DockerCliRunner } from "./docker-cli-image-transport.js";
const containerId = "b".repeat(64), imageId = "sha256:" + "c".repeat(64);
function fixture(engine: "postgres" | "mysql" | "mariadb" | "mongodb" | "redis" = "postgres") {
    const input = {request:{schemaVersion:1,projectId:"project-a",databaseId:"orders",engine},profile:{},commandId:"origin-a",imageId,containerId,environmentFingerprint:"d".repeat(32)};
    const original = {projectId:"project-a",databaseId:"orders",commandId:"origin-a",planDigest:"e".repeat(64),volume:{name:"volume-a",createdAt:"2026-10-10T00:00:00Z"},network:{name:"network-a",id:"f".repeat(64)}};
    const events: string[] = [];
    const verifier = {
        verifyRunning:vi.fn(async () => {events.push("original-running");return {containerId,uid:999};}),
        verifyStopped:vi.fn(async () => {events.push("original-stopped");return {containerId};})
    };
    const authority = {assertValid:vi.fn(async () => {events.push("authority");})};
    const runner = {run:vi.fn<DockerCliRunner["run"]>(async () => {events.push("stop");return {exitCode:0,signal:null,stdout:containerId+"\n",stderr:""};})};
    const options = {runner,verifier,clock:{now:()=>1000},limits:{deadlineMs:1000,maxOutputBytes:1024,stopGraceSeconds:10}};
    return {input,original,events,verifier,authority,runner,options,stopper:createManagedDatabaseDaemonStopper(options)};
}
it.each(["postgres","mysql","mariadb","mongodb","redis"] as const)("stops only the admitted original %s daemon preserving storage and network",async engine => {
    const f=fixture(engine), original=structuredClone(f.original);
    await expect(f.stopper.stop(f.input,f.original,f.authority,new AbortController().signal)).resolves.toEqual({containerId});
    expect(f.events).toEqual(["authority","original-running","authority","stop","original-stopped","authority"]);
    expect(f.runner.run).toHaveBeenCalledWith(["docker","stop","--timeout","10",containerId],expect.any(AbortSignal));
    expect(f.verifier.verifyStopped).toHaveBeenCalledWith(f.input,original,f.authority,expect.any(AbortSignal));
    expect(f.original).toEqual(original);
});
it("rejects mismatched or revoked pre-effect admission without running stop",async () => {
    for(const reason of ["identity","uid","authority","proof"] as const){
        const f=fixture();
        if(reason==="identity")f.verifier.verifyRunning.mockResolvedValue({containerId:"a".repeat(64),uid:999});
        if(reason==="uid")f.verifier.verifyRunning.mockResolvedValue({containerId,uid:0});
        if(reason==="authority")f.authority.assertValid.mockResolvedValueOnce().mockRejectedValue(new Error("revoked"));
        if(reason==="proof")f.verifier.verifyRunning.mockRejectedValue(new Error("private-proof"));
        await expect(f.stopper.stop(f.input,f.original,f.authority,new AbortController().signal)).rejects.toThrow(/^Database daemon stop is unavailable\.$/);
        expect(f.runner.run).not.toHaveBeenCalled();
    }
});
it("withholds success for failed or ambiguous stop and never retries or removes resources",async()=>{
    for(const patch of [{exitCode:1},{signal:"SIGTERM" as const},{stdout:"foreign"},{stdout:containerId+"\nprivate"}]){
        const f=fixture();f.runner.run.mockResolvedValue({exitCode:0,signal:null,stdout:containerId+"\n",stderr:"",...patch});
        await expect(f.stopper.stop(f.input,f.original,f.authority,new AbortController().signal)).rejects.toThrow();
        expect(f.runner.run).toHaveBeenCalledTimes(1);expect(f.verifier.verifyStopped).not.toHaveBeenCalled();
    }
});
it("requires original stopped proof and current final authority after the effect",async()=>{
    for(const reason of ["proof","identity","authority"] as const){
        const f=fixture();
        if(reason==="proof")f.verifier.verifyStopped.mockRejectedValue(new Error("foreign-storage"));
        if(reason==="identity")f.verifier.verifyStopped.mockResolvedValue({containerId:"a".repeat(64)});
        if(reason==="authority")f.authority.assertValid.mockResolvedValueOnce().mockResolvedValueOnce().mockRejectedValue(new Error("revoked"));
        await expect(f.stopper.stop(f.input,f.original,f.authority,new AbortController().signal)).rejects.toThrow();
        expect(f.runner.run).toHaveBeenCalledTimes(1);
    }
});
it("bounds stalled proof and stop ports and rejects pre-cancellation/selectors",async()=>{
    for(const stage of ["proof","stop","stopped"] as const){
        const f=fixture();
        if(stage==="proof")f.verifier.verifyRunning.mockImplementation(()=>new Promise(()=>{}));
        if(stage==="stop")f.runner.run.mockImplementation(()=>new Promise(()=>{}));
        if(stage==="stopped")f.verifier.verifyStopped.mockImplementation(()=>new Promise(()=>{}));
        const stopper=createManagedDatabaseDaemonStopper({...f.options,limits:{...f.options.limits,deadlineMs:5}});
        await expect(stopper.stop(f.input,f.original,f.authority,new AbortController().signal)).rejects.toThrow();
        expect(f.runner.run).toHaveBeenCalledTimes(stage==="proof"?0:1);
    }
    const f=fixture(),cancel=new AbortController();cancel.abort();
    await expect(f.stopper.stop(f.input,f.original,f.authority,cancel.signal)).rejects.toThrow();
    await expect(f.stopper.stop({...f.input,containerId:"--all"},f.original,f.authority,new AbortController().signal)).rejects.toThrow();
    expect(f.runner.run).not.toHaveBeenCalled();
});

it("snapshots caller identity/resources and explicit limits before asynchronous admission",async()=>{
    const f=fixture(), original=structuredClone(f.original), input=structuredClone(f.input);
    f.verifier.verifyRunning.mockImplementation(async()=>{
        f.input.containerId="a".repeat(64);f.original.network.id="a".repeat(64);f.options.limits.stopGraceSeconds=30;
        return {containerId,uid:999};
    });
    await f.stopper.stop(f.input,f.original,f.authority,new AbortController().signal);
    expect(f.verifier.verifyStopped).toHaveBeenCalledWith(input,original,f.authority,expect.any(AbortSignal));
    expect(f.runner.run).toHaveBeenCalledWith(["docker","stop","--timeout","10",containerId],expect.any(AbortSignal));
});
it("expires before stop and rejects invalid operator bounds",async()=>{
    const f=fixture();let now=1000;
    const stopper=createManagedDatabaseDaemonStopper({...f.options,clock:{now:()=>now}});
    f.verifier.verifyRunning.mockImplementation(async()=>{now=2000;return {containerId,uid:999};});
    await expect(stopper.stop(f.input,f.original,f.authority,new AbortController().signal)).rejects.toThrow();
    expect(f.runner.run).not.toHaveBeenCalled();
    for(const patch of [{deadlineMs:0},{deadlineMs:60001},{maxOutputBytes:0},{stopGraceSeconds:0},{stopGraceSeconds:31}])
        expect(()=>createManagedDatabaseDaemonStopper({...f.options,limits:{...f.options.limits,...patch}})).toThrow();
});

it("uses the canonical timeout flag without deprecated reply contamination", async () => {
    const f = fixture();
    f.runner.run.mockImplementation(async argv => ({exitCode:0,signal:null,
        stdout: argv[2] === "--timeout" ? containerId + "\n" : "Flag --time has been deprecated, use --timeout instead\n" + containerId + "\n", stderr:""}));
    await expect(f.stopper.stop(f.input,f.original,f.authority,new AbortController().signal)).resolves.toEqual({containerId});
    expect(f.runner.run).toHaveBeenCalledWith(["docker","stop","--timeout","10",containerId],expect.any(AbortSignal));
});
