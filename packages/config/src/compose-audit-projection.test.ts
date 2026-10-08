import { describe, expect, it } from "vitest";
import { createSafeProjection } from "./redaction.js";

describe("Compose audit evidence projection", () => {
  it("retains bounded counts and canonical digest while dropping raw input and secrets", () => {
    const digest = "a".repeat(64);
    expect(createSafeProjection("log", { metadata: { projectId: "project-1", inputDigest: digest, serviceCount: 2, networkCount: 1, volumeCount: 1, canonicalDocument: "fixture_inline_secret", document: "fixture_inline_secret", environment: { API_KEY: "fixture_inline_secret" } } })).toEqual({ metadata: { projectId: "project-1", inputDigest: digest, serviceCount: 2, networkCount: 1, volumeCount: 1 } });
  });
  it("drops malformed digest/count evidence across every outward surface", () => {
    for (const surface of ["api", "log", "sse", "mcp", "ai"] as const) {
      expect(createSafeProjection(surface, { inputDigest: "fixture_inline_secret", serviceCount: "fixture_inline_secret", networkCount: -1, volumeCount: 33 })).toEqual({});
    }
  });
});
