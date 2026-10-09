import { composeDocumentSchema, composeRevisionSchema, protocolPayloadFingerprint, type ComposeDocumentV1, type ComposePreviewV1, type ComposeRevisionV1, type ImageReferencePolicyV1 } from "@deploylite/contracts";
import { createComposePreview, composeRuntimeResourceName } from "./compose-preview.js";

export type ComposeVolumeAttachmentReplacementPlanV1 = Readonly<{
  projectId: string;
  composeId: string;
  priorRevisionId: string;
  revisionId: string;
  priorConfigDigest: string;
  configDigest: string;
  service: string;
  key: string;
  runtimeName: string;
  attachmentAction: "attach" | "detach";
  priorCanonicalDocument: string;
  canonicalDocument: string;
  image: string;
  networks: readonly string[];
  mounts: ComposePreviewV1["services"][number]["volumes"];
  secretRefs: ComposePreviewV1["services"][number]["secretRefs"];
}>;
export type ComposeVolumeAttachmentPlanInput = Readonly<{
  priorRevision: ComposeRevisionV1;
  revision: ComposeRevisionV1;
  service: string;
  key: string;
  attachmentAction: "attach" | "detach";
}>;

export class ComposeVolumeAttachmentPlanError extends Error {
  constructor(readonly code: "COMPOSE_ATTACHMENT_UNSUPPORTED" | "COMPOSE_RESOURCE_STALE") {
    super("Saved Compose revisions cannot safely reconstruct this volume replacement.");
    this.name = "ComposeVolumeAttachmentPlanError";
  }
}
function fail(code: ComposeVolumeAttachmentPlanError["code"]): never { throw new ComposeVolumeAttachmentPlanError(code); }
function documentOf(revision: ComposeRevisionV1): ComposeDocumentV1 {
  try { return composeDocumentSchema.parse(JSON.parse(revision.preview.canonicalDocument)); }
  catch { fail("COMPOSE_ATTACHMENT_UNSUPPORTED"); }
}
function verifiedPreview(revision: ComposeRevisionV1, imagePolicy: ImageReferencePolicyV1): ComposePreviewV1 {
  const parsed = composeRevisionSchema.safeParse(revision);
  if (!parsed.success) fail("COMPOSE_ATTACHMENT_UNSUPPORTED");
  try {
    const preview = createComposePreview(parsed.data.preview.canonicalDocument, parsed.data.projectId, imagePolicy);
    if (preview.configDigest !== parsed.data.preview.configDigest
      || protocolPayloadFingerprint(preview) !== protocolPayloadFingerprint(parsed.data.preview)) fail("COMPOSE_ATTACHMENT_UNSUPPORTED");
    return preview;
  } catch (error) {
    if (error instanceof ComposeVolumeAttachmentPlanError) throw error;
    fail("COMPOSE_ATTACHMENT_UNSUPPORTED");
  }
}
function withoutSelectedMount(document: ComposeDocumentV1, service: string, key: string): ComposeDocumentV1 {
  const target = document.services[service];
  if (!target || !/^[a-z][a-z0-9_-]{0,62}$/.test(service) || !/^[a-z][a-z0-9_-]{0,62}$/.test(key)
    || ["constructor", "prototype", "__proto__"].includes(service) || ["constructor", "prototype", "__proto__"].includes(key)) fail("COMPOSE_ATTACHMENT_UNSUPPORTED");
  return { ...document, services: { ...document.services, [service]: { ...target, volumes: target.volumes.filter((mount) => mount.source !== key) } } };
}

/**
 * A fail-closed preflight for the only supported volume replacement shape.
 * The immutable revisions must be consecutive and valid under today's image policy;
 * after removing the selected service's single selected-volume mount, their complete
 * canonical documents must be identical. It performs no runtime operation.
 */
export function createComposeVolumeAttachmentReplacementPlan(
  raw: ComposeVolumeAttachmentPlanInput,
  imagePolicy: ImageReferencePolicyV1
): ComposeVolumeAttachmentReplacementPlanV1 {
  const prior = verifiedPreview(raw.priorRevision, imagePolicy);
  const next = verifiedPreview(raw.revision, imagePolicy);
  if (raw.priorRevision.projectId !== raw.revision.projectId || raw.priorRevision.composeId !== raw.revision.composeId
    || raw.priorRevision.id === raw.revision.id || raw.revision.number !== raw.priorRevision.number + 1
    || prior.policyVersion !== next.policyVersion) fail("COMPOSE_RESOURCE_STALE");

  const oldService = prior.services.find((item) => item.name === raw.service);
  const newService = next.services.find((item) => item.name === raw.service);
  const oldVolume = prior.volumes.find((item) => item.key === raw.key);
  const newVolume = next.volumes.find((item) => item.key === raw.key);
  if (!oldService || !newService || !oldVolume || !newVolume
    || oldVolume.runtimeName !== newVolume.runtimeName
    || oldVolume.runtimeName !== composeRuntimeResourceName(raw.revision.projectId, "volume", raw.key)) fail("COMPOSE_ATTACHMENT_UNSUPPORTED");

  const oldMounts = oldService.volumes.filter((mount) => mount.source === raw.key);
  const newMounts = newService.volumes.filter((mount) => mount.source === raw.key);
  if ((raw.attachmentAction === "attach" && (oldMounts.length !== 0 || newMounts.length !== 1))
    || (raw.attachmentAction === "detach" && (oldMounts.length !== 1 || newMounts.length !== 0))
    || oldService.networks.length !== 1 || newService.networks.length !== 1
    || oldService.volumes.length !== (raw.attachmentAction === "attach" ? 0 : 1)
    || newService.volumes.length !== (raw.attachmentAction === "attach" ? 1 : 0)) fail("COMPOSE_ATTACHMENT_UNSUPPORTED");

  const oldWithoutMount = withoutSelectedMount(documentOf(raw.priorRevision), raw.service, raw.key);
  const newWithoutMount = withoutSelectedMount(documentOf(raw.revision), raw.service, raw.key);
  if (protocolPayloadFingerprint(oldWithoutMount) !== protocolPayloadFingerprint(newWithoutMount)) fail("COMPOSE_ATTACHMENT_UNSUPPORTED");

  return {
    projectId: raw.revision.projectId, composeId: raw.revision.composeId, priorRevisionId: raw.priorRevision.id, revisionId: raw.revision.id,
    priorConfigDigest: prior.configDigest, configDigest: next.configDigest, service: raw.service, key: raw.key,
    runtimeName: newVolume.runtimeName, attachmentAction: raw.attachmentAction,
    priorCanonicalDocument: prior.canonicalDocument, canonicalDocument: next.canonicalDocument,
    image: newService.image, networks: [...newService.networks], mounts: structuredClone(newService.volumes), secretRefs: structuredClone(newService.secretRefs)
  };
}
