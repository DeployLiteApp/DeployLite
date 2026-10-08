import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { protocolPayloadFingerprint, type ComposeResourceObservationV1, type ComposeResourceInspectionInput } from "@deploylite/contracts";
import * as domain from "./index.js";
const imagePolicy = { policyVersion: "inspection-test-1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true };
const image = `registry.example.com/app@sha256:${"a".repeat(64)}`;
const document = JSON.stringify({ services: { app: { image, networks: ["app"], environment: { TOKEN: "${APP_TOKEN}" } } }, networks: { app: {} } });
const preview = domain.createComposePreview(document,"project-1",imagePolicy);
type Input = ComposeResourceInspectionInput;
function seal(o: ComposeResourceObservationV1) { const { observedAt: _time,stateDigest: _digest,...state }=o; o.stateDigest=createHash("sha256").update(protocolPayloadFingerprint(state)).digest("hex");return o; }
function fixture() {
  const observation: ComposeResourceObservationV1=seal({schemaVersion:1,owner:"deploylite",agentId:"agent-1",projectId:"project-1",kind:"network",key:"app",runtimeName:preview.networks[0]!.runtimeName,physicalIdentity:"b".repeat(64),configDigest:preview.configDigest,stateDigest:"0".repeat(64),observedAt:1_000,containers:[{containerId:"c".repeat(64),service:"app",running:true,attached:true,mounts:[]}]});
  const inspect=vi.fn(async (_input: unknown,_signal:AbortSignal)=>structuredClone(observation));
  const deps:{-readonly [P in keyof domain.ComposeAttachmentPreviewDependencies]:domain.ComposeAttachmentPreviewDependencies[P]}={imagePolicy,owner:"deploylite",agentId:"agent-1",inspector:{inspect},clock:{now:()=>1_010},maxAgeMs:100};
  const input:Input={document,projectId:"project-1",kind:"network",key:"app",expectedConfigDigest:preview.configDigest};
  return {observation,inspect,deps,input};
}
const call = domain.createComposeResourceInspectionView;
describe("safe current Compose inspection view",()=>{
  it("returns only current bounded service-use metadata and never permits execution",async()=>{
    const s=fixture();const v=await call(s.input,s.deps);
    expect(v).toEqual({schemaVersion:1,status:"observed",executionAllowed:false,projectId:"project-1",kind:"network",key:"app",configDigest:preview.configDigest,stateDigest:s.observation.stateDigest,observedAt:1_000,containers:[{service:"app",running:true,attached:true}]});
    expect(s.inspect).toHaveBeenCalledOnce();expect(JSON.stringify(v)).not.toContain("APP_TOKEN");expect(JSON.stringify(v)).not.toContain("c".repeat(64));expect(JSON.stringify(v)).not.toContain(image);
  });
  it("can report an owned resource with zero consumers",async()=>{
    const s=fixture();s.observation.containers=[];seal(s.observation);
    await expect(call(s.input,s.deps)).resolves.toMatchObject({containers:[],executionAllowed:false});
  });
  it("checks the requested digest and declared resource before invoking the port",async()=>{
    const s=fixture();s.input.expectedConfigDigest="f".repeat(64);
    await expect(call(s.input,s.deps)).rejects.toMatchObject({code:"COMPOSE_RESOURCE_STALE"});expect(s.inspect).not.toHaveBeenCalled();
    s.input.expectedConfigDigest=preview.configDigest;s.input.key="missing";
    await expect(call(s.input,s.deps)).rejects.toMatchObject({code:"COMPOSE_RESOURCE_CONFLICT"});expect(s.inspect).not.toHaveBeenCalled();
  });
  for(const field of ["owner","agentId","projectId"] as const)it(`refuses foreign observation ${field}`,async()=>{
    const s=fixture();s.observation[field]="foreign";seal(s.observation);
    await expect(call(s.input,s.deps)).rejects.toMatchObject({code:"COMPOSE_RESOURCE_FOREIGN"});
  });
  it("refuses a corrupt observation digest",async()=>{const s=fixture();s.observation.stateDigest="e".repeat(64);await expect(call(s.input,s.deps)).rejects.toMatchObject({code:"COMPOSE_INSPECTION_INVALID"});});
  it("does not reflect unsafe documents or unknown observation fields",async()=>{
    const s=fixture();Object.assign(s.observation,{password:"do-not-reflect"});
    const e=await call(s.input,s.deps).catch((e:unknown)=>e);expect(e).toMatchObject({code:"COMPOSE_INSPECTION_INVALID"});expect(JSON.stringify(e)).not.toContain("do-not-reflect");
    s.input.document="password=do-not-reflect";await expect(call(s.input,s.deps)).rejects.toMatchObject({code:"COMPOSE_INSPECTION_INVALID"});
  });
  for(const observedAt of [100,2_000])it(`refuses stale/future observation ${observedAt}`,async()=>{
    const s=fixture();s.observation.observedAt=observedAt;
    await expect(call(s.input,s.deps)).rejects.toMatchObject({code:"COMPOSE_RESOURCE_STALE"});
  });
  it("masks an untrusted port failure",async()=>{
    const s=fixture();s.deps.inspector.inspect=async()=>{throw new Error("password=do-not-reflect");};
    const e=await call(s.input,s.deps).catch((e:unknown)=>e);expect(e).toMatchObject({code:"COMPOSE_INSPECTION_FAILED"});expect(JSON.stringify(e)).not.toContain("do-not-reflect");
  });
  it("captures configured owner/age before awaiting observation",async()=>{
    const s=fixture();s.deps.inspector.inspect=async()=>{s.deps.owner="changed";s.deps.maxAgeMs=0;return structuredClone(s.observation);};
    await expect(call(s.input,s.deps)).resolves.toMatchObject({status:"observed",executionAllowed:false});
  });
});
