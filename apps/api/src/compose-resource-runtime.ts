import { z } from "zod";
import { COMPOSE_RESOURCE_INSPECTION_CAPABILITY, InMemoryCapabilityRegistry } from "@deploylite/contracts";
import type { ProjectRepository, ProjectUpdateControlRepository } from "@deploylite/domain";
import { AuthenticatedAgentDeploymentTransport } from "./agent-transport.js";
import type { ComposeResourceCleanupExecutionAccess } from "./compose-resource-cleanup-route.js";
import type { ComposeNetworkAttachmentExecutionAccess } from "./compose-network-attachment-execution-route.js";
import type { ComposeVolumeAttachmentExecutionAccess } from "./compose-volume-attachment-execution-route.js";
import { AuthenticatedAgentComposeResourceInspectionTransport } from "./compose-resource-inspection-transport.js";
import type { ComposeResourceInspectionAccess } from "./compose-resource-inspection-route.js";

export const COMPOSE_RESOURCE_PROJECT_AGENTS_ENV = "DEPLOYLITE_COMPOSE_RESOURCE_PROJECT_AGENTS_JSON" as const;
export const COMPOSE_VOLUME_ATTACHMENT_PROJECT_AGENTS_ENV = "DEPLOYLITE_COMPOSE_VOLUME_ATTACHMENT_PROJECT_AGENTS_JSON" as const;
export const COMPOSE_RESOURCE_CLEANUP_PROJECT_AGENTS_ENV = "DEPLOYLITE_COMPOSE_RESOURCE_CLEANUP_PROJECT_AGENTS_JSON" as const;
const identity = /^[A-Za-z0-9_-]{1,200}$/;
const bindingsSchema = z.array(z.object({ projectId: z.string().regex(identity), agentId: z.string().regex(identity) }).strict()).min(1).max(128);

export type ComposeResourceProjectBinding = Readonly<{ projectId: string; agentId: string }>;
export type ProjectScopedComposeResourceRuntime = Readonly<{
  inspectionAccess: ReadonlyMap<string, ComposeResourceInspectionAccess>;
  attachmentExecutions: ReadonlyMap<string, ComposeNetworkAttachmentExecutionAccess>;
  volumeAttachmentExecutions: ReadonlyMap<string, ComposeVolumeAttachmentExecutionAccess>;
  cleanupExecutions: ReadonlyMap<string, ComposeResourceCleanupExecutionAccess>;
}>;
export type ProjectScopedComposeResourceRuntimeInput = Readonly<{
  bindings: readonly ComposeResourceProjectBinding[];
  volumeAttachmentBindings?: readonly ComposeResourceProjectBinding[];
  cleanupBindings?: readonly ComposeResourceProjectBinding[];
  projects: ProjectRepository;
  controls: unknown;
  agent: Readonly<{ endpoint?: string; agentId?: string; trustKey?: string }>;
}>;

export function parseComposeResourceProjectBindings(value: string | undefined): readonly ComposeResourceProjectBinding[] {
  if (value === undefined || value.trim() === "") return [];
  let raw: unknown;
  try { raw = JSON.parse(value); } catch { throw new Error(`${COMPOSE_RESOURCE_PROJECT_AGENTS_ENV} must be valid JSON.`); }
  const parsed = bindingsSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${COMPOSE_RESOURCE_PROJECT_AGENTS_ENV} must be a non-empty array of projectId/agentId bindings.`);
  const projectIds = new Set<string>();
  for (const binding of parsed.data) {
    if (projectIds.has(binding.projectId)) throw new Error(`${COMPOSE_RESOURCE_PROJECT_AGENTS_ENV} must not repeat a projectId.`);
    projectIds.add(binding.projectId);
  }
  return parsed.data;
}

export function parseComposeVolumeAttachmentProjectBindings(value: string | undefined, resourceBindings: readonly ComposeResourceProjectBinding[]): readonly ComposeResourceProjectBinding[] {
  if (value === undefined || value.trim() === "") return [];
  let raw: unknown;
  try { raw = JSON.parse(value); } catch { throw new Error(`${COMPOSE_VOLUME_ATTACHMENT_PROJECT_AGENTS_ENV} must be valid JSON.`); }
  const parsed = bindingsSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${COMPOSE_VOLUME_ATTACHMENT_PROJECT_AGENTS_ENV} must be a non-empty array of projectId/agentId bindings.`);
  const resourceProjects = new Map(resourceBindings.map(binding => [binding.projectId, binding.agentId]));
  const projectIds = new Set<string>();
  for (const binding of parsed.data) {
    if (projectIds.has(binding.projectId) || resourceProjects.get(binding.projectId) !== binding.agentId)
      throw new Error(`${COMPOSE_VOLUME_ATTACHMENT_PROJECT_AGENTS_ENV} must be a unique subset of ${COMPOSE_RESOURCE_PROJECT_AGENTS_ENV}.`);
    projectIds.add(binding.projectId);
  }
  return parsed.data;
}

