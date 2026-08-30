export const SOURCE_INTENT_SCHEMA_VERSION = 1 as const;

export type ImageSelectorKindV1 = "tag" | "digest";
export type SourceIntentErrorCode =
  | "invalid-source-mode" | "invalid-build-intent" | "missing-image-reference"
  | "invalid-image-policy" | "invalid-image-reference" | "invalid-image-host"
  | "image-host-not-allowlisted" | "invalid-image-selector"
  | "image-tag-not-allowed" | "image-digest-not-allowed";

export interface ImageReferencePolicyV1 {
  readonly policyVersion: string;
  readonly trustedHosts: readonly string[];
  readonly allowTags: boolean;
  readonly allowDigests: boolean;
}
export type NormalizedImageReferencePolicyV1 = Readonly<ImageReferencePolicyV1>;
export interface ImageSelectorV1 { readonly kind: ImageSelectorKindV1; readonly value: string; }
export interface ValidatedImageReferenceV1 {
  readonly reference: string;
  readonly redactedReference: string;
  readonly registryHost: string;
  readonly repository: string;
  readonly selector: ImageSelectorV1;
  readonly declaredIntentOnly: true;
  readonly policyVersion: string;
}
export type SourceIntentInputV1 =
  | { readonly sourceMode: "build"; readonly sourceRevision: string; readonly buildProfileId: string; readonly imageTag?: string | null }
  | { readonly sourceMode: "image"; readonly requestedReference: string | null; readonly imageTag?: string | null };
export interface BuildSourceIntentV1 { readonly schemaVersion: 1; readonly sourceMode: "build"; readonly sourceRevision: string; readonly buildProfileId: string; }
export interface ImageSourceIntentV1 { readonly schemaVersion: 1; readonly sourceMode: "image"; readonly image: ValidatedImageReferenceV1; }
export type SourceIntentV1 = BuildSourceIntentV1 | ImageSourceIntentV1;

const messages: Record<SourceIntentErrorCode, string> = {
  "invalid-source-mode": "Source mode must be explicitly set to build or image.",
  "invalid-build-intent": "Build intent is incomplete or invalid.",
  "missing-image-reference": "Image intent requires an image reference.",
  "invalid-image-policy": "Image reference policy is invalid.",
  "invalid-image-reference": "Image reference is invalid.",
  "invalid-image-host": "Image registry host is invalid.",
  "image-host-not-allowlisted": "Image registry host is not allowlisted.",
  "invalid-image-selector": "Image reference selector is invalid.",
  "image-tag-not-allowed": "Image tag intent is not admitted by policy.",
  "image-digest-not-allowed": "Image digest intent is not admitted by policy."
};
export class SourceIntentValidationError extends Error {
  constructor(readonly code: SourceIntentErrorCode) { super(messages[code]); this.name = "SourceIntentValidationError"; }
}

const tagPattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const digestPattern = /^sha256:[0-9a-fA-F]{64}$/;
const hostLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const repoSegment = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
function fail(code: SourceIntentErrorCode): never { throw new SourceIntentValidationError(code); }
function text(value: unknown, code: SourceIntentErrorCode): string {
  if (typeof value !== "string" || !value || value.trim() !== value || /\s/.test(value)) fail(code);
  return value;
}
function host(value: unknown, code: SourceIntentErrorCode): string {
  let result = text(value, code).toLowerCase().replace(/\.$/, "");
  if (!result || /[\\/@%*]/.test(result)) fail(code);
  const colon = result.indexOf(":");
  let hostname = result; let port = "";
  if (colon >= 0) {
    if (colon !== result.lastIndexOf(":")) fail(code);
    hostname = result.slice(0, colon); const rawPort = result.slice(colon + 1);
    if (!/^\d{1,5}$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) fail(code);
    port = String(Number(rawPort));
  }
  const labels = hostname.split(".");
  if (!hostname || hostname.length > 253 || labels.some((label) => !hostLabel.test(label))) fail(code);
  return port ? `${hostname}:${port}` : hostname;
}
export function normalizeImageReferencePolicy(policy: ImageReferencePolicyV1): NormalizedImageReferencePolicyV1 {
  if (!policy || typeof policy !== "object" || !text(policy.policyVersion, "invalid-image-policy") || !Array.isArray(policy.trustedHosts) || !policy.trustedHosts.length || typeof policy.allowTags !== "boolean" || typeof policy.allowDigests !== "boolean") fail("invalid-image-policy");
  const trustedHosts = [...new Set(policy.trustedHosts.map((item) => host(item, "invalid-image-policy")))].sort();
  return Object.freeze({ policyVersion: policy.policyVersion, trustedHosts: Object.freeze(trustedHosts), allowTags: policy.allowTags, allowDigests: policy.allowDigests });
}
function repository(value: string): string {
  const normalized = value.toLowerCase(); const segments = normalized.split("/");
  if (!normalized || normalized.length > 255 || segments.some((part) => !repoSegment.test(part) || part.includes(".."))) fail("invalid-image-reference");
  return normalized;
}
export function validateImageReference(reference: string, policy: ImageReferencePolicyV1): ValidatedImageReferenceV1 {
  const normalizedPolicy = normalizeImageReferencePolicy(policy);
  if (typeof reference !== "string" || !reference || reference.trim() !== reference || /\s|[\u0000-\u001f\u007f\\%]/.test(reference) || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(reference)) fail("invalid-image-reference");
  const at = reference.indexOf("@"); let name: string; let selector: ImageSelectorV1;
  if (at >= 0) { if (!at || at !== reference.lastIndexOf("@") || !digestPattern.test(reference.slice(at + 1))) fail("invalid-image-selector"); name = reference.slice(0, at); selector = { kind: "digest", value: reference.slice(at + 1).toLowerCase() }; }
  else { const slash = reference.lastIndexOf("/"); const colon = reference.lastIndexOf(":"); if (colon <= slash || colon === reference.length - 1 || !tagPattern.test(reference.slice(colon + 1))) fail("invalid-image-selector"); name = reference.slice(0, colon); selector = { kind: "tag", value: reference.slice(colon + 1) }; }
  const slash = name.indexOf("/"); if (slash <= 0 || slash === name.length - 1) fail("invalid-image-reference");
  const registryHost = host(name.slice(0, slash), "invalid-image-host"); if (!normalizedPolicy.trustedHosts.includes(registryHost)) fail("image-host-not-allowlisted");
  const repo = repository(name.slice(slash + 1)); if (selector.kind === "tag" && !normalizedPolicy.allowTags) fail("image-tag-not-allowed"); if (selector.kind === "digest" && !normalizedPolicy.allowDigests) fail("image-digest-not-allowed");
  const base = `${registryHost}/${repo}`; return Object.freeze({ reference: selector.kind === "tag" ? `${base}:${selector.value}` : `${base}@${selector.value}`, redactedReference: selector.kind === "tag" ? `${base}:<tag>` : `${base}@sha256:<digest>`, registryHost, repository: repo, selector: Object.freeze(selector), declaredIntentOnly: true, policyVersion: normalizedPolicy.policyVersion });
}
export function createSourceIntent(input: SourceIntentInputV1, policy?: ImageReferencePolicyV1): SourceIntentV1 {
  if (!input || typeof input !== "object" || (input.sourceMode !== "build" && input.sourceMode !== "image")) fail("invalid-source-mode");
  if (input.sourceMode === "build") return Object.freeze({ schemaVersion: 1, sourceMode: "build", sourceRevision: text(input.sourceRevision, "invalid-build-intent"), buildProfileId: text(input.buildProfileId, "invalid-build-intent") });
  if (input.requestedReference == null) fail("missing-image-reference"); if (!policy) fail("invalid-image-policy");
  return Object.freeze({ schemaVersion: 1, sourceMode: "image", image: validateImageReference(input.requestedReference, policy) });
}
