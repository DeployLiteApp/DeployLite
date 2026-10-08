import { z } from "zod";

export const COMPOSE_PREVIEW_MAX_BYTES = 65_536;
const reservedKeys = new Set(["constructor", "prototype", "__proto__"]);
const key = z.string().max(63).regex(/^[a-z][a-z0-9_-]*$/).refine((value) => !reservedKeys.has(value));
const projectId = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const target = z.string().max(256).regex(/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/).refine((value) =>
  !value.split("/").some((part) => part === "." || part === "..") && !/^\/(?:proc|sys|dev)(?:\/|$)/.test(value));
const mount = z.object({ type: z.literal("volume"), source: key, target, read_only: z.boolean().default(false) }).strict();
const environment = z.record(z.string().max(128).regex(/^[A-Z_][A-Z0-9_]*$/), z.string().max(132).regex(/^\$\{[A-Z_][A-Z0-9_]*\}$/))
  .refine((value) => Object.keys(value).length <= 64);
const service = z.object({
  image: z.string().min(1).max(512),
  networks: z.array(key).min(1).max(32).default(["default"]),
  volumes: z.array(mount).max(32).default([]),
  environment: environment.default({})
}).strict();
const network = z.object({ driver: z.literal("bridge").default("bridge"), internal: z.boolean().default(false) }).strict();
const volume = z.object({ driver: z.literal("local").default("local") }).strict();
const bounded = <T extends z.ZodTypeAny>(value: T) => z.record(key, value).refine((record) => Object.keys(record).length <= 32);

// A closed preview subset; unsupported fields are rejected rather than ignored.
export const composeDocumentSchema = z.object({
  services: bounded(service).refine((value) => Object.keys(value).length > 0),
  networks: bounded(z.union([network, z.null().transform(() => network.parse({}))])).default({}),
  volumes: bounded(z.union([volume, z.null().transform(() => volume.parse({}))])).default({})
}).strict();
export type ComposeDocumentV1 = z.infer<typeof composeDocumentSchema>;
export const composePreviewRequestSchema = z.object({ document: z.string().min(1).max(COMPOSE_PREVIEW_MAX_BYTES) }).strict();

const attachment = z.object({ source: key, target, readOnly: z.boolean() }).strict();
const resource = z.object({ key, projectId, runtimeName: z.string().max(160), attachedServices: z.array(key).max(32) });
export const composePreviewSchema = z.object({
  schemaVersion: z.literal(1), projectId, status: z.literal("preview"), executionAllowed: z.literal(false),
  policyVersion: z.string().min(1), configDigest: z.string().regex(/^[a-f0-9]{64}$/), canonicalDocument: z.string().max(262_144),
  services: z.array(z.object({ name: key, image: z.string().max(512), networks: z.array(key).max(32), volumes: z.array(attachment).max(32),
    secretRefs: z.array(z.object({ key: z.string(), secretRefId: z.string() }).strict()).max(64) }).strict()).min(1).max(32),
  networks: z.array(resource.extend({ driver: z.literal("bridge"), internal: z.boolean() }).strict()).max(33),
  volumes: z.array(resource.extend({ driver: z.literal("local") }).strict()).max(32)
}).strict();
export type ComposePreviewV1 = z.infer<typeof composePreviewSchema>;
