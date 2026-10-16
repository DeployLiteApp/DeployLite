// @vitest-environment jsdom
import {useEffect} from "react";
import {act, cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, expect, it, vi} from "vitest";
import {readManagedDatabaseInventory, type ManagedDatabaseInventoryEntry} from "@/lib/managed-database-inventory";
import {startManagedDatabase, stopManagedDatabase} from "@/lib/managed-database-lifecycle";
import {ManagedDatabaseInventoryPanel} from "./managed-database-inventory-panel";
vi.mock("./managed-database-delete-control",()=>({ManagedDatabaseDeleteControl:({onDeleted}:{onDeleted():void})=><button onClick={onDeleted}>Fixture delete completion</button>}));
const observed = vi.hoisted(() => ({state: "running" as "running" | "stopped" | null, backup: vi.fn()}));
vi.mock("@/lib/managed-database-inventory", () => ({readManagedDatabaseInventory: vi.fn()}));
vi.mock("@/lib/managed-database-lifecycle", () => ({stopManagedDatabase: vi.fn(), startManagedDatabase: vi.fn()}));
vi.mock("./managed-database-telemetry-panel", () => ({ManagedDatabaseTelemetryPanel: ({preparation, onState}: {preparation: {databaseId: string}; onState?(value: "running" | "stopped" | null): void}) => {
  useEffect(() => {onState?.(observed.state);}, [onState, preparation]); return <p>Telemetry for {preparation.databaseId}</p>;
}}));
vi.mock("./managed-database-backup-panel",()=>({ManagedDatabaseBackupPanel:(props:unknown)=>{observed.backup(props);return <p>Scoped backup controls</p>;}}));
const read = vi.mocked(readManagedDatabaseInventory), stop = vi.mocked(stopManagedDatabase), start = vi.mocked(startManagedDatabase);
afterEach(() => {cleanup(); vi.resetAllMocks(); observed.state = "running";});
function fixture(projectId = "project-a", databaseId = "orders", engine: "postgres" | "mysql" | "mariadb" | "mongodb" | "redis" = "postgres") {
  const preparation = {schemaVersion: 1 as const, projectId, databaseId, engine, profileId: `profile-${engine}`, planDigest: "a".repeat(64), environmentFingerprint: "b".repeat(32)};
  const {profileId: _profile, ...receiptBase} = preparation;
  const originalReceipt = {...receiptBase, action: "database.runtime" as const, agentId: "agent-a", commandId: "create-a", inputDigest: "c".repeat(64), correlationId: "create-correlation",
    containerId: "d".repeat(64), imageId: `sha256:${"e".repeat(64)}`, networkId: "f".repeat(64), volumeName: `dl-${"1".repeat(32)}-vol-db-${databaseId}`,
    networkName: `dl-${"1".repeat(32)}-net-db-${databaseId}`, volumeCreatedAt: "2026-01-01T00:00:00.000Z", observedAt: 1000, status: "ready" as const,
    health: "passed" as const, storage: "verified" as const, idempotent: false, redacted: true as const};
  const source = {...preparation, originalReceipt, originalReplayFingerprint: "2".repeat(64)};
  const {health: _health, idempotent: _idem, ...physical} = originalReceipt;
  const originalStopReceipt = {...physical, action: "database.runtime.stop" as const, status: "stopped" as const, profileId: preparation.profileId,
    commandId: "stop-a", originalCommandId: "create-a", inputDigest: "3".repeat(64), correlationId: "stop-correlation", observedAt: 2000};
  const startPreparation = {...source, originalStopReceipt, originalStopReplayFingerprint: "4".repeat(64)};
  const {environmentFingerprint: _fp, ...connectionBase} = preparation;
  const connection = {...connectionBase, availability: "planned" as const, exposure: "internal" as const, hostname: `db-${databaseId}`, networkName: originalReceipt.networkName,
    port: {postgres: 5432, mysql: 3306, mariadb: 3306, mongodb: 27017, redis: 6379}[engine], databaseName: engine === "redis" ? "0" : databaseId,
    username: engine === "redis" ? "default" : "dl_123456789abc", authenticationDatabase: engine === "mongodb" ? "admin" as const : null};
  const entry: ManagedDatabaseInventoryEntry = {preparation, connection, source, startPreparation};
  const started = {...originalReceipt, action: "database.runtime.start" as const, profileId: preparation.profileId, originalCommandId: "create-a", originalStopCommandId: "stop-a",
    commandId: "start-a", inputDigest: "5".repeat(64), correlationId: "start-correlation", observedAt: 3000};
  read.mockResolvedValue({kind: "ready", databases: [entry]});
  stop.mockImplementation(async () => {observed.state = "stopped"; return {kind: "ready", preparation: startPreparation};});
  start.mockImplementation(async () => {observed.state = "running"; return {kind: "ready", receipt: started};});
  return {entry, source, startPreparation, started, props: {projectId, apiBaseUrl: "https://api.example.test"}};
}
async function choose(name = "orders (PostgreSQL)") {fireEvent.click(await screen.findByRole("button", {name}));}
it("loads all five stored engines without preparing credentials or executing commands on mount", async () => {
  const entries = (["postgres", "mysql", "mariadb", "mongodb", "redis"] as const).map(engine => fixture("project-a", `orders_${engine}`, engine).entry);
  read.mockResolvedValue({kind: "ready", databases: entries}); render(<ManagedDatabaseInventoryPanel projectId="project-a" apiBaseUrl="https://api.example.test" />);
  for (const name of ["PostgreSQL", "MySQL", "MariaDB", "MongoDB", "Redis"]) expect(await screen.findByRole("button", {name: new RegExp(`\\(${name}\\)`)})).toBeTruthy();
  expect(read).toHaveBeenCalledExactlyOnceWith("project-a", expect.objectContaining({apiBaseUrl: "https://api.example.test", signal: expect.any(AbortSignal)}));
  expect(stop).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
});
it("recovers stored STOP evidence and permits START only after a fresh stopped observation", async () => {
  const f = fixture(); observed.state = "stopped"; render(<ManagedDatabaseInventoryPanel {...f.props} />); await choose();
  await waitFor(() => expect((screen.getByRole("button", {name: "Start database"}) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByRole("button", {name: "Stop database"}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", {name: "Start database"})); await screen.findByText("Start completed.");
  expect(start).toHaveBeenCalledWith(f.startPreparation, expect.objectContaining({apiBaseUrl: f.props.apiBaseUrl}), expect.any(String));
});
it("uses the recovered original source for STOP then START and refreshes current telemetry after both", async () => {
  const f = fixture(); render(<ManagedDatabaseInventoryPanel {...f.props} />); await choose();
  await waitFor(() => expect((screen.getByRole("button", {name: "Stop database"}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", {name: "Stop database"})); await screen.findByText("Stop completed.");
  expect(stop).toHaveBeenCalledWith(f.source, expect.objectContaining({apiBaseUrl: f.props.apiBaseUrl}), expect.any(String));
  await waitFor(() => expect((screen.getByRole("button", {name: "Start database"}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", {name: "Start database"})); await screen.findByText("Start completed.");
  expect(start).toHaveBeenCalledWith(f.startPreparation, expect.anything(), expect.any(String));
});
it("keeps the original explicit key for manual confirmation retry without retrying automatically", async () => {
  const f = fixture(); stop.mockResolvedValueOnce({kind: "error", message: "private-detail"});
  render(<ManagedDatabaseInventoryPanel {...f.props} />); await choose();
  await waitFor(() => expect((screen.getByRole("button", {name: "Stop database"}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", {name: "Stop database"})); await screen.findByRole("button", {name: "Retry stop confirmation"});
  expect(stop).toHaveBeenCalledTimes(1); expect(screen.queryByText("private-detail")).toBeNull();
  fireEvent.click(screen.getByRole("button", {name: "Retry stop confirmation"})); await screen.findByText("Stop completed.");
  expect(stop.mock.calls[1]![2]).toBe(stop.mock.calls[0]![2]);
});
it("withholds runtime controls when original evidence or a current observation is unavailable", async () => {
  const f = fixture(); read.mockResolvedValueOnce({kind: "ready", databases: [{...f.entry, source: null, startPreparation: null}]});
  const view = render(<ManagedDatabaseInventoryPanel {...f.props} />); await choose(); await screen.findByText("Runtime controls could not be recovered.");
  expect(screen.queryByRole("button", {name: "Start database"})).toBeNull(); view.unmount();
  read.mockResolvedValue({kind: "ready", databases: [f.entry]}); observed.state = null;
  render(<ManagedDatabaseInventoryPanel {...f.props} />); await choose();
  expect((screen.getByRole("button", {name: "Start database"}) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", {name: "Stop database"}) as HTMLButtonElement).disabled).toBe(true);
});
it("clears stale rows on a failed explicit reload instead of reporting an empty successful inventory", async () => {
  const f = fixture(); render(<ManagedDatabaseInventoryPanel {...f.props} />); await choose();
  read.mockResolvedValueOnce({kind: "error", message: "private-detail"}); fireEvent.click(screen.getByRole("button", {name: "Reload databases"}));
  await screen.findByText("Database inventory could not be loaded.");
  expect(screen.queryByRole("button", {name: "orders (PostgreSQL)"})).toBeNull(); expect(screen.queryByText("No stored databases.")).toBeNull();
  expect(stop).not.toHaveBeenCalled();
});
it("aborts and withholds a stale inventory reply after switching project scope", async () => {
  const first = fixture(), second = fixture("project-b", "billing");
  let finish!: (value: Awaited<ReturnType<typeof readManagedDatabaseInventory>>) => void;
  read.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;})).mockResolvedValueOnce({kind: "ready", databases: [second.entry]});
  const view = render(<ManagedDatabaseInventoryPanel {...first.props} />);
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1)); const signal = read.mock.calls[0]![1].signal!;
  view.rerender(<ManagedDatabaseInventoryPanel {...second.props} />); await screen.findByRole("button", {name: "billing (PostgreSQL)"});
  expect(signal.aborted).toBe(true); await act(async () => {finish({kind: "ready", databases: [first.entry]});});
  expect(screen.queryByRole("button", {name: "orders (PostgreSQL)"})).toBeNull(); expect(stop).not.toHaveBeenCalled();
});
it("prevents overlapping effects and aborts stale control results on unmount", async () => {
  const f = fixture(); let finish!: (value: Awaited<ReturnType<typeof stopManagedDatabase>>) => void;
  stop.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
  const view = render(<ManagedDatabaseInventoryPanel {...f.props} />); await choose();
  await waitFor(() => expect((screen.getByRole("button", {name: "Stop database"}) as HTMLButtonElement).disabled).toBe(false));
  const button = screen.getByRole("button", {name: "Stop database"}); fireEvent.click(button); fireEvent.click(button);
  await waitFor(() => expect(stop).toHaveBeenCalledTimes(1)); const signal = stop.mock.calls[0]![1].signal!;
  view.unmount(); expect(signal.aborted).toBe(true); await act(async () => {finish({kind: "ready", preparation: f.startPreparation});});
  expect(start).not.toHaveBeenCalled();
});

it("reloads and clears the retired selection after explicit delete control completion",async()=>{
  const f=fixture();read.mockResolvedValueOnce({kind:"ready",databases:[f.entry]}).mockResolvedValue({kind:"ready",databases:[]});
  render(<ManagedDatabaseInventoryPanel {...f.props}/>);await choose();fireEvent.click(screen.getByRole("button",{name:"Fixture delete completion"}));await screen.findByText("No stored databases.");expect(screen.queryByText("Telemetry for orders")).toBeNull();expect(read).toHaveBeenCalledTimes(2);
});

it("activates backups only for a known actor and the selected original source with current health",async()=>{
  const f=fixture();const view=render(<ManagedDatabaseInventoryPanel {...f.props}/>);await choose();expect(observed.backup).not.toHaveBeenCalled();
  view.rerender(<ManagedDatabaseInventoryPanel {...f.props} actorId="operator-a"/>);await choose();
  await waitFor(()=>expect(observed.backup).toHaveBeenLastCalledWith(expect.objectContaining({preparation:f.source,actorId:"operator-a",apiBaseUrl:f.props.apiBaseUrl,currentState:"running"})));
});
