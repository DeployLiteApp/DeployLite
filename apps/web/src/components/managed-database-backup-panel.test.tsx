// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import {managedDatabaseBackupReceiptSchema,managedDatabaseHealthPreparationSchema,type ManagedDatabaseEngineV1} from "@deploylite/contracts";
import {readManagedDatabaseBackups,backupManagedDatabase} from "@/lib/managed-database-backup";
import {ManagedDatabaseBackupPanel} from "./managed-database-backup-panel";
vi.mock("@/lib/managed-database-backup",()=>({readManagedDatabaseBackups:vi.fn(),backupManagedDatabase:vi.fn()}));
const restoreObserved=vi.hoisted(()=>vi.fn());
vi.mock("./managed-database-restore-control",async importOriginal=>({...await importOriginal<object>(),ManagedDatabaseRestoreControl:(props:unknown)=>{restoreObserved(props);return <p>Confirmed restore control</p>;}}));
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

it("offers restore only through the original source and selected immutable inventory hashes",async()=>{
 const f=setup();read.mockResolvedValue({kind:"ready",destinations:[{destinationId:"destination-a",maxBytes:4096}],backups:[f.inventory]});
 render(<ManagedDatabaseBackupPanel {...f.props}/>);await screen.findByText(f.receipt.archiveId);
 expect(restoreObserved).toHaveBeenLastCalledWith(expect.objectContaining({actorId:"operator-a",apiBaseUrl:f.props.apiBaseUrl,currentState:"running",selection:{...f.source,archiveId:f.receipt.archiveId,destinationId:f.receipt.destinationId,expectedArchiveSha256:f.receipt.archiveSha256,expectedManifestSha256:f.receipt.manifestSha256,maxBytes:4096}}));
 expect(backup).not.toHaveBeenCalled();
});

it("keeps the original uncertain restore reachable when fresh backup metadata is unavailable after reopen",async()=>{
 const f=setup(),selection={...f.source,archiveId:f.receipt.archiveId,destinationId:f.receipt.destinationId,expectedArchiveSha256:f.receipt.archiveSha256,expectedManifestSha256:f.receipt.manifestSha256,maxBytes:4096};
 const prepared={selection,idempotencyKey:"restore-original-key",command:{...f.command,id:"restore-a",status:"pending_confirmation",idempotencyKey:"restore-original-key"},confirmation:{id:"original-nonce",classification:"destructive",expiresAt:f.command.expiresAt,consumedAt:null}};
 const slot="deploylite.native-restore:"+JSON.stringify([f.props.apiBaseUrl,f.props.actorId,selection]);sessionStorage.setItem(slot,JSON.stringify({key:"restore-original-key",selection,prepared,uncertainApply:true,confirmedReceipt:null}));
 read.mockResolvedValue({kind:"error",message:"unavailable"});render(<ManagedDatabaseBackupPanel {...f.props} currentState={null}/>);
 await screen.findByText("Backups are unavailable.");expect(restoreObserved).toHaveBeenLastCalledWith(expect.objectContaining({selection,actorId:"operator-a",currentState:null}));expect(backup).not.toHaveBeenCalled();
});
it("blocks a fresh selector with a changed budget when an owned original restore journal is malformed",async()=>{
 const f=setup(),selection={...f.source,archiveId:f.receipt.archiveId,destinationId:f.receipt.destinationId,expectedArchiveSha256:f.receipt.archiveSha256,expectedManifestSha256:f.receipt.manifestSha256,maxBytes:4096};
 sessionStorage.setItem("deploylite.native-restore:"+JSON.stringify([f.props.apiBaseUrl,f.props.actorId,selection]),'{"key":"original-key"}');
 read.mockResolvedValue({kind:"ready",destinations:[{destinationId:"destination-a",maxBytes:8192}],backups:[f.inventory]});render(<ManagedDatabaseBackupPanel {...f.props}/>);
 await screen.findByText(f.receipt.archiveId);expect(restoreObserved).toHaveBeenLastCalledWith(expect.objectContaining({disabled:true}));expect(backup).not.toHaveBeenCalled();
});

it("retains visible restore completion while refreshed inventory replaces the completed recovery control",async()=>{
 const f=setup();read.mockResolvedValue({kind:"ready",destinations:[{destinationId:"destination-a",maxBytes:4096}],backups:[f.inventory]});
 const view=render(<ManagedDatabaseBackupPanel {...f.props}/>);await screen.findByText(f.receipt.archiveId);
 const props=restoreObserved.mock.lastCall![0] as {onRestored?():void};act(()=>props.onRestored?.());await screen.findByText("Restore completed.");
 view.rerender(<ManagedDatabaseBackupPanel {...f.props} actorId="operator-b"/>);await waitFor(()=>expect(screen.queryByText("Restore completed.")).toBeNull());expect(backup).not.toHaveBeenCalled();
});

