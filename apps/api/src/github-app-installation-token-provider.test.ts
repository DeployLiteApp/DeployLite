import { generateKeyPairSync, verify } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { GithubAppInstallationTokenProvider } from "./github-app-installation-token-provider.js";
import { GithubCloudReadAdapter } from "./github-cloud-read-adapter.js";

const now = 1_700_000_000_000;
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const ecPem = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const pssKeyPair = Reflect.apply(generateKeyPairSync, null, ["rsa-pss", { modulusLength: 2048, hash: "sha256" }]) as ReturnType<typeof generateKeyPairSync>;
const pssPem = pssKeyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const binding = { installationId: 42, allowedRepositoryIds: [7, 8] } as const;

function response(body: unknown, status = 201) {
  return new Response(JSON.stringify(body), { status });
}

function makeProvider(fetch: typeof globalThis.fetch, overrides: Record<string, unknown> = {}) {
  return new GithubAppInstallationTokenProvider({ appId: 123, privateKey: pem, trustedInstallationId: 42, allowedRepositoryIds: [7, 8], fetch, now: () => now, ...overrides });
}

describe("GitHub App installation token provider", () => {
  it("signs an RS256 JWT with skewed iat, bounded exp, and app issuer", async () => {
    let request: RequestInit | undefined;
    const provider = makeProvider(async (_, init) => { request = init; return response({ token: "installation-token", expires_at: new Date(now + 3_600_000).toISOString(), repositories: [{ id: 7 }, { id: 8 }], permissions: { contents: "read", metadata: "read" } }); });
    await provider.getInstallationToken(binding);
    const token = String(request?.headers && (request.headers as Record<string, string>).authorization).slice(7);
    const [header, payload, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toMatchObject({ iss: 123, iat: 1_699_999_940, exp: 1_700_000_540 });
    expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
  });

  it("uses the fixed endpoint and readonly scoped payload", async () => {
    let url = ""; let body = "";
    const provider = makeProvider(async (input, init) => { url = String(input); body = String(init?.body); return response({ token: "t", expires_at: new Date(now + 1000).toISOString(), repositories: [{ id: 7 }, { id: 8 }], permissions: { contents: "read", metadata: "read" } }); });
    await provider.getInstallationToken(binding);
    expect(url).toBe("https://api.github.com/app/installations/42/access_tokens");
    expect(JSON.parse(body)).toEqual({ repository_ids: [7, 8], permissions: { contents: "read", metadata: "read" } });
  });

  it("rejects a caller-selected installation or mismatched binding before fetch", async () => {
    let calls = 0;
    const provider = makeProvider(async () => { calls += 1; return response({}); });
    await expect(provider.getInstallationToken({ installationId: 99, allowedRepositoryIds: [7, 8] })).rejects.toThrow("binding");
    await expect(provider.getInstallationToken({ installationId: 42, allowedRepositoryIds: [7] })).rejects.toThrow("binding");
    expect(calls).toBe(0);
  });

  it("rejects encoded or non-integer installation configuration before fetch", async () => {
    expect(() => makeProvider(async () => response({}), { trustedInstallationId: "42%2Fevil" })).toThrow("installation id");
    expect(() => makeProvider(async () => response({}), { trustedInstallationId: 42.5 })).toThrow("installation id");
  });

  it("requires an RSA key and runtime-safe injected options", async () => {
    expect(() => makeProvider(async () => response({}), { privateKey: ecPem })).toThrow("RSA");
    expect(() => makeProvider(async () => response({}), { privateKey: pssPem })).toThrow("RSA");
    expect(() => new GithubAppInstallationTokenProvider(null as never)).toThrow("options");
    expect(() => makeProvider(async () => response({}), { fetch: "not-fetch" })).toThrow("fetch");
    expect(() => makeProvider(async () => response({}), { now: "not-clock" })).toThrow("clock");
    expect(() => makeProvider(async () => response({}), { allowedRepositoryIds: "7" })).toThrow("Repository ids");
    const invalidClock = makeProvider(async () => response({}), { now: () => Infinity });
    await expect(invalidClock.getInstallationToken(binding)).rejects.toThrow("clock");
  });

  it("validates expiry, returned scope, and redacts response secrets", async () => {
    const secret = "body-secret";
    const provider = makeProvider(async () => response({ token: secret, expires_at: "not-a-date", repositories: [{ id: 7 }, { id: 8 }], permissions: { contents: "read", metadata: "read" } }));
    await expect(provider.getInstallationToken(binding)).rejects.toThrow();
    await expect(provider.getInstallationToken(binding)).rejects.not.toThrow(secret);
    const permissions = makeProvider(async () => response({ token: "t", expires_at: new Date(now + 1000).toISOString(), repositories: [{ id: 7 }, { id: 8 }], permissions: { contents: "write", metadata: "read" } }));
    await expect(permissions.getInstallationToken(binding)).rejects.toThrow();
  });

  it("bounds response reads and timeout without calling a real API", async () => {
    const provider = makeProvider(async () => new Response("x".repeat(20)), { maxResponseBytes: 10 });
    await expect(provider.getInstallationToken(binding)).rejects.toThrow();
    const hanging = makeProvider(async () => new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined), cancel: () => new Promise<void>(() => undefined) })), { timeoutMs: 10 });
    await expect(hanging.getInstallationToken(binding)).rejects.toThrow();
    const late = makeProvider(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return response({}); }, { timeoutMs: 5 });
    await expect(late.getInstallationToken(binding)).rejects.toThrow();
  });

  it("rejects a fetch that never settles at the deadline even when it ignores abort", async () => {
    vi.useFakeTimers();
    try {
      let called = false;
      const provider = makeProvider(() => { called = true; return new Promise<Response>(() => undefined); }, { timeoutMs: 5 });
      const pending = provider.getInstallationToken(binding);
      const rejected = expect(pending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(5);
      await rejected;
      expect(called).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("omits repository narrowing when no trusted repository allowlist is configured", async () => {
    let body = "";
    const provider = new GithubAppInstallationTokenProvider({ appId: 123, privateKey: pem, trustedInstallationId: 42, fetch: async (_, init) => { body = String(init?.body); return response({ token: "t", expires_at: new Date(now + 1000).toISOString(), permissions: { contents: "read", metadata: "read" } }); }, now: () => now });
    await provider.getInstallationToken({ installationId: 42, allowedRepositoryIds: [7] });
    expect(JSON.parse(body)).toEqual({ permissions: { contents: "read", metadata: "read" } });
  });

  it("chains exchange into the read adapter with the exchanged token only in headers", async () => {
    const paths: string[] = [];
    const authorizations: string[] = [];
    const token = "fake-installation-token";
    const sha = "a".repeat(40);
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      paths.push(new URL(url).pathname);
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      if (url.endsWith("/access_tokens")) return response({ token, expires_at: new Date(now + 3_600_000).toISOString(), repositories: [{ id: 7 }, { id: 8 }], permissions: { contents: "read", metadata: "read" } });
      if (url.includes("/installation/repositories")) return response({ repositories: [{ id: 7, owner: { login: "acme" }, name: "app", default_branch: "main" }] }, 200);
      if (url.includes("/branches/v1.0.0")) return response({ message: "missing" }, 404);
      if (url.includes("/git/ref/tags/v1.0.0")) return response({ object: { type: "commit", sha } }, 200);
      throw new Error("unexpected URL");
    };
    const provider = makeProvider(fakeFetch);
    const adapter = new GithubCloudReadAdapter({ binding, credentials: provider, fetch: fakeFetch, now: () => now });
    await expect(adapter.resolveRevision({ id: 7, owner: "acme", name: "app", defaultBranch: "main" }, "v1.0.0")).resolves.toEqual({ ref: "v1.0.0", sha, kind: "tag" });
    expect(paths).toEqual(["/app/installations/42/access_tokens", "/installation/repositories", "/app/installations/42/access_tokens", "/repos/acme/app/branches/v1.0.0", "/app/installations/42/access_tokens", "/repos/acme/app/git/ref/tags/v1.0.0"]);
    expect(authorizations.filter((_, index) => paths[index]?.startsWith("/repos") || paths[index] === "/installation/repositories").every((value) => value === `Bearer ${token}`)).toBe(true);
    expect(authorizations[0]).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
    expect(paths.every((path) => !path.includes(token))).toBe(true);
  });
});
