import { z } from "zod";
import { trustedPriorExecutionReceiptSchema } from "./prior-execution-receipt.js";
const id = z.string().min(1).max(256);
export const agentCapabilityHandshakeSchema = z.object({ schemaVersion: z.literal(1), agentId: id, capabilities: z.array(id).max(32), protocolVersions: z.array(z.union([z.literal(1), z.literal(2)])).min(1).max(4) }).strict();
export type AgentCapabilityHandshake = z.infer<typeof agentCapabilityHandshakeSchema>;
const requestContextSchema = z.object({ requestId: id, correlationId: id });
const leaseSchema = z.object({ leaseId: id, deploymentId: id, fence: z.number().int().positive(), expiresAt: z.number().finite() }).strict();

// Reuse deployment leases for project, immediate source and new execution authority.
export const deploymentExecutionAuthoritySchema = z.object({
  projectId: id, commandId: id, action: z.enum(["deployment.redeploy", "deployment.stop", "deployment.rollback"]),
  projectLease: leaseSchema, executionLease: leaseSchema, sourceLease: leaseSchema.optional()
}).strict();
export type DeploymentExecutionAuthorityV1 = z.infer<typeof deploymentExecutionAuthoritySchema>;

// Match the existing source-intent registry-port range without changing the immutable reference.
const digestImage = z.string().min(1).max(1024).regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[0-9a-f]{64}$/).refine((reference) => {
  const host = reference.slice(0, reference.indexOf("/")), separator = host.indexOf(":");
  return separator < 0 || (Number(host.slice(separator + 1)) >= 1 && Number(host.slice(separator + 1)) <= 65535);
}, "registry port must be between 1 and 65535");
export const promotionPolicySchema = z.object({ maxOutageMs: z.number().int().positive().max(300_000), maxRecoveryMs: z.number().int().positive().max(300_000) }).strict();
export type PromotionPolicy = z.infer<typeof promotionPolicySchema>;
export const agentReplacementSchema = z.object({ prior: trustedPriorExecutionReceiptSchema, effectiveImage: digestImage, policy: promotionPolicySchema }).strict();
export type AgentReplacementV1 = z.infer<typeof agentReplacementSchema>;

const agentExecutionFields = { agentId: id, commandId: id, deploymentId: id, projectId: id, snapshot: z.record(z.unknown()), snapshotHash: z.string().regex(/^[a-f0-9]{64}$/), requiredCapabilities: z.array(z.string().min(1).max(128)).max(8), lease: leaseSchema, context: requestContextSchema, timeoutMs: z.number().int().positive().max(300_000), cancellationRequested: z.boolean() };
const agentExecutionCommandV1Schema = z.object({ schemaVersion: z.literal(1), ...agentExecutionFields }).strict();
const agentExecutionCommandV2Schema = z.object({ schemaVersion: z.literal(2), ...agentExecutionFields, sourceDeploymentId: id, activeDeploymentId: id.optional(), authority: deploymentExecutionAuthoritySchema.optional(), replacement: agentReplacementSchema.optional() }).strict();
export const agentExecutionCommandSchema = z.union([agentExecutionCommandV1Schema, agentExecutionCommandV2Schema]).superRefine((command, context) => {
  if (command.schemaVersion === 2) validateRollbackRoles(command, context);
});
export type AgentExecutionCommand = z.infer<typeof agentExecutionCommandSchema>;

