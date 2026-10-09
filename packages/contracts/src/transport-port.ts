import { z } from "zod";

const id = z.string().min(1).max(256);
const port = z.number().int().min(1).max(65_535);

export const transportPortProtocolSchema = z.enum(["tcp", "udp"]);

/** A project-owned direct transport publication, separate from an HTTP hostname route. */
export const transportPortClaimSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: id,
  deploymentId: id.nullable(),
  protocol: transportPortProtocolSchema,
  publishedPort: port,
  targetPort: port
}).strict();

export const transportPortIntentSchema = transportPortClaimSchema.extend({
  deploymentId: id
}).strict();

export const transportPortBindingSchema = z.object({
  protocol: transportPortProtocolSchema,
  publishedPort: port,
  targetPort: port
}).strict();

export const transportPortPreviewRequestSchema = z.object({
  protocol: transportPortProtocolSchema,
  publishedPort: port,
  targetPort: port,
  deploymentId: id
}).strict();

export const transportPortRollbackRequestSchema = z.object({
  protocol: transportPortProtocolSchema,
  publishedPort: port
}).strict();

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);

export const transportPortRevisionSchema = z.object({
  schemaVersion: z.literal(1),
  id: id,
  projectId: id,
  protocol: transportPortProtocolSchema,
  publishedPort: port,
  deploymentId: id,
  targetPort: port,
  revisionNumber: z.number().int().positive(),
  operation: z.enum(["apply", "rollback"]),
  rollbackRevisionId: id.nullable(),
  commandId: id,
  correlationId: id,
  createdAt: z.string().datetime({ offset: true }),
  evidence: z.object({ state: z.enum(["created", "updated", "unchanged"]), observedAt: z.number().int().nonnegative(), redacted: z.literal(true) }).strict()
}).strict().superRefine((revision, issue) => {
  if ((revision.operation === "apply") !== (revision.rollbackRevisionId === null)) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["rollbackRevisionId"], message: "Transport revision operation binding is invalid" });
  }
});

export const transportPortApplyReceiptSchema = z.object({
  schemaVersion: z.literal(1), action: z.literal("transport.port.apply"), agentId: identity, commandId: id,
  projectId: identity, protocol: transportPortProtocolSchema, publishedPort: port, targetPort: port,
  deploymentId: id, operation: z.enum(["apply", "rollback"]), rollbackRevisionId: id.nullable(),
  inputDigest: digest, correlationId: id, containerId: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  state: z.enum(["created", "updated", "unchanged", "failed"]), observedAt: z.number().int().nonnegative(),
  failureReason: z.enum(["target-unavailable", "port-conflict", "docker-unavailable", "restart-failed", "canceled"]).nullable(), redacted: z.literal(true)
}).strict().superRefine((receipt, issue) => {
  if (receipt.state === "failed" && receipt.failureReason === null) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["failureReason"], message: "Failed transport receipt requires a bounded reason" });
  if (receipt.state !== "failed" && (receipt.containerId === null || receipt.failureReason !== null)) issue.addIssue({ code: z.ZodIssueCode.custom, message: "Successful transport receipts require a verified container identity" });
});

/** Last verified physical container state after a successful transport-port apply. */
export const transportPortRuntimeStateSchema = z.object({
  projectId: id, deploymentId: id, containerId: z.string().regex(/^[a-f0-9]{64}$/),
  bindings: z.array(transportPortBindingSchema).max(128)
}).strict().superRefine((state, issue) => {
  const keys = new Set<string>();
  for (const binding of state.bindings) {
    const key = `${binding.protocol}:${binding.publishedPort}`;
    if (keys.has(key)) issue.addIssue({ code: z.ZodIssueCode.custom, path: ["bindings"], message: "Runtime bindings must have unique protocol and published-port keys" });
    keys.add(key);
  }
});

export type TransportPortClaimV1 = z.infer<typeof transportPortClaimSchema>;
export type TransportPortIntentV1 = z.infer<typeof transportPortIntentSchema>;
export type TransportPortBindingV1 = z.infer<typeof transportPortBindingSchema>;
export type TransportPortRevisionV1 = z.infer<typeof transportPortRevisionSchema>;
export type TransportPortApplyReceiptV1 = z.infer<typeof transportPortApplyReceiptSchema>;
export type TransportPortRuntimeStateV1 = z.infer<typeof transportPortRuntimeStateSchema>;
