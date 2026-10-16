// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import {managedDatabaseBackupReceiptSchema,managedDatabaseHealthPreparationSchema,type ManagedDatabaseEngineV1} from "@deploylite/contracts";
import {readManagedDatabaseBackups,backupManagedDatabase} from "@/lib/managed-database-backup";
import {ManagedDatabaseBackupPanel} from "./managed-database-backup-panel";
vi.mock("@/lib/managed-database-backup",()=>({readManagedDatabaseBackups:vi.fn(),backupManagedDatabase:vi.fn()}));
const read=vi.mocked(readManagedDatabaseBackups),backup=vi.mocked(backupManagedDatabase);
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.resetAllMocks();sessionStorage.clear();});
function fixture(engine: ManagedDatabaseEngineV1 = "postgres") {
  const now = Date.now(), base = {schemaVersion: 1, projectId: "project-a", databaseId: "orders", engine, profileId: "profile-a",
    planDigest: "a".repeat(64), environmentFingerprint: "b".repeat(32)};
  const {profileId: _profile, ...runtime} = base;
  const original = {...runtime, action: "database.runtime", agentId: "agent-a", commandId: "original-a", inputDigest: "c".repeat(64),
    correlationId: "original-correlation", containerId: "d".repeat(64), imageId: "sha256:" + "e".repeat(64),
    volumeName: "dl-" + "1".repeat(32) + "-vol-db-orders", networkName: "dl-" + "1".repeat(32) + "-net-db-orders",
    networkId: "f".repeat(64), volumeCreatedAt: new Date(now - 3000).toISOString(), observedAt: now - 2000,
    status: "ready", health: "passed", storage: "verified", idempotent: false, redacted: true};
  const source = managedDatabaseHealthPreparationSchema.parse({...base, originalReceipt: original, originalReplayFingerprint: "2".repeat(64)});
  const formats = {postgres: "postgres-custom-gzip", mysql: "mysql-sql-gzip", mariadb: "mariadb-sql-gzip", mongodb: "mongodb-archive-gzip", redis: "volume-tar"};
  const consistency = {postgres: "native-snapshot", mysql: "global-read-lock", mariadb: "global-read-lock", mongodb: "quiesced-writes", redis: "all-consumers-stopped"};
  const receipt = managedDatabaseBackupReceiptSchema.parse({...base, action: "database.runtime.backup", agentId: "agent-a", commandId: "backup-a",
    originalCommandId: original.commandId, inputDigest: "3".repeat(64), correlationId: "backup-correlation", containerId: original.containerId,
    imageId: original.imageId, volumeName: original.volumeName, networkName: original.networkName, networkId: original.networkId,
    volumeCreatedAt: original.volumeCreatedAt, volumeKey: "db-orders", destinationId: "destination-a", sourceDigest: "4".repeat(64),
    archiveId: "backup_" + "5".repeat(32), archiveBytes: 2048, archiveSha256: "6".repeat(64), manifestSha256: "7".repeat(64),
    format: formats[engine], consistency: consistency[engine], observedAt: now - 1000, status: "created", idempotent: false, storage: "verified", redacted: true});
  const inventory = {schemaVersion: 1 as const, receipt, createdAtMs: now - 999};
  const preparation = {...source, destinationId: "destination-a", maxBytes: 4096};
  const command = {id: receipt.commandId, action: "project.update" as const, status: "completed" as const, scope: {kind: "project" as const, projectId: base.projectId},
    inputDigest: receipt.inputDigest, correlationId: receipt.correlationId, idempotencyKey: "backup-key", expiresAt: new Date(now + 60000).toISOString()};
  const response = (data: unknown) => new Response(JSON.stringify({data, error: null, requestId: "backup-request"}));
  const outcome = {command, receipt, inventory, originalBackupReplayFingerprint: "8".repeat(64), backupCreated: true as const, idempotent: false};
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response(outcome));
  return {source, preparation, receipt, inventory, command, outcome, response, fetchImpl,
    options: {apiBaseUrl: "https://api.example.test", actorId: "operator-a", fetchImpl}};
}
function setup(engine: ManagedDatabaseEngineV1 = "postgres") {
  const f=fixture(engine);
  read.mockResolvedValue({kind:"ready",destinations:[{destinationId:"destination-a",maxBytes:4096}],backups:[]});
  backup.mockResolvedValue({kind:"ready",...f.outcome});
  return {...f,props:{preparation:f.source,apiBaseUrl:"https://api.example.test",actorId:"operator-a",currentState:engine==="redis"?"stopped" as const:"running" as const}};
}
it.each(["postgres","mysql","mariadb","mongodb","redis"] as const)("creates a %s backup only after explicit click and shows its confirmed archive",async engine=>{
  const f=setup(engine);render(<ManagedDatabaseBackupPanel {...f.props}/>);
  await screen.findByRole("button",{name:"Create backup"});expect(backup).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"Create backup"}));await screen.findByText(f.receipt.archiveId);
  expect(backup).toHaveBeenCalledOnce();expect(backup.mock.calls[0]![0]).toEqual(f.preparation);
  expect(backup.mock.calls[0]![1]).toMatchObject({actorId:"operator-a",apiBaseUrl:f.props.apiBaseUrl});
  expect(backup.mock.calls[0]![2]).toMatch(/^[A-Za-z0-9_-]+$/);
});
it("recovers an unknown result after reload using exactly its original source and key on explicit retry",async()=>{
  const f=setup();backup.mockResolvedValueOnce({kind:"error",message:"private transport sentinel"});
  const view=render(<ManagedDatabaseBackupPanel {...f.props}/>);await screen.findByRole("button",{name:"Create backup"});
  fireEvent.click(screen.getByRole("button",{name:"Create backup"}));await screen.findByRole("button",{name:"Retry backup confirmation"});
  const first=backup.mock.calls[0]!;expect(backup).toHaveBeenCalledOnce();expect(screen.queryByText("private transport sentinel")).toBeNull();
  view.unmount();render(<ManagedDatabaseBackupPanel {...f.props} currentState={null}/>);
  await screen.findByRole("button",{name:"Retry backup confirmation"});expect(backup).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button",{name:"Retry backup confirmation"}));await screen.findByText(f.receipt.archiveId);
  expect(backup.mock.calls[1]![0]).toEqual(first[0]);expect(backup.mock.calls[1]![2]).toBe(first[2]);
});
it("persists the exact public original request before dispatch and reads only the scoped metadata",async()=>{
  const f=setup();backup.mockImplementation(async(input,_options,key)=>{
    const saved=JSON.parse(sessionStorage.getItem(sessionStorage.key(0)!)!);
    expect(saved).toEqual({key,preparation:input,confirmedArchiveId:null});
    expect(JSON.stringify(saved)).not.toMatch(/password|sealedEnvironment|privatePath|archiveBytes/i);
    return {kind:"ready",...f.outcome};
  });
  render(<ManagedDatabaseBackupPanel {...f.props}/>);await screen.findByRole("button",{name:"Create backup"});
  expect(read.mock.calls[0]![0]).toEqual({projectId:"project-a",databaseId:"orders"});
  fireEvent.click(screen.getByRole("button",{name:"Create backup"}));await screen.findByText("Backup completed.");
});
it("withholds dispatch when browser storage cannot preserve the original request",async()=>{
  const f=setup();render(<ManagedDatabaseBackupPanel {...f.props}/>);await screen.findByRole("button",{name:"Create backup"});
  vi.spyOn(Storage.prototype,"setItem").mockImplementation(()=>{throw new Error("private quota sentinel");});
  fireEvent.click(screen.getByRole("button",{name:"Create backup"}));await screen.findByText("The original backup request could not be saved. No new request was sent.");
  expect(backup).not.toHaveBeenCalled();expect(screen.queryByText("private quota sentinel")).toBeNull();
});
it("preserves an uncertain original key when saving confirmed state fails",async()=>{
  const f=setup();const real=Storage.prototype.setItem;let writes=0;
  vi.spyOn(Storage.prototype,"setItem").mockImplementation(function(this:Storage,key,value){if(++writes===2)throw new Error("quota");real.call(this,key,value);});
  render(<ManagedDatabaseBackupPanel {...f.props}/>);await screen.findByRole("button",{name:"Create backup"});
  fireEvent.click(screen.getByRole("button",{name:"Create backup"}));await screen.findByRole("button",{name:"Retry backup confirmation"});
  const original=backup.mock.calls[0]![2];fireEvent.click(screen.getByRole("button",{name:"Retry backup confirmation"}));await screen.findByText("Backup completed.");
  expect(backup.mock.calls[1]![2]).toBe(original);
});
it("requires stopped Redis and running other engines for new backups",async()=>{
  for(const engine of ["postgres","mysql","mariadb","mongodb","redis"] as const){
    const f=setup(engine);const view=render(<ManagedDatabaseBackupPanel {...f.props} currentState={engine==="redis"?"running":"stopped"}/>);
    const button=await screen.findByRole("button",{name:"Create backup"});expect((button as HTMLButtonElement).disabled).toBe(true);fireEvent.click(button);expect(backup).not.toHaveBeenCalled();view.unmount();
  }
});
it("aborts an old actor's request and publishes no result into the new actor's view",async()=>{
  const f=setup();let finish!:(value:Awaited<ReturnType<typeof backup>>)=>void;
  backup.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const view=render(<ManagedDatabaseBackupPanel {...f.props}/>);await screen.findByRole("button",{name:"Create backup"});
  const button=screen.getByRole("button",{name:"Create backup"});fireEvent.click(button);fireEvent.click(button);expect(backup).toHaveBeenCalledOnce();
  const signal=backup.mock.calls[0]![1].signal!;view.rerender(<ManagedDatabaseBackupPanel {...f.props} actorId="operator-b"/>);
  expect(signal.aborted).toBe(true);await screen.findByRole("button",{name:"Create backup"});finish({kind:"ready",...f.outcome});
  await waitFor(()=>expect(screen.queryByText(f.receipt.archiveId)).toBeNull());expect(backup).toHaveBeenCalledOnce();
});
it("withholds corrupt stored attempts instead of creating replacement keys",async()=>{
  const f=setup(),scope=JSON.stringify([f.props.apiBaseUrl,f.props.actorId,f.source]);sessionStorage.setItem("deploylite.native-backup:"+scope,'{"key":"foreign"}');
  render(<ManagedDatabaseBackupPanel {...f.props}/>);const button=await screen.findByRole("button",{name:"Create backup"});expect((button as HTMLButtonElement).disabled).toBe(true);fireEvent.click(button);expect(backup).not.toHaveBeenCalled();
});
