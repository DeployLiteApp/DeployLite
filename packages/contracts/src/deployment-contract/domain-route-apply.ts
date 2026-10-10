import { z } from "zod";
import { trustedPriorExecutionReceiptSchema } from "./prior-execution-receipt.js";
import { projectControlAuthoritySchema, projectControlLeaseSchema } from "./project-control-authority.js";
import { domainRouteIntentSchema } from "../domain-route.js";

const id = z.string().min(1).max(256);
const identity = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const context = z.object({ requestId: id, correlationId: id }).strict();

export const DOMAIN_ROUTE_APPLY_CAPABILITY = "traefik.domain.route.apply.v1" as const;
export const DOMAIN_ROUTE_APPLY_PATH = "/traefik/domain-routes/apply" as const;
export const DOMAIN_ROUTE_APPLY_RECEIPT_PATH = "/traefik/domain-routes/receipt" as const;

const applyFields = {
  schemaVersion: z.literal(1), action: z.literal("domain.route.apply"), agentId: identity, commandId: id,
  projectId: identity, idempotencyKey: z.string().min(1).max(200), inputDigest: digest,
  route: domainRouteIntentSchema, executionReceipt: trustedPriorExecutionReceiptSchema,
  effectiveImage: z.string().min(1).max(1024).regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[0-9a-f]{64}$/),
  requiredCapabilities: z.tuple([z.literal(DOMAIN_ROUTE_APPLY_CAPABILITY)]), authority: projectControlAuthoritySchema,
  lease: projectControlLeaseSchema, context, timeoutMs: z.number().int().positive().max(60_000), cancellationRequested: z.literal(false)
};

const domainRouteApplyCommandBaseSchema = z.object(applyFields).strict();
type DomainRouteApplyScope = Pick<z.infer<typeof domainRouteApplyCommandBaseSchema>,
  "projectId" | "commandId" | "inputDigest" | "route" | "executionReceipt" | "effectiveImage" | "agentId" | "authority" | "lease">;
function refineApply(value: DomainRouteApplyScope, issue: z.RefinementCtx): void {
  if (value.projectId !== value.route.projectId || value.projectId !== value.executionReceipt.projectId
    || value.route.deploymentId !== value.executionReceipt.deploymentId
    || value.executionReceipt.runtimeHost !== value.agentId
    || value.executionReceipt.container !== `deploylite-active-${value.route.deploymentId}`
    || value.executionReceipt.effectiveImageDigest !== value.effectiveImage.split("@")[1]
    || value.authority.projectId !== value.projectId || value.authority.commandId !== value.commandId
    || value.authority.inputDigest !== value.inputDigest || value.authority.action !== "project.update"
    || JSON.stringify(value.lease) !== JSON.stringify(value.authority.projectLease)) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["authority"], message: "Domain route apply scope and project authority must agree" });
  }
}

export const domainRouteApplyAgentCommandSchema = domainRouteApplyCommandBaseSchema.superRefine(refineApply);
export type DomainRouteApplyAgentCommandV1 = z.infer<typeof domainRouteApplyAgentCommandSchema>;

export const domainRouteApplyReceiptSchema = z.object({
  schemaVersion: z.literal(1), action: z.literal("domain.route.apply"), agentId: identity, commandId: id,
  projectId: identity, domain: z.string().min(1).max(253), deploymentId: id, inputDigest: digest, correlationId: id,
  networkName: z.string().regex(/^deploylite-project-[a-f0-9]{24}$/).nullable(), networkId: digest.nullable(),
  targetContainerId: trustedPriorExecutionReceiptSchema.shape.containerId.nullable(), traefikContainerId: trustedPriorExecutionReceiptSchema.shape.containerId.nullable(),
  fileName: z.string().regex(/^domain-route-[a-f0-9]{24}\.yml$/).nullable(), contentDigest: digest.nullable(),
  state: z.enum(["created", "updated", "unchanged", "failed"]), observedAt: z.number().int().nonnegative(),
  failureReason: z.enum(["target-unavailable", "network-conflict", "traefik-unavailable", "config-write-failed", "canceled"]).nullable(), redacted: z.literal(true)
}).strict().superRefine((receipt, issue) => {
  const success = receipt.state !== "failed";
  if (success && (receipt.networkName === null || receipt.networkId === null || receipt.targetContainerId === null
    || receipt.traefikContainerId === null || receipt.fileName === null || receipt.contentDigest === null || receipt.failureReason !== null)) {
    issue.addIssue({ code: z.ZodIssueCode.custom, message: "Successful route receipts require complete verified runtime evidence" });
  }
  if (!success && receipt.failureReason === null) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["failureReason"], message: "Failed route receipt requires a bounded reason" });
});
export type DomainRouteApplyReceiptV1 = z.infer<typeof domainRouteApplyReceiptSchema>;

export const domainRouteApplyReceiptQuerySchema = domainRouteApplyCommandBaseSchema.omit({
  timeoutMs: true, cancellationRequested: true
}).extend({ timeoutMs: z.number().int().positive().max(60_000) }).strict().superRefine(refineApply);
export type DomainRouteApplyReceiptQueryV1 = z.infer<typeof domainRouteApplyReceiptQuerySchema>;

export const domainRouteApplyCachedReceiptSchema = z.object({
  schemaVersion: z.literal(1), action: z.literal("domain.route.apply"), agentId: identity,
  commandId: id, correlationId: id, receipt: domainRouteApplyReceiptSchema.nullable()
}).strict();
export type DomainRouteApplyCachedReceiptV1 = z.infer<typeof domainRouteApplyCachedReceiptSchema>;
