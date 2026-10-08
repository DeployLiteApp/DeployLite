// @vitest-environment jsdom
import { act,cleanup,fireEvent,render,screen } from "@testing-library/react";
import { afterEach,describe,expect,it,vi } from "vitest";
import type { ComposeAttachmentPreviewV1,ComposePreviewV1,ComposeResourceInspectionInput,ComposeResourceInspectionViewV1 } from "@deploylite/contracts";
import { inspectProjectComposeResource as inspect,previewProjectComposeAttachment as attachment } from "./compose-resource-client";
import { ComposePreviewCard } from "./compose-preview-card";

const props={projectId:"project-1",apiBaseUrl:"https://api.example.test"};
const image="registry.example.test/app@sha256:"+"a".repeat(64);
const document=JSON.stringify({services:{web:{image,networks:["front"],volumes:[{type:"volume",source:"data",target:"/data"}]},worker:{image,networks:["default"]}},networks:{front:{}},volumes:{data:{}}});
const preview:ComposePreviewV1={schemaVersion:1,projectId:"project-1",status:"preview",executionAllowed:false,policyVersion:"policy-1",configDigest:"b".repeat(64),canonicalDocument:"{}",
  services:[{name:"web",image,networks:["front"],volumes:[{source:"data",target:"/data",readOnly:false}],secretRefs:[]},{name:"worker",image,networks:["default"],volumes:[],secretRefs:[]}],
  networks:[{key:"front",projectId:"project-1",runtimeName:"dl-scoped-net-front",attachedServices:["web"],driver:"bridge",internal:false},{key:"default",projectId:"project-1",runtimeName:"dl-scoped-net-default",attachedServices:["worker"],driver:"bridge",internal:false}],
  volumes:[{key:"data",projectId:"project-1",runtimeName:"dl-scoped-vol-data",attachedServices:["web"],driver:"local"}]};
