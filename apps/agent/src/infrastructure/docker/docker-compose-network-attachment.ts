import { composeNetworkAttachmentAgentCommandSchema, composeNetworkAttachmentReceiptSchema, composeResourceObservationSchema,
  type CapabilityRegistry, type ComposeNetworkAttachmentAgentCommandV1,
  type ComposeNetworkAttachmentReceiptV1, type ImageReferencePolicyV1 } from "@deploylite/contracts";
import { awaitAbortable, createComposePreview, digestComposeResourceObservation, type ComposeResourceInspector } from "@deploylite/domain";
import type { DockerCliRunner } from "./docker-cli-image-transport.js";

export type NetworkAttachmentAuthority = Readonly<{ assertValid(): Promise<void> }>;
export type DockerComposeNetworkAttachmentOptions = Readonly<{
  runner: DockerCliRunner; inspector: ComposeResourceInspector; imagePolicy: ImageReferencePolicyV1;
  capabilities: CapabilityRegistry; owner: string; agentId: string;
}>;
const failureReason = (): "mutation-failed" => "mutation-failed";
function commandFor(command: ComposeNetworkAttachmentAgentCommandV1): readonly string[] {
  return ["docker", "network", command.attachmentAction === "attach" ? "connect" : "disconnect", command.runtimeName, command.containerId];
}

/** Exact-ID network attachment execution. Its only process port is injected, so tests cannot reach a Docker daemon. */
export function createDockerComposeNetworkAttachmentExecutor(supplied: DockerComposeNetworkAttachmentOptions) {
  const options = { ...supplied, imagePolicy: structuredClone(supplied.imagePolicy) };
  return {
    async execute(raw: ComposeNetworkAttachmentAgentCommandV1, authority: NetworkAttachmentAuthority, signal: AbortSignal): Promise<ComposeNetworkAttachmentReceiptV1> {
      const command = composeNetworkAttachmentAgentCommandSchema.parse(structuredClone(raw));
      if (!options.capabilities.has("compose.resource.inspect.v1") || command.agentId !== options.agentId) throw new Error("network attachment capability or agent scope rejected");
      const preview = createComposePreview(command.canonicalDocument, command.projectId, options.imagePolicy);
      const resource = preview.networks.find(item => item.key === command.key);
      const service = preview.services.find(item => item.name === command.service);
      if (preview.configDigest !== command.configDigest || !resource || resource.runtimeName !== command.runtimeName || !service
        || service.networks.includes(command.key) !== (command.attachmentAction === "attach")) throw new Error("network attachment configuration binding rejected");

      const inspect = async (readSignal = signal) => {
        if (readSignal.aborted) throw readSignal.reason ?? new Error("network attachment canceled");
        const value = composeResourceObservationSchema.parse(await awaitAbortable(() => options.inspector.inspect({ preview, kind: "network", key: command.key }, readSignal), readSignal));
        if (digestComposeResourceObservation(value) !== value.stateDigest || value.owner !== options.owner || value.agentId !== options.agentId
          || value.projectId !== command.projectId || value.kind !== "network" || value.key !== command.key
          || value.runtimeName !== command.runtimeName || value.configDigest !== command.configDigest || !/^[a-f0-9]{64}$/.test(value.physicalIdentity)) {
          throw new Error("network attachment observation binding rejected");
        }
        const targets = value.containers.filter(item => item.service === command.service);
        if (targets.length !== 1 || targets[0]!.containerId !== command.containerId || targets[0]!.running
          || value.containers.some(item => item.attached && item.running)) throw new Error("network attachment target is unsafe or changed");
        return { value, target: targets[0]! };
      };
      const before = await inspect();
      const desired = before.target.attached === (command.attachmentAction === "attach");
      if (before.value.stateDigest !== command.stateDigest && !desired) throw new Error("network attachment state is stale");
      const terminalStatus = (already: boolean) => command.attachmentAction === "attach"
        ? already ? "already-attached" as const : "attached" as const
        : already ? "already-detached" as const : "detached" as const;
      const makeReceipt = (after: typeof before, status: ComposeNetworkAttachmentReceiptV1["status"], reconciled: boolean, reason: ComposeNetworkAttachmentReceiptV1["reason"]) => composeNetworkAttachmentReceiptSchema.parse({
        schemaVersion: 1, action: "compose.network.attachment", agentId: command.agentId, commandId: command.commandId,
        projectId: command.projectId, inputDigest: command.inputDigest, correlationId: command.context.correlationId,
        key: command.key, runtimeName: command.runtimeName, service: command.service, attachmentAction: command.attachmentAction,
        containerId: command.containerId, resourceId: before.value.physicalIdentity, beforeStateDigest: before.value.stateDigest,
        afterStateDigest: after.value.stateDigest, observedAt: after.value.observedAt, status, reconciled, redacted: true, reason
      });
      if (desired) return makeReceipt(before, terminalStatus(true), before.value.stateDigest !== command.stateDigest, null);

      let mutationError: unknown;
      try {
        await awaitAbortable(() => authority.assertValid(), signal);
        if (signal.aborted) throw signal.reason;
        const result = await awaitAbortable(() => options.runner.run(commandFor(command), signal), signal);
        if (result.exitCode !== 0 || result.signal !== null) mutationError = new Error("docker network operation failed");
      } catch (error) { mutationError = error; }
      const postcondition = new AbortController();
      const postconditionTimer = setTimeout(() => postcondition.abort(new Error("network attachment reconciliation timed out")), 5_000);
      let after: Awaited<ReturnType<typeof inspect>>;
      try { after = await inspect(postcondition.signal); }
      finally { clearTimeout(postconditionTimer); }
      if (after.value.physicalIdentity !== before.value.physicalIdentity || after.target.containerId !== before.target.containerId) throw new Error("network attachment resource identity changed");
      const satisfied = after.target.attached === (command.attachmentAction === "attach");
      if (satisfied && !mutationError) return makeReceipt(after, terminalStatus(false), false, null);
      if (satisfied && mutationError) return makeReceipt(after, terminalStatus(true), true, null);
      return makeReceipt(after, "failed", false, mutationError ? failureReason() : "postcondition-failed");
    }
  };
}
