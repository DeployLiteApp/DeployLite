// @vitest-environment jsdom
import type { Deployment } from "@deploylite/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { DeploymentHistoryStatusFilter } from "./deployment-history-status-filter.js";

afterEach(() => cleanup());
function deployment(id: string, status: Deployment["status"]): Deployment {
  return { id, projectId: `project-${id}`, agentId: "agent-1", status, commitSha: "abcdef1", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: null };
}
const history = (["queued", "running", "succeeded", "failed", "canceled"] as Deployment["status"][]).map((status) => deployment(`dep-${status}`, status));

describe("DeploymentHistoryStatusFilter", () => {
  it("renders all supported options and an atomic live count", () => {
    render(<DeploymentHistoryStatusFilter deployments={history} />);
    const select = screen.getByRole("combobox", { name: "Filter by status" });
    expect(select.tagName).toBe("SELECT");
    expect(Array.from(select.querySelectorAll("option")).map((option) => option.value)).toEqual(["all", "queued", "running", "succeeded", "failed", "canceled"]);
    const count = screen.getByText("Showing 5 deployment records.");
    expect(count.getAttribute("aria-live")).toBe("polite");
    expect(count.getAttribute("aria-atomic")).toBe("true");
  });
  it("updates rows and count through native keyboard selection", async () => {
    const user = userEvent.setup(); render(<DeploymentHistoryStatusFilter deployments={history} />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Filter by status" }), "failed");
    expect(screen.getByText("Showing 1 deployment record with status failed.")).toBeTruthy();
    expect(screen.getByText("dep-failed")).toBeTruthy(); expect(screen.queryByText("dep-running")).toBeNull();
  });
  it("shows a no-match state and resets without a reload", async () => {
    const user = userEvent.setup(); render(<DeploymentHistoryStatusFilter deployments={history.filter(({ status }) => status !== "canceled")} />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Filter by status" }), "canceled");
    expect(screen.queryByRole("table")).toBeNull(); expect(screen.getByText(/No deployments match/i)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Show all statuses" }));
    expect(screen.getByRole("table")).toBeTruthy(); expect(screen.getByText("Showing 4 deployment records.")).toBeTruthy();
  });
  it("preserves matching row order and log destinations", async () => {
    const user = userEvent.setup(); const interleaved = [deployment("running-1", "running"), deployment("failed", "failed"), deployment("running-2", "running")];
    render(<DeploymentHistoryStatusFilter deployments={interleaved} />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Filter by status" }), "running");
    const rows = screen.getAllByRole("row"); expect(rows).toHaveLength(3); expect(rows[1]?.textContent).toContain("running-1"); expect(rows[2]?.textContent).toContain("running-2");
    expect(screen.getAllByRole("link", { name: "Logs" })[0]?.getAttribute("href")).toBe("/deployments/running-1");
  });

  it("keeps reset state and project-to-deployment associations stable while filtering", async () => {
    const user = userEvent.setup();
    const filteredHistory = [deployment("deployment-a", "running"), deployment("deployment-b", "failed")];
    render(<DeploymentHistoryStatusFilter deployments={filteredHistory} />);

    const select = screen.getByRole("combobox", { name: "Filter by status" });
    const reset = screen.getByRole("button", { name: "Show all statuses" });
    expect((reset as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("project-deployment-a")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Logs" })[0]?.getAttribute("href")).toBe("/deployments/deployment-a");

    await user.selectOptions(select, "failed");

    expect((reset as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText("project-deployment-a")).toBeNull();
    expect(screen.getByText("project-deployment-b")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Logs" }).getAttribute("href")).toBe("/deployments/deployment-b");
  });
});
