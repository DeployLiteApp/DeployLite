import { describe, expect, it } from "vitest";
import { type ImageReferencePolicyV1 } from "@deploylite/contracts";
import { createComposePreview } from "./compose-preview.js";
import { createComposeRevision } from "./compose-revision.js";
import { createComposeVolumeAttachmentReplacementPlan, ComposeVolumeAttachmentPlanError } from "./compose-volume-attachment-plan.js";

const policy: ImageReferencePolicyV1 = { policyVersion: "compose-volume-test-1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true };
const image = `registry.example.com/app@sha256:${"a".repeat(64)}`;
const service = (imageValue = image, environment = { TOKEN: "${APP_TOKEN}" }, networks = ["backend"], volumes: Array<{ type: "volume"; source: string; target: string; read_only?: boolean }> = []) =>
  ({ image: imageValue, environment, networks, volumes });
const document = (app: ReturnType<typeof service>, worker = service(), networkNames = ["backend"], volumeNames = ["data"]) => JSON.stringify({ services: { app, worker }, networks: Object.fromEntries(networkNames.map((name) => [name, {}])), volumes: Object.fromEntries(volumeNames.map((name) => [name, {}])) });
function revision(id: string, number: number, source: string) {
  const preview = createComposePreview(source, "project-1", policy);
  return createComposeRevision({ document: source, projectId: "project-1", composeId: "compose-1", revisionId: id, revisionNumber: number,
    createdBy: "actor-1", createdAt: `2026-10-08T00:0${number}:00.000Z`, expectedPreviewDigest: preview.configDigest }, policy);
}
function attachPair(nextDocument = document(service(image, undefined, undefined, [{ type: "volume", source: "data", target: "/data" }])) , priorDocument = document(service())) {
  return { priorRevision: revision("revision-1", 1, priorDocument), revision: revision("revision-2", 2, nextDocument), service: "app", key: "data", attachmentAction: "attach" as const };
}

describe("saved-revision Compose volume replacement preflight", () => {
  it("permits exactly one newly attached owned volume mount and carries both immutable bindings", () => {
    const input = attachPair();
    const plan = createComposeVolumeAttachmentReplacementPlan(input, policy);
    expect(plan).toMatchObject({ projectId: "project-1", composeId: "compose-1", priorRevisionId: "revision-1", revisionId: "revision-2",
      service: "app", key: "data", attachmentAction: "attach", image, networks: ["backend"], mounts: [{ source: "data", target: "/data", readOnly: false }] });
    expect(plan.priorConfigDigest).not.toBe(plan.configDigest);
    expect(plan.secretRefs).toEqual([{ key: "TOKEN", secretRefId: "APP_TOKEN" }]);
  });

  it("supports the inverse single-mount detach with matching resource identity", () => {
    const old = document(service(image, undefined, undefined, [{ type: "volume", source: "data", target: "/data" }]));
    const input = { priorRevision: revision("revision-1", 1, old), revision: revision("revision-2", 2, document(service())), service: "app", key: "data", attachmentAction: "detach" as const };
    expect(createComposeVolumeAttachmentReplacementPlan(input, policy).mounts).toEqual([]);
  });

  it.each([
    ["image", document(service(`registry.example.com/other@sha256:${"b".repeat(64)}`, undefined, undefined, [{ type: "volume", source: "data", target: "/data" }]))],
    ["environment references", document(service(image, { TOKEN: "${OTHER_TOKEN}" }, undefined, [{ type: "volume", source: "data", target: "/data" }]))],
    ["network", document(service(image, undefined, ["other"], [{ type: "volume", source: "data", target: "/data" }]), service(), ["backend", "other"])],
    ["another service", document(service(image, undefined, undefined, [{ type: "volume", source: "data", target: "/data" }]), service(`registry.example.com/worker@sha256:${"c".repeat(64)}`))],
    ["second selected-volume mount", document(service(image, undefined, undefined, [{ type: "volume", source: "data", target: "/data" }, { type: "volume", source: "data", target: "/archive" }]))]
  ])("rejects changed %s configuration during preflight", (_name, next) => {
    expect(() => createComposeVolumeAttachmentReplacementPlan(attachPair(next), policy)).toThrow(ComposeVolumeAttachmentPlanError);
  });

  it("rejects a nonconsecutive or foreign revision before producing an executable plan", () => {
    const input = attachPair();
    expect(() => createComposeVolumeAttachmentReplacementPlan({ ...input, revision: revision("revision-3", 3, input.revision.preview.canonicalDocument) }, policy)).toThrow(ComposeVolumeAttachmentPlanError);
    const foreign = createComposeRevision({ document: input.revision.preview.canonicalDocument, projectId: "project-2", composeId: "compose-1", revisionId: "revision-2",
      revisionNumber: 2, createdBy: "actor-1", createdAt: "2026-10-08T00:02:00.000Z", expectedPreviewDigest: createComposePreview(input.revision.preview.canonicalDocument, "project-2", policy).configDigest }, policy);
    expect(() => createComposeVolumeAttachmentReplacementPlan({ ...input, revision: foreign }, policy)).toThrow(ComposeVolumeAttachmentPlanError);
  });

  it.each([
    ["another network", document(service(image, undefined, ["backend", "extra"], [{ type: "volume", source: "data", target: "/data" }]), service(), ["backend", "extra"]), document(service(image, undefined, ["backend", "extra"]), service(), ["backend", "extra"])],
    ["another volume mount", document(service(image, undefined, undefined, [{ type: "volume", source: "data", target: "/data" }, { type: "volume", source: "archive", target: "/archive" }]), service(), ["backend"], ["data", "archive"]), document(service(image, undefined, undefined, [{ type: "volume", source: "archive", target: "/archive" }]), service(), ["backend"], ["data", "archive"])],
  ])("rejects %s that the replacement runtime cannot reconstruct", (_name, next, prior) => {
    expect(() => createComposeVolumeAttachmentReplacementPlan(attachPair(next, prior), policy)).toThrow(ComposeVolumeAttachmentPlanError);
  });
});
