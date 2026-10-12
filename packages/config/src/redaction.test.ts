import { describe, expect, it } from "vitest";
import { createAuditLogRecord } from "./audit.js";
import { createSafeProjection, redactLogMessage, redactSecrets } from "./redaction.js";

describe("redaction helpers", () => {
  it("masks secret-like object keys recursively", () => {
    const redacted = redactSecrets({
      user: "admin@example.test",
      nested: { apiKey: "dl_fixture_token_1234567890abcdef" },
      password: "test_fixture_password_value"
    });

    expect(redacted).toEqual({
      user: "admin@example.test",
      nested: { apiKey: "[REDACTED]" },
      password: "[REDACTED]"
    });
  });

  it("masks token-like values inside log messages", () => {
    expect(redactLogMessage("using token dl_fixture_token_1234567890abcdef for deploy")).toBe(
      "using token [REDACTED] for deploy"
    );
  });

  it("redacts URL userinfo while preserving the URL destination", () => {
    const value = "Pull https://deploy:super-secret@example.test:8443/path?ref=main and ssh://git@example.test/repo.git";

    expect(redactSecrets(value)).toBe(
      "Pull https://[REDACTED]@example.test:8443/path?ref=main and ssh://[REDACTED]@example.test/repo.git"
    );
  });

  it("redacts all multi-at URL userinfo while preserving the authority destination", () => {
    const value = "Pull https://deploy:super@secret@example.test:8443/path?ref=main and ssh://git@service@example.test/repo.git";

    expect(redactSecrets(value)).toBe(
      "Pull https://[REDACTED]@example.test:8443/path?ref=main and ssh://[REDACTED]@example.test/repo.git"
    );
  });

  it("preserves non-URL text containing an at sign", () => {
    expect(redactSecrets("Contact deploy@example.test and deploy@support@example.test; this is not a URL.")).toBe(
      "Contact deploy@example.test and deploy@support@example.test; this is not a URL."
    );
  });

  it("redacts audit metadata before serialization", () => {
    const record = createAuditLogRecord({
      actorId: "scaffold-user",
      action: "deployment.read",
      targetType: "deployment",
      targetId: "dep_1",
      requestId: "req_1",
      correlationId: "req_1",
      metadata: { authorization: "Bearer dl_fixture_token_1234567890abcdef" }
    });

    expect(record.metadata).toEqual({});
  });

  it("preserves non-reversible identifiers such as hex fingerprints, checksums, and UUIDs", () => {
    const fingerprint = "abcdef0123456789abcdef0123456789";
    const checksum = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    const uuid = "123e4567-e89b-12d3-a456-426614174000";

    const redacted = redactSecrets({
      valueFingerprint: fingerprint,
      valueChecksum: checksum,
      sha256: checksum,
      deploymentId: uuid,
      unrelated: "x".repeat(64)
    });

    expect(redacted).toEqual({
      valueFingerprint: fingerprint,
      valueChecksum: checksum,
      sha256: checksum,
      deploymentId: uuid,
      unrelated: "[REDACTED]"
    });
  });

  it("omits unclassified secret-bearing fields for every external projection surface", () => {
    for (const surface of ["api", "log", "sse", "mcp", "ai"] as const) {
      const projected = createSafeProjection(surface, {
        requestId: "req_1",
        correlationId: "req_1",
        action: "deployment.read",
        token: "dl_fixture_token_1234567890abcdef",
        environment: { DATABASE_URL: "postgres://test_fixture_user:test_fixture_password@fixture.invalid/test_fixture_database" },
        certificate: "-----BEGIN PRIVATE KEY-----"
      });

      expect(projected).toEqual({ requestId: "req_1", correlationId: "req_1", action: "deployment.read" });
    }
  });
});
for(const key of ["password","passwd","api_key","apiKey","cookie","credential","AUTHORIZATION","DATABASE_PASSWORD","REDIS_PASSWORD","MONGO_INITDB_ROOT_PASSWORD"])it(`redacts short labelled ${key} values from public logs`,()=>{for(const input of [`${key}=tiny-private`, `"${key}":"tiny private"`,`${key}='tiny private'`]){const output=redactLogMessage(input);expect(output).not.toContain("tiny");expect(output).toContain("[REDACTED]");}});
it("normalizes terminal controls before redacting split credentials",()=>{const output=redactLogMessage("a".repeat(32)+"\u001b[31m"+"b".repeat(32)+"\u001b[0m\nready\u0000");expect(output).toBe("[REDACTED]\nready");});
it("preserves labelled log delimiters and redaction idempotence",()=>{for(const message of ['{"password":"tiny"}',"password=tiny}","password=[REDACTED]tail"]){const once=redactLogMessage(message);expect(redactLogMessage(once)).toBe(once);expect(once).not.toContain("tiny");expect(once).not.toContain("tail");}expect(redactLogMessage('{"password":"tiny"}')).toBe('{"password":"[REDACTED]"}');});
