import { createHash } from "node:crypto";
import { COMPOSE_PREVIEW_MAX_BYTES, composeDocumentSchema, composePreviewSchema, normalizeImageReferencePolicy, validateImageReference,
  type ComposeDocumentV1, type ComposePreviewV1, type ImageReferencePolicyV1 } from "@deploylite/contracts";

import { decodeComposeInput } from "./compose-input.js";

type ErrorCode = "COMPOSE_INVALID_DOCUMENT" | "COMPOSE_POLICY_REJECTED" | "COMPOSE_IMAGE_REJECTED" | "COMPOSE_UNDECLARED_RESOURCE" | "COMPOSE_DUPLICATE_ATTACHMENT";
export class ComposePreviewError extends Error {
  constructor(readonly code: ErrorCode) { super("Compose input is outside the supported preview policy."); this.name = "ComposePreviewError"; }
}
function fail(code: ErrorCode): never { throw new ComposePreviewError(code); }
function sorted<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.keys(record).sort().map((name) => [name, record[name]!]));
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

/** Pure planning only: no runtime port, secret source, file or process adapter. */
export function createComposePreview(document: string, projectId: string, imagePolicy: ImageReferencePolicyV1): ComposePreviewV1 {
  if (typeof document !== "string" || Buffer.byteLength(document, "utf8") > COMPOSE_PREVIEW_MAX_BYTES) fail("COMPOSE_INVALID_DOCUMENT");
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(projectId)) fail("COMPOSE_POLICY_REJECTED");
  let decoded: unknown;
  try { decoded = decodeComposeInput(document); } catch { fail("COMPOSE_INVALID_DOCUMENT"); }
  const parsed = composeDocumentSchema.safeParse(decoded);
  if (!parsed.success) fail("COMPOSE_POLICY_REJECTED");
  const model: ComposeDocumentV1 = parsed.data;
  const policy = normalizeImageReferencePolicy({ ...imagePolicy, allowTags: false });
  const services = Object.keys(model.services).sort().map((name) => {
    const service = model.services[name]!;
    try { service.image = validateImageReference(service.image, policy).reference; } catch { fail("COMPOSE_IMAGE_REJECTED"); }
    if (new Set(service.networks).size !== service.networks.length) fail("COMPOSE_DUPLICATE_ATTACHMENT");
    service.networks.sort();
    service.volumes.sort((a, b) => a.target < b.target ? -1 : a.target > b.target ? 1 : 0);
    service.environment = sorted(service.environment);
    for (const network of service.networks) {
      if (network === "default" && !Object.hasOwn(model.networks, network)) model.networks.default = { driver: "bridge", internal: false };
      if (!Object.hasOwn(model.networks, network)) fail("COMPOSE_UNDECLARED_RESOURCE");
    }
    for (let i = 0; i < service.volumes.length; i++) {
      const mount = service.volumes[i]!;
      if (!Object.hasOwn(model.volumes, mount.source)) fail("COMPOSE_UNDECLARED_RESOURCE");
      if (service.volumes.slice(i + 1).some((other) => other.target === mount.target || other.target.startsWith(`${mount.target}/`))) fail("COMPOSE_DUPLICATE_ATTACHMENT");
    }
    return { name, image: service.image, networks: [...service.networks],
      volumes: service.volumes.map((mount) => ({ source: mount.source, target: mount.target, readOnly: mount.read_only })),
      secretRefs: Object.entries(service.environment).map(([key, reference]) => ({ key, secretRefId: reference.slice(2, -1) })) };
  });
  const canonicalDocument = JSON.stringify({ services: sorted(model.services), networks: sorted(model.networks), volumes: sorted(model.volumes) });
  // Scoped names are proposals only. Later apply must prove ownership/conflict state.
  const prefix = `dl-${hash(projectId).slice(0, 32)}`;
  const networks = Object.keys(model.networks).sort().map((key) => ({ key, projectId, runtimeName: `${prefix}-net-${key}`, ...model.networks[key]!,
    attachedServices: services.filter((service) => service.networks.includes(key)).map((service) => service.name) }));
  const volumes = Object.keys(model.volumes).sort().map((key) => ({ key, projectId, runtimeName: `${prefix}-vol-${key}`, ...model.volumes[key]!,
    attachedServices: services.filter((service) => service.volumes.some((mount) => mount.source === key)).map((service) => service.name) }));
  return composePreviewSchema.parse({ schemaVersion: 1, projectId, status: "preview", executionAllowed: false, policyVersion: policy.policyVersion,
    configDigest: hash(JSON.stringify({ schemaVersion: 1, projectId, policy, canonicalDocument })), canonicalDocument, services, networks, volumes });
}
