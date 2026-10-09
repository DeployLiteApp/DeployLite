import { describe, expect, it } from "vitest";
import { composeResourceAttachmentCommandSchema } from "./resource-attachment-command.js";

const request = {
  schemaVersion: 1,
  action: "project.update",
  scope: { kind: "project", projectId: "project-1" },
  operation: "compose.resource.attachment",
  idempotencyKey: "attach-once",
  correlationId: "corr-1",
  projectId: "project-1",
  kind: "network",
  key: "backend",
  service: "api",
  attachmentAction: "attach",
  runtimeName: `dl-${"d".repeat(32)}-net-backend`,
  alreadySatisfied: false,
  configDigest: "a".repeat(64),
  stateDigest: "b".repeat(64),
  containerId: "c".repeat(64)
} as const;

describe("project-scoped Compose attachment command contract", () => {
  it("binds one reviewed attachment to the existing project.update command scope", () => {
    expect(composeResourceAttachmentCommandSchema.parse(request)).toEqual(request);
  });

  it.each([
    ["action", { ...request, action: "project.delete" }],
    ["scope", { ...request, scope: { kind: "project", projectId: "project-2" } }],
    ["digest", { ...request, stateDigest: "not-a-digest" }],
    ["caller execution flag", { ...request, executionAllowed: true }]
    , ["volume application", { ...request, kind: "volume" }]
  ])("rejects mismatched %s", (_name, value) => {
    expect(composeResourceAttachmentCommandSchema.safeParse(value).success).toBe(false);
  });
});
