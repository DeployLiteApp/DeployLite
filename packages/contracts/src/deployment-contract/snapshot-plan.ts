import type { SourceIntentV1 } from "./source-intent.js";

export const DEPLOYMENT_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export interface CanonicalHasher { sha256(bytes: Uint8Array): string; }
export interface SecretReferenceV1 { readonly secretRefId: string; readonly version: number; }
export interface DeploymentSnapshotInputV1 {
  readonly deploymentId: string; readonly projectId: string; readonly source: SourceIntentV1;
  readonly configRevision: string; readonly runtimeRevision: string; readonly runtimePort: number | null;
  readonly secretRefs: readonly SecretReferenceV1[]; readonly policyVersion: string; readonly schemaVersion: number;
  readonly resolvedDigest?: string; readonly secretValues?: unknown; readonly timestamp?: unknown; readonly random?: unknown;
}
export interface DeploymentSnapshotV1 {
  readonly schemaVersion: 1; readonly deploymentId: string; readonly projectId: string; readonly source: SourceIntentV1;
  readonly configRevision: string; readonly runtimeRevision: string; readonly runtimePort: number | null;
  readonly secretRefs: readonly SecretReferenceV1[]; readonly policyVersion: string; readonly sourceSchemaVersion: number;
  readonly resolvedDigest?: string; readonly canonicalJson: string; readonly canonicalBytes: Uint8Array; readonly hash: string;
}
export type DeploymentPlanStatus = "executable" | "blocked";
export interface DeploymentPlanStepV1 { readonly order: number; readonly action: "validate-snapshot" | "prepare-artifact" | "await-mock-dispatch"; readonly mockOnly: true; }
export interface DeploymentPlanV1 { readonly mockOnly: true; readonly status: DeploymentPlanStatus; readonly snapshotHash: string; readonly sourceMode: SourceIntentV1["sourceMode"]; readonly artifact: { readonly reference: string } | { readonly kind: "build" }; readonly steps: readonly DeploymentPlanStepV1[]; readonly blocked?: { readonly code: "image-digest-required" }; }

const clone = <T>(value: T): T => structuredClone(value);
function freeze<T>(value: T): T { if (ArrayBuffer.isView(value)) return value; if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) freeze(child); } return value; }
function text(value: string): string { if (typeof value !== "string" || !value.trim()) throw new Error("snapshot text must be non-empty"); return value.trim(); }
function digest(value: string | undefined): string | undefined { if (value === undefined) return undefined; const normalized = value.trim().toLowerCase(); if (!/^sha256:[0-9a-f]{64}$/.test(normalized)) throw new Error("resolved digest must be sha256"); return normalized; }
function canonical(value: unknown): unknown { if (value === undefined) return undefined; if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === "object") { const result: Record<string, unknown> = {}; for (const key of Object.keys(value as Record<string, unknown>).sort()) { const item = canonical((value as Record<string, unknown>)[key]); if (item !== undefined) result[key] = item; } return result; } return value; }
function refs(values: readonly SecretReferenceV1[]): readonly SecretReferenceV1[] { return values.map((ref) => ({ secretRefId: text(ref.secretRefId), version: ref.version })).sort((a, b) => a.secretRefId.localeCompare(b.secretRefId) || a.version - b.version); }
export function createDeploymentSnapshot(input: DeploymentSnapshotInputV1, hasher: CanonicalHasher): DeploymentSnapshotV1 {
  const data = { schemaVersion: 1 as const, deploymentId: text(input.deploymentId), projectId: text(input.projectId), source: clone(input.source), configRevision: text(input.configRevision), runtimeRevision: text(input.runtimeRevision), runtimePort: input.runtimePort, secretRefs: refs(input.secretRefs), policyVersion: text(input.policyVersion), sourceSchemaVersion: input.schemaVersion, resolvedDigest: digest(input.resolvedDigest) };
  const canonicalJson = JSON.stringify(canonical(data)); const canonicalBytes = new TextEncoder().encode(canonicalJson); const hash = hasher.sha256(canonicalBytes);
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("snapshot hash must be a lowercase 64-hex SHA-256 digest");
  return freeze({ ...data, canonicalJson, canonicalBytes: new Uint8Array(canonicalBytes), hash });
}
export function createDeploymentPlan(snapshot: DeploymentSnapshotV1): DeploymentPlanV1 {
  const steps: readonly DeploymentPlanStepV1[] = freeze([{ order: 1, action: "validate-snapshot", mockOnly: true as const }, { order: 2, action: "prepare-artifact", mockOnly: true as const }, { order: 3, action: "await-mock-dispatch", mockOnly: true as const }]);
  if (snapshot.source.sourceMode === "image" && snapshot.source.image.selector.kind === "tag" && !snapshot.resolvedDigest) return freeze({ mockOnly: true, status: "blocked", snapshotHash: snapshot.hash, sourceMode: "image", artifact: { reference: snapshot.source.image.redactedReference }, steps, blocked: { code: "image-digest-required" } });
  return freeze({ mockOnly: true, status: "executable", snapshotHash: snapshot.hash, sourceMode: snapshot.source.sourceMode, artifact: snapshot.source.sourceMode === "build" ? { kind: "build" } : { reference: snapshot.resolvedDigest ?? snapshot.source.image.redactedReference }, steps });
}
