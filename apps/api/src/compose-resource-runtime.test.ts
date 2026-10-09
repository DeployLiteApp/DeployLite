import { describe, expect, it, vi } from "vitest";
import type { ProjectUpdateControlRepository, ProjectRepository } from "@deploylite/domain";
import { createProjectScopedComposeResourceRuntime, parseComposeResourceCleanupProjectBindings, parseComposeResourceProjectBindings, parseComposeVolumeAttachmentProjectBindings } from "./compose-resource-runtime.js";

const trustKey = "compose_network_transport_test_key_123";
const project = { id: "project-one", name: "One", repoUrl: "https://github.com/DeployLiteApp/DeployLite", defaultBranch: "main",
  buildCommand: null, runCommand: null, port: null, description: null, imageTag: null };
const controls = {
  resolve: vi.fn(), complete: vi.fn(), findProjectUpdateByIdempotency: vi.fn(), claimProjectUpdate: vi.fn(),
  validateProjectUpdateAuthority: vi.fn(), completeProjectUpdate: vi.fn()
} as unknown as ProjectUpdateControlRepository;

describe("project-scoped Compose runtime configuration", () => {
  it("keeps runtime resources disabled when the opt-in setting is absent", () => {
    expect(parseComposeResourceProjectBindings(undefined)).toEqual([]);
    expect(parseComposeResourceProjectBindings(" ")).toEqual([]);
  });

  it("parses only unique explicit project-to-agent bindings", () => {
    expect(parseComposeResourceProjectBindings(JSON.stringify([{ projectId: "project-one", agentId: "agent-one" }]))).toEqual([
      { projectId: "project-one", agentId: "agent-one" }
    ]);
    expect(() => parseComposeResourceProjectBindings(JSON.stringify([
      { projectId: "project-one", agentId: "agent-one" }, { projectId: "project-one", agentId: "agent-one" }
    ]))).toThrow(/DEPLOYLITE_COMPOSE_RESOURCE_PROJECT_AGENTS_JSON/);
  });

  it("keeps volume replacement opt-in empty and restricts it to the existing resource allowlist", () => {
    const resourceBindings = [{ projectId: "project-one", agentId: "agent-one" }, { projectId: "project-two", agentId: "agent-one" }];
    expect(parseComposeVolumeAttachmentProjectBindings(undefined, resourceBindings)).toEqual([]);
    expect(parseComposeVolumeAttachmentProjectBindings(JSON.stringify([resourceBindings[0]]), resourceBindings)).toEqual([resourceBindings[0]]);
    expect(() => parseComposeVolumeAttachmentProjectBindings(JSON.stringify([{ projectId: "project-three", agentId: "agent-one" }]), resourceBindings))
      .toThrow(/DEPLOYLITE_COMPOSE_VOLUME_ATTACHMENT_PROJECT_AGENTS_JSON/);
    expect(() => parseComposeVolumeAttachmentProjectBindings(JSON.stringify([{ projectId: "project-one", agentId: "agent-other" }]), resourceBindings))
      .toThrow(/DEPLOYLITE_COMPOSE_VOLUME_ATTACHMENT_PROJECT_AGENTS_JSON/);
  });

  it("keeps physical cleanup opt-in empty and restricts it to the existing resource allowlist", () => {
    const resourceBindings = [{ projectId: "project-one", agentId: "agent-one" }, { projectId: "project-two", agentId: "agent-one" }];
    expect(parseComposeResourceCleanupProjectBindings(undefined, resourceBindings)).toEqual([]);
    expect(parseComposeResourceCleanupProjectBindings(JSON.stringify([resourceBindings[0]]), resourceBindings)).toEqual([resourceBindings[0]]);
    expect(() => parseComposeResourceCleanupProjectBindings(JSON.stringify([{ projectId: "project-three", agentId: "agent-one" }]), resourceBindings))
      .toThrow(/DEPLOYLITE_COMPOSE_RESOURCE_CLEANUP_PROJECT_AGENTS_JSON/);
    expect(() => parseComposeResourceCleanupProjectBindings(JSON.stringify([{ projectId: "project-one", agentId: "agent-other" }]), resourceBindings))
      .toThrow(/DEPLOYLITE_COMPOSE_RESOURCE_CLEANUP_PROJECT_AGENTS_JSON/);
  });

  it("creates inspection and attachment access only for configured projects and binds the shared update authority", async () => {
    const projects = { findById: vi.fn(async (id: string) => id === project.id ? project : null) } as unknown as ProjectRepository;
    const runtime = await createProjectScopedComposeResourceRuntime({
      bindings: [{ projectId: project.id, agentId: "agent-one" }], volumeAttachmentBindings: [{ projectId: project.id, agentId: "agent-one" }],
      cleanupBindings: [{ projectId: project.id, agentId: "agent-one" }], projects, controls,
      agent: { endpoint: "https://agent.internal", agentId: "agent-one", trustKey }
    });

    expect([...runtime.inspectionAccess.keys()]).toEqual([project.id]);
    expect([...runtime.attachmentExecutions.keys()]).toEqual([project.id]);
    expect(runtime.inspectionAccess.get(project.id)).toMatchObject({ owner: "deploylite", agentId: "agent-one", deadlineMs: 30_000, maxAgeMs: 30_000 });
    expect(runtime.attachmentExecutions.get(project.id)?.controls).toBe(controls);
    expect(runtime.attachmentExecutions.get(project.id)?.commandTtlMs).toBe(30_000);
    expect([...runtime.volumeAttachmentExecutions.keys()]).toEqual([project.id]);
    expect(runtime.volumeAttachmentExecutions.get(project.id)?.controls).toBe(controls);
    expect(runtime.volumeAttachmentExecutions.get(project.id)?.commandTtlMs).toBe(30_000);
    expect([...runtime.cleanupExecutions.keys()]).toEqual([project.id]);
    expect(runtime.cleanupExecutions.get(project.id)?.transport).toBeDefined();
    expect(runtime.attachmentExecutions.get("another-project")).toBeUndefined();
    expect(runtime.volumeAttachmentExecutions.get("another-project")).toBeUndefined();
    expect(projects.findById).toHaveBeenCalledWith(project.id);
  });

  it("fails closed when a binding points at another agent or project-update authority is unavailable", async () => {
    const projects = { findById: vi.fn(async () => project) } as unknown as ProjectRepository;
    await expect(createProjectScopedComposeResourceRuntime({
      bindings: [{ projectId: project.id, agentId: "agent-other" }], projects, controls,
      agent: { endpoint: "https://agent.internal", agentId: "agent-one", trustKey }
    })).rejects.toThrow(/agent identity/);
    await expect(createProjectScopedComposeResourceRuntime({
      bindings: [{ projectId: project.id, agentId: "agent-one" }], projects, controls: {},
      agent: { endpoint: "https://agent.internal", agentId: "agent-one", trustKey }
    })).rejects.toThrow(/project.update authority/);
    await expect(createProjectScopedComposeResourceRuntime({
      bindings: [{ projectId: project.id, agentId: "agent-one" }], volumeAttachmentBindings: [{ projectId: "project-other", agentId: "agent-one" }], projects, controls,
      agent: { endpoint: "https://agent.internal", agentId: "agent-one", trustKey }
    })).rejects.toThrow(/subset/);
  });

  it("refuses configuration for a project that does not exist", async () => {
    const projects = { findById: vi.fn(async () => null) } as unknown as ProjectRepository;
    await expect(createProjectScopedComposeResourceRuntime({
      bindings: [{ projectId: "missing", agentId: "agent-one" }], projects, controls,
      agent: { endpoint: "https://agent.internal", agentId: "agent-one", trustKey }
    })).rejects.toThrow(/configured project/);
  });
});