const runtimeConfigSchema = z.object({ hostPort: z.number().int().min(1024).max(65535), containerPort: z.number().int().min(1).max(65535), networkName: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,62}$/).optional() }).strict();
export const dockerImageExecutionReceiptSchema = z.object({
  deploymentId: id, candidateId: id.optional(), effectiveImage: digestImage, runtimePort: z.number().int().min(1).max(65535), runtimeConfig: runtimeConfigSchema.optional(), executionReceipt: trustedPriorExecutionReceiptSchema.optional(),
  health: z.enum(["passed", "failed"]), terminalStatus: z.enum(["succeeded", "failed", "canceled"]),
  rollback: z.object({ target: digestImage.nullable(), result: z.enum(["not-required", "restored", "not-available"]) }).strict(), proven: z.boolean()
}).strict().superRefine((receipt, context) => {
  if (receipt.terminalStatus === "succeeded" && (receipt.health !== "passed" || !receipt.proven)) context.addIssue({ code: z.ZodIssueCode.custom, message: "successful receipt must be proven and healthy" });
  if (receipt.terminalStatus !== "succeeded" && receipt.proven) context.addIssue({ code: z.ZodIssueCode.custom, message: "non-successful receipt cannot be proven" });
  if (receipt.terminalStatus === "canceled" && receipt.health !== "failed") context.addIssue({ code: z.ZodIssueCode.custom, message: "canceled receipt must be unhealthy" });
  if (receipt.rollback.result === "restored" && receipt.rollback.target === null) context.addIssue({ code: z.ZodIssueCode.custom, message: "restored rollback requires a target" });
  if (receipt.rollback.result === "not-required" && receipt.rollback.target !== null) context.addIssue({ code: z.ZodIssueCode.custom, message: "not-required rollback cannot have a target" });
  const proof = receipt.executionReceipt;
  if (!proof) return;
  // Wire alignment does not authenticate the producer or establish runtime observation.
  if (receipt.terminalStatus !== "succeeded" || receipt.health !== "passed" || !receipt.proven) context.addIssue({ code: z.ZodIssueCode.custom, path: ["executionReceipt"], message: "execution proof requires a successful proven healthy receipt" });
  if (receipt.candidateId !== proof.candidateId) context.addIssue({ code: z.ZodIssueCode.custom, path: ["candidateId"], message: "candidate must match execution proof" });
  if (receipt.deploymentId !== proof.deploymentId) context.addIssue({ code: z.ZodIssueCode.custom, path: ["deploymentId"], message: "deployment must match execution proof" });
  if (receipt.effectiveImage.split("@")[1] !== proof.effectiveImageDigest) context.addIssue({ code: z.ZodIssueCode.custom, path: ["effectiveImage"], message: "immutable image digest must match execution proof" });
  const runtime = receipt.runtimeConfig;
  if (!runtime) context.addIssue({ code: z.ZodIssueCode.custom, path: ["runtimeConfig"], message: "execution proof requires runtime configuration" });
  if (receipt.runtimePort !== proof.containerPort) context.addIssue({ code: z.ZodIssueCode.custom, path: ["runtimePort"], message: "runtime port must match proof container port" });
  if (runtime && (runtime.containerPort !== proof.containerPort || runtime.hostPort !== proof.hostPort || (runtime.networkName ?? null) !== proof.network)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["runtimeConfig"], message: "runtime ports and network must match execution proof" });
});
export type DockerImageExecutionReceipt = z.infer<typeof dockerImageExecutionReceiptSchema>;
const agentExecutionReceiptFields = { commandId: id, deploymentId: id, terminalStatus: z.enum(["succeeded", "failed", "canceled"]), health: z.enum(["passed", "failed"]), redacted: z.literal(true), receipt: dockerImageExecutionReceiptSchema };
const agentExecutionReceiptV1Schema = z.object({ schemaVersion: z.literal(1), ...agentExecutionReceiptFields, correlationId: id.optional() }).strict();
const agentExecutionReceiptV2Schema = z.object({ schemaVersion: z.literal(2), ...agentExecutionReceiptFields, correlationId: id, sourceDeploymentId: id, activeDeploymentId: id.optional(), snapshotHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const agentExecutionReceiptSchema = z.union([agentExecutionReceiptV1Schema, agentExecutionReceiptV2Schema]).superRefine((envelope, context) => {
  const receipt = envelope.receipt;
  const proof = receipt.executionReceipt;
  if (!proof) return;
  if (envelope.deploymentId !== receipt.deploymentId || envelope.terminalStatus !== receipt.terminalStatus || envelope.health !== receipt.health) context.addIssue({ code: z.ZodIssueCode.custom, path: ["receipt"], message: "outer deployment, terminal status and health must match proof-bearing receipt" });
  // sourceDeploymentId names the immediate execution, not the canonical snapshot origin.
  if (envelope.schemaVersion === 2 && envelope.snapshotHash !== proof.snapshotHash) context.addIssue({ code: z.ZodIssueCode.custom, path: ["snapshotHash"], message: "canonical snapshot hash must match execution proof" });
});
export type AgentExecutionReceipt = z.infer<typeof agentExecutionReceiptSchema>;

export const deploymentStopAgentCommandSchema = z.object({
  schemaVersion: z.literal(1), action: z.literal("deployment.stop"), agentId: id, commandId: id,
  projectId: id, deploymentId: id, candidateId: id, effectiveImage: digestImage, containerId: trustedPriorExecutionReceiptSchema.shape.containerId.optional(),
  requiredCapabilities: z.array(z.literal("deployment.stop")).length(1), lease: leaseSchema, authority: deploymentExecutionAuthoritySchema.optional(),
  context: requestContextSchema, timeoutMs: z.number().int().positive().max(300_000), cancellationRequested: z.boolean()
}).strict();
export type DeploymentStopAgentCommand = z.infer<typeof deploymentStopAgentCommandSchema>;

export const deploymentStopAgentReceiptSchema = z.object({
  schemaVersion: z.literal(1), action: z.literal("deployment.stop"), agentId: id, commandId: id,
  projectId: id, deploymentId: id, candidateId: id, effectiveImage: digestImage, containerId: trustedPriorExecutionReceiptSchema.shape.containerId.optional(),
  status: z.enum(["stopped", "already-stopped", "absent", "failed", "canceled"]), redacted: z.literal(true),
  correlationId: id, reason: z.string().max(512).nullable()
}).strict();
export type DeploymentStopAgentReceipt = z.infer<typeof deploymentStopAgentReceiptSchema>;

// Cache queries carry original immutable scope, never a new execution lease.
const cachedQueryFields = { schemaVersion: z.literal(1), agentId: id, commandId: id, projectId: id, deploymentId: id, correlationId: id, authority: deploymentExecutionAuthoritySchema.nullable(), timeoutMs: z.number().int().positive().max(300_000) };
export const agentReceiptQuerySchema = z.discriminatedUnion("action", [
  z.object({ ...cachedQueryFields, action: z.literal("deploy.execute"), sourceDeploymentId: id.nullable(), activeDeploymentId: id.optional(), snapshot: z.record(z.unknown()), snapshotHash: z.string().regex(/^[a-f0-9]{64}$/), replacement: agentReplacementSchema.nullable() }).strict(),
  z.object({ ...cachedQueryFields, action: z.literal("deployment.stop"), candidateId: id, effectiveImage: digestImage, containerId: trustedPriorExecutionReceiptSchema.shape.containerId.nullable() }).strict()
]).superRefine((query, context) => {
  if (query.action === "deploy.execute") validateRollbackRoles(query, context);
});
const cachedResponseFields = { schemaVersion: z.literal(1), agentId: id, commandId: id, correlationId: id };
export const agentCachedReceiptSchema = z.discriminatedUnion("action", [
  z.object({ ...cachedResponseFields, action: z.literal("deploy.execute"), receipt: agentExecutionReceiptSchema.nullable() }).strict(),
  z.object({ ...cachedResponseFields, action: z.literal("deployment.stop"), receipt: deploymentStopAgentReceiptSchema.nullable() }).strict()
]);
export type AgentReceiptQuery = z.infer<typeof agentReceiptQuerySchema>;
export type AgentCachedReceipt = z.infer<typeof agentCachedReceiptSchema>;


function validateRollbackRoles(value: { projectId: string; deploymentId: string; sourceDeploymentId: string | null; activeDeploymentId?: string; authority?: DeploymentExecutionAuthorityV1 | null; replacement?: AgentReplacementV1 | null }, context: z.RefinementCtx): void {
  const authority = value.authority;
  if (authority?.action !== "deployment.rollback") {
    if (value.activeDeploymentId !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ["activeDeploymentId"], message: "active replacement identity requires rollback authority" });
    return;
  }
  const active = value.activeDeploymentId;
  if (!active || !value.sourceDeploymentId || value.deploymentId === active || value.sourceDeploymentId === value.deploymentId
    || authority.projectId !== value.projectId || authority.projectLease.deploymentId !== value.projectId
    || authority.executionLease.deploymentId !== value.deploymentId || authority.sourceLease?.deploymentId !== active
    || value.replacement?.prior.deploymentId !== active || value.replacement?.prior.projectId !== value.projectId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["activeDeploymentId"], message: "rollback A/H/R authority and replacement bindings must agree" });
  }
}
