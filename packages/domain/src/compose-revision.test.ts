import { describe, expect, it } from "vitest";
import { createComposePreview, createComposeRevision, InMemoryComposeRevisionRepository, type CreateComposeRevisionInput, type ComposeRevisionRepository } from "./index.js";
import { composeRevisionSchema, type ComposeRevisionV1 } from "@deploylite/contracts";
type Revision = ComposeRevisionV1;
type Input = CreateComposeRevisionInput;
type Repository = ComposeRevisionRepository;
const image = `registry.example.com/team/app@sha256:${"a".repeat(64)}`;
const policy = { policyVersion: "revision-policy-1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true };
const document = JSON.stringify({ services: { web: { image, environment: { TOKEN: "${APP_TOKEN}" } } } });
const preview = createComposePreview(document, "project-1", policy);
const input: Input = { document, projectId: "project-1", composeId: "compose-1", revisionId: "revision-1", revisionNumber: 1, createdBy: "actor-1", createdAt: "2026-10-08T00:00:00Z", expectedPreviewDigest: preview.configDigest };
function create(overrides: Partial<Input> = {}): Revision { return createComposeRevision({ ...input, ...overrides }, policy); }
function repo(): Repository { return new InMemoryComposeRevisionRepository(); }
describe("immutable project-owned Compose revision source boundary", () => {
  it("creates a server-derived preview revision containing references and no runtime permission", () => {
    const revision = create();
    expect(revision.preview).toEqual(preview);
    expect(revision).toMatchObject({ id: "revision-1", projectId: "project-1", composeId: "compose-1", number: 1 });
    expect(revision.preview.executionAllowed).toBe(false);
    expect(JSON.stringify(revision)).not.toContain('"document":');
    expect(revision.preview.services[0]?.secretRefs).toEqual([{ key: "TOKEN", secretRefId: "APP_TOKEN" }]);
  });
  it("stores the same canonical intent from equivalent YAML and JSON", () => {
    expect(create({ document: `services: {web: {image: '${image}', environment: {TOKEN: '\${APP_TOKEN}'}}}` })).toEqual(create());
  });
  it("rejects a stale preview digest without reflecting source", () => {
    expect(() => create({ expectedPreviewDigest: "b".repeat(64) })).toThrow(expect.objectContaining({ code: "COMPOSE_PREVIEW_STALE" }));
  });
  it.each([
    ["cross-project preview", { projectId: "project-2" }],
    ["invalid revision number", { revisionNumber: 0 }],
    ["invalid timestamp", { createdAt: "yesterday" }],
    ["invalid resource ID", { composeId: "../foreign" }],
    ["literal secret", { document: JSON.stringify({ services: { web: { image, environment: { TOKEN: "fixture_literal_secret" } } } }) }]
  ] as const)("rejects %s before exposing a saved revision", (_name, overrides) => {
    let error: unknown;
    try { createComposeRevision({ ...input, ...overrides }, policy); } catch (observed) { error = observed; }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("fixture_literal_secret");
  });
  it("keeps the revision contract closed and prevents project/preview mismatch", () => {
    const revision = create();
    expect(composeRevisionSchema.safeParse(revision).success).toBe(true);
    for (const value of [{ ...revision, rawSource: "fixture_literal_secret" }, { ...revision, projectId: "foreign-project" }, { ...revision, preview: { ...revision.preview, executionAllowed: true } }]) {
      expect(composeRevisionSchema.safeParse(value).success).toBe(false);
    }
  });
  it("rejects literal or duplicate-key canonical source in the stored contract", () => {
    const revision = create();
    for (const canonicalDocument of [JSON.stringify({ services: { web: { image, environment: { TOKEN: "fixture_literal_secret" } } } }), `{"services":{"web":{"image":"fixture_literal_secret","image":"${image}"}}}`]) {
      expect(composeRevisionSchema.safeParse({ ...revision, preview: { ...preview, canonicalDocument } }).success).toBe(false);
    }
  });
  it("stores and reads only under the owning project", async () => {
    const store = repo(); const revision = create();
    expect(await store.appendRevision(revision, null)).toEqual(revision);
    expect(await store.findRevision("project-1", revision.id)).toEqual(revision);
    expect(await store.findRevision("foreign-project", revision.id)).toBeNull();
    expect(await store.findLatestRevision("foreign-project", revision.composeId)).toBeNull();
    expect(await store.listRevisions("foreign-project", revision.composeId, { limit: 10, offset: 0 })).toEqual({ revisions: [], total: 0, limit: 10, offset: 0 });
  });
  it("returns independent copies for caller input and every read/result", async () => {
    const store = repo(), revision = create(); const expected = structuredClone(revision);
    const saved = await store.appendRevision(revision, null);
    revision.preview.services[0]!.image = "caller-input-mutated"; saved.preview.services[0]!.image = "caller-output-mutated";
    const found = (await store.findRevision("project-1", revision.id))!; found.createdBy = "mutated";
    const latest = (await store.findLatestRevision("project-1", revision.composeId))!; latest.number = 99;
    const listed = await store.listRevisions("project-1", revision.composeId, { limit: 10, offset: 0 }); listed.revisions[0]!.preview.services.length = 0;
    expect(await store.findRevision("project-1", revision.id)).toEqual(expected);
  });
  it("replays an identical revision identity without another append or pointer movement", async () => {
    const store = repo(), a = create(), b = create({ revisionId: "revision-2", revisionNumber: 2 });
    await store.appendRevision(a, null); await store.appendRevision(b, a.id);
    expect(await store.appendRevision(a, null)).toEqual(a);
    expect((await store.findLatestRevision(a.projectId, a.composeId))?.id).toBe(b.id);
    expect((await store.listRevisions(a.projectId, a.composeId, { limit: 10, offset: 0 })).total).toBe(2);
  });
  it.each(["createdBy", "createdAt", "composeId", "projectId", "number"] as const)("rejects immutable identity overwrite of %s", async (field) => {
    const store = repo(), revision = create(); await store.appendRevision(revision, null);
    const value = field === "number" ? 2 : field === "createdAt" ? "2026-10-08T00:01:00Z" : "changed";
    await expect(store.appendRevision({ ...revision, [field]: value }, revision.id)).rejects.toThrow();
    expect(await store.findRevision(revision.projectId, revision.id)).toEqual(revision);
  });
  it("appends through an exact latest-revision compare-and-set", async () => {
    const store = repo(), a = create(), b = create({ revisionId: "revision-2", revisionNumber: 2 });
    await store.appendRevision(a, null);
    await expect(store.appendRevision(b, "stale-revision")).rejects.toThrow(expect.objectContaining({ code: "COMPOSE_REVISION_CONFLICT" }));
    expect(await store.findRevision(a.projectId, b.id)).toBeNull();
    expect(await store.appendRevision(b, a.id)).toEqual(b);
  });
  it("lets exactly one competing next revision win atomically", async () => {
    const store = repo(), a = create(); await store.appendRevision(a, null);
    const candidates = [create({ revisionId: "revision-2a", revisionNumber: 2 }), create({ revisionId: "revision-2b", revisionNumber: 2 })];
    const outcomes = await Promise.allSettled(candidates.map((v) => store.appendRevision(v, a.id)));
    expect(outcomes.filter((v) => v.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((v) => v.status === "rejected")).toHaveLength(1);
    expect((await store.listRevisions(a.projectId, a.composeId, { limit: 10, offset: 0 })).total).toBe(2);
  });
  it("rejects skipped revision numbers without reserving the revision identity", async () => {
    const store = repo(), a = create(); await store.appendRevision(a, null);
    await expect(store.appendRevision(create({ revisionId: "revision-2", revisionNumber: 3 }), a.id)).rejects.toThrow();
    expect(await store.appendRevision(create({ revisionId: "revision-2", revisionNumber: 2 }), a.id)).toMatchObject({ number: 2 });
  });
  it("rejects foreign Compose association without writes", async () => {
    const store = repo(), a = create(); await store.appendRevision(a, null);
    const foreignPreview = createComposePreview(document, "foreign-project", policy);
    const foreign = create({ projectId: "foreign-project", revisionId: "revision-foreign", expectedPreviewDigest: foreignPreview.configDigest });
    await expect(store.appendRevision(foreign, null)).rejects.toThrow();
    expect(await store.findRevision("foreign-project", foreign.id)).toBeNull();
  });
  it("pages owned history deterministically with newest revision first", async () => {
    const store = repo(), a = create(), b = create({ revisionId: "revision-2", revisionNumber: 2 }), c = create({ revisionId: "revision-3", revisionNumber: 3 });
    await store.appendRevision(a, null); await store.appendRevision(b, a.id); await store.appendRevision(c, b.id);
    expect(await store.listRevisions(a.projectId, a.composeId, { limit: 1, offset: 1 })).toEqual({ revisions: [b], total: 3, limit: 1, offset: 1 });
  });
  it.each([{ limit: 0, offset: 0 }, { limit: 101, offset: 0 }, { limit: 1.5, offset: 0 }, { limit: 10, offset: -1 }, { limit: 10, offset: 1_000_001 }])("rejects unbounded/invalid pagination %#", async (options) => {
    const store = repo(); await expect(store.listRevisions("project-1", "compose-1", options)).rejects.toThrow();
  });
});
