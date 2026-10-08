import { z } from "zod";
import { composeResourceInspectionInputSchema } from "./resource-inspection.js";
const identity=z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const composeVolumeBackupLimitsSchema=z.object({maxBytes:positive,maxEntries:positive,maxDurationMs:positive,planTtlMs:positive.max(900_000)}).strict();
export const composeVolumeBackupPlanningProfileSchema=composeVolumeBackupLimitsSchema.extend({owner:identity,agentId:identity,projectId:identity,profileId:identity,destinationId:identity}).strict();
export type ComposeVolumeBackupPlanningProfile=z.infer<typeof composeVolumeBackupPlanningProfileSchema>;
export const composeVolumeBackupPlanRequestSchema=composeResourceInspectionInputSchema.omit({kind:true}).extend({expectedStateDigest:digest,destinationId:identity}).strict();
export type ComposeVolumeBackupPlanRequest=z.infer<typeof composeVolumeBackupPlanRequestSchema>;
export const composeVolumeBackupPlanSchema=z.object({schemaVersion:z.literal(1),operation:z.literal("compose.volume.backup.plan"),status:z.literal("preview"),executionAllowed:z.literal(false),archiveCreated:z.literal(false),
  projectId:identity,volumeKey:composeResourceInspectionInputSchema.shape.key,configDigest:digest,stateDigest:digest,profileId:identity,destinationId:identity,
  consistency:z.literal("offline-required"),verification:z.literal("integrity-and-completeness-required"),limits:composeVolumeBackupLimitsSchema,planDigest:digest}).strict();
export type ComposeVolumeBackupPlanV1=z.infer<typeof composeVolumeBackupPlanSchema>;
export const composeVolumeBackupPlanReceiptSchema=z.object({commandId:identity,expiresAt:z.string().datetime({offset:true}),plan:composeVolumeBackupPlanSchema,idempotent:z.boolean()}).strict();
export type ComposeVolumeBackupPlanReceiptV1=z.infer<typeof composeVolumeBackupPlanReceiptSchema>;
