import { createPrivateKey, sign } from "node:crypto";

import type { GithubInstallationBinding, GithubInstallationToken, GithubInstallationTokenProvider } from "./github-cloud-read-adapter.js";

const GITHUB_ORIGIN = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const CLOCK_SKEW_SECONDS = 60;
const MAX_JWT_LIFETIME_SECONDS = 600;

export type GithubAppTokenPermissions = Readonly<{ contents: "read"; metadata: "read" }>;
export type GithubAppInstallationTokenProviderOptions = Readonly<{
  appId: number;
  privateKey: string;
  trustedInstallationId: number;
  allowedRepositoryIds?: readonly number[];
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  timeoutMs?: number;
  maxResponseBytes?: number;
}>;

export class GithubAppTokenProviderError extends Error {
  constructor(message = "GitHub installation token request failed") {
    super(message);
    this.name = "GithubAppTokenProviderError";
  }
}

function invalid(message = "GitHub installation token response is invalid"): never {
  throw new GithubAppTokenProviderError(message);
}

function validateId(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) invalid(`${label} is invalid`);
  return value;
}

function base64url(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function readJson(response: Response, signal: AbortSignal, maxBytes: number): Promise<unknown> {
  if (!response.body) throw new GithubAppTokenProviderError();
  if (signal.aborted) throw new GithubAppTokenProviderError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  return (async () => {
    let aborted = false;
    let rejectAbort: (error: GithubAppTokenProviderError) => void = () => undefined;
    const abortPromise = new Promise<never>((_, reject) => { rejectAbort = reject; });
    abortPromise.catch(() => undefined);
    const abort = () => { aborted = true; rejectAbort(new GithubAppTokenProviderError()); void reader.cancel().catch(() => undefined); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      while (true) {
        const result = await Promise.race([
          reader.read(),
          abortPromise
        ]);
        if (result.done) break;
        size += result.value.byteLength;
        if (size > maxBytes) throw new GithubAppTokenProviderError();
        chunks.push(result.value);
      }
      try {
        return JSON.parse(new TextDecoder().decode(Uint8Array.from(chunks.flatMap((chunk) => [...chunk]))));
      } catch {
        throw new GithubAppTokenProviderError();
      }
    } finally {
      signal.removeEventListener("abort", abort);
      reader.releaseLock();
      if (aborted) throw new GithubAppTokenProviderError();
    }
  })();
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function jsonId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid();
  return value;
}

function validateRepositoryIds(value: readonly number[]): readonly number[] {
  const ids = value.map((id) => validateId(id, "Repository id"));
  if (!ids.length || new Set(ids).size !== ids.length) invalid("Repository ids are invalid");
  return Object.freeze(ids);
}

/** Trusted server-side configuration only. The request binding cannot select an installation. */
export class GithubAppInstallationTokenProvider implements GithubInstallationTokenProvider {
  readonly #appId: number;
  readonly #privateKey: ReturnType<typeof createPrivateKey>;
  readonly #installationId: number;
  readonly #repositoryIds: readonly number[] | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;

  constructor(options: GithubAppInstallationTokenProviderOptions) {
    if (!options || typeof options !== "object") invalid("GitHub App provider options are invalid");
    this.#appId = validateId(options.appId, "GitHub App id");
    this.#installationId = validateId(options.trustedInstallationId, "GitHub installation id");
    if (options.allowedRepositoryIds !== undefined && !Array.isArray(options.allowedRepositoryIds)) invalid("Repository ids are invalid");
    this.#repositoryIds = options.allowedRepositoryIds ? validateRepositoryIds(options.allowedRepositoryIds) : undefined;
    if (options.fetch !== undefined && typeof options.fetch !== "function") invalid("GitHub fetch implementation is invalid");
    if (options.now !== undefined && typeof options.now !== "function") invalid("GitHub clock implementation is invalid");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    if (typeof this.#fetch !== "function") invalid("GitHub fetch implementation is invalid");
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || !Number.isSafeInteger(this.#maxResponseBytes) || this.#maxResponseBytes < 1) invalid("GitHub request limits are invalid");
    let key: ReturnType<typeof createPrivateKey>;
    try {
      key = createPrivateKey(options.privateKey);
    } catch {
      throw new GithubAppTokenProviderError("GitHub App private key is invalid");
    }
    if (key.asymmetricKeyType !== "rsa") invalid("GitHub App private key must be RSA");
    this.#privateKey = key;
  }

  async getInstallationToken(binding: GithubInstallationBinding): Promise<GithubInstallationToken> {
    if (!binding || typeof binding !== "object" || binding.installationId !== this.#installationId || !Array.isArray(binding.allowedRepositoryIds) || binding.allowedRepositoryIds.some((id) => !Number.isSafeInteger(id) || id < 1)) invalid("GitHub installation binding is invalid");
    const bindingIds = [...binding.allowedRepositoryIds];
    if (this.#repositoryIds && (bindingIds.length !== this.#repositoryIds.length || bindingIds.some((id, index) => id !== this.#repositoryIds?.[index]))) invalid("GitHub installation binding is invalid");
    const nowMilliseconds = this.#now();
    if (typeof nowMilliseconds !== "number" || !Number.isFinite(nowMilliseconds)) invalid("GitHub clock is invalid");
    const nowSeconds = Math.floor(nowMilliseconds / 1000);
    if (!Number.isSafeInteger(nowSeconds)) invalid("GitHub clock is invalid");
    const iat = nowSeconds - CLOCK_SKEW_SECONDS;
    const exp = iat + MAX_JWT_LIFETIME_SECONDS;
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = base64url(JSON.stringify({ iat, exp, iss: this.#appId }));
    const unsigned = `${header}.${payload}`;
    let jwt: string;
    try {
      jwt = `${unsigned}.${base64url(sign("RSA-SHA256", Buffer.from(unsigned), this.#privateKey))}`;
    } catch {
      throw new GithubAppTokenProviderError();
    }
    const controller = new AbortController();
    let rejectDeadline: (error: GithubAppTokenProviderError) => void = () => undefined;
    const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
    deadline.catch(() => undefined);
    const timer = setTimeout(() => { controller.abort(); rejectDeadline(new GithubAppTokenProviderError()); }, this.#timeoutMs);
    const payloadBody = { ...(this.#repositoryIds ? { repository_ids: this.#repositoryIds } : {}), permissions: { contents: "read", metadata: "read" } };
    try {
      const response = await Promise.race([this.#fetch(`${GITHUB_ORIGIN}/app/installations/${this.#installationId}/access_tokens`, {
        method: "POST",
        headers: { accept: "application/vnd.github+json", "content-type": "application/json", "x-github-api-version": GITHUB_API_VERSION, authorization: `Bearer ${jwt}` },
        body: JSON.stringify(payloadBody),
        redirect: "error",
        signal: controller.signal
      }), deadline]);
      if (controller.signal.aborted) throw new GithubAppTokenProviderError();
      const body = await readJson(response, controller.signal, this.#maxResponseBytes);
      if (!response.ok) throw new GithubAppTokenProviderError();
      return this.#parseToken(body, nowSeconds);
    } catch (error) {
      if (error instanceof GithubAppTokenProviderError) throw error;
      throw new GithubAppTokenProviderError();
    } finally {
      clearTimeout(timer);
    }
  }

  #parseToken(value: unknown, nowSeconds: number): GithubInstallationToken {
    const body = jsonObject(value);
    if (typeof body.token !== "string" || body.token.trim() === "") invalid();
    if (typeof body.expires_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(body.expires_at)) invalid();
    const expiresAt = Date.parse(body.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= nowSeconds * 1000) invalid();
    if (this.#repositoryIds) {
      if (!Array.isArray(body.repositories)) invalid();
      const returnedIds = body.repositories.map((repository) => jsonId(jsonObject(repository).id));
      if (returnedIds.length !== new Set(returnedIds).size || returnedIds.length !== this.#repositoryIds.length || this.#repositoryIds.some((id) => !returnedIds.includes(id))) invalid();
    }
    const permissions = jsonObject(body.permissions);
    if (Object.keys(permissions).some((key) => key !== "contents" && key !== "metadata") || permissions.contents !== "read" || permissions.metadata !== "read") invalid();
    return Object.freeze({ token: body.token, expiresAt });
  }
}
