import { describe, expect, it } from "vitest";
import * as domain from "./index.js";
import { prepareComposeRevisionSave, InMemoryComposeRevisionSaveStore, type PreparedComposeRevisionSave as Prepared, type PrepareComposeRevisionSaveInput as Input } from "./compose-revision-save.js";
import type { ControlCommand } from "./control-plane.js";

const image = `registry.example.com/team/app@sha256:${"a".repeat(64)}`;
const policy = { policyVersion: "compose-save-fixture", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true };
const document = JSON.stringify({ services: { web: { image, environment: { TOKEN: "${APP_TOKEN}" } } } });
const now = new Date("2026-10-08T04:00:00Z");
function prepare(overrides: Partial<Input> = {}): Prepared {
  const input = { document, projectId: "project-1", composeId: null, expectedRevisionId: null, actorId: "actor-1", idempotencyKey: "save-key-1", correlationId: "correlation-1", requestId: "request-1", now, ...overrides };
  const expectedPreviewDigest = overrides.expectedPreviewDigest ?? domain.createComposePreview(input.document, input.projectId, policy).configDigest;
  return prepareComposeRevisionSave({ ...input, expectedPreviewDigest }, policy);
}
function fixture(options: { auditFails?: boolean } = {}) {
  const ledger = { commands: new Map<string, ControlCommand>() }; const audits: unknown[] = []; let fail = options.auditFails === true; let clock = now;
  const store = new InMemoryComposeRevisionSaveStore({ ledger, appendAudit: (input) => { if (fail) throw new Error("fixture_literal_secret"); audits.push(structuredClone(input)); }, clock: () => clock });
  return { store, ledger, audits, allowAudit: () => { fail = false; }, advance: () => { clock = new Date(now.valueOf() + 16 * 60_000); } };
}
describe("Compose save through the shared command ledger", () => {
  it("prepares a server-owned nondestructive project.update command bound to the preview, without retaining source", () => {
    const input = prepare(); expect(input.command).toMatchObject({ actorId: "actor-1", action: "project.update", scope: { kind: "project", projectId: "project-1" }, status: "eligible", idempotencyKey: "save-key-1" });
    expect(input.command.expiresAt).toEqual(new Date(now.valueOf() + 15 * 60_000)); expect(input.preview.executionAllowed).toBe(false);
    expect(input).not.toHaveProperty("document"); expect(input.command).not.toHaveProperty("executionAuthority");
  });
  it("binds equivalent JSON and YAML intent to the same shared input digest", () => {
    expect(prepare({ document: `services: {web: {image: '${image}', environment: {TOKEN: '${"${APP_TOKEN}"}'}}}` }).command.inputDigest).toBe(prepare().command.inputDigest);
  });
  it("rejects a stale preview before preparing any command", () => { expect(() => prepare({ expectedPreviewDigest: "b".repeat(64) })).toThrow(expect.objectContaining({ code: "COMPOSE_PREVIEW_STALE" })); });
  it.each([{ composeId: null, expectedRevisionId: "revision-1" }, { composeId: "compose-1", expectedRevisionId: null }, { composeId: "../foreign", expectedRevisionId: "revision-1" }])("rejects invalid create/update identity binding %#", (overrides) => { expect(() => prepare(overrides)).toThrow(expect.objectContaining({ code: "COMPOSE_REVISION_INVALID" })); });
  it.each(["", "x".repeat(201), "invalid key"])("rejects an invalid bounded idempotency key %#", (idempotencyKey) => { expect(() => prepare({ idempotencyKey })).toThrow(expect.objectContaining({ code: "COMPOSE_REVISION_INVALID" })); });
  it("publishes revision, shared completed command and safe audit in one memory turn", async () => {
    const f = fixture(), input = prepare(), saved = await f.store.save(input);
    expect(saved).toMatchObject({ commandId: input.command.id, idempotent: false, revision: { id: input.command.id, composeId: input.command.id, projectId: "project-1", number: 1, createdBy: "actor-1", createdAt: now.toISOString(), preview: input.preview } });
    expect([...f.ledger.commands.values()]).toMatchObject([{ id: input.command.id, status: "completed", result: { action: "project.update", operation: "compose.revision.save", revisionId: saved.revision.id } }]);
    expect(f.audits).toHaveLength(1); expect(f.audits[0]).toMatchObject({ action: "compose.revision.saved", actorUserId: "actor-1", targetId: "project-1", correlationId: "correlation-1" });
    expect(JSON.stringify(f.audits)).not.toContain(image); expect(JSON.stringify(f.audits)).not.toContain("APP_TOKEN");
  });
  it("replays the same intent using the original durable command/revision identity and one audit", async () => {
    const f = fixture(), first = await f.store.save(prepare()), retry = await f.store.save(prepare());
    expect(retry).toEqual({ ...first, idempotent: true }); expect(f.ledger.commands.size).toBe(1); expect(f.audits).toHaveLength(1);
  });
  it("rejects reuse of one idempotency key with different canonical input", async () => {
    const f = fixture(), first = await f.store.save(prepare());
    await expect(f.store.save(prepare({ document: document.replace("a".repeat(64), "b".repeat(64)) }))).rejects.toThrow(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
    expect(await f.store.findRevision("project-1", first.revision.id)).toEqual(first.revision); expect(f.audits).toHaveLength(1); expect(f.ledger.commands.size).toBe(1);
  });
  it("appends only against the exact latest owned revision", async () => {
    const f = fixture(), first = await f.store.save(prepare());
    const updated = prepare({ composeId: first.revision.composeId, expectedRevisionId: first.revision.id, idempotencyKey: "save-key-2" }); const second = await f.store.save(updated);
    expect(second.revision.number).toBe(2); expect(second.revision.composeId).toBe(first.revision.composeId);
    await expect(f.store.save(prepare({ composeId: first.revision.composeId, expectedRevisionId: first.revision.id, idempotencyKey: "save-key-3" }))).rejects.toThrow(expect.objectContaining({ code: "COMPOSE_REVISION_CONFLICT" }));
    expect(f.ledger.commands.size).toBe(2); expect(f.audits).toHaveLength(2);
  });
  it("allows one of two competing next revisions to commit", async () => {
    const f = fixture(), first = await f.store.save(prepare());
    const outcomes = await Promise.allSettled(["next-a", "next-b"].map((idempotencyKey) => f.store.save(prepare({ composeId: first.revision.composeId, expectedRevisionId: first.revision.id, idempotencyKey }))));
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1); expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1); expect(f.audits).toHaveLength(2);
  });
  it("rejects a foreign Compose identity without reserving a command", async () => {
    const f = fixture(), first = await f.store.save(prepare());
    await expect(f.store.save(prepare({ projectId: "foreign-project", composeId: first.revision.composeId, expectedRevisionId: first.revision.id, idempotencyKey: "foreign-save" }))).rejects.toThrow();
    expect(await f.store.findRevision("foreign-project", first.revision.id)).toBeNull(); expect(f.ledger.commands.size).toBe(1); expect(f.audits).toHaveLength(1);
  });
  it("refuses a forged command/input binding before writes or audit", async () => {
    const f = fixture(), input = prepare(); input.command.inputDigest = "b".repeat(64);
    await expect(f.store.save(input)).rejects.toThrow(); expect(f.ledger.commands.size).toBe(0); expect(f.audits).toHaveLength(0);
  });
  it("does not publish any revision or command when safe audit fails; a later retry can save", async () => {
    const f = fixture({ auditFails: true }), input = prepare();
    await expect(f.store.save(input)).rejects.toThrow(); expect(await f.store.findRevision("project-1", input.command.id)).toBeNull(); expect(f.ledger.commands.size).toBe(0);
    f.allowAudit(); await expect(f.store.save(input)).resolves.toMatchObject({ idempotent: false }); expect(f.audits).toHaveLength(1);
  });
  it("rejects an expired eligible command without effects", async () => {
    const f = fixture(), input = prepare(); f.advance(); await expect(f.store.save(input)).rejects.toThrow(); expect(f.ledger.commands.size).toBe(0); expect(f.audits).toHaveLength(0);
  });
  it("keeps a completed replay read-only after its original command expiration", async () => {
    const f = fixture(), input = prepare(), first = await f.store.save(input); f.advance(); expect(await f.store.save(input)).toEqual({ ...first, idempotent: true }); expect(f.audits).toHaveLength(1);
  });
  it("lists owned logical resources without canonical source, image or secret-reference names", async () => {
    const f = fixture(), first = await f.store.save(prepare());
    const page = await f.store.listResources("project-1", { limit: 20, offset: 0 }); expect(page).toMatchObject({ total: 1, resources: [{ id: first.revision.composeId, latestRevisionId: first.revision.id, latestNumber: 1, serviceNames: ["web"] }] });
    expect(JSON.stringify(page)).not.toContain(image); expect(JSON.stringify(page)).not.toContain("APP_TOKEN"); expect((await f.store.listResources("foreign", { limit: 20, offset: 0 })).total).toBe(0);
  });
  it("keeps returned/input records independent from saved copies", async () => {
    const f = fixture(), input = prepare(), saved = await f.store.save(input), id = saved.revision.id;
    input.preview.services[0]!.image = "mutated-input"; saved.revision.preview.services[0]!.image = "mutated-output";
    expect((await f.store.findRevision("project-1", id))?.preview.services[0]?.image).toBe(image);
  });
});
