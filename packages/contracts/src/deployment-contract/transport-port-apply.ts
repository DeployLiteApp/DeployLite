import { z } from "zod";
import { trustedPriorExecutionReceiptSchema } from "./prior-execution-receipt.js";
import { projectControlAuthoritySchema, projectControlLeaseSchema } from "./project-control-authority.js";
import { transportPortBindingSchema, transportPortIntentSchema, transportPortApplyReceiptSchema, transportPortProtocolSchema } from "../transport-port.js";

const id = z.string().min(1).max(256);
const identity = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const context = z.object({ requestId: id, correlationId: id }).strict();
const image = z.string().min(1).max(1024).regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[0-9a-f]{64}$/);

export const TRANSPORT_PORT_APPLY_CAPABILITY = "docker.transport.port.apply.v1" as const;
export const TRANSPORT_PORT_APPLY_PATH = "/docker/transport-ports/apply" as const;
export const TRANSPORT_PORT_APPLY_RECEIPT_PATH = "/docker/transport-ports/receipt" as const;

const commandBase = z.object({
  schemaVersion: z.literal(1), action: z.literal("transport.port.apply"), agentId: identity, commandId: id,
  projectId: identity, idempotencyKey: z.string().min(1).max(200), inputDigest: digest,
  operation: z.enum(["apply", "rollback"]), rollbackRevisionId: id.nullable(), route: transportPortIntentSchema,
  currentContainerId: z.string().regex(/^[a-f0-9]{64}$/),
  bindings: z.array(transportPortBindingSchema).max(128),
  previousBindings: z.array(transportPortBindingSchema).max(128),
  executionReceipt: trustedPriorExecutionReceiptSchema, effectiveImage: image,
  requiredCapabilities: z.tuple([z.literal(TRANSPORT_PORT_APPLY_CAPABILITY)]), authority: projectControlAuthoritySchema,
  lease: projectControlLeaseSchema, context, timeoutMs: z.number().int().positive().max(60_000), cancellationRequested: z.literal(false)
}).strict();
type CommandScope = Pick<z.infer<typeof commandBase>, "projectId" | "operation" | "rollbackRevisionId" | "route" | "currentContainerId" | "bindings" | "previousBindings" | "executionReceipt" | "effectiveImage" | "agentId" | "commandId" | "inputDigest" | "authority" | "lease">;
function refineCommand(value: CommandScope, issue: z.RefinementCtx): void {
  for (const [name, bindings] of [["bindings", value.bindings], ["previousBindings", value.previousBindings]] as const) {
    const keys = new Set<string>();
    for (const binding of bindings) {
      const key = `${binding.protocol}:${binding.publishedPort}`;
      if (keys.has(key)) issue.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: "Transport bindings must have unique protocol and published-port keys" });
      keys.add(key);
    }
  }
  const hasRoute = value.bindings.some(binding => binding.protocol === value.route.protocol && binding.publishedPort === value.route.publishedPort && binding.targetPort === value.route.targetPort);
  if (!hasRoute || value.projectId !== value.route.projectId || value.projectId !== value.executionReceipt.projectId
    || value.route.deploymentId !== value.executionReceipt.deploymentId || value.executionReceipt.runtimeHost !== value.agentId
    || value.executionReceipt.effectiveImageDigest !== value.effectiveImage.split("@")[1]
    || value.authority.projectId !== value.projectId || value.authority.commandId !== value.commandId
    || value.authority.inputDigest !== value.inputDigest || value.authority.action !== "project.update"
    || JSON.stringify(value.lease) !== JSON.stringify(value.authority.projectLease)
    || (value.operation === "apply") !== (value.rollbackRevisionId === null)) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["authority"], message: "Transport apply scope and project authority must agree" });
  }
}

export const transportPortApplyAgentCommandSchema = commandBase.superRefine(refineCommand);
export type TransportPortApplyAgentCommandV1 = z.infer<typeof transportPortApplyAgentCommandSchema>;
export const transportPortApplyReceiptQuerySchema = commandBase.omit({ timeoutMs: true, cancellationRequested: true })
  .extend({ timeoutMs: z.number().int().positive().max(60_000) }).strict().superRefine(refineCommand);
export type TransportPortApplyReceiptQueryV1 = z.infer<typeof transportPortApplyReceiptQuerySchema>;
export const transportPortApplyCachedReceiptSchema = z.object({ schemaVersion: z.literal(1), action: z.literal("transport.port.apply"), agentId: identity,
  commandId: id, correlationId: id, receipt: transportPortApplyReceiptSchema.nullable() }).strict();
export type TransportPortApplyCachedReceiptV1 = z.infer<typeof transportPortApplyCachedReceiptSchema>;
