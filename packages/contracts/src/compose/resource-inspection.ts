import { z } from "zod";

const key = z.string().max(63).regex(/^[a-z][a-z0-9_-]*$/).refine(value => !["constructor", "prototype", "__proto__"].includes(value));
const identity = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const runtimeName = z.string().max(160).regex(/^dl-[a-f0-9]{32}-(?:net|vol)-[a-z][a-z0-9_-]*$/);
const target = z.string().max(256).regex(/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/)
  .refine(value => !value.split("/").some(part => part === "." || part === "..") && !/^\/(?:proc|sys|dev)(?:\/|$)/.test(value));
export const COMPOSE_RESOURCE_INSPECTION_CAPABILITY = "compose.resource.inspect.v1";
export const composeResourceKindSchema = z.enum(["network", "volume"]);
export type ComposeResourceKind = z.infer<typeof composeResourceKindSchema>;
export const composeResourceContainerObservationSchema = z.object({
  containerId: digest, service: key, running: z.boolean(), attached: z.boolean(),
  mounts: z.array(z.object({ target, readOnly: z.boolean() }).strict()).max(32)
}).strict();
export const composeResourceObservationSchema = z.object({
  schemaVersion: z.literal(1), owner: identity, agentId: identity, projectId: identity,
  kind: composeResourceKindSchema, key, runtimeName, physicalIdentity: z.string().min(1).max(64),
  configDigest: digest, observedAt: z.number().int().nonnegative(), stateDigest: digest,
  containers: z.array(composeResourceContainerObservationSchema).max(32)
}).strict().superRefine((value, context) => {
  const valid = value.kind === "network" ? /^[a-f0-9]{64}$/.test(value.physicalIdentity)
    : /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value.physicalIdentity) && Number.isFinite(Date.parse(value.physicalIdentity));
  if (!valid) context.addIssue({ code: z.ZodIssueCode.custom, path: ["physicalIdentity"], message: "Invalid physical identity" });
  if (new Set(value.containers.map(c => c.containerId)).size !== value.containers.length)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["containers"], message: "Duplicate container identity" });
  if (value.kind === "network" && value.containers.some(c => c.mounts.length))
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["containers"], message: "Invalid network projection" });
});
export type ComposeResourceObservationV1 = z.infer<typeof composeResourceObservationSchema>;
export const composeAttachmentPreviewInputSchema = z.object({
  document: z.string().min(1).max(65_536), projectId: identity, kind: composeResourceKindSchema,
  key, service: key, action: z.enum(["attach", "detach"]), expectedConfigDigest: digest,
  expectedStateDigest: digest.optional()
}).strict();
export type ComposeAttachmentPreviewInput = z.infer<typeof composeAttachmentPreviewInputSchema>;
export const composeAttachmentPreviewSchema = z.object({
  schemaVersion: z.literal(1), status: z.literal("preview"), executionAllowed: z.literal(false),
  projectId: identity, kind: composeResourceKindSchema, key, service: key, action: z.enum(["attach", "detach"]),
  configDigest: digest, stateDigest: digest, containerId: digest, alreadySatisfied: z.boolean()
}).strict();
export type ComposeAttachmentPreviewV1 = z.infer<typeof composeAttachmentPreviewSchema>;
export const composeResourceInspectionInputSchema = composeAttachmentPreviewInputSchema.pick({ document: true, projectId: true, kind: true, key: true, expectedConfigDigest: true });
export type ComposeResourceInspectionInput = z.infer<typeof composeResourceInspectionInputSchema>;
export const composeResourceInspectionRequestSchema = composeResourceInspectionInputSchema.omit({ projectId: true });
export const composeAttachmentPreviewRequestSchema = composeAttachmentPreviewInputSchema.omit({ projectId: true });
export const composeResourceInspectionViewSchema = z.object({
  schemaVersion: z.literal(1), status: z.literal("observed"), executionAllowed: z.literal(false),
  projectId: identity, kind: composeResourceKindSchema, key, configDigest: digest, stateDigest: digest,
  observedAt: z.number().int().nonnegative(), containers: z.array(composeResourceContainerObservationSchema.pick({ service: true, running: true, attached: true })).max(32)
}).strict();
export type ComposeResourceInspectionViewV1 = z.infer<typeof composeResourceInspectionViewSchema>;
