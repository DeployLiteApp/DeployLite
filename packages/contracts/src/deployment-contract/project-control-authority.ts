import { z } from "zod";

const id = z.string().min(1).max(256);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const projectControlLeaseSchema = z.object({ leaseId: id, projectId: id, fence: z.number().int().positive(), expiresAt: z.number().finite() }).strict();
export const projectControlAuthoritySchema = z.object({
  schemaVersion: z.literal(1),
  projectId: id,
  commandId: id,
  action: z.literal("project.update"),
  inputDigest: digest,
  projectLease: projectControlLeaseSchema
}).strict().superRefine((authority, context) => {
  if (authority.projectLease.projectId !== authority.projectId) context.addIssue({ code: z.ZodIssueCode.custom, path: ["projectLease", "projectId"], message: "Project lease must match authority scope" });
});
export type ProjectControlAuthorityV1 = z.infer<typeof projectControlAuthoritySchema>;
