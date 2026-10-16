// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ManagedDatabaseHealthPreparationV1, ManagedDatabaseHealthObservationV1 } from "@deploylite/contracts";
import { readManagedDatabaseTelemetry } from "@/lib/managed-database-telemetry";
import { ManagedDatabaseTelemetryPanel } from "./managed-database-telemetry-panel";
vi.mock("@/lib/managed-database-telemetry", () => ({readManagedDatabaseTelemetry: vi.fn()}));
const read = vi.mocked(readManagedDatabaseTelemetry);
const browserDescriptors = [[navigator,"clipboard"],[URL,"createObjectURL"],[URL,"revokeObjectURL"]].map(([target,key]) => ({target:target as object,key:key as string,descriptor:Object.getOwnPropertyDescriptor(target,key as string)}));
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.resetAllMocks(); vi.useRealTimers();
  for (const {target,key,descriptor} of browserDescriptors) {if (descriptor) Object.defineProperty(target,key,descriptor); else Reflect.deleteProperty(target,key);}
});
function fixture() {
  const preparation: ManagedDatabaseHealthPreparationV1 = {schemaVersion: 1, projectId: "project-a", databaseId: "orders", engine: "postgres",
    profileId: "profile-a", planDigest: "a".repeat(64), environmentFingerprint: "b".repeat(32), originalReplayFingerprint: "c".repeat(64),
    originalReceipt: {schemaVersion: 1, projectId: "project-a", databaseId: "orders", engine: "postgres", action: "database.runtime",
      agentId: "agent-a", commandId: "command-a", inputDigest: "d".repeat(64), planDigest: "a".repeat(64), environmentFingerprint: "b".repeat(32),
      correlationId: "original", containerId: "e".repeat(64), imageId: "sha256:" + "f".repeat(64), networkId: "1".repeat(64),
      volumeName: "dl-" + "2".repeat(32) + "-vol-db-orders", networkName: "dl-" + "2".repeat(32) + "-net-db-orders",
      volumeCreatedAt: "2026-01-01T00:00:00.000Z", observedAt: 1000, status: "ready", health: "passed", storage: "verified", idempotent: false, redacted: true}};
  const {commandId, inputDigest: _digest, correlationId: _correlation, status: _status, health: _health, idempotent: _idempotent, ...scope} = preparation.originalReceipt;
  const health: ManagedDatabaseHealthObservationV1 = {...scope, containerId: scope.containerId!, imageId: scope.imageId!, networkId: scope.networkId!, volumeCreatedAt: scope.volumeCreatedAt!,
    action: "database.runtime.health", originalCommandId: commandId, profileId: "profile-a", context: {requestId: "query-a", correlationId: "query-a"},
    observedAt: 2000, state: "running", health: "healthy", storage: "verified", uid: 999};
  read.mockResolvedValue({kind: "ready", observation: health});
  return {preparation, health, props: {preparation, apiBaseUrl: "https://api.example.test"}};
}
it("shows observed health and sends only the selected original public scope", async () => {
  const f = fixture(); render(<ManagedDatabaseTelemetryPanel {...f.props} />);
  await screen.findByText("Healthy");
  expect(read).toHaveBeenCalledWith("health", expect.objectContaining(f.props), undefined);
  expect(screen.getByRole("button", {name: "Pause live"})).toBeTruthy();
});
it("shows stopped metrics absence without inventing counters", async () => {
  const f = fixture(); render(<ManagedDatabaseTelemetryPanel {...f.props} />); await screen.findByText("Healthy");
  read.mockResolvedValue({kind: "ready", observation: {...f.health, action: "database.runtime.metrics", state: "stopped", health: "not-running", uid: null, metrics: null, metricsObservedAt: null}});
  fireEvent.click(screen.getByRole("button", {name: "Metrics"}));
  await screen.findByText("No metrics while stopped."); expect(screen.queryByText("0%")).toBeNull();
});
it("searches retained logs locally and sends bounded line/date selections", async () => {
  const f = fixture(); render(<ManagedDatabaseTelemetryPanel {...f.props} />); await screen.findByText("Healthy");
  read.mockResolvedValue({kind: "ready", observation: {...f.health, action: "database.runtime.logs", logs: {stdout: "alpha line\nbeta line\n", stderr: "notice\n", redacted: true}, logsObservedAt: 1999}});
  fireEvent.click(screen.getByRole("button", {name: "Logs"})); await screen.findByText(/alpha line/);
  fireEvent.click(screen.getByRole("button", {name: "Pause live"})); const count = read.mock.calls.length;
  fireEvent.change(screen.getByLabelText("Search logs"), {target: {value: "beta"}});
  expect(screen.getByText("beta line")).toBeTruthy(); expect(screen.queryByText(/alpha line/)).toBeNull(); expect(read.mock.calls.length).toBe(count);
  fireEvent.change(screen.getByLabelText("Log lines"), {target: {value: "300"}});
  fireEvent.change(screen.getByLabelText("Since (local time)"), {target: {value: "2026-01-01T00:00"}});
  fireEvent.click(screen.getByRole("button", {name: "Refresh"}));
  await waitFor(() => expect(read.mock.calls.at(-1)?.[2]).toEqual({tail: 300, since: new Date("2026-01-01T00:00").toISOString()}));
});
it("cancels original reads when the selected view changes or unmounts", async () => {
  const f = fixture(); read.mockImplementation(() => new Promise(() => {})); const ui = render(<ManagedDatabaseTelemetryPanel {...f.props} />);
  await waitFor(() => expect(read).toHaveBeenCalledOnce()); const first = read.mock.calls[0]![1].signal!;
  fireEvent.click(screen.getByRole("button", {name: "Logs"})); await waitFor(() => expect(read).toHaveBeenCalledTimes(2)); expect(first.aborted).toBe(true);
  const second = read.mock.calls[1]![1].signal!; ui.unmount(); expect(second.aborted).toBe(true);
});
it("shows a generic unavailable message without reflecting rejected payloads", async () => {
  const f = fixture(); read.mockResolvedValue({kind: "error", message: "Database observation is unavailable."}); render(<ManagedDatabaseTelemetryPanel {...f.props} />);
  await screen.findByText("Database observation is unavailable."); expect(screen.queryByText("Healthy")).toBeNull();
});