// Prospective integration specifications use existing render/HTTP surfaces only.
function retentionPlan(f: ReturnType<typeof setup>, keepNewest = 1) {
  return {schemaVersion: 1, operation: "backup.retention.preview", executionAllowed: false,
    projectId: f.source.projectId, volumeKey: "db-" + f.source.databaseId, destinationId: "destination-a", keepNewest,
    retainedArchiveIds: ["new-p3", "old-protected-native"], protectedArchiveIds: ["old-protected-native"],
    deletionCandidates: [{archiveId: "candidate-p3", archiveSha256: "a".repeat(64), manifestSha256: "b".repeat(64), createdAtMs: 1}],
    inventoryDigest: "c".repeat(64), planDigest: "d".repeat(64)};
}
async function retentionControls(f: ReturnType<typeof setup>) {
  let mounted!: ReturnType<typeof render>;
  await act(async () => {mounted = render(<ManagedDatabaseBackupPanel {...f.props} />);});
  await screen.findByRole("button", {name: "Create backup"});
  const input = screen.getByRole("textbox", {name: "Keep newest backups"}) as HTMLInputElement;
  return {mounted, input};
}
function enterRetentionCount(value: string) {
  const input = screen.getByRole("textbox", {name: "Keep newest backups"}) as HTMLInputElement;
  fireEvent.change(input, {target: {value}});
  expect(input.value).toBe(value);
}
function clickRetentionPreview() {
  const button = screen.getByRole("button", {name: "Preview retention"}) as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
}

it("exposes blank explicitly described retention controls without preview HTTP on render, reload or source selection", async () => {
  const f = setup(), fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(f.response({plan: retentionPlan(f)}));
  const {mounted, input} = await retentionControls(f);
  expect(input.value).toBe("");
  const description = input.getAttribute("aria-describedby"); expect(description).toBeTruthy();
  expect(description!.split(/\s+/).map(id => document.getElementById(id)?.textContent).join(" ")).toContain("integer from 1 to 10,000");
  expect((screen.getByRole("button", {name: "Preview retention"}) as HTMLButtonElement).disabled).toBe(true);
  expect(fetchSpy).not.toHaveBeenCalled(); expect(backup).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", {name: "Reload backups"}));
  await screen.findByRole("button", {name: "Create backup"}); expect(fetchSpy).not.toHaveBeenCalled();
  mounted.rerender(<ManagedDatabaseBackupPanel {...f.props} actorId="operator-b" />);
  await screen.findByRole("button", {name: "Create backup"}); expect(fetchSpy).not.toHaveBeenCalled();
});

it("previews the server full-union summary only after explicit action, with current actor and no backup or command key", async () => {
  const f = setup(); read.mockResolvedValue({kind: "ready", destinations: [{destinationId: "destination-a", maxBytes: 4096}], backups: [f.inventory]});
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(f.response({plan: retentionPlan(f)}));
  await retentionControls(f); expect(fetchSpy).not.toHaveBeenCalled(); enterRetentionCount("1"); expect(fetchSpy).not.toHaveBeenCalled();
  clickRetentionPreview(); await screen.findByText("Retained: 2 · Protected: 1 · Candidates: 1");
  expect(fetchSpy).toHaveBeenCalledOnce(); const [url, request] = fetchSpy.mock.calls[0]!;
  expect(String(url)).toBe("https://api.example.test/api/v1/projects/project-a/backups/retention/preview");
  expect(request).toMatchObject({method: "POST", credentials: "include", redirect: "error", cache: "no-store"});
  expect(JSON.parse(String(request!.body))).toEqual({schemaVersion: 1, volumeKey: "db-orders", destinationId: "destination-a", keepNewest: 1});
  const headers = new Headers(request!.headers); expect(headers.get("x-deploylite-expected-actor-id")).toBe("operator-a");
  expect(headers.has("idempotency-key")).toBe(false);
  expect(screen.getByText("Preview only. No deletion is performed.")).toBeTruthy(); expect(screen.queryByRole("button", {name: /delete/i})).toBeNull();
  expect(screen.getByRole("button", {name: "Create backup"})).toBeTruthy(); expect(screen.getByText("Confirmed restore control")).toBeTruthy();
  expect(sessionStorage.length).toBe(0); expect(backup).not.toHaveBeenCalled();
  enterRetentionCount("2"); expect(screen.queryByText(/Retained:/)).toBeNull(); expect(fetchSpy).toHaveBeenCalledOnce();
});

it.each(["", "0", "10001", "1.5", "-1", "1e3"])("requires an explicit integer count rather than defaulting invalid %s", async value => {
  const f = setup(), fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(f.response({plan: retentionPlan(f)}));
  await retentionControls(f); enterRetentionCount(value);
  expect((screen.getByRole("button", {name: "Preview retention"}) as HTMLButtonElement).disabled).toBe(true); expect(fetchSpy).not.toHaveBeenCalled();
});

