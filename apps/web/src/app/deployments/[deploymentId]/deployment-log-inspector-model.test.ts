import type { LogEvent } from "@deploylite/contracts";
import { describe, expect, it } from "vitest";
import { filterDeploymentLogEvents } from "./deployment-log-inspector-model.js";

const event = (id: string, level: LogEvent["level"], message: string): LogEvent => ({ id, deploymentId: "deployment-1", sequence: Number(id), level, message, timestamp: `2026-01-01T00:00:${id}.000Z`, redactionApplied: false, requestId: `request-${id}`, correlationId: `correlation-${id}` });
const events = [event("20", "info", "Preparing the deployment"), event("10", "debug", "Resolved build configuration"), event("30", "error", "Build failed"), event("40", "warn", "Using token [REDACTED]")];

describe("filterDeploymentLogEvents", () => {
  it("returns all events for blank query and all severities", () => expect(filterDeploymentLogEvents(events, { query: "  ", severity: "all" })).toEqual(events));
  it("matches messages and visible metadata case-insensitively", () => {
    expect(filterDeploymentLogEvents(events, { query: " BUILD ", severity: "all" }).map(({ id }) => id)).toEqual(["10", "30"]);
    expect(filterDeploymentLogEvents(events, { query: "request-40", severity: "all" }).map(({ id }) => id)).toEqual(["40"]);
  });
  it("supports every severity and combines criteria conjunctively", () => {
    expect(filterDeploymentLogEvents(events, { query: "", severity: "debug" }).map(({ id }) => id)).toEqual(["10"]);
    expect(filterDeploymentLogEvents(events, { query: "build", severity: "error" }).map(({ id }) => id)).toEqual(["30"]);
    expect(filterDeploymentLogEvents(events, { query: "workspace", severity: "error" })).toEqual([]);
  });
  it("preserves source order and object references", () => {
    const filtered = filterDeploymentLogEvents(events, { query: "deployment", severity: "all" });
    expect(filtered.map(({ id }) => id)).toEqual(["20"]);
    expect(filtered[0]).toBe(events[0]);
    expect(events[3]?.message).toContain("[REDACTED]");
  });

  it("searches sequence and timestamp fields without changing the source events", () => {
    expect(filterDeploymentLogEvents(events, { query: "10", severity: "all" }).map(({ id }) => id)).toEqual(["10"]);
    expect(filterDeploymentLogEvents(events, { query: "00:00:30", severity: "all" }).map(({ id }) => id)).toEqual(["30"]);
    expect(events.map(({ id }) => id)).toEqual(["20", "10", "30", "40"]);
  });
});
