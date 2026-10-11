// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import {prepareManagedDatabaseDeletion,applyManagedDatabaseDeletion} from "@/lib/managed-database-deletion";
import {ManagedDatabaseDeleteControl} from "./managed-database-delete-control";
vi.mock("@/lib/managed-database-deletion",()=>({prepareManagedDatabaseDeletion:vi.fn(),applyManagedDatabaseDeletion:vi.fn()}));
const prepare=vi.mocked(prepareManagedDatabaseDeletion),apply=vi.mocked(applyManagedDatabaseDeletion);
afterEach(()=>{cleanup();vi.resetAllMocks();});
function fixture(databaseId="orders") {
  const source={schemaVersion:1 as const,projectId:"project-a",databaseId,engine:"postgres" as const,profileId:"profile-a",planDigest:"a".repeat(64),environmentFingerprint:"b".repeat(32),originalReplayFingerprint:"2".repeat(64),originalReceipt:{schemaVersion:1 as const,projectId:"project-a",databaseId,engine:"postgres" as const,planDigest:"a".repeat(64),environmentFingerprint:"b".repeat(32),action:"database.runtime" as const,agentId:"agent-a",commandId:"create-"+databaseId,inputDigest:"c".repeat(64),correlationId:"create",containerId:"d".repeat(64),imageId:"sha256:"+"e".repeat(64),volumeName:"dl-"+"1".repeat(32)+"-vol-db-"+databaseId,networkName:"dl-"+"1".repeat(32)+"-net-db-"+databaseId,networkId:"f".repeat(64),volumeCreatedAt:"2026-01-01T00:00:00Z",observedAt:1000,status:"ready" as const,health:"passed" as const,storage:"verified" as const,idempotent:false,redacted:true as const}};
  const prepared={preparation:source,idempotencyKey:"",command:{id:"delete-a",status:"pending_confirmation" as const,action:"project.update" as const,scope:{kind:"project" as const,projectId:source.projectId},inputDigest:"3".repeat(64),idempotencyKey:"",correlationId:"delete",expiresAt:new Date(Date.now()+60000).toISOString()},confirmation:{id:"nonce-a",classification:"destructive" as const,expiresAt:new Date(Date.now()+60000).toISOString(),consumedAt:null}};
  prepare.mockImplementation(async(_raw,_options,key)=>({kind:"ready",prepared:{...prepared,idempotencyKey:key,command:{...prepared.command,idempotencyKey:key}}}));
  const {health:_health,idempotent:_idempotent,...physical}=source.originalReceipt;
  const receipt={...physical,action:"database.runtime.delete" as const,profileId:source.profileId,commandId:"delete-a",inputDigest:"3".repeat(64),correlationId:"delete",originalCommandId:source.originalReceipt.commandId,originalStopCommandId:null,confirmationId:"nonce-a",observedAt:2000,status:"removed" as const,storage:"retained" as const};
  apply.mockResolvedValue({kind:"ready",receipt});const onDeleted=vi.fn(),onBusyChange=vi.fn();
  return {source,prepared,props:{preparation:source,apiBaseUrl:"https://api.example.test",onDeleted,onBusyChange},onDeleted,onBusyChange};
}
async function open(){fireEvent.click(screen.getByRole("button",{name:"Delete database"}));await screen.findByRole("dialog",{name:"Delete database"});}
it("prepares only on explicit click and requires a separate confirmation with retained-storage text",async()=>{
  const f=fixture();render(<ManagedDatabaseDeleteControl {...f.props}/>);expect(prepare).not.toHaveBeenCalled();expect(apply).not.toHaveBeenCalled();await open();
  expect(screen.getByText("Persistent storage and credentials will be retained.")).toBeTruthy();expect(apply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"Confirm deletion"}));await waitFor(()=>expect(f.onDeleted).toHaveBeenCalledOnce());
  expect(prepare).toHaveBeenCalledOnce();expect(apply).toHaveBeenCalledOnce();expect(apply.mock.calls[0]![0]).toMatchObject({confirmation:{id:"nonce-a"},idempotencyKey:prepare.mock.calls[0]![2]});
});
it("cancel leaves the original unused approval and reopens it without another key or preparation",async()=>{
  const f=fixture();render(<ManagedDatabaseDeleteControl {...f.props}/>);await open();fireEvent.click(screen.getByRole("button",{name:"Cancel"}));expect(apply).not.toHaveBeenCalled();await open();expect(prepare).toHaveBeenCalledOnce();
});
it("keeps an uncertain apply on its exact original nonce/key for explicit retry only",async()=>{
  const f=fixture();apply.mockResolvedValueOnce({kind:"error",message:"private"});render(<ManagedDatabaseDeleteControl {...f.props}/>);await open();
  fireEvent.click(screen.getByRole("button",{name:"Confirm deletion"}));await screen.findByRole("button",{name:"Retry deletion confirmation"});expect(apply).toHaveBeenCalledOnce();expect(screen.queryByText("private")).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Retry deletion confirmation"}));await waitFor(()=>expect(f.onDeleted).toHaveBeenCalledOnce());expect(apply.mock.calls[1]![0]).toEqual(apply.mock.calls[0]![0]);expect(prepare).toHaveBeenCalledOnce();
});
it("reuses the same key after preparation loses a reply",async()=>{
  const f=fixture();prepare.mockResolvedValueOnce({kind:"error",message:"private"});render(<ManagedDatabaseDeleteControl {...f.props}/>);fireEvent.click(screen.getByRole("button",{name:"Delete database"}));await screen.findByRole("button",{name:"Retry deletion preparation"});
  fireEvent.click(screen.getByRole("button",{name:"Retry deletion preparation"}));await screen.findByRole("dialog");expect(prepare.mock.calls[1]![2]).toBe(prepare.mock.calls[0]![2]);expect(apply).not.toHaveBeenCalled();
});
it("aborts a stale preparation on source switch and never exposes its confirmation",async()=>{
  const first=fixture(),second=fixture("billing");let finish!: (value:Awaited<ReturnType<typeof prepare>>) => void;
  prepare.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));const view=render(<ManagedDatabaseDeleteControl {...first.props}/>);fireEvent.click(screen.getByRole("button",{name:"Delete database"}));await waitFor(()=>expect(prepare).toHaveBeenCalledOnce());
  const signal=prepare.mock.calls[0]![1].signal!;view.rerender(<ManagedDatabaseDeleteControl {...second.props}/>);expect(signal.aborted).toBe(true);
  finish({kind:"ready",prepared:first.prepared});await waitFor(()=>expect(screen.queryByRole("dialog")).toBeNull());expect(apply).not.toHaveBeenCalled();
});
it("withholds a stale apply result after scope change and permits no duplicate click",async()=>{
  const first=fixture(),second=fixture("billing");let finish!: (value:Awaited<ReturnType<typeof apply>>) => void;apply.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const view=render(<ManagedDatabaseDeleteControl {...first.props}/>);await open();const button=screen.getByRole("button",{name:"Confirm deletion"});fireEvent.click(button);fireEvent.click(button);expect(apply).toHaveBeenCalledOnce();
  const signal=apply.mock.calls[0]![1].signal!;view.rerender(<ManagedDatabaseDeleteControl {...second.props}/>);expect(signal.aborted).toBe(true);finish({kind:"error",message:"private"});await waitFor(()=>expect(first.onDeleted).not.toHaveBeenCalled());
});

it("withholds first destructive apply when the original approval has expired",async()=>{
  const f=fixture(),expired={...f.prepared,command:{...f.prepared.command,expiresAt:"2026-01-01T00:00:00Z"},confirmation:{...f.prepared.confirmation,expiresAt:"2026-01-01T00:00:00Z"}};
  prepare.mockResolvedValue({kind:"ready",prepared:expired});render(<ManagedDatabaseDeleteControl {...f.props}/>);await open();expect((screen.getByRole("button",{name:"Confirm deletion"}) as HTMLButtonElement).disabled).toBe(true);expect(apply).not.toHaveBeenCalled();
});
it("dismisses an unused confirmation with Escape without consuming or replacing it",async()=>{
  const f=fixture();render(<ManagedDatabaseDeleteControl {...f.props}/>);await open();fireEvent.keyDown(document,{key:"Escape"});await waitFor(()=>expect(screen.queryByRole("dialog")).toBeNull());expect(apply).not.toHaveBeenCalled();await open();expect(prepare).toHaveBeenCalledOnce();
});
