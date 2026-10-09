import { composeResourceCleanupAgentCommandSchema, composeResourceCleanupExecutionReceiptSchema,
  COMPOSE_RESOURCE_CLEANUP_CAPABILITY, COMPOSE_RESOURCE_INSPECTION_CAPABILITY,
  type CapabilityRegistry, type ComposeResourceCleanupAgentCommandV1, type ComposeResourceCleanupExecutionReceiptV1,
  type ImageReferencePolicyV1 } from "@deploylite/contracts";
import { awaitAbortable, createComposePreview, digestControlInput, type ComposeResourceInspector } from "@deploylite/domain";
import type { DockerCliRunner } from "./docker-cli-image-transport.js";

export type DockerComposeResourceCleanupExecutorOptions = Readonly<{
  runner: DockerCliRunner; inspector: ComposeResourceInspector; owner: string; agentId: string;
  imagePolicy: ImageReferencePolicyV1; capabilities: CapabilityRegistry; now?: () => number;
}>;
export class ComposeResourceCleanupExecutorError extends Error {
  constructor() { super("Compose resource cleanup failed or is outside the supported scope."); this.name = "ComposeResourceCleanupExecutorError"; }
}
function fail(): never { throw new ComposeResourceCleanupExecutorError(); }
function cleanupDigest(command: ComposeResourceCleanupAgentCommandV1): string {
  return digestControlInput({ operation: "compose.resource.cleanup", commandId: command.commandId, confirmationId: command.confirmationId,
    projectId: command.projectId, agentId: command.agentId, inputDigest: command.inputDigest, kind: command.kind,
    key: command.key, configDigest: command.configDigest, stateDigest: command.stateDigest });
}

/** Removes one confirmed, currently observed owned resource and verifies its absence by exact name. */
export function createDockerComposeResourceCleanupExecutor(supplied: DockerComposeResourceCleanupExecutorOptions) {
  const options = { ...supplied, imagePolicy: structuredClone(supplied.imagePolicy) };
  return { async execute(raw: ComposeResourceCleanupAgentCommandV1, signal: AbortSignal): Promise<ComposeResourceCleanupExecutionReceiptV1> {
    const command = composeResourceCleanupAgentCommandSchema.parse(structuredClone(raw)), now = options.now ?? Date.now;
    const started = now(), deadline = started + command.timeoutMs;
    const current = () => {
      const instant = now();
      if (signal.aborted || !Number.isSafeInteger(instant) || instant < started || instant >= deadline || instant >= command.expiresAt
        || !options.capabilities.has(COMPOSE_RESOURCE_CLEANUP_CAPABILITY) || !options.capabilities.has(COMPOSE_RESOURCE_INSPECTION_CAPABILITY)) fail();
    };
    try {
      current();
      if (command.agentId !== options.agentId || command.cleanupCommandId !== command.commandId
        || command.cleanupInputDigest !== cleanupDigest(command)) fail();
      const preview = createComposePreview(command.canonicalDocument, command.projectId, options.imagePolicy);
      const selected = (command.kind === "network" ? preview.networks : preview.volumes).find(resource => resource.key === command.key);
      if (preview.configDigest !== command.configDigest || !selected || selected.runtimeName !== command.runtimeName) fail();
      const observation = await awaitAbortable(() => options.inspector.inspect({ preview, kind: command.kind, key: command.key }, signal), signal);
      current();
      if (observation.owner !== options.owner || observation.agentId !== options.agentId || observation.projectId !== command.projectId
        || observation.kind !== command.kind || observation.key !== command.key || observation.runtimeName !== command.runtimeName
        || observation.configDigest !== command.configDigest || observation.stateDigest !== command.stateDigest
        || observation.containers.some(container => container.attached)) fail();

      let removeUnknown = false;
      try {
        const removed = await awaitAbortable(() => options.runner.run(["docker", command.kind, "rm", command.runtimeName], signal), signal);
        current();
        if (removed.exitCode !== 0 || removed.signal !== null || Buffer.byteLength(removed.stdout, "utf8") > 65_536
          || Buffer.byteLength(removed.stderr, "utf8") > 65_536) removeUnknown = true;
      } catch { removeUnknown = true; }
      current();
      const readback = await awaitAbortable(() => options.runner.run(["docker", command.kind, "ls", "--filter", `name=^${command.runtimeName}$`, "--format", "{{.Name}}"], signal), signal);
      current();
      if (readback.exitCode !== 0 || readback.signal !== null || readback.stdout.trim() !== ""
        || Buffer.byteLength(readback.stdout, "utf8") > 65_536 || Buffer.byteLength(readback.stderr, "utf8") > 65_536) fail();
      return composeResourceCleanupExecutionReceiptSchema.parse({ schemaVersion: 1, action: "compose.resource.cleanup", agentId: options.agentId,
        commandId: command.commandId, cleanupCommandId: command.cleanupCommandId, confirmationId: command.confirmationId,
        projectId: command.projectId, inputDigest: command.inputDigest, cleanupInputDigest: command.cleanupInputDigest,
        correlationId: command.context.correlationId, kind: command.kind, key: command.key, runtimeName: command.runtimeName,
        configDigest: command.configDigest, stateDigest: command.stateDigest, status: "completed", physicalIdentity: observation.physicalIdentity,
        terminalStatus: "removed", idempotent: removeUnknown, redacted: true });
    } catch (error) {
      if (error instanceof ComposeResourceCleanupExecutorError) throw error;
      fail();
    }
  } };
}