it("renders the actual CPU, rounded quantities and I/O fields from live metrics", async () => {
  const f = fixture(); render(<ManagedDatabaseTelemetryPanel {...f.props} />); await screen.findByText("Healthy");
  read.mockResolvedValue({kind: "ready", observation: {...f.health, action: "database.runtime.metrics", metricsObservedAt: 1999,
    metrics: {cpuPercent: 2.5, memoryUsage: "4MiB / 64MiB", memoryPercent: 6.25, networkIO: "10kB / 20kB", blockIO: "1MB / 2MB", pids: 8}}});
  fireEvent.click(screen.getByRole("button", {name: "Metrics"}));
  await screen.findByText("10kB / 20kB"); expect(screen.getByText("1MB / 2MB")).toBeTruthy(); expect(screen.getByText("2.5%")).toBeTruthy();
  expect(screen.getByText("4MiB / 64MiB (6.25%)")).toBeTruthy(); expect(screen.getByText("8")).toBeTruthy();
});
it("starts each live read after the previous read settles and cancels polling on pause", async () => {
  vi.useFakeTimers(); const f = fixture(); let finish!: (value: Awaited<ReturnType<typeof read>>) => void;
  read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<ManagedDatabaseTelemetryPanel {...f.props} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(20000); }); expect(read).toHaveBeenCalledOnce();
  await act(async () => { finish({kind: "ready", observation: f.health}); });
  await act(async () => { await vi.advanceTimersByTimeAsync(4999); }); expect(read).toHaveBeenCalledOnce();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); }); expect(read).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", {name: "Pause live"}));
  await act(async () => { await vi.advanceTimersByTimeAsync(20000); }); expect(read).toHaveBeenCalledTimes(2);
});
it("reports only fresh observed state and clears it after a rejected observation", async () => {
  const f = fixture(), onState = vi.fn(); render(<ManagedDatabaseTelemetryPanel {...f.props} onState={onState} />);
  await screen.findByText("Healthy"); expect(onState).toHaveBeenLastCalledWith("running");
  read.mockResolvedValueOnce({kind: "error", message: "private-detail"});
  fireEvent.click(screen.getByRole("button", {name: "Refresh"}));
  await waitFor(() => expect(onState).toHaveBeenLastCalledWith(null));
});
it("copies only the currently filtered redacted logs without another runtime read", async () => {
  const f = fixture(), writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {configurable:true,value:{writeText}});
  render(<ManagedDatabaseTelemetryPanel {...f.props} />); await screen.findByText("Healthy");
  read.mockResolvedValue({kind:"ready",observation:{...f.health,action:"database.runtime.logs",logs:{stdout:"alpha line\nbeta line\n",stderr:"notice\n",redacted:true},logsObservedAt:1999}});
  fireEvent.click(screen.getByRole("button",{name:"Logs"})); await screen.findByText(/alpha line/);
  fireEvent.click(screen.getByRole("button",{name:"Pause live"}));
  fireEvent.change(screen.getByLabelText("Search logs"),{target:{value:"beta"}}); const count = read.mock.calls.length;
  fireEvent.click(screen.getByRole("button",{name:"Copy logs"})); await screen.findByText("Logs copied.");
  expect(writeText).toHaveBeenCalledExactlyOnceWith("beta line"); expect(read.mock.calls.length).toBe(count);
});
it("downloads the displayed redacted logs as text and releases the object URL", async () => {
  const f = fixture(), create = vi.fn().mockReturnValue("blob:fixture"), revoke = vi.fn();
  Object.defineProperty(URL,"createObjectURL",{configurable:true,value:create}); Object.defineProperty(URL,"revokeObjectURL",{configurable:true,value:revoke});
  const click = vi.spyOn(HTMLAnchorElement.prototype,"click").mockImplementation(() => {});
  render(<ManagedDatabaseTelemetryPanel {...f.props} />); await screen.findByText("Healthy");
  read.mockResolvedValue({kind:"ready",observation:{...f.health,action:"database.runtime.logs",logs:{stdout:"public line",stderr:"public notice",redacted:true},logsObservedAt:1999}});
  fireEvent.click(screen.getByRole("button",{name:"Logs"})); await screen.findByText(/public line/);
  fireEvent.click(screen.getByRole("button",{name:"Pause live"})); const count=read.mock.calls.length;
  fireEvent.click(screen.getByRole("button",{name:"Download logs"})); await screen.findByText("Logs downloaded.");
  expect(create).toHaveBeenCalledOnce(); expect(create.mock.calls[0]![0]).toBeInstanceOf(Blob);
  expect(create.mock.calls[0]![0].type).toBe("text/plain;charset=utf-8");
  const contents = await new Promise<string>(resolve => {const reader=new FileReader(); reader.onload=()=>resolve(String(reader.result)); reader.readAsText(create.mock.calls[0]![0]);});
  expect(contents).toBe("public line\npublic notice"); expect(click).toHaveBeenCalledOnce();
  expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:fixture"); expect(document.querySelector('a[download]')).toBeNull();
  expect(read.mock.calls.length).toBe(count); click.mockRestore();
});
it("reports clipboard rejection generically and disables exporting empty filtered logs", async () => {
  const f=fixture(), writeText=vi.fn().mockRejectedValue(new Error("private-detail"));
  Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText}});
  render(<ManagedDatabaseTelemetryPanel {...f.props} />); await screen.findByText("Healthy");
  read.mockResolvedValue({kind:"ready",observation:{...f.health,action:"database.runtime.logs",logs:{stdout:"public line",stderr:"",redacted:true},logsObservedAt:1999}});
  fireEvent.click(screen.getByRole("button",{name:"Logs"})); await screen.findByText("public line");
  fireEvent.click(screen.getByRole("button",{name:"Copy logs"})); await screen.findByText("Logs could not be copied.");
  expect(screen.queryByText("private-detail")).toBeNull();
  fireEvent.change(screen.getByLabelText("Search logs"),{target:{value:"absent"}});
  for(const name of ["Copy logs","Download logs"]) expect((screen.getByRole("button",{name}) as HTMLButtonElement).disabled).toBe(true);
});
