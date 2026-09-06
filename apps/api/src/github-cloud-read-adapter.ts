const GITHUB_ORIGIN = "https://api.github.com";
const FULL_SHA = /^[0-9a-f]{40}$/;
const NAME = /^[A-Za-z0-9_.-]+$/;
const REF = /^(?!\.)(?!.*\.\.)(?!.*[\s~^:?*\\\[\]])[^\u0000-\u001f\u007f]{1,255}$/;

export type GithubInstallationBinding = Readonly<{
  installationId: number;
  allowedRepositoryIds: readonly number[];
}>;

export type GithubInstallationToken = Readonly<{ token: string; expiresAt: number }>;
export interface GithubInstallationTokenProvider {
  getInstallationToken(binding: GithubInstallationBinding): Promise<GithubInstallationToken>;
}

export type GithubRepository = Readonly<{
  id: number;
  owner: string;
  name: string;
  defaultBranch: string;
}>;
export type GithubBranch = Readonly<{ name: string; sha: string }>;
export type GithubResolvedRevision = Readonly<{ ref: string; sha: string; kind: "branch" | "tag" | "commit" }>;
export type GithubPage<T> = Readonly<{ items: readonly T[]; nextPage: number | null; truncated: boolean }>;

export type GithubCloudReadErrorCode = "unauthorized" | "notfound" | "unavailable" | "invalidinput";
export class GithubCloudReadError extends Error {
  constructor(readonly code: GithubCloudReadErrorCode, message: string) {
    super(message);
    this.name = "GithubCloudReadError";
  }
}

type FetchLike = typeof globalThis.fetch;
type Operation = { requests: number };
type PageOptions = Readonly<{ page?: number; perPage?: number; maxPages?: number; signal?: AbortSignal }>;

function invalid(message: string): never { throw new GithubCloudReadError("invalidinput", message); }
function validateName(value: string, label: string): string {
  if (typeof value !== "string" || !NAME.test(value) || value.length > 100) invalid(`${label} is invalid`);
  return value;
}
function validateRef(value: string): string {
  if (typeof value !== "string" || !REF.test(value)) invalid("Git ref is invalid");
  return value;
}
function validateSha(value: unknown): string {
  if (typeof value !== "string" || !FULL_SHA.test(value)) invalid("GitHub returned an invalid commit SHA");
  return value;
}
function validateRepository(repository: GithubRepository): GithubRepository {
  if (!repository || !Number.isSafeInteger(repository.id) || repository.id < 1) invalid("Repository id is invalid");
  return Object.freeze({ id: repository.id, owner: validateName(repository.owner, "Repository owner"), name: validateName(repository.name, "Repository name"), defaultBranch: validateRef(repository.defaultBranch) });
}
function pathSegment(value: string, label: string): string { return encodeURIComponent(label === "ref" ? validateRef(value) : validateName(value, label)); }
function nextPage(link: string | null, page: number, expectedPath: string): number | null {
  if (!link) return null;
  let found: number | null = null;
  for (const entry of link.split(",")) {
    const match = /^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/.exec(entry);
    if (!match) invalid("GitHub pagination metadata is invalid");
    const target = new URL(match[1]!);
    if (target.origin !== GITHUB_ORIGIN || target.pathname !== expectedPath) invalid("GitHub pagination metadata is invalid");
    const targetPage = target.searchParams.get("page");
    if (match[2] === "next") {
      if (found !== null || !targetPage || !/^\d+$/.test(targetPage) || !Number.isSafeInteger(Number(targetPage)) || Number(targetPage) <= page) invalid("GitHub pagination metadata is invalid");
      found = Number(targetPage);
    }
  }
  return found;
}

export type GithubCloudReadOptions = Readonly<{
  binding: GithubInstallationBinding;
  credentials: GithubInstallationTokenProvider;
  fetch?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
  requestBudget?: number;
  maxRepositoryPages?: number;
  maxResponseBytes?: number;
}>;

/** Internal foundation only: callers must receive this binding from trusted server context. No route accepts tokens or bindings yet. */
export class GithubCloudReadAdapter {
  readonly #binding: GithubInstallationBinding;
  readonly #credentials: GithubInstallationTokenProvider;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #requestBudget: number;
  readonly #maxRepositoryPages: number;
  readonly #maxResponseBytes: number;

  constructor(options: GithubCloudReadOptions) {
    if (!options.binding || !Number.isSafeInteger(options.binding.installationId) || options.binding.installationId < 1 || !options.binding.allowedRepositoryIds.length || options.binding.allowedRepositoryIds.some((id) => !Number.isSafeInteger(id) || id < 1)) invalid("GitHub installation binding is invalid");
    this.#binding = options.binding; this.#credentials = options.credentials; this.#fetch = options.fetch ?? globalThis.fetch; this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? 10_000; this.#requestBudget = options.requestBudget ?? 20; this.#maxRepositoryPages = options.maxRepositoryPages ?? 10; this.#maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || !Number.isSafeInteger(this.#requestBudget) || this.#requestBudget < 1 || !Number.isSafeInteger(this.#maxRepositoryPages) || this.#maxRepositoryPages < 1 || !Number.isSafeInteger(this.#maxResponseBytes) || this.#maxResponseBytes < 1) invalid("GitHub request limits are invalid");
  }