it("accepts the explicit upper count bound without inventing a retention duration", async () => {
  const f = setup(), plan = retentionPlan(f, 10000); plan.retainedArchiveIds.push("candidate-p3"); plan.deletionCandidates = [];
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(f.response({plan}));
  await retentionControls(f); enterRetentionCount("10000"); clickRetentionPreview();
  await screen.findByText("Retained: 3 · Protected: 1 · Candidates: 0");
  expect(JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body)).keepNewest).toBe(10000);
});

it.each(["project", "database", "actor", "source", "api"])("aborts and withholds late preview HTTP after %s changes without another POST", async field => {
  const f = setup(); let finish!: (response: Response) => void;
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(resolve => {finish = resolve;}));
  const {mounted} = await retentionControls(f); enterRetentionCount("1"); clickRetentionPreview(); await waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
  const signal = fetchSpy.mock.calls[0]![1]!.signal!;
  const changed = structuredClone(f.props);
  if (field === "project") {changed.preparation.projectId = "project-b"; changed.preparation.originalReceipt.projectId = "project-b";}
  if (field === "database") {
    changed.preparation.databaseId = "orders_b"; changed.preparation.originalReceipt.databaseId = "orders_b";
    changed.preparation.originalReceipt.volumeName = changed.preparation.originalReceipt.volumeName.replace("db-orders", "db-orders_b");
    changed.preparation.originalReceipt.networkName = changed.preparation.originalReceipt.networkName.replace("db-orders", "db-orders_b");
  }
  if (field === "actor") changed.actorId = "operator-b";
  if (field === "source") changed.preparation.originalReplayFingerprint = "9".repeat(64);
  if (field === "api") changed.apiBaseUrl = "https://other.example.test";
  changed.preparation = managedDatabaseHealthPreparationSchema.parse(changed.preparation);
  mounted.rerender(<ManagedDatabaseBackupPanel {...changed} />); await waitFor(() => expect(signal.aborted).toBe(true));
  await act(async () => finish(f.response({plan: retentionPlan(f)})));
  expect(screen.queryByText(/Retained:/)).toBeNull(); expect(fetchSpy).toHaveBeenCalledOnce(); expect(backup).not.toHaveBeenCalled();
});

it("binds the selected configured destination and aborts its old in-flight preview", async () => {
  const f = setup(); read.mockResolvedValue({kind: "ready", destinations: [{destinationId: "destination-a", maxBytes: 4096}, {destinationId: "destination-b", maxBytes: 4096}], backups: []});
  let finish!: (response: Response) => void;
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(resolve => {finish = resolve;}));
  await retentionControls(f); enterRetentionCount("1"); clickRetentionPreview(); await waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
  const signal = fetchSpy.mock.calls[0]![1]!.signal!;
  fireEvent.change(screen.getByRole("combobox", {name: "Backup destination"}), {target: {value: "destination-b"}});
  await waitFor(() => expect(signal.aborted).toBe(true)); await act(async () => finish(f.response({plan: retentionPlan(f)})));
  expect(screen.queryByText(/Retained:/)).toBeNull(); expect(fetchSpy).toHaveBeenCalledOnce();
  const plan = {...retentionPlan(f), destinationId: "destination-b"}; fetchSpy.mockResolvedValue(f.response({plan}));
  await screen.findByRole("button", {name: "Create backup"}); enterRetentionCount("1"); clickRetentionPreview(); await screen.findByText(/Retained: 2/);
  expect(JSON.parse(String(fetchSpy.mock.calls[1]![1]!.body)).destinationId).toBe("destination-b");
});

it.each(["count", "unmount"])("aborts preview and withholds its late HTTP response on %s", async field => {
  const f = setup(); let finish!: (response: Response) => void;
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(resolve => {finish = resolve;}));
  const {mounted} = await retentionControls(f); enterRetentionCount("1"); clickRetentionPreview(); await waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
  const signal = fetchSpy.mock.calls[0]![1]!.signal!;
  if (field === "count") enterRetentionCount("2"); else mounted.unmount();
  expect(signal.aborted).toBe(true); await act(async () => finish(f.response({plan: retentionPlan(f)})));
  expect(screen.queryByText(/Retained:/)).toBeNull(); expect(fetchSpy).toHaveBeenCalledOnce(); expect(sessionStorage.length).toBe(0);
});

