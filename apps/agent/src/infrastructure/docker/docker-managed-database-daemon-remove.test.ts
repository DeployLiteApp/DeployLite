import {expect,it,vi} from "vitest";
import type {DockerCliRunner} from "./docker-cli-image-transport.js";
import {createManagedDatabaseDaemonRemover} from "./docker-managed-database-daemon-remove.js";
const containerId="b".repeat(64), imageId="sha256:"+"c".repeat(64);
function fixture(engine: "postgres"|"mysql"|"mariadb"|"mongodb"|"redis"="postgres") {
  const input={request:{schemaVersion:1,projectId:"project-a",databaseId:"orders",engine},profile:{},commandId:"origin-a",containerId,imageId,environmentFingerprint:"d".repeat(32)};
  const original={projectId:"project-a",databaseId:"orders",commandId:"origin-a",planDigest:"e".repeat(64),volume:{name:"volume-a",createdAt:"2026-10-10T00:00:00Z"},network:{name:"network-a",id:"f".repeat(64)}};
  const events: string[]=[], authority={assertValid:vi.fn(async()=>{events.push("authority");})};
  const verifier={verifyStopped:vi.fn(async()=>{events.push("stopped-original");return {containerId};}),verifyRetained:vi.fn(async()=>{events.push("retained-original");return {containerId};})};
  const runner={run:vi.fn<DockerCliRunner["run"]>(async argv=>{events.push(argv[1]==="rm"?"remove":"absence");return {exitCode:0,signal:null,stdout:argv[1]==="rm"?containerId+"\n":"",stderr:""};})};
  let now=1000;
  const options={runner,verifier,clock:{now:()=>now},limits:{deadlineMs:1000,maxOutputBytes:1024}};
  return {input,original,events,authority,verifier,runner,options,remover:createManagedDatabaseDaemonRemover(options),setNow:(value:number)=>{now=value;}};
}
it.each(["postgres","mysql","mariadb","mongodb","redis"] as const)("removes only the corroborated stopped %s daemon with retained original storage",async engine=>{
  const f=fixture(engine), original=structuredClone(f.original);
  await expect(f.remover.remove(f.input,f.original,f.authority,new AbortController().signal)).resolves.toEqual({containerId,storage:"retained"});
  expect(f.events).toEqual(["authority","stopped-original","authority","remove","absence","retained-original","authority"]);
  expect(f.runner.run.mock.calls.map(([argv])=>argv)).toEqual([["docker","rm",containerId],["docker","container","ls","--all","--no-trunc","--filter",`id=${containerId}`,"--format","{{.ID}}"]]);
  expect(f.verifier.verifyRetained).toHaveBeenCalledWith(f.input,original,f.authority,expect.any(AbortSignal)); expect(f.original).toEqual(original);
});
it("rejects failed stopped admission or revoked authority before removing anything",async()=>{
  for(const mode of ["identity","running","authority"]){const f=fixture();
    if(mode==="identity")f.verifier.verifyStopped.mockResolvedValue({containerId:"a".repeat(64)});
    if(mode==="running")f.verifier.verifyStopped.mockRejectedValue(new Error("running"));
    if(mode==="authority")f.authority.assertValid.mockResolvedValueOnce().mockRejectedValue(new Error("revoked"));
    await expect(f.remover.remove(f.input,f.original,f.authority,new AbortController().signal)).rejects.toThrow(); expect(f.runner.run).not.toHaveBeenCalled();}
});
it("withholds ambiguous removal without force, storage removal, retry or adoption",async()=>{
  for(const patch of [{exitCode:1},{signal:"SIGTERM" as const},{stdout:"foreign"},{stdout:containerId+"\nprivate"},{stderr:"x".repeat(1025)}]) {
    const f=fixture(); f.runner.run.mockResolvedValueOnce({exitCode:0,signal:null,stdout:containerId+"\n",stderr:"",...patch});
    await expect(f.remover.remove(f.input,f.original,f.authority,new AbortController().signal)).rejects.toThrow();
    expect(f.runner.run).toHaveBeenCalledExactlyOnceWith(["docker","rm",containerId],expect.any(AbortSignal)); expect(f.verifier.verifyRetained).not.toHaveBeenCalled();
  }
});
it("requires explicit absence and retained proof after removal without repeating the effect",async()=>{
  for(const mode of ["present","unavailable","retained","identity","revoked"]){const f=fixture();
    if(mode==="present")f.runner.run.mockResolvedValueOnce({exitCode:0,signal:null,stdout:containerId+"\n",stderr:""}).mockResolvedValueOnce({exitCode:0,signal:null,stdout:containerId+"\n",stderr:""});
    if(mode==="unavailable")f.runner.run.mockResolvedValueOnce({exitCode:0,signal:null,stdout:containerId+"\n",stderr:""}).mockRejectedValueOnce(new Error("private"));
    if(mode==="retained")f.verifier.verifyRetained.mockRejectedValue(new Error("changed-storage"));
    if(mode==="identity")f.verifier.verifyRetained.mockResolvedValue({containerId:"a".repeat(64)});
    if(mode==="revoked")f.verifier.verifyRetained.mockImplementation(async()=>{f.authority.assertValid.mockRejectedValue(new Error("revoked"));return {containerId};});
    await expect(f.remover.remove(f.input,f.original,f.authority,new AbortController().signal)).rejects.toThrow(/^Database daemon removal is unavailable\.$/);
    expect(f.runner.run.mock.calls.filter(([argv])=>argv[1]==="rm")).toHaveLength(1);
  }
});
it("bounds stalled ports, cancellation and expired admission",async()=>{
  for(const mode of ["stopped","remove","absence","retained"]){const f=fixture();
    if(mode==="stopped")f.verifier.verifyStopped.mockImplementation(()=>new Promise(()=>{}));
    if(mode==="remove")f.runner.run.mockImplementation(()=>new Promise(()=>{}));
    if(mode==="absence")f.runner.run.mockResolvedValueOnce({exitCode:0,signal:null,stdout:containerId+"\n",stderr:""}).mockImplementation(()=>new Promise(()=>{}));
    if(mode==="retained")f.verifier.verifyRetained.mockImplementation(()=>new Promise(()=>{}));
    const remover=createManagedDatabaseDaemonRemover({...f.options,limits:{...f.options.limits,deadlineMs:5}});
    await expect(remover.remove(f.input,f.original,f.authority,new AbortController().signal)).rejects.toThrow();
    expect(f.runner.run.mock.calls.filter(([argv])=>argv[1]==="rm")).toHaveLength(mode==="stopped"?0:1);
  }
  const f=fixture(),abort=new AbortController();abort.abort();await expect(f.remover.remove(f.input,f.original,f.authority,abort.signal)).rejects.toThrow();
  f.verifier.verifyStopped.mockImplementation(async()=>{f.setNow(2000);return {containerId};});await expect(f.remover.remove(f.input,f.original,f.authority,new AbortController().signal)).rejects.toThrow();expect(f.runner.run).not.toHaveBeenCalled();
});
it("snapshots inputs before waits and rejects invalid selectors and explicit bounds",async()=>{
  const f=fixture(),input=structuredClone(f.input),original=structuredClone(f.original);
  f.verifier.verifyStopped.mockImplementation(async()=>{f.input.containerId="a".repeat(64);f.original.network.id="a".repeat(64);f.options.limits.maxOutputBytes=1;return {containerId};});
  await f.remover.remove(f.input,f.original,f.authority,new AbortController().signal);
  expect(f.verifier.verifyRetained).toHaveBeenCalledWith(input,original,f.authority,expect.any(AbortSignal));
  const invalid=fixture();await expect(invalid.remover.remove({...invalid.input,containerId:"--all"},invalid.original,invalid.authority,new AbortController().signal)).rejects.toThrow();expect(invalid.runner.run).not.toHaveBeenCalled();
  for(const limits of [{deadlineMs:0,maxOutputBytes:1},{deadlineMs:60001,maxOutputBytes:1},{deadlineMs:1,maxOutputBytes:0},{deadlineMs:1,maxOutputBytes:1048577}])expect(()=>createManagedDatabaseDaemonRemover({...invalid.options,limits})).toThrow();
});
