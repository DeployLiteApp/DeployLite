import { describe, expect, it } from "vitest";
import {
  GithubCloudReadAdapter,
  type GithubCloudReadOptions,
  type GithubInstallationBinding
} from "./github-cloud-read-adapter.js";

const binding: GithubInstallationBinding = { installationId: 42, allowedRepositoryIds: [7] };
const repository = { id: 7, owner: "acme", name: "app", defaultBranch: "main" };
const sha = "a".repeat(40);
const repositoryPayload = () => ({ repositories: [{ id: 7, owner: { login: "acme" }, name: "app", default_branch: "main" }] });

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function makeAdapter(fetch: typeof globalThis.fetch, overrides: Partial<GithubCloudReadOptions> = {}) {
  return new GithubCloudReadAdapter({
    binding,
    credentials: { getInstallationToken: async () => ({ token: "test-installation-token", expiresAt: 10_000 }) },
    fetch,
    now: () => 1_000,
    ...overrides
  });
}

describe("GitHub cloud read adapter", () => {
  it("uses the fixed origin and reports a bounded first page as truncated", async () => {
    let request: RequestInit | undefined;
    let url = "";
    const client = makeAdapter(async (input, init) => {
      url = String(input); request = init;
      return jsonResponse(repositoryPayload(), 200, { link: '<https://api.github.com/installation/repositories?page=2>; rel="next"' });
    });
    await expect(client.listRepositories()).resolves.toMatchObject({ items: [repository], nextPage: 2, truncated: true });
    expect(url).toBe("https://api.github.com/installation/repositories?per_page=100&page=1");
    expect(request?.redirect).toBe("error");
  });

  it("follows only validated numeric pages and honors maxPages", async () => {
    const urls: string[] = [];
    const client = makeAdapter(async (input) => {
      urls.push(String(input));
      return jsonResponse(repositoryPayload(), 200, urls.length === 1 ? { link: '<https://api.github.com/installation/repositories?page=2>; rel="next"' } : {});
    });
    await expect(client.listRepositories({ maxPages: 2 })).resolves.toMatchObject({ items: [repository, repository], nextPage: null, truncated: false });
    expect(urls[1]).toContain("page=2");
  });

  it("enforces request budget across one paginated operation", async () => {
    let calls = 0;
    const client = makeAdapter(async () => {
      calls += 1;
      return jsonResponse(repositoryPayload(), 200, { link: '<https://api.github.com/installation/repositories?page=2>; rel="next"' });
    }, { requestBudget: 1 });
    await expect(client.listRepositories({ maxPages: 2 })).rejects.toMatchObject({ code: "unavailable" });
    expect(calls).toBe(1);
  });

  it.each([NaN, Infinity, -Infinity, 0, -1, 1.5, "2"])("rejects invalid maxPages value %s before network access", async (maxPages) => {
    let called = false;
    const client = makeAdapter(async () => { called = true; return jsonResponse(repositoryPayload()); });
    await expect(client.listRepositories({ maxPages } as never)).rejects.toMatchObject({ code: "invalidinput" });
    expect(called).toBe(false);
  });

  it("rejects malformed repository and ref input before network access", async () => {
    let called = false;
    const client = makeAdapter(async () => { called = true; return jsonResponse(repositoryPayload()); });
    await expect(client.listBranches({ ...repository, owner: "acme/evil" })).rejects.toMatchObject({ code: "invalidinput" });
    await expect(client.resolveRevision(repository, "bad ref")).rejects.toMatchObject({ code: "invalidinput" });
    expect(called).toBe(false);
  });

  it("rejects empty tokens, non-finite expiry, and expired credentials without leaks", async () => {
    for (const credentials of [
      { token: "", expiresAt: 10_000 },
      { token: "   ", expiresAt: 10_000 },
      { token: undefined, expiresAt: 10_000 },
      { token: "secret-token", expiresAt: NaN },
      { token: "secret-token", expiresAt: Infinity },
      { token: "secret-token", expiresAt: -Infinity },
      { token: "secret-token", expiresAt: 999 }
    ]) {
      const client = makeAdapter(async () => jsonResponse(repositoryPayload()), { credentials: { getInstallationToken: async () => credentials } as never });
      const result = client.listRepositories();
      await expect(result).rejects.toMatchObject({ code: "unauthorized" });
      await expect(result).rejects.not.toThrow("secret-token");
    }
  });

  it("normalizes invalid JSON and oversized bodies without exposing body content", async () => {
    const invalidJson = makeAdapter(async () => new Response('{"token":"body-secret"'));
    const invalidResult = invalidJson.listRepositories();
    await expect(invalidResult).rejects.toMatchObject({ code: "invalidinput" });
    await expect(invalidResult).rejects.not.toThrow("body-secret");
    const oversized = makeAdapter(async () => new Response("x".repeat(101)), { maxResponseBytes: 100 });
    await expect(oversized.listRepositories()).rejects.toMatchObject({ code: "invalidinput" });
  });

  it("times out a hanging response body and cancels its reader", async () => {
    let canceled = false;
    const client = makeAdapter(async () => new Response(new ReadableStream<Uint8Array>({
      pull() { return new Promise<void>(() => undefined); },
      cancel() { canceled = true; return new Promise<void>(() => undefined); }
    })), { timeoutMs: 10 });
    await expect(client.listRepositories()).rejects.toMatchObject({ code: "unavailable" });
    expect(canceled).toBe(true);
  });

  it.each([
    '<https://evil.example/installation/repositories?page=2>; rel="next"',
    '<https://api.github.com/installation/repositories?page=1>; rel="next"',
    '<https://api.github.com/installation/repositories?page=2>; rel="next", <https://api.github.com/installation/repositories?page=3>; rel="next"',
    "not-a-link"
  ])("rejects unsafe or malformed Link header %s", async (link) => {
    const client = makeAdapter(async () => jsonResponse(repositoryPayload(), 200, { link }));
    await expect(client.listRepositories()).rejects.toMatchObject({ code: "invalidinput" });
  });

  it("lists a branch continuation page with explicit bounded pagination", async () => {
    const urls: string[] = [];
    const client = makeAdapter(async (input) => {
      urls.push(String(input));
      if (urls.length === 1) return jsonResponse(repositoryPayload());
      if (urls.length === 2) return jsonResponse([{ name: "main", commit: { sha } }], 200, { link: '<https://api.github.com/repos/acme/app/branches?page=2>; rel="next"' });
      return jsonResponse([{ name: "release", commit: { sha: "b".repeat(40) } }]);
    });
    await expect(client.listBranches(repository, { maxPages: 2 })).resolves.toMatchObject({
      items: [{ name: "main", sha }, { name: "release", sha: "b".repeat(40) }], nextPage: null, truncated: false
    });
    expect(urls[2]).toContain("/branches?per_page=100&page=2");
  });

  it("resolves full commit SHAs only after installation access verification", async () => {
    const paths: string[] = [];
    const client = makeAdapter(async (input) => {
      paths.push(new URL(String(input)).pathname);
      return paths.length === 1 ? jsonResponse(repositoryPayload()) : jsonResponse({ sha });
    });
    await expect(client.resolveRevision(repository, sha)).resolves.toEqual({ ref: sha, sha, kind: "commit" });
    expect(paths[1]).toBe(`/repos/acme/app/commits/${sha}`);
  });

  it("peels annotated tags and rejects unsupported tag objects safely", async () => {
    let count = 0;
    const client = makeAdapter(async () => {
      count += 1;
      if (count === 1) return jsonResponse(repositoryPayload());
      if (count === 2) return jsonResponse({ message: "missing" }, 404);
      if (count === 3) return jsonResponse({ object: { type: "tag", sha: "b".repeat(40) } });
      return jsonResponse({ object: { type: "commit", sha } });
    });
    await expect(client.resolveRevision(repository, "v1.0.0")).resolves.toEqual({ ref: "v1.0.0", sha, kind: "tag" });
    let unsupportedCount = 0;
    const unsupported = makeAdapter(async () => {
      unsupportedCount += 1;
      return unsupportedCount === 1 ? jsonResponse(repositoryPayload()) : jsonResponse({ object: { type: "tree", sha } });
    });
    await expect(unsupported.resolveRevision(repository, "v1")).rejects.toMatchObject({ code: "invalidinput" });
  });
});
