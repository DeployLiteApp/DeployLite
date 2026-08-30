import { describe, expect, it } from "vitest";

import { admitControlPlaneRequest, deployLiteEnvSchema, parseDeployLiteEnv } from "./env.js";

function createEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...overrides };
}

describe("parseDeployLiteEnv", () => {
  it("applies documented defaults without secret-bearing input", () => {
    const input = createEnv();
    const parsed = parseDeployLiteEnv(input);

    expect(parsed).toMatchObject({
      NODE_ENV: "development",
      DEPLOYLITE_API_URL: "http://localhost:3001",
      DEPLOYLITE_API_HOST: "127.0.0.1",
      DEPLOYLITE_API_PORT: 3001,
      DEPLOYLITE_SESSION_TTL_SECONDS: 28_800,
      DEPLOYLITE_SESSION_COOKIE_NAME: "deploylite_session",
      DEPLOYLITE_BCRYPT_COST: 12
    });
    expect(input).not.toHaveProperty("DEPLOYLITE_SECRET_KEY");
  });

  it("preserves valid overrides and coerces environment-style numbers", () => {
    const parsed = parseDeployLiteEnv(
      createEnv({
        NODE_ENV: "production",
        DEPLOYLITE_API_URL: "https://api.example.test",
        DEPLOYLITE_CORS_ORIGIN: "https://console.example.test",
        DEPLOYLITE_API_HOST: "0.0.0.0",
        DEPLOYLITE_API_PORT: "8443",
        DEPLOYLITE_SESSION_TTL_SECONDS: "900",
        DEPLOYLITE_SESSION_COOKIE_NAME: "session_id",
        DEPLOYLITE_SESSION_COOKIE_SECURE: "TrUe",
        DEPLOYLITE_BCRYPT_COST: "13"
      })
    );

    expect(parsed).toMatchObject({
      NODE_ENV: "production",
      DEPLOYLITE_API_URL: "https://api.example.test",
      DEPLOYLITE_CORS_ORIGIN: "https://console.example.test",
      DEPLOYLITE_API_HOST: "0.0.0.0",
      DEPLOYLITE_API_PORT: 8443,
      DEPLOYLITE_SESSION_TTL_SECONDS: 900,
      DEPLOYLITE_SESSION_COOKIE_NAME: "session_id",
      DEPLOYLITE_SESSION_COOKIE_SECURE: true,
      DEPLOYLITE_BCRYPT_COST: 13
    });
  });

  it.each([
    ["minimum port", "1"],
    ["maximum port", "65535"]
  ])("accepts the %s boundary", (_label, port) => {
    const parsed = parseDeployLiteEnv(createEnv({ DEPLOYLITE_API_PORT: port }));

    expect(parsed.DEPLOYLITE_API_PORT).toBe(Number(port));
  });

  it.each([
    ["minimum bcrypt cost", "10"],
    ["maximum bcrypt cost", "14"]
  ])("accepts the %s boundary", (_label, cost) => {
    const parsed = parseDeployLiteEnv(createEnv({ DEPLOYLITE_BCRYPT_COST: cost }));

    expect(parsed.DEPLOYLITE_BCRYPT_COST).toBe(Number(cost));
  });

  it.each([
    ["true", true],
    ["FALSE", false]
  ])("coerces secure-cookie %s case-insensitively", (value, expected) => {
    const parsed = parseDeployLiteEnv(
      createEnv({ DEPLOYLITE_SESSION_COOKIE_SECURE: value })
    );

    expect(parsed.DEPLOYLITE_SESSION_COOKIE_SECURE).toBe(expected);
  });

  it.each([
    ["malformed API URL", { DEPLOYLITE_API_URL: "not-a-url" }],
    ["malformed CORS URL", { DEPLOYLITE_CORS_ORIGIN: "not-a-url" }],
    ["zero port", { DEPLOYLITE_API_PORT: "0" }],
    ["oversized port", { DEPLOYLITE_API_PORT: "65536" }],
    ["fractional port", { DEPLOYLITE_API_PORT: "1.5" }],
    ["low bcrypt cost", { DEPLOYLITE_BCRYPT_COST: "9" }],
    ["high bcrypt cost", { DEPLOYLITE_BCRYPT_COST: "15" }],
    ["zero TTL", { DEPLOYLITE_SESSION_TTL_SECONDS: "0" }],
    ["negative TTL", { DEPLOYLITE_SESSION_TTL_SECONDS: "-1" }],
    ["fractional TTL", { DEPLOYLITE_SESSION_TTL_SECONDS: "1.5" }],
    ["unsupported secure-cookie value", { DEPLOYLITE_SESSION_COOKIE_SECURE: "yes" }],
    ["empty API host", { DEPLOYLITE_API_HOST: "" }],
    ["empty cookie name", { DEPLOYLITE_SESSION_COOKIE_NAME: "" }]
  ])("rejects %s", (_label, overrides) => {
    const result = deployLiteEnvSchema.safeParse(createEnv(overrides));

    expect(result.success).toBe(false);
  });

  it("is deterministic and does not mutate the supplied environment", () => {
    const input = createEnv({
      DEPLOYLITE_API_PORT: "3002",
      DEPLOYLITE_SESSION_TTL_SECONDS: "120",
      DEPLOYLITE_SESSION_COOKIE_SECURE: "false"
    });
    const snapshot = { ...input };

    const first = parseDeployLiteEnv(input);
    const second = parseDeployLiteEnv(input);

    expect(second).toEqual(first);
    expect(input).toEqual(snapshot);
  });

const env = parseDeployLiteEnv({
  DEPLOYLITE_REPOSITORY_ALLOWLIST: "github.com",
  DEPLOYLITE_IMAGE_ALLOWLIST: "ghcr.io",
  DEPLOYLITE_ADMISSION_MAX_PAYLOAD_BYTES: "100",
  DEPLOYLITE_ADMISSION_MAX_RATE_PER_MINUTE: "2",
  DEPLOYLITE_ADMISSION_MAX_CONCURRENCY: "1",
  DEPLOYLITE_ADMISSION_MAX_CPU_CORES: "2",
  DEPLOYLITE_ADMISSION_MAX_MEMORY_MIB: "512"
});

describe("control-plane admission", () => {
  it("canonicalizes allowed references and admits a bounded request", () => {
    expect(admitControlPlaneRequest(env, {
      repositoryUrl: "HTTPS://GitHub.com/owner/repo.git",
      image: "ghcr.io/owner/app:v1",
      payloadBytes: 100,
      ratePerMinute: 2,
      concurrentCommands: 1,
      cpuCores: 2,
      memoryMiB: 512
    })).toEqual({ repositoryUrl: "https://github.com/owner/repo", image: "ghcr.io/owner/app:v1" });
  });

  it("rejects private repositories, mutable production images, and each exceeded limit deterministically", () => {
    const base = { repositoryUrl: "https://github.com/owner/repo", image: "ghcr.io/owner/app:latest", payloadBytes: 1, ratePerMinute: 1, concurrentCommands: 1, cpuCores: 1, memoryMiB: 1 };
    expect(() => admitControlPlaneRequest(env, { ...base, repositoryUrl: "http://127.0.0.1/repo" })).toThrow("REPOSITORY_DENIED");
    expect(() => admitControlPlaneRequest({ ...env, NODE_ENV: "production" }, base)).toThrow("IMAGE_MUTABLE_TAG");
    expect(() => admitControlPlaneRequest(env, { ...base, image: "ghcr.io/owner/app:v1", payloadBytes: 101 })).toThrow("PAYLOAD_LIMIT_EXCEEDED");
    expect(() => admitControlPlaneRequest(env, { ...base, image: "ghcr.io/owner/app:v1", ratePerMinute: 3 })).toThrow("RATE_LIMIT_EXCEEDED");
    expect(() => admitControlPlaneRequest(env, { ...base, image: "ghcr.io/owner/app:v1", concurrentCommands: 2 })).toThrow("CONCURRENCY_LIMIT_EXCEEDED");
    expect(() => admitControlPlaneRequest(env, { ...base, image: "ghcr.io/owner/app:v1", cpuCores: 3 })).toThrow("RESOURCE_LIMIT_EXCEEDED");
  });
});

});
