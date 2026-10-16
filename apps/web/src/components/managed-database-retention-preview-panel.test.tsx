// @vitest-environment jsdom
import {act, cleanup, fireEvent, render, screen} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {afterEach, expect, it, vi} from "vitest";
import {previewManagedDatabaseRetention} from "@/lib/managed-database-retention";
import {ManagedDatabaseRetentionPreviewPanel} from "./managed-database-retention-preview-panel";
vi.mock("@/lib/managed-database-retention", () => ({previewManagedDatabaseRetention: vi.fn()}));
const preview = vi.mocked(previewManagedDatabaseRetention);
afterEach(() => {cleanup(); vi.resetAllMocks();});
const props = {projectId: "project-a", databaseId: "orders", destinationId: "destination-a", sourceIdentity: "original-a", actorId: "actor-a", apiBaseUrl: "https://api.example.test"};
const plan = {schemaVersion: 1 as const, operation: "backup.retention.preview" as const, executionAllowed: false as const,
  projectId: "project-a", volumeKey: "db-orders", destinationId: "destination-a", keepNewest: 1, retainedArchiveIds: ["new", "protected"],
  protectedArchiveIds: ["protected"], deletionCandidates: [{archiveId: "old", archiveSha256: "a".repeat(64), manifestSha256: "b".repeat(64), createdAtMs: 1}], inventoryDigest: "c".repeat(64), planDigest: "d".repeat(64)};
function fill(value = "1") {fireEvent.change(screen.getByRole("textbox", {name: "Keep newest backups"}), {target: {value}});}
it("starts blank, makes no automatic request and previews only on an explicit accessible button", async () => {
  preview.mockResolvedValue({kind: "ready", plan}); const view = render(<ManagedDatabaseRetentionPreviewPanel {...props} />);
  const input = screen.getByRole("textbox", {name: "Keep newest backups"}) as HTMLInputElement;
  expect(input.value).toBe(""); expect(preview).not.toHaveBeenCalled();
  fill(); expect(preview).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", {name: "Preview retention"}));
  await screen.findByText("Retained: 2 · Protected: 1 · Candidates: 1"); expect(preview).toHaveBeenCalledOnce();
  expect(preview.mock.calls[0]![0]).toEqual({projectId: props.projectId, databaseId: props.databaseId});
  expect(preview.mock.calls[0]![1]).toMatchObject({actorId: props.actorId});
  expect(preview.mock.calls[0]![2]).toEqual({schemaVersion: 1, volumeKey: "db-orders", destinationId: props.destinationId, keepNewest: 1});
  expect(screen.getByText("Preview only. No deletion is performed.")).toBeTruthy(); expect(screen.queryByRole("button", {name: /delete/i})).toBeNull();
  view.unmount(); render(<ManagedDatabaseRetentionPreviewPanel {...props} />); expect(preview).toHaveBeenCalledOnce(); expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("");
});
it.each(["", "0", "10001", "1.5", "-1", "1e3"])("requires explicit integer count instead of defaulting invalid %s", value => {
  render(<ManagedDatabaseRetentionPreviewPanel {...props} />); fill(value);
  expect((screen.getByRole("button", {name: "Preview retention"}) as HTMLButtonElement).disabled).toBe(true); expect(preview).not.toHaveBeenCalled();
});
it.each(["sourceIdentity", "actorId", "destinationId", "projectId", "databaseId", "apiBaseUrl"] as const)("aborts and withholds pending response on %s change without automatic POST", async field => {
  let finish!: (value: Awaited<ReturnType<typeof previewManagedDatabaseRetention>>) => void;
  preview.mockImplementation(() => new Promise(resolve => {finish = resolve;}));
  const view = render(<ManagedDatabaseRetentionPreviewPanel {...props} />); fill(); fireEvent.click(screen.getByRole("button", {name: "Preview retention"}));
  const signal = preview.mock.calls[0]![1].signal!; view.rerender(<ManagedDatabaseRetentionPreviewPanel {...props} {...{[field]: "changed"}} />);
  expect(signal.aborted).toBe(true); await act(async () => finish({kind: "ready", plan}));
  expect(screen.queryByText(/Retained: 2/)).toBeNull(); expect(preview).toHaveBeenCalledOnce();
});
it("clears result and aborts pending response immediately when submitted count changes or unmounts", async () => {
  preview.mockResolvedValueOnce({kind: "ready", plan}); const view = render(<ManagedDatabaseRetentionPreviewPanel {...props} />);
  fill(); fireEvent.click(screen.getByRole("button", {name: "Preview retention"})); await screen.findByText(/Retained: 2/); fill("2"); expect(screen.queryByText(/Retained: 2/)).toBeNull();
  let finish!: (value: Awaited<ReturnType<typeof previewManagedDatabaseRetention>>) => void; preview.mockImplementation(() => new Promise(resolve => {finish = resolve;}));
  fireEvent.click(screen.getByRole("button", {name: "Preview retention"})); const signal = preview.mock.calls[1]![1].signal!; fill("3"); expect(signal.aborted).toBe(true);
  await act(async () => finish({kind: "ready", plan})); expect(screen.queryByText(/Retained: 2/)).toBeNull();
  fireEvent.click(screen.getByRole("button", {name: "Preview retention"})); const last = preview.mock.calls[2]![1].signal!; view.unmount(); expect(last.aborted).toBe(true);
});
it("shows bounded unavailable state without raw errors and honors parent disabled controls", async () => {
  preview.mockResolvedValue({kind: "error", message: "private-sentinel"}); const view = render(<ManagedDatabaseRetentionPreviewPanel {...props} />);
  fill(); fireEvent.click(screen.getByRole("button", {name: "Preview retention"})); await screen.findByText("Retention preview is unavailable.");
  expect(screen.queryByText("private-sentinel")).toBeNull(); view.rerender(<ManagedDatabaseRetentionPreviewPanel {...props} disabled />);
  expect((screen.getByRole("button", {name: "Preview retention"}) as HTMLButtonElement).disabled).toBe(true);
});

it("supports labelled keyboard-only explicit preview without any automatic request", async () => {
  preview.mockResolvedValue({kind: "ready", plan}); const user = userEvent.setup(); render(<ManagedDatabaseRetentionPreviewPanel {...props} />);
  await user.tab(); expect(document.activeElement).toBe(screen.getByRole("textbox", {name: "Keep newest backups"}));
  await user.keyboard("1"); expect(preview).not.toHaveBeenCalled(); await user.tab(); expect(document.activeElement).toBe(screen.getByRole("button", {name: "Preview retention"}));
  await user.keyboard("{Enter}"); await screen.findByText(/Retained: 2/); expect(preview).toHaveBeenCalledOnce();
});