it.each([403, 409, 503])("withholds unavailable or forbidden preview HTTP%s without exposing raw errors or retrying", async status => {
  const f = setup(), fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("private-error-sentinel", {status}));
  await retentionControls(f); enterRetentionCount("1"); clickRetentionPreview(); expect(fetchSpy).toHaveBeenCalledOnce();
  await screen.findByText("Retention preview is unavailable.");
  expect(screen.queryByText("private-error-sentinel")).toBeNull(); expect(screen.queryByText(/Retained:/)).toBeNull(); expect(fetchSpy).toHaveBeenCalledOnce();
});

it.each(["project", "volume", "destination", "count", "effect", "protection", "private", "overlap", "future"])("withholds malformed or detached %s server plans", async field => {
  const f = setup(), plan = retentionPlan(f) as Record<string, unknown>;
  if (field === "project") plan.projectId = "foreign";
  if (field === "volume") plan.volumeKey = "db-foreign";
  if (field === "destination") plan.destinationId = "foreign";
  if (field === "count") plan.keepNewest = 2;
  if (field === "effect") plan.executionAllowed = true;
  if (field === "protection") delete plan.protectedArchiveIds;
  if (field === "private") plan.password = "private-error-sentinel";
  if (field === "overlap") plan.retainedArchiveIds = ["candidate-p3", "old-protected-native"];
  if (field === "future") (plan.deletionCandidates as {createdAtMs: number}[])[0]!.createdAtMs = Date.now() + 100000;
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(f.response({plan}));
  await retentionControls(f); enterRetentionCount("1"); clickRetentionPreview(); expect(fetchSpy).toHaveBeenCalledOnce();
  await screen.findByText("Retention preview is unavailable.");
  expect(screen.queryByText(/Retained:/)).toBeNull(); expect(screen.queryByText("private-error-sentinel")).toBeNull(); expect(fetchSpy).toHaveBeenCalledOnce();
});

it("mounts an explicit blank count preview alongside old backup controls without any preview POST", async () => {
  const f=setup(); render(<ManagedDatabaseBackupPanel {...f.props}/>);
  await screen.findByRole("button",{name:"Create backup"});
  expect((screen.getByRole("textbox",{name:"Keep newest backups"}) as HTMLInputElement).value).toBe("");
  expect(screen.getByRole("button",{name:"Preview retention"})).toBeTruthy();
  expect(screen.getByRole("button",{name:"Reload backups"})).toBeTruthy(); expect(backup).not.toHaveBeenCalled();
});

it("withholds a detached volume plan after separately settled destination and inventory transitions", async () => {
  const f = setup(), plan = {...retentionPlan(f), volumeKey: "db-foreign"};
  const ready = {kind: "ready" as const, destinations: [{destinationId: "destination-a", maxBytes: 4096}], backups: []};
  let finishDestinations!: (value: Awaited<ReturnType<typeof read>>) => void;
  let finishInventory!: (value: Awaited<ReturnType<typeof read>>) => void;
  const destinations = new Promise<Awaited<ReturnType<typeof read>>>(resolve => {finishDestinations = resolve;});
  const inventory = new Promise<Awaited<ReturnType<typeof read>>>(resolve => {finishInventory = resolve;});
  read.mockImplementationOnce(() => destinations).mockImplementationOnce(() => inventory);
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(f.response({plan}));
  render(<ManagedDatabaseBackupPanel {...f.props} />);
  expect(read).toHaveBeenCalledOnce(); expect(screen.queryByRole("textbox", {name: "Keep newest backups"})).toBeNull();
  expect(fetchSpy).not.toHaveBeenCalled();
  await act(async () => {finishDestinations(ready); await destinations;});
  expect(read).toHaveBeenCalledTimes(2); expect(read.mock.calls[1]![2]).toBe("destination-a");
  expect(screen.queryByRole("textbox", {name: "Keep newest backups"})).toBeNull(); expect(fetchSpy).not.toHaveBeenCalled();
  await act(async () => {finishInventory(ready); await inventory;});
  const input = screen.getByRole("textbox", {name: "Keep newest backups"}) as HTMLInputElement;
  const button = screen.getByRole("button", {name: "Preview retention"}) as HTMLButtonElement;
  expect(input.value).toBe(""); expect(button.disabled).toBe(true); expect(fetchSpy).not.toHaveBeenCalled();
  enterRetentionCount("1"); expect(input.value).toBe("1"); expect(button.disabled).toBe(false);
  clickRetentionPreview(); expect(fetchSpy).toHaveBeenCalledOnce();
  expect(JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body))).toEqual({schemaVersion: 1, volumeKey: "db-orders", destinationId: "destination-a", keepNewest: 1});
  await screen.findByText("Retention preview is unavailable.");
  expect(input.value).toBe("1"); expect(screen.queryByText(/Retained:/)).toBeNull();
  expect(screen.queryByText("private-error-sentinel")).toBeNull(); expect(fetchSpy).toHaveBeenCalledOnce(); expect(backup).not.toHaveBeenCalled();
});
