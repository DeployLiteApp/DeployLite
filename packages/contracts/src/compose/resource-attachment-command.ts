import { z } from "zod";

const identity = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const key = z.string().max(63).regex(/^[a-z][a-z0-9_-]*$/).refine(value => !["constructor", "prototype", "__proto__"].includes(value));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const runtimeName = z.string().max(160).regex(/^dl-[a-f0-9]{32}-net-[a-z][a-z0-9_-]*$/);

/** A server-derived project.update command envelope; it carries no caller-selected authority or runtime execution flag. */
export const composeResourceAttachmentCommandSchema = z.object({
  schemaVersion: z.literal(1),
  action: z.literal("project.update"),
  scope: z.object({ kind: z.literal("project"), projectId: identity }).strict(),
  operation: z.literal("compose.resource.attachment"),
  idempotencyKey: z.string().min(1).max(200),
  correlationId: identity,
  projectId: identity,
  kind: z.literal("network"),
  key,
  runtimeName,
  service: key,
  attachmentAction: z.enum(["attach", "detach"]),
  configDigest: digest,
  stateDigest: digest,
  containerId: digest,
  alreadySatisfied: z.boolean()
}).strict().superRefine((value, context) => {
  if (value.scope.projectId !== value.projectId) context.addIssue({ code: z.ZodIssueCode.custom, path: ["scope", "projectId"], message: "Project scope must match the command" });
});
export type ComposeResourceAttachmentCommandV1 = z.infer<typeof composeResourceAttachmentCommandSchema>;