export function parseComposeResourceCleanupProjectBindings(value: string | undefined, resourceBindings: readonly ComposeResourceProjectBinding[]): readonly ComposeResourceProjectBinding[] {
  if (value === undefined || value.trim() === "") return [];
  let raw: unknown;
  try { raw = JSON.parse(value); } catch { throw new Error(`${COMPOSE_RESOURCE_CLEANUP_PROJECT_AGENTS_ENV} must be valid JSON.`); }
  const parsed = bindingsSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${COMPOSE_RESOURCE_CLEANUP_PROJECT_AGENTS_ENV} must be a non-empty array of projectId/agentId bindings.`);
  const resourceProjects = new Map(resourceBindings.map(binding => [binding.projectId, binding.agentId]));
  const projectIds = new Set<string>();
  for (const binding of parsed.data) {
    if (projectIds.has(binding.projectId) || resourceProjects.get(binding.projectId) !== binding.agentId)
      throw new Error(`${COMPOSE_RESOURCE_CLEANUP_PROJECT_AGENTS_ENV} must be a unique subset of ${COMPOSE_RESOURCE_PROJECT_AGENTS_ENV}.`);
    projectIds.add(binding.projectId);
  }
  return parsed.data;
}

function projectUpdateControls(value: unknown): ProjectUpdateControlRepository | null {
  if (typeof value !== "object" || value === null) return null;
  const required = ["resolve", "complete", "findProjectUpdateByIdempotency", "claimProjectUpdate", "validateProjectUpdateAuthority", "completeProjectUpdate"] as const;
  return required.every(method => typeof (value as Record<string, unknown>)[method] === "function")
    ? value as ProjectUpdateControlRepository : null;
}

/** Builds only the project bindings explicitly named in configuration; no default/global project access is granted. */
export async function createProjectScopedComposeResourceRuntime(input: ProjectScopedComposeResourceRuntimeInput): Promise<ProjectScopedComposeResourceRuntime> {
  const inspectionAccess = new Map<string, ComposeResourceInspectionAccess>();
  const attachmentExecutions = new Map<string, ComposeNetworkAttachmentExecutionAccess>();
  const volumeAttachmentExecutions = new Map<string, ComposeVolumeAttachmentExecutionAccess>();
  const cleanupExecutions = new Map<string, ComposeResourceCleanupExecutionAccess>();
  if (input.bindings.length === 0) {
    if (input.volumeAttachmentBindings?.length) throw new Error("Compose volume attachment bindings require the existing resource inspection project bindings.");
    if (input.cleanupBindings?.length) throw new Error("Compose resource cleanup bindings require the existing resource inspection project bindings.");
    return { inspectionAccess, attachmentExecutions, volumeAttachmentExecutions, cleanupExecutions };
  }

  const endpoint = input.agent.endpoint, agentId = input.agent.agentId, trustKey = input.agent.trustKey;
  if (!endpoint || !agentId || !trustKey) throw new Error("Compose resource project bindings require the configured authenticated agent endpoint, ID, and trust key.");
  const controls = projectUpdateControls(input.controls);
  if (!controls) throw new Error("Compose resource project bindings require the validated project.update authority repository.");

  const seen = new Set<string>();
  const volumeBindings = new Map((input.volumeAttachmentBindings ?? []).map(binding => [binding.projectId, binding.agentId]));
  const cleanupBindings = new Map((input.cleanupBindings ?? []).map(binding => [binding.projectId, binding.agentId]));
  if (volumeBindings.size !== (input.volumeAttachmentBindings ?? []).length || [...volumeBindings].some(([projectId, agentId]) => seen.has(projectId)
    || !input.bindings.some(binding => binding.projectId === projectId && binding.agentId === agentId))) {
    throw new Error("Compose volume attachment bindings must be a unique subset of the existing resource project bindings.");
  }
  if (cleanupBindings.size !== (input.cleanupBindings ?? []).length || [...cleanupBindings].some(([projectId, agentId]) =>
    !input.bindings.some(binding => binding.projectId === projectId && binding.agentId === agentId))) {
    throw new Error("Compose resource cleanup bindings must be a unique subset of the existing resource project bindings.");
  }
  for (const binding of input.bindings) {
    if (!identity.test(binding.projectId) || !identity.test(binding.agentId) || seen.has(binding.projectId))
      throw new Error("Compose resource project bindings are invalid.");
    seen.add(binding.projectId);
    if (binding.agentId !== agentId) throw new Error(`Compose resource project ${binding.projectId} agent identity does not match the configured authenticated agent.`);
    if (!await input.projects.findById(binding.projectId)) throw new Error(`Compose resource configured project ${binding.projectId} does not exist.`);

    const transportOptions = { endpoint, agentId, trustKey, allowInsecureInternal: true };
    const transport = new AuthenticatedAgentDeploymentTransport(transportOptions);
    const inspector = new AuthenticatedAgentComposeResourceInspectionTransport(transportOptions);
    if (!transport.available() || !inspector.available()) throw new Error(`Compose resource transport configuration is invalid for project ${binding.projectId}.`);
    inspectionAccess.set(binding.projectId, { owner: "deploylite", agentId, inspector, clock: { now: Date.now }, maxAgeMs: 30_000,
      capabilities: new InMemoryCapabilityRegistry([COMPOSE_RESOURCE_INSPECTION_CAPABILITY]), deadlineMs: 30_000 });
    attachmentExecutions.set(binding.projectId, { controls, transport, commandTtlMs: 30_000 });
    if (volumeBindings.has(binding.projectId)) {
      volumeAttachmentExecutions.set(binding.projectId, { controls, transport, commandTtlMs: 30_000 });
    }
    if (cleanupBindings.has(binding.projectId)) {
      cleanupExecutions.set(binding.projectId, { transport });
    }
  }
  return { inspectionAccess, attachmentExecutions, volumeAttachmentExecutions, cleanupExecutions };
}
