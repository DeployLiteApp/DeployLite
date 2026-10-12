import { z } from "zod";
import { managedDatabaseProfileRequestSchema } from "../managed-database-profile.js";
import { projectControlAuthoritySchema, projectControlLeaseSchema } from "./project-control-authority.js";
const identity = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const id = z.string().min(1).max(256);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const fingerprint = z.string().regex(/^[a-f0-9]{32}$/);
export const MANAGED_DATABASE_RUNTIME_CAPABILITY = "database.runtime.v1" as const;
export const MANAGED_DATABASE_RUNTIME_PATH = "/databases/runtime" as const;
export const MANAGED_DATABASE_RUNTIME_RECEIPT_PATH = "/databases/runtime/receipt" as const;
export const managedDatabaseRuntimePreparationSchema = managedDatabaseProfileRequestSchema.extend({
    profileId: identity, planDigest: digest, environmentFingerprint: fingerprint
}).strict();
const fields = {
    ...managedDatabaseRuntimePreparationSchema.shape,
    action: z.literal("database.runtime"), operation: z.literal("database.runtime.apply"),
    agentId: identity, commandId: id, profileId: identity, planDigest: digest, environmentFingerprint: fingerprint,
    idempotencyKey: identity, inputDigest: digest,
    requiredCapabilities: z.tuple([z.literal(MANAGED_DATABASE_RUNTIME_CAPABILITY)]),
    authority: projectControlAuthoritySchema, lease: projectControlLeaseSchema,
    context: z.object({ requestId: id, correlationId: id }).strict(), timeoutMs: z.number().int().min(1).max(60000)
};
const base = z.object(fields).strict();
type Binding = z.infer<typeof base>;
function bind(value: Binding, ctx: z.RefinementCtx) {
    if (value.projectId !== value.authority.projectId || value.commandId !== value.authority.commandId
        || value.inputDigest !== value.authority.inputDigest || JSON.stringify(value.lease) !== JSON.stringify(value.authority.projectLease))
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["authority"], message: "Database runtime must bind existing project update authority and lease" });
}
/** Server-owned profile lookup and sealed secrets are required; no image, argv or plaintext caller fields. */
export const managedDatabaseRuntimeAgentCommandSchema = base.extend({
    sealedEnvironment: z.string().min(1).max(131072), cancellationRequested: z.literal(false)
}).strict().superRefine(bind);
/** Original binding only: receipt recovery cannot carry secrets or request execution. */
export const managedDatabaseRuntimeReceiptQuerySchema = base.superRefine(bind);
export const managedDatabaseRuntimeReceiptSchema = z.object({
    ...managedDatabaseProfileRequestSchema.shape,
    action: z.literal("database.runtime"), agentId: identity, commandId: id, inputDigest: digest, planDigest: digest,
    environmentFingerprint: fingerprint, correlationId: id, containerId: digest.nullable(), imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
    volumeName: z.string().max(160).regex(/^dl-[a-f0-9]{32}-vol-db-[a-z][a-z0-9_-]{0,59}$/),
    networkName: z.string().max(160).regex(/^dl-[a-f0-9]{32}-net-db-[a-z][a-z0-9_-]{0,59}$/),
    observedAt: z.number().int().nonnegative(), status: z.enum(["ready", "failed"]), health: z.enum(["passed", "failed", "not-run"]),
    storage: z.enum(["verified", "unverified"]), idempotent: z.boolean(), redacted: z.literal(true)
}).strict().superRefine((receipt, ctx) => {
    if (receipt.status === "ready" && (receipt.health !== "passed" || receipt.storage !== "verified" || !receipt.containerId || !receipt.imageId))
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["status"], message: "Database readiness requires corroborated image, container, storage and health" });
    if (receipt.status === "failed" && receipt.health === "passed")
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["health"], message: "Failed execution cannot claim passed health" });
});
export type ManagedDatabaseRuntimeAgentCommandV1 = z.infer<typeof managedDatabaseRuntimeAgentCommandSchema>;
export type ManagedDatabaseRuntimeReceiptQueryV1 = z.infer<typeof managedDatabaseRuntimeReceiptQuerySchema>;
export type ManagedDatabaseRuntimeReceiptV1 = z.infer<typeof managedDatabaseRuntimeReceiptSchema>;
export const managedDatabaseRuntimeCachedReceiptSchema = z.object({
    schemaVersion: z.literal(1), action: z.literal("database.runtime"), agentId: identity, commandId: id, correlationId: id,
    receipt: managedDatabaseRuntimeReceiptSchema.nullable()
}).strict().superRefine((cached, ctx) => {
    if (cached.receipt && (cached.agentId !== cached.receipt.agentId || cached.commandId !== cached.receipt.commandId || cached.correlationId !== cached.receipt.correlationId))
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["receipt"], message: "Cached database receipt identity must match its wrapper" });
});