  async listRepositories(options: PageOptions = {}): Promise<GithubPage<GithubRepository>> {
    return this.#listRepositories(options, { requests: 0 });
  }
  async #listRepositories(options: PageOptions, operation: Operation): Promise<GithubPage<GithubRepository>> {
    const page = this.#page(options); const maxPages = options.maxPages ?? 1; const items: GithubRepository[] = [];
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > this.#maxRepositoryPages) invalid("Repository page cap is invalid");
    let current = page; let next: number | null = page.page;
    for (let count = 0; count < maxPages && next !== null; count += 1) {
      const response = await this.#request(`/installation/repositories?per_page=${current.perPage}&page=${next}`, operation, options.signal);
      const body = this.#jsonObject(response.body); const repositories = body.repositories;
      if (!Array.isArray(repositories)) invalid("GitHub repository response is invalid");
      for (const value of repositories) { const repository = this.#parseRepository(value); if (this.#binding.allowedRepositoryIds.includes(repository.id)) items.push(repository); }
      const following = nextPage(response.headers.get("link"), next, "/installation/repositories"); next = following; current = { ...current, page: following ?? current.page };
    }
    return Object.freeze({ items: Object.freeze(items), nextPage: next, truncated: next !== null });
  }

  async listBranches(repositoryInput: GithubRepository, options: PageOptions = {}): Promise<GithubPage<GithubBranch>> {
    const operation: Operation = { requests: 0 }; const repository = await this.#authorizedRepository(repositoryInput, operation, options.signal); const page = this.#page(options); const maxPages = options.maxPages ?? 1;
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > this.#maxRepositoryPages) invalid("Branch page cap is invalid");
    const items: GithubBranch[] = []; let current = page; let next: number | null = page.page;
    for (let count = 0; count < maxPages && next !== null; count += 1) {
      const response = await this.#request(`/repos/${pathSegment(repository.owner, "owner")}/${pathSegment(repository.name, "repo")}/branches?per_page=${current.perPage}&page=${next}`, operation, options.signal);
      if (!Array.isArray(response.body)) invalid("GitHub branch response is invalid");
      items.push(...response.body.map((value: unknown) => this.#parseBranch(value))); const following = nextPage(response.headers.get("link"), next, `/repos/${repository.owner}/${repository.name}/branches`); next = following; current = { ...current, page: following ?? current.page };
    }
    return Object.freeze({ items: Object.freeze(items), nextPage: next, truncated: next !== null });
  }

  async resolveRevision(repositoryInput: GithubRepository, revision: string, signal?: AbortSignal): Promise<GithubResolvedRevision> {
    const ref = validateRef(revision); const operation: Operation = { requests: 0 }; const repository = await this.#authorizedRepository(repositoryInput, operation, signal);
    if (FULL_SHA.test(ref)) { const response = await this.#request(`/repos/${pathSegment(repository.owner, "owner")}/${pathSegment(repository.name, "repo")}/commits/${ref}`, operation, signal); const body = this.#jsonObject(response.body); return Object.freeze({ ref, sha: validateSha(body.sha), kind: "commit" }); }
    try { const response = await this.#request(`/repos/${pathSegment(repository.owner, "owner")}/${pathSegment(repository.name, "repo")}/branches/${pathSegment(ref, "ref")}`, operation, signal); const body = this.#jsonObject(response.body); const commit = this.#jsonObject(body.commit); return Object.freeze({ ref, sha: validateSha(commit.sha), kind: "branch" }); }
    catch (error) { if (!(error instanceof GithubCloudReadError) || error.code !== "notfound") throw error; }
    const tagResponse = await this.#request(`/repos/${pathSegment(repository.owner, "owner")}/${pathSegment(repository.name, "repo")}/git/ref/tags/${pathSegment(ref, "ref")}`, operation, signal); const tag = this.#jsonObject(tagResponse.body); const object = this.#jsonObject(tag.object); const type = object.type;
    if (type === "commit") return Object.freeze({ ref, sha: validateSha(object.sha), kind: "tag" });
    if (type !== "tag") invalid("GitHub tag object type is unsupported");
    const annotated = await this.#request(`/repos/${pathSegment(repository.owner, "owner")}/${pathSegment(repository.name, "repo")}/git/tags/${pathSegment(String(object.sha), "ref")}`, operation, signal); const peeled = this.#jsonObject(annotated.body).object; const peeledObject = this.#jsonObject(peeled);
    if (peeledObject.type !== "commit") invalid("GitHub annotated tag does not point to a commit");
    return Object.freeze({ ref, sha: validateSha(peeledObject.sha), kind: "tag" });
  }

  async #authorizedRepository(input: GithubRepository, operation: Operation, signal?: AbortSignal): Promise<GithubRepository> {
    const repository = validateRepository(input); if (!this.#binding.allowedRepositoryIds.includes(repository.id)) throw new GithubCloudReadError("unauthorized", "Repository is outside the installation scope");
    const listed = await this.#listRepositories({ maxPages: this.#maxRepositoryPages, signal }, operation); if (!listed.items.some((item) => item.id === repository.id)) throw new GithubCloudReadError("unauthorized", "Repository is not available to the installation"); return repository;
  }
  #page(options: PageOptions): { page: number; perPage: number } { const page = options.page ?? 1; const perPage = options.perPage ?? 100; if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(perPage) || perPage < 1 || perPage > 100) invalid("GitHub pagination is invalid"); return { page, perPage }; }
  #parseRepository(value: unknown): GithubRepository { const body = this.#jsonObject(value); const owner = this.#jsonObject(body.owner); return validateRepository({ id: body.id as number, owner: owner.login as string, name: body.name as string, defaultBranch: body.default_branch as string }); }
  #parseBranch(value: unknown): GithubBranch { const body = this.#jsonObject(value); const commit = this.#jsonObject(body.commit); return Object.freeze({ name: validateRef(body.name as string), sha: validateSha(commit.sha) }); }
  #jsonObject(value: unknown): Record<string, any> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid("GitHub response is invalid"); return value as Record<string, any>; }
  async #request(path: string, operation: Operation, signal?: AbortSignal): Promise<{ body: unknown; headers: Headers }> {
    if (++operation.requests > this.#requestBudget) throw new GithubCloudReadError("unavailable", "GitHub request budget exceeded");
    let credentials: GithubInstallationToken; try { credentials = await this.#credentials.getInstallationToken(this.#binding); } catch { throw new GithubCloudReadError("unavailable", "GitHub installation credentials are unavailable"); }
    if (typeof credentials.token !== "string" || credentials.token.trim() === "" || typeof credentials.expiresAt !== "number" || !Number.isFinite(credentials.expiresAt) || credentials.expiresAt <= this.#now()) throw new GithubCloudReadError("unauthorized", "GitHub installation credentials are expired or unavailable");
    const controller = new AbortController(); let timedOut = false; const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.#timeoutMs); const cancel = () => controller.abort(); signal?.addEventListener("abort", cancel, { once: true });
    try { const response = await this.#fetch(`${GITHUB_ORIGIN}${path}`, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${credentials.token}` }, redirect: "error", signal: controller.signal }); if (response.status === 401 || response.status === 403) throw new GithubCloudReadError("unauthorized", "GitHub denied installation access"); if (response.status === 404) throw new GithubCloudReadError("notfound", "GitHub resource was not found"); if (!response.ok) throw new GithubCloudReadError(response.status >= 500 || response.status === 429 ? "unavailable" : "invalidinput", "GitHub read request failed"); const body = await this.#readJson(response, controller); return { body, headers: response.headers }; }
    catch (error) { if (error instanceof GithubCloudReadError) throw error; throw new GithubCloudReadError(timedOut ? "unavailable" : "unavailable", "GitHub read request was unavailable"); } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
  }
  async #readJson(response: Response, controller: AbortController): Promise<unknown> {
    if (!response.body) throw new GithubCloudReadError("invalidinput", "GitHub response body is invalid");
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    let aborted = false; let rejectAbort: (error: GithubCloudReadError) => void = () => undefined; const abortPromise = new Promise<never>((_, reject) => { rejectAbort = reject; }); abortPromise.catch(() => undefined); const abort = () => { aborted = true; rejectAbort(new GithubCloudReadError("unavailable", "GitHub read request was unavailable")); void reader.cancel().catch(() => undefined); }; controller.signal.addEventListener("abort", abort, { once: true });
    try { while (true) { const result = await Promise.race([reader.read(), abortPromise]); if (result.done) break; size += result.value.byteLength; if (size > this.#maxResponseBytes) { void reader.cancel().catch(() => undefined); controller.abort(); throw new GithubCloudReadError("invalidinput", "GitHub response is too large"); } chunks.push(result.value); } if (aborted) throw new GithubCloudReadError("unavailable", "GitHub read request was unavailable"); const text = new TextDecoder().decode(Uint8Array.from(chunks.flatMap((chunk) => [...chunk]))); try { return JSON.parse(text); } catch { throw new GithubCloudReadError("invalidinput", "GitHub response JSON is invalid"); } }
    catch (error) { if (error instanceof GithubCloudReadError) throw error; void reader.cancel().catch(() => undefined); throw error; } finally { controller.signal.removeEventListener("abort", abort); reader.releaseLock(); }
  }
}
