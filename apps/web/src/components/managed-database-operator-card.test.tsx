// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { managedDatabaseHealthPreparationSchema, managedDatabaseStartPreparationSchema } from "@deploylite/contracts";
import { applyManagedDatabase, prepareManagedDatabase, startManagedDatabase, stopManagedDatabase } from "@/lib/managed-database-lifecycle";
import { ManagedDatabaseOperatorCard } from "./managed-database-operator-card";
vi.mock("@/lib/managed-database-lifecycle", () => ({applyManagedDatabase: vi.fn(), prepareManagedDatabase: vi.fn(), startManagedDatabase: vi.fn(), stopManagedDatabase: vi.fn()}));
vi.mock("./managed-database-telemetry-panel", () => ({ManagedDatabaseTelemetryPanel: ({preparation}: {preparation: {databaseId: string}}) => <p>Telemetry for {preparation.databaseId}</p>}));
afterEach(() => {cleanup(); vi.resetAllMocks();});
function fixture() {
  const preparation = {schemaVersion: 1 as const, projectId: "project-a", databaseId: "orders", engine: "postgres" as const, profileId: "profile-a", planDigest: "a".repeat(64), environmentFingerprint: "b".repeat(32)};
  const receipt = {schemaVersion: 1, projectId: "project-a", databaseId: "orders", engine: "postgres", action: "database.runtime", agentId: "agent-a", commandId: "create-a", inputDigest: "c".repeat(64), planDigest: "a".repeat(64), environmentFingerprint: "b".repeat(32), correlationId: "create-correlation",
    containerId: "d".repeat(64), imageId: "sha256:" + "e".repeat(64), networkId: "f".repeat(64), volumeName: "dl-" + "1".repeat(32) + "-vol-db-orders", networkName: "dl-" + "1".repeat(32) + "-net-db-orders",
    volumeCreatedAt: "2026-01-01T00:00:00.000Z", observedAt: 1000, status: "ready", health: "passed", storage: "verified", idempotent: false, redacted: true};
  const source = managedDatabaseHealthPreparationSchema.parse({...preparation, originalReceipt: receipt, originalReplayFingerprint: "2".repeat(64)});
  const {action: _action, health: _health, idempotent: _idempotent, ...fields} = receipt;
  const stopped = {...fields, action: "database.runtime.stop", originalCommandId: "create-a", profileId: "profile-a", commandId: "stop-a", inputDigest: "3".repeat(64), correlationId: "stop-correlation", status: "stopped", observedAt: 2000};
  const startSource = managedDatabaseStartPreparationSchema.parse({...source, originalStopReceipt: stopped, originalStopReplayFingerprint: "4".repeat(64)});
  const started = {...source.originalReceipt, action: "database.runtime.start" as const, originalCommandId: "create-a", originalStopCommandId: "stop-a", profileId: "profile-a", commandId: "start-a", status: "ready" as const, health: "passed" as const, containerId: source.originalReceipt.containerId!, imageId: source.originalReceipt.imageId!, networkId: source.originalReceipt.networkId!, volumeCreatedAt: source.originalReceipt.volumeCreatedAt!, storage: "verified" as const, observedAt: 3000};
  const {environmentFingerprint: _fp, ...base} = preparation;
  const connection = {...base, availability: "planned" as const, exposure: "internal" as const, hostname: "db-orders", networkName: receipt.networkName, port: 5432, databaseName: "orders", username: "orders_owner", authenticationDatabase: null};
  vi.mocked(prepareManagedDatabase).mockResolvedValue({kind: "ready", preparation, connection});
  vi.mocked(applyManagedDatabase).mockResolvedValue({kind: "ready", preparation: source});
  vi.mocked(stopManagedDatabase).mockResolvedValue({kind: "ready", preparation: startSource});
  vi.mocked(startManagedDatabase).mockResolvedValue({kind: "ready", receipt: started});
  return {preparation, source, startSource, props: {projectId: "project-a", apiBaseUrl: "https://api.example.test"}};
}
function enter(f: ReturnType<typeof fixture>) {
  const ui = render(<ManagedDatabaseOperatorCard {...f.props} />);
  fireEvent.change(screen.getByLabelText("Database name"), {target: {value: "orders"}}); return ui;
}
async function prepared() {
  const f = fixture(); enter(f); fireEvent.click(screen.getByRole("button", {name: "Prepare database"})); await screen.findByText("db-orders:5432"); return f;
}
it("offers exactly the five Dokploy engines and performs no operation on mount", () => {
  const f = fixture(); enter(f);
  expect([...screen.getByLabelText("Engine").querySelectorAll("option")].map(option => option.textContent)).toEqual(["PostgreSQL", "MySQL", "MariaDB", "MongoDB", "Redis"]);
  expect(prepareManagedDatabase).not.toHaveBeenCalled(); expect(applyManagedDatabase).not.toHaveBeenCalled();
});
it("prepares the selected engine for this project without executing creation", async () => {
  const f = fixture(); enter(f); fireEvent.change(screen.getByLabelText("Engine"), {target: {value: "mysql"}});
  fireEvent.click(screen.getByRole("button", {name: "Prepare database"}));
  await waitFor(() => expect(prepareManagedDatabase).toHaveBeenCalledWith({schemaVersion: 1, projectId: "project-a", databaseId: "orders", engine: "mysql"}, expect.objectContaining({apiBaseUrl: f.props.apiBaseUrl})));
  expect(applyManagedDatabase).not.toHaveBeenCalled();
});
it("creates and controls only original public sources, then enables telemetry", async () => {
  const f = await prepared(); fireEvent.click(screen.getByRole("button", {name: "Create database"})); await screen.findByText("Telemetry for orders");
  expect(vi.mocked(applyManagedDatabase).mock.calls[0]![0]).toEqual(f.preparation);
  fireEvent.click(screen.getByRole("button", {name: "Stop database"})); await waitFor(() => expect(stopManagedDatabase).toHaveBeenCalled());
  expect(vi.mocked(stopManagedDatabase).mock.calls[0]![0]).toEqual(f.source);
  await waitFor(() => expect((screen.getByRole("button", {name: "Start database"}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", {name: "Start database"})); await waitFor(() => expect(startManagedDatabase).toHaveBeenCalled());
  expect(vi.mocked(startManagedDatabase).mock.calls[0]![0]).toEqual(f.startSource);
});
it("retains the same explicit key when a creation reply is ambiguous", async () => {
  await prepared(); vi.mocked(applyManagedDatabase).mockResolvedValueOnce({kind: "error", message: "Database operation is unavailable."});
  fireEvent.click(screen.getByRole("button", {name: "Create database"})); await screen.findByText("Database creation could not be confirmed.");
  expect(applyManagedDatabase).toHaveBeenCalledOnce(); fireEvent.click(screen.getByRole("button", {name: "Create database"})); await screen.findByText("Telemetry for orders");
  const calls = vi.mocked(applyManagedDatabase).mock.calls; expect(calls[0]![2]).toMatch(/^[A-Za-z0-9_-]{1,200}$/); expect(calls[1]![2]).toBe(calls[0]![2]);
});
it("cancels pending operations on unmount and withholds operation controls until preparation", async () => {
  const f = fixture(); vi.mocked(prepareManagedDatabase).mockImplementation(() => new Promise(() => {})); const ui = enter(f);
  expect(screen.queryByRole("button", {name: "Create database"})).toBeNull(); fireEvent.click(screen.getByRole("button", {name: "Prepare database"}));
  await waitFor(() => expect(prepareManagedDatabase).toHaveBeenCalledOnce()); const signal = vi.mocked(prepareManagedDatabase).mock.calls[0]![1].signal!;
  ui.unmount(); expect(signal.aborted).toBe(true);
});
it("hands a confirmed creation to the stored inventory once and clears stale creation controls", async () => {
  const f = fixture(), onCreated = vi.fn(); render(<ManagedDatabaseOperatorCard {...f.props} {...{onCreated}} />);
  fireEvent.change(screen.getByLabelText("Database name"), {target: {value: "orders"}});
  fireEvent.click(screen.getByRole("button", {name: "Prepare database"})); await screen.findByText("db-orders:5432");
  fireEvent.click(screen.getByRole("button", {name: "Create database"}));
  await waitFor(() => expect(onCreated).toHaveBeenCalledExactlyOnceWith("orders"));
  expect(screen.queryByRole("button", {name: "Create database"})).toBeNull();
  expect(screen.queryByRole("button", {name: "Stop database"})).toBeNull();
  expect((screen.getByLabelText("Database name") as HTMLInputElement).value).toBe("");
});
