import {createHash} from "node:crypto";
import {expect,it,vi} from "vitest";
import {createManagedDatabaseComposePreview,digestComposeResourceObservation,digestControlInput,planManagedDatabaseProfile} from "@deploylite/domain";
import {createManagedDatabaseRestoreVolumeWriter} from "./docker-managed-database-restore-volume.js";
function fixture(){
 const imagePolicy={policyVersion:"images-1",trustedHosts:["registry.example.com"],allowTags:false,allowDigests:true};
 const request={schemaVersion:1 as const,projectId:"project-a",databaseId:"orders",engine:"redis" as const},profile={schemaVersion:1,profileId:"redis-a",engine:"redis",image:"registry.example.com/redis@sha256:"+"a".repeat(64),dataPath:"/data",containerPort:6379,credentialKeys:["DATABASE_PASSWORD"],backupStrategy:"volume-quiesced"};
 const plan=planManagedDatabaseProfile(request,profile,imagePolicy),preview=createManagedDatabaseComposePreview(request,profile,imagePolicy),originalId="b".repeat(64),helperId="c".repeat(64),commandId="restore-a";
 const input={request,profile,commandId:"origin-a",imageId:"sha256:"+"d".repeat(64),containerId:originalId,environmentFingerprint:"e".repeat(32)};
 const resources={projectId:request.projectId,databaseId:request.databaseId,commandId:input.commandId,planDigest:plan.planDigest,volume:{name:plan.volume.runtimeName,createdAt:"2026-10-10T00:00:00Z"},network:{name:plan.network.runtimeName,id:"f".repeat(64)}};
 const state={helper:false,wait:"0",remove:helperId,extra:false,foreignResource:false,helperNetworks:[] as Array<{name:string;networkId:string}>};
 const baseline={id:originalId,name:"/original",imageId:input.imageId,image:plan.image,owner:"deploylite",projectId:request.projectId,databaseId:request.databaseId,engine:"redis",commandId:input.commandId,planDigest:plan.planDigest,environmentFingerprint:input.environmentFingerprint,networkMode:plan.network.runtimeName,storageInitialization:null,running:false,health:"healthy" as const,user:"redis",readOnly:true,privileged:false,capAdd:[],capDrop:["ALL"],securityOpt:["no-new-privileges"],cpu:1000000000,memory:536870912,pids:256,ports:null};
 const helper={...baseline,id:helperId,name:"/dl-"+digestControlInput({projectId:request.projectId,databaseId:request.databaseId,commandId}).slice(0,32)+"-database-init",environmentFingerprint:null,networkMode:"none",storageInitialization:"v1",health:null};
 const nativeInspector={inspectContainer:vi.fn(async(id:string)=>structuredClone(id===originalId?baseline:helper)),inspectImage:vi.fn(async()=>({imageId:input.imageId,declaredVolumes:["/data"]}))};
 const verifier={verifyStopped:vi.fn(async()=>({containerId:originalId}))},authority={assertValid:vi.fn(async()=>{})},clock={now:()=>2000};
 const composeInspector={inspectAllConsumers:vi.fn(async({kind}:{kind:"network"|"volume"})=>{
  const original={containerId:originalId,service:plan.volume.key,running:false,attached:true,composeConfigDigest:preview.configDigest,composeEnvironmentDigest:digestControlInput({environmentFingerprint:input.environmentFingerprint}),networks:[{name:plan.network.runtimeName,networkId:resources.network.id}],mounts:kind==="volume"?[{target:"/data",readOnly:false}]:[]};
  const consumer={containerId:helperId,service:plan.volume.key,running:false,attached:kind==="volume",composeConfigDigest:preview.configDigest,networks:state.helperNetworks,mounts:kind==="volume"?[{target:"/data",readOnly:false}]:[]};
  const value={schemaVersion:1 as const,owner:"deploylite",agentId:"agent-a",projectId:request.projectId,kind,key:plan.volume.key,runtimeName:kind==="volume"?resources.volume.name:resources.network.name,physicalIdentity:state.foreignResource?"foreign":kind==="volume"?resources.volume.createdAt:resources.network.id,configDigest:preview.configDigest,observedAt:clock.now(),containers:[original,...(state.helper?[consumer]:[]),...(state.extra?[{...consumer,containerId:"0".repeat(64)}]:[])],stateDigest:"0".repeat(64)};
  value.stateDigest=digestComposeResourceObservation(value);return value;
 })};
 const runner={run:vi.fn(async(argv:readonly string[])=>{let stdout="";if(argv[1]==="create"){state.helper=true;stdout=helperId;}else if(argv[1]==="wait")stdout=state.wait;else if(argv[1]==="rm"){state.helper=false;stdout=state.remove;}else throw new Error("unexpected operation");return {exitCode:0,signal:null,stdout,stderr:""};}),runBinaryFromSource:vi.fn(async(_argv:readonly string[],_signal:AbortSignal,bytes:Uint8Array)=>({bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")}))};
 const options={owner:"deploylite",agentId:"agent-a",imagePolicy,clock,runner,nativeInspector,verifier,composeInspector,limits:{deadlineMs:5000,maxBytes:10000,maxOutputBytes:4096,cpus:1,memoryBytes:536870912,pidsLimit:256}};
 const bytes=Buffer.alloc(1024),signal=new AbortController().signal,writer=createManagedDatabaseRestoreVolumeWriter(options),restore=()=>writer.restore(input,resources,bytes,authority,signal,6000,commandId);
 return {options,input,resources,bytes,signal,commandId,state,baseline,helper,runner,verifier,authority,composeInspector,nativeInspector,restore,originalId,helperId};
}
it("uses the existing owned helper lifecycle to restore only the stopped original Redis volume and removes only that helper",async()=>{
 const f=fixture(),result=await f.restore();expect(result).toEqual({bytes:1024,sha256:createHash("sha256").update(f.bytes).digest("hex")});expect(f.verifier.verifyStopped).toHaveBeenCalledTimes(2);expect(f.runner.runBinaryFromSource).toHaveBeenCalledOnce();
 const create=f.runner.run.mock.calls[0]![0];expect(create).toContain("--read-only");expect(create).toContain("--cap-drop=ALL");expect(create).toContain("--network");expect(create).toContain("none");expect(create).toContain("redis");expect(create).toContain(`type=volume,source=${f.resources.volume.name},target=/data,volume-nocopy`);expect(create.join(" ")).not.toContain("--env");
 expect(f.runner.runBinaryFromSource.mock.calls[0]![0]).toEqual(["docker","start","--attach","--interactive",f.helperId]);expect(f.runner.run.mock.calls.slice(1).map(call=>call[0])).toEqual([["docker","wait",f.helperId],["docker","rm",f.helperId]]);expect(f.state.helper).toBe(false);
});
it.each(["tar","source","image","authority"])("denies invalid %s before helper creation or volume write",async mode=>{
 const f=fixture();if(mode==="tar")f.bytes[0]=1;if(mode==="source")f.state.foreignResource=true;if(mode==="image")f.nativeInspector.inspectImage.mockResolvedValue({imageId:"sha256:"+"0".repeat(64),declaredVolumes:["/data"]});if(mode==="authority")f.authority.assertValid.mockRejectedValue(new Error("unconfirmed"));await expect(f.restore()).rejects.toThrow();expect(f.runner.run).not.toHaveBeenCalled();expect(f.runner.runBinaryFromSource).not.toHaveBeenCalled();
});
it.each(["helper-owner","helper-root","foreign-consumer","changed-original","provider"])("denies detached %s after creation before private volume input",async mode=>{
 const f=fixture(),create=f.runner.run.getMockImplementation()!;f.runner.run.mockImplementation(async argv=>{const result=await create(argv);if(argv[1]==="create"){if(mode==="helper-owner")f.helper.owner="foreign";if(mode==="helper-root")f.helper.user="0:0";if(mode==="foreign-consumer")f.state.extra=true;if(mode==="changed-original")f.baseline.environmentFingerprint="0".repeat(32);if(mode==="provider")f.runner.runBinaryFromSource=vi.fn(async()=>({bytes:1024,sha256:"0".repeat(64)}));}return result;});await expect(f.restore()).rejects.toThrow();expect(f.runner.runBinaryFromSource).not.toHaveBeenCalled();expect(f.runner.run.mock.calls.filter(call=>call[0][1]==="create")).toHaveLength(1);
});
it.each(["input","wait","remove"])("withholds success for %s uncertainty without repeating native input",async mode=>{
 const f=fixture();if(mode==="input")f.runner.runBinaryFromSource.mockRejectedValue(new Error("password=private-fixture"));if(mode==="wait")f.state.wait="1";if(mode==="remove")f.state.remove="0".repeat(64);await expect(f.restore()).rejects.toThrow("Database restore volume is unavailable.");expect(f.runner.runBinaryFromSource).toHaveBeenCalledOnce();expect(f.runner.run.mock.calls.filter(call=>call[0][1]==="create")).toHaveLength(1);
});
it("bounds canceled and stalled source observation without creating a helper",async()=>{
 const f=fixture(),abort=new AbortController();abort.abort();await expect(createManagedDatabaseRestoreVolumeWriter(f.options).restore(f.input,f.resources,f.bytes,f.authority,abort.signal,6000,f.commandId)).rejects.toThrow();expect(f.runner.run).not.toHaveBeenCalled();
 const g=fixture();g.options.limits.deadlineMs=5;g.composeInspector.inspectAllConsumers.mockImplementation(()=>new Promise(()=>{}));await expect(createManagedDatabaseRestoreVolumeWriter(g.options).restore(g.input,g.resources,g.bytes,g.authority,g.signal,6000,g.commandId)).rejects.toThrow();expect(g.runner.run).not.toHaveBeenCalled();
});

it("accepts only the Docker builtin none network retained by the stopped owned helper",async()=>{
 const f=fixture();f.state.helperNetworks=[{name:"none",networkId:"a".repeat(64)}];await expect(f.restore()).resolves.toMatchObject({bytes:1024});expect(f.runner.runBinaryFromSource).toHaveBeenCalledOnce();
});
it.each(["bridge","project","two"])("rejects %s helper network before private input",async mode=>{
 const f=fixture();f.state.helperNetworks=mode==="two"?[{name:"none",networkId:"a".repeat(64)},{name:"none",networkId:"b".repeat(64)}]:[{name:mode==="project"?f.resources.network.name:"bridge",networkId:"a".repeat(64)}];await expect(f.restore()).rejects.toThrow();expect(f.runner.runBinaryFromSource).not.toHaveBeenCalled();
});
