// @vitest-environment jsdom
import {cleanup, fireEvent, render, screen} from "@testing-library/react";
import {afterEach, expect, it, vi} from "vitest";
import {ManagedDatabaseWorkbench} from "./managed-database-workbench";
const observed = vi.hoisted(() => ({inventory: vi.fn(), creator: vi.fn()}));
vi.mock("./managed-database-operator-card", () => ({ManagedDatabaseOperatorCard: (props: {onCreated?(id: string): void}) => {
  observed.creator(props); return <button onClick={() => props.onCreated?.("orders")}>Fixture create confirmed</button>;
}}));
vi.mock("./managed-database-inventory-panel", () => ({ManagedDatabaseInventoryPanel: (props: {onSelect?(id: string): void}) => {
  observed.inventory(props); return <button onClick={() => props.onSelect?.("billing")}>Fixture select stored</button>;
}}));
afterEach(() => {cleanup(); vi.clearAllMocks();});
it("activates readonly stored inventory and refreshes/selects only after confirmed creation", () => {
  render(<ManagedDatabaseWorkbench projectId="project-a" apiBaseUrl="https://api.example.test" />);
  expect(observed.inventory).toHaveBeenLastCalledWith({projectId: "project-a", apiBaseUrl: "https://api.example.test", refreshKey: 0, selectedDatabaseId: "", onSelect: expect.any(Function)});
  expect(observed.creator).toHaveBeenLastCalledWith({projectId: "project-a", apiBaseUrl: "https://api.example.test", onCreated: expect.any(Function)});
  fireEvent.click(screen.getByRole("button", {name: "Fixture create confirmed"}));
  expect(observed.inventory).toHaveBeenLastCalledWith(expect.objectContaining({refreshKey: 1, selectedDatabaseId: "orders"}));
  fireEvent.click(screen.getByRole("button", {name: "Fixture select stored"}));
  expect(observed.inventory).toHaveBeenLastCalledWith(expect.objectContaining({refreshKey: 1, selectedDatabaseId: "billing"}));
});
it("does not mount authenticated inventory without a configured API", () => {
  render(<ManagedDatabaseWorkbench projectId="project-a" apiBaseUrl={null} />);
  expect(observed.creator).toHaveBeenCalled(); expect(observed.inventory).not.toHaveBeenCalled();
});
