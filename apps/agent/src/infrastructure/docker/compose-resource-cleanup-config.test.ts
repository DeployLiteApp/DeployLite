import { describe, expect, it } from "vitest";
import { COMPOSE_RESOURCE_CLEANUP_ENABLED_ENV, parseComposeResourceCleanupEnabled } from "./compose-resource-cleanup-config.js";

describe("Compose resource cleanup runtime flag", () => {
  it("is disabled unless explicitly enabled in a nonproduction runtime", () => {
    expect(COMPOSE_RESOURCE_CLEANUP_ENABLED_ENV).toBe("DEPLOYLITE_COMPOSE_RESOURCE_CLEANUP_ENABLED");
    expect(parseComposeResourceCleanupEnabled(undefined, "test")).toBe(false);
    expect(parseComposeResourceCleanupEnabled("false", "test")).toBe(false);
    expect(parseComposeResourceCleanupEnabled("true", "test")).toBe(true);
  });
  it("rejects malformed or production enablement", () => {
    expect(() => parseComposeResourceCleanupEnabled("yes", "test")).toThrow(/must be true or false/);
    expect(() => parseComposeResourceCleanupEnabled("true", "production")).toThrow(/disabled in production/);
  });
});