const input:ComposeResourceInspectionInput={document,projectId:"project-1",kind:"network",key:"front",expectedConfigDigest:preview.configDigest};
const observation:ComposeResourceInspectionViewV1={schemaVersion:1,status:"observed",executionAllowed:false,projectId:"project-1",kind:"network",key:"front",configDigest:preview.configDigest,stateDigest:"c".repeat(64),observedAt:1000,containers:[{service:"web",running:false,attached:false},{service:"worker",running:false,attached:false}]};
const intent={...input,service:"web",action:"attach" as const,expectedStateDigest:observation.stateDigest};
const proposed:ComposeAttachmentPreviewV1={schemaVersion:1,status:"preview",executionAllowed:false,projectId:"project-1",kind:"network",key:"front",service:"web",action:"attach",configDigest:preview.configDigest,stateDigest:observation.stateDigest,containerId:"d".repeat(64),alreadySatisfied:false};
const wrap=(name:string,value:unknown)=>new Response(JSON.stringify({data:{[name]:value},error:null,requestId:"request-1"}));
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
describe("closed scoped Compose observation clients",()=>{
  it("inspects only its project and explicit resource using browser credentials and cancellation",async()=>{
    const fetchImpl=vi.fn<typeof fetch>().mockResolvedValue(wrap("inspection",observation)),signal=new AbortController().signal;
    expect(await inspect({...input,...props,fetchImpl,signal})).toEqual({kind:"ready",inspection:observation});
    const [url,init]=fetchImpl.mock.calls[0]!;expect(String(url)).toBe("https://api.example.test/api/v1/projects/project-1/compose/resources/inspect");
    expect(init).toMatchObject({method:"POST",credentials:"include",redirect:"error",cache:"no-store",signal,body:JSON.stringify({document,kind:"network",key:"front",expectedConfigDigest:preview.configDigest})});
    expect(new Headers(init?.headers).has("cookie")).toBe(false);expect(new Headers(init?.headers).has("authorization")).toBe(false);
  });
  it("binds attachment preview to the previously observed digest and never sends execution authority",async()=>{
    const fetchImpl=vi.fn<typeof fetch>().mockResolvedValue(wrap("preview",proposed));
    expect(await attachment({...intent,...props,fetchImpl})).toEqual({kind:"ready",preview:proposed});
    const [url,init]=fetchImpl.mock.calls[0]!;expect(String(url)).toContain("/project-1/compose/attachments/preview");
    expect(JSON.parse(String(init?.body))).toEqual({document,kind:"network",key:"front",expectedConfigDigest:preview.configDigest,service:"web",action:"attach",expectedStateDigest:observation.stateDigest});
  });
  it.each([{document:""},{document:"é".repeat(32769)},{projectId:"../foreign"},{key:"constructor"}])("rejects invalid inputs before transport %#",async extra=>{
    const fetchImpl=vi.fn<typeof fetch>();expect(await inspect({...input,...props,...extra,fetchImpl})).toEqual({kind:"error",message:"Choose a valid project resource and preview the current document again."});expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("requires a previous observation for attachment preview",async()=>{
    const fetchImpl=vi.fn<typeof fetch>();expect(await attachment({...intent,...props,expectedStateDigest:undefined,fetchImpl})).toEqual({kind:"error",message:"Inspect this resource before requesting an attachment preview."});expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([null,"javascript:alert(1)","https://user:password@example.test"])('refuses missing or unsafe API configuration %#',async apiBaseUrl=>{
    const fetchImpl=vi.fn<typeof fetch>();expect(await inspect({...input,...props,apiBaseUrl,fetchImpl})).toEqual({kind:"error",message:"Resource inspection is unavailable until the project API is configured."});expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([{projectId:"foreign"},{kind:"volume"},{key:"other"},{configDigest:"e".repeat(64)},{executionAllowed:true},{containers:[{service:"web",running:false,attached:false,password:"must-not-reflect"}]}])("refuses foreign or unsafe inspection responses %#",async extra=>{
    expect(await inspect({...input,...props,fetchImpl:vi.fn<typeof fetch>().mockResolvedValue(wrap("inspection",{...observation,...extra}))})).toEqual({kind:"error",message:"The API returned an invalid resource observation."});
  });
  it.each([{projectId:"foreign"},{kind:"volume"},{key:"other"},{service:"worker"},{action:"detach"},{configDigest:"e".repeat(64)},{stateDigest:"f".repeat(64)},{executionAllowed:true}])("refuses a mismatched attachment proposal %#",async extra=>{
    expect(await attachment({...intent,...props,fetchImpl:vi.fn<typeof fetch>().mockResolvedValue(wrap("preview",{...proposed,...extra}))})).toEqual({kind:"error",message:"The API returned an invalid attachment preview."});
  });
  it.each([[401,"Sign in again to inspect project resources."],[403,"Resource inspection requires project deploy permission."],[404,"This project is unavailable."],[409,"The resource changed or is in use. Inspect it again."],[503,"Resource inspection is not available for this project."]])("reports status %s without leaking server diagnostics",async(status,message)=>{
    const fetchImpl=vi.fn<typeof fetch>().mockResolvedValue(new Response("must-not-reflect",{status:Number(status)}));expect(await inspect({...input,...props,fetchImpl})).toEqual({kind:"error",message});
  });
  it("rejects malformed JSON and transport failures using fixed safe messages",async()=>{
    expect(await inspect({...input,...props,fetchImpl:vi.fn<typeof fetch>().mockResolvedValue(new Response("must-not-reflect"))})).toEqual({kind:"error",message:"The API returned an invalid resource observation."});
    expect(await attachment({...intent,...props,fetchImpl:vi.fn<typeof fetch>().mockRejectedValue(new Error("must-not-reflect"))})).toEqual({kind:"error",message:"The project API is unreachable. Try inspection again."});
  });
});

async function open(fetchImpl=vi.fn<typeof fetch>().mockResolvedValue(wrap("preview",preview))){
  vi.stubGlobal("fetch",fetchImpl);const mounted=render(<ComposePreviewCard {...props}/>);
  fireEvent.change(screen.getByLabelText("Compose document (YAML or JSON)"),{target:{value:document}});fireEvent.click(screen.getByRole("button",{name:"Preview Compose"}));
  await screen.findByRole("heading",{name:"Proposed resources"});expect(screen.queryByRole("button",{name:"Inspect resource"})).not.toBeNull();return{...mounted,fetchImpl};
}
async function observed(fetchImpl=vi.fn<typeof fetch>().mockResolvedValueOnce(wrap("preview",preview)).mockResolvedValue(wrap("inspection",observation))){
  const f=await open(fetchImpl);fireEvent.click(screen.getByRole("button",{name:"Inspect resource"}));await screen.findByRole("heading",{name:"Observed resource use"});return f;
}
describe("deliberate read-only project resource UI",()=>{
  it("requires deliberate inspection and offers no lifecycle action or browser persistence",async()=>{
    const storage=vi.spyOn(Storage.prototype,"setItem"),f=await open();expect(f.fetchImpl).toHaveBeenCalledTimes(1);expect(screen.queryByRole("heading",{name:"Observed resource use"})).toBeNull();
    expect((screen.getByRole("button",{name:"Preview attachment"}) as HTMLButtonElement).disabled).toBe(true);expect(screen.queryByRole("button",{name:/apply|deploy|create|delete/i})).toBeNull();expect(storage).not.toHaveBeenCalled();
  });
  it("shows only observed use and binds a later attachment proposal to that observation",async()=>{
    const f=await observed();f.fetchImpl.mockResolvedValueOnce(wrap("preview",proposed));fireEvent.click(screen.getByRole("button",{name:"Preview attachment"}));
    expect(await screen.findByText("Attachment preview ready. No runtime change was made.")).toBeTruthy();expect(JSON.parse(String(f.fetchImpl.mock.calls[2]![1]?.body))).toMatchObject({expectedStateDigest:observation.stateDigest,expectedConfigDigest:preview.configDigest,action:"attach",service:"web"});
    expect(screen.queryByText(proposed.containerId)).toBeNull();expect(screen.getByText("web: stopped, detached")).toBeTruthy();
  });
  it("derives detachment from current intent for a service outside the selected network",async()=>{
    const f=await observed();fireEvent.change(screen.getByLabelText("Service for attachment preview"),{target:{value:"worker"}});f.fetchImpl.mockResolvedValueOnce(wrap("preview",{...proposed,service:"worker",action:"detach"}));fireEvent.click(screen.getByRole("button",{name:"Preview detachment"}));
    await screen.findByText("Detachment preview ready. No runtime change was made.");expect(JSON.parse(String(f.fetchImpl.mock.calls[2]![1]?.body))).toMatchObject({service:"worker",action:"detach"});
  });
  it("changes to a named volume without reusing the preceding network observation",async()=>{
    const f=await observed();fireEvent.change(screen.getByLabelText("Resource to inspect"),{target:{value:"volume:data"}});expect(screen.queryByRole("heading",{name:"Observed resource use"})).toBeNull();expect((screen.getByRole("button",{name:"Preview attachment"}) as HTMLButtonElement).disabled).toBe(true);
    f.fetchImpl.mockResolvedValueOnce(wrap("inspection",{...observation,kind:"volume",key:"data"}));fireEvent.click(screen.getByRole("button",{name:"Inspect resource"}));await screen.findByRole("heading",{name:"Observed resource use"});expect(JSON.parse(String(f.fetchImpl.mock.calls[2]![1]?.body))).toMatchObject({kind:"volume",key:"data"});
  });
  it("blocks duplicate inspection and discards its late response when selection changes",async()=>{
    const f=await open();let resolve!:(r:Response)=>void;f.fetchImpl.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));fireEvent.click(screen.getByRole("button",{name:"Inspect resource"}));
    const pending=screen.getByRole("button",{name:"Inspecting..."});expect((pending as HTMLButtonElement).disabled).toBe(true);fireEvent.click(pending);expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    const signal=f.fetchImpl.mock.calls[1]![1]?.signal;fireEvent.change(screen.getByLabelText("Resource to inspect"),{target:{value:"volume:data"}});expect(signal?.aborted).toBe(true);
    await act(async()=>{resolve(wrap("inspection",observation));});expect(screen.queryByRole("heading",{name:"Observed resource use"})).toBeNull();
  });
  it("discards an attachment response for a changed service and aborts the old request",async()=>{
    const f=await observed();let resolve!:(r:Response)=>void;f.fetchImpl.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));fireEvent.click(screen.getByRole("button",{name:"Preview attachment"}));const signal=f.fetchImpl.mock.calls[2]![1]?.signal;
    fireEvent.change(screen.getByLabelText("Service for attachment preview"),{target:{value:"worker"}});expect(signal?.aborted).toBe(true);await act(async()=>{resolve(wrap("preview",proposed));});expect(screen.queryByText("Attachment preview ready. No runtime change was made.")).toBeNull();
  });
  it.each(["edit","clear","project","unmount"])("cancels pending inspection on %s and never resurrects the old result",async mode=>{
    const f=await open();let resolve!:(r:Response)=>void;f.fetchImpl.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));fireEvent.click(screen.getByRole("button",{name:"Inspect resource"}));const signal=f.fetchImpl.mock.calls[1]![1]?.signal;
    if(mode==="edit")fireEvent.change(screen.getByLabelText("Compose document (YAML or JSON)"),{target:{value:document+" "}});
    if(mode==="clear")fireEvent.click(screen.getByRole("button",{name:"Clear draft"}));
    if(mode==="project")f.rerender(<ComposePreviewCard {...props} projectId="project-2"/>);
    if(mode==="unmount")f.unmount();expect(signal?.aborted).toBe(true);
    await act(async()=>{resolve(wrap("inspection",observation));});expect(screen.queryByRole("heading",{name:"Observed resource use"})).toBeNull();
  });
  it("requires fresh inspection after a stale attachment response without reflecting diagnostics",async()=>{
    const f=await observed();f.fetchImpl.mockResolvedValueOnce(new Response("must-not-reflect",{status:409}));fireEvent.click(screen.getByRole("button",{name:"Preview attachment"}));
    expect((await screen.findByRole("alert")).textContent).toContain("Inspect it again");expect(screen.getByRole("alert").textContent).not.toContain("must-not-reflect");expect(screen.queryByRole("heading",{name:"Observed resource use"})).toBeNull();expect((screen.getByRole("button",{name:"Preview attachment"}) as HTMLButtonElement).disabled).toBe(true);
  });
  it("reports unavailable capability and permits a new deliberate inspection",async()=>{
    const f=await open();f.fetchImpl.mockResolvedValueOnce(new Response("must-not-reflect",{status:503}));fireEvent.click(screen.getByRole("button",{name:"Inspect resource"}));expect((await screen.findByRole("alert")).textContent).toContain("not available");
    expect((screen.getByRole("button",{name:"Inspect resource"}) as HTMLButtonElement).disabled).toBe(false);expect(screen.queryByRole("heading",{name:"Observed resource use"})).toBeNull();
  });
  it("explains already-satisfied previews without exposing identifiers or enabling apply",async()=>{
    const f=await observed();f.fetchImpl.mockResolvedValueOnce(wrap("preview",{...proposed,alreadySatisfied:true}));fireEvent.click(screen.getByRole("button",{name:"Preview attachment"}));expect(await screen.findByText("The requested attachment is already satisfied. No runtime change was made.")).toBeTruthy();expect(screen.queryByText(proposed.containerId)).toBeNull();expect(screen.queryByRole("button",{name:/apply|connect|disconnect/i})).toBeNull();
  });
  it("shows running use while withholding attachment preview",async()=>{
    await observed(vi.fn<typeof fetch>().mockResolvedValueOnce(wrap("preview",preview)).mockResolvedValue(wrap("inspection",{...observation,containers:[{service:"web",running:true,attached:false}]})));
    expect(screen.getByText("web: running, detached")).toBeTruthy();expect((screen.getByRole("button",{name:"Preview attachment"}) as HTMLButtonElement).disabled).toBe(true);expect(screen.getByText("Stop the selected service and running consumers before an attachment preview.")).toBeTruthy();
  });
  it("clears previous observations before reinspection and prevents duplicate attachment requests",async()=>{
    const f=await observed();let resolve!:(r:Response)=>void;f.fetchImpl.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));fireEvent.click(screen.getByRole("button",{name:"Preview attachment"}));const pending=screen.getByRole("button",{name:"Checking attachment..."});expect((pending as HTMLButtonElement).disabled).toBe(true);fireEvent.click(pending);expect(f.fetchImpl).toHaveBeenCalledTimes(3);
    await act(async()=>{resolve(wrap("preview",proposed));});await screen.findByText("Attachment preview ready. No runtime change was made.");
    f.fetchImpl.mockResolvedValueOnce(new Response("private",{status:503}));fireEvent.click(screen.getByRole("button",{name:"Inspect resource"}));await screen.findByRole("alert");expect(screen.queryByRole("heading",{name:"Observed resource use"})).toBeNull();expect(screen.queryByText("Attachment preview ready. No runtime change was made.")).toBeNull();
  });
});
