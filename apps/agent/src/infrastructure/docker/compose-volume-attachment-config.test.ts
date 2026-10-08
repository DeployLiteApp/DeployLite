import { describe, expect, it } from "vitest";
import { COMPOSE_VOLUME_ATTACHMENT_ENABLED_ENV, parseComposeVolumeAttachmentEnabled } from "./compose-volume-attachment-config.js";

describe("Compose volume replacement runtime flag", () => {
  it("is disabled by default and enables only in a nonproduction environment", () => {
    expect(COMPOSE_VOLUME_ATTACHMENT_ENABLED_ENV).toBe("DEPLOYLITE_COMPOSE_VOLUME_ATTACHMENT_ENABLED");
    expect(parseComposeVolumeAttachmentEnabled(undefined, "test")).toBe(false);
    expect(parseComposeVolumeAttachmentEnabled("false", "test")).toBe(false);
    expect(parseComposeVolumeAttachmentEnabled("true", "test")).toBe(true);
  });
  it("rejects malformed and production enablement", () => {
    expect(() => parseComposeVolumeAttachmentEnabled("yes", "test")).toThrow("must be true or false");
    expect(() => parseComposeVolumeAttachmentEnabled("true", "production")).toThrow("disabled in production");
  });
});
