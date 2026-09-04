import { z } from "zod";
const id = z.string().min(1).max(256);
const requestContextSchema = z.object({ requestId: id, correlationId: id });

export const agentExecutionCommandSchema = z.object({
  schemaVersion: z.literal(1), agentId: id, commandId: id, deploymentId: id, projectId: id, snapshot: z.record(z.unknown()),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/), requiredCapabilities: z.array(z.string().min(1).max(128)).max(8),
  lease: z.object({ leaseId: id, deploymentId: id, fence: z.number().int().positive(), expiresAt: z.number().finite() }).strict(),
  context: requestContextSchema, timeoutMs: z.number().int().positive().max(300_000), cancellationRequested: z.boolean()
}).strict();
export type AgentExecutionCommand = z.infer<typeof agentExecutionCommandSchema>;

const digestImage = z.string().min(1).max(1024).regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[0-9a-f]{64}$/);
export const dockerImageExecutionReceiptSchema = z.object({
  deploymentId: id, candidateId: id.optional(), effectiveImage: digestImage, runtimePort: z.number().int().min(1).max(65535),
  health: z.enum(["passed", "failed"]), terminalStatus: z.enum(["succeeded", "failed", "canceled"]),
  rollback: z.object({ target: digestImage.nullable(), result: z.enum(["not-required", "restored", "not-available"]) }).strict(), proven: z.boolean()
}).strict().superRefine((receipt, context) => {
  if (receipt.terminalStatus === "succeeded" && (receipt.health !== "passed" || !receipt.proven)) context.addIssue({ code: z.ZodIssueCode.custom, message: "successful receipt must be proven and healthy" });
  if (receipt.terminalStatus !== "succeeded" && receipt.proven) context.addIssue({ code: z.ZodIssueCode.custom, message: "non-successful receipt cannot be proven" });
  if (receipt.terminalStatus === "canceled" && receipt.health !== "failed") context.addIssue({ code: z.ZodIssueCode.custom, message: "canceled receipt must be unhealthy" });
  if (receipt.rollback.result === "restored" && receipt.rollback.target === null) context.addIssue({ code: z.ZodIssueCode.custom, message: "restored rollback requires a target" });
  if (receipt.rollback.result === "not-required" && receipt.rollback.target !== null) context.addIssue({ code: z.ZodIssueCode.custom, message: "not-required rollback cannot have a target" });
});
export type DockerImageExecutionReceipt = z.infer<typeof dockerImageExecutionReceiptSchema>;
export const agentExecutionReceiptSchema = z.object({ schemaVersion: z.literal(1), commandId: id, deploymentId: id, terminalStatus: z.enum(["succeeded", "failed", "canceled"]), health: z.enum(["passed", "failed"]), redacted: z.literal(true), receipt: dockerImageExecutionReceiptSchema }).strict();
export type AgentExecutionReceipt = z.infer<typeof agentExecutionReceiptSchema>;
