// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { LogEvent } from "@deploylite/contracts";
import { DeploymentLogInspector } from "./deployment-log-inspector.js";

const event = (id: string, level: LogEvent["level"], message: string): LogEvent => ({ id, deploymentId: "deployment-1", sequence: Number(id), level, message, timestamp: "2026-01-01T00:00:00.000Z", redactionApplied: false, requestId: `request-${id}`, correlationId: `correlation-${id}` });
const events = [event("20", "info", "Preparing the deployment"), event("10", "debug", "Resolved build configuration"), event("30", "error", "Build failed"), event("40", "warn", "Using token [REDACTED]")];
afterEach(() => cleanup());

describe("DeploymentLogInspector", () => {
  it("renders labelled controls and a polite result count", async () => {
    const user = userEvent.setup(); render(<DeploymentLogInspector events={events} />);
    const search = screen.getByRole("searchbox", { name: "Search log events" });
    await user.type(search, "build"); await user.selectOptions(screen.getByRole("combobox", { name: "Severity" }), "error");
    expect(screen.getByRole("status").textContent).toBe("Showing 1 of 4 events"); expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });
  it("distinguishes empty and no-match states, then resets", async () => {
    const user = userEvent.setup(); const { unmount } = render(<DeploymentLogInspector events={[]} />);
    expect(screen.getByTestId("log-empty-state")).toBeTruthy(); unmount(); render(<DeploymentLogInspector events={events} />);
    await user.type(screen.getByRole("searchbox", { name: "Search log events" }), "does-not-exist");
    expect(screen.getByTestId("log-no-match-state")).toBeTruthy(); await user.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
  });
  it("renders redacted messages and visible request metadata", () => {
    render(<DeploymentLogInspector events={events} />);
    expect(screen.getByText("Using token [REDACTED]")).toBeTruthy(); expect(screen.getByText("request-40")).toBeTruthy();
  });
});
