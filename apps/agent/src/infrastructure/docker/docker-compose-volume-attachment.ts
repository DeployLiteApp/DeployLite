import { createHash } from "node:crypto";
import { openAgentSecretEnvelope } from "@deploylite/config";
import { COMPOSE_VOLUME_ATTACHMENT_CAPABILITY, composeResourceObservationSchema, composeVolumeAttachmentAgentCommandSchema,
  composeVolumeAttachmentReceiptSchema, protocolPayloadFingerprint, type CapabilityRegistry, type ComposePreviewV1,
  type ComposeResourceObservationV1, type ComposeVolumeAttachmentAgentCommandV1, type ComposeVolumeAttachmentReceiptV1,
  type ImageReferencePolicyV1 } from "@deploylite/contracts";
import { awaitAbortable, createComposePreview, digestComposeResourceObservation, type ComposeResourceInspector } from "@deploylite/domain";

export type ComposeVolumeReplacementCandidateV1 = Readonly<{
  containerId: string; owner: string; projectId: string; service: string; commandId: string; revisionId: string;
  configDigest: string; environmentDigest: string; image: string; running: boolean;
  networks: readonly string[]; mounts: readonly Readonly<{ source: string; target: string; readOnly: boolean }>[];
}>;
export type ComposeVolumeReplacementDriver = Readonly<{
  inspectContainer(containerId: string, signal: AbortSignal): Promise<Readonly<{ healthcheck: boolean; health: string | null; writableLayerClean: boolean }>>;
  findCandidate(name: string, signal: AbortSignal): Promise<ComposeVolumeReplacementCandidateV1 | null>;
  createCandidate(input: Readonly<{ name: string; command: ComposeVolumeAttachmentAgentCommandV1; preview: ComposePreviewV1; environment: Readonly<Record<string, string>> }>, signal: AbortSignal): Promise<string>;
  waitUntilHealthy(containerId: string, timeoutMs: number, signal: AbortSignal): Promise<boolean>;
  cutover(input: Readonly<{ priorContainerId: string; candidateContainerId: string; networkName: string; service: string }>, signal: AbortSignal): Promise<void>;
  restorePrior(input: Readonly<{ priorContainerId: string; candidateContainerId: string; networkName: string; service: string }>, signal: AbortSignal): Promise<void>;
  removeCandidate(containerId: string, commandId: string, signal: AbortSignal): Promise<void>;
}>;
export type DockerComposeVolumeAttachmentOptions = Readonly<{
  inspector: ComposeResourceInspector; driver: ComposeVolumeReplacementDriver; owner: string; agentId: string;
  trustKey: string; imagePolicy: ImageReferencePolicyV1; capabilities: CapabilityRegistry; clock?: { now(): number };
}>;

function fail(message: string): never { throw new Error(message); }
function same(left: unknown, right: unknown): boolean { return protocolPayloadFingerprint(left) === protocolPayloadFingerprint(right); }
function candidateName(commandId: string): string { return `dl-${createHash("sha256").update(commandId).digest("hex").slice(0, 32)}-vol-candidate`; }
function documentWithoutSelectedMount(preview: ComposePreviewV1, service: string, key: string): unknown {
  const document = JSON.parse(preview.canonicalDocument) as { services: Record<string, { volumes: Array<{ source: string }> }> };
  const selected = document.services[service];
  if (!selected) fail("volume replacement service is absent from saved revision");
  return { ...document, services: { ...document.services, [service]: { ...selected, volumes: selected.volumes.filter(mount => mount.source !== key) } } };
}
function parseBoundPreviews(command: ComposeVolumeAttachmentAgentCommandV1, imagePolicy: ImageReferencePolicyV1) {
  const prior = createComposePreview(command.priorCanonicalDocument, command.projectId, imagePolicy);
  const next = createComposePreview(command.canonicalDocument, command.projectId, imagePolicy);
  if (prior.configDigest !== command.priorConfigDigest || next.configDigest !== command.configDigest
    || protocolPayloadFingerprint(documentWithoutSelectedMount(prior, command.service, command.key))
      !== protocolPayloadFingerprint(documentWithoutSelectedMount(next, command.service, command.key))) fail("volume replacement saved configuration is not reconstructable");
  const oldService = prior.services.find(value => value.name === command.service), newService = next.services.find(value => value.name === command.service);
  const oldVolume = prior.volumes.find(value => value.key === command.key), newVolume = next.volumes.find(value => value.key === command.key);
  if (!oldService || !newService || !oldVolume || !newVolume || oldVolume.runtimeName !== command.runtimeName || newVolume.runtimeName !== command.runtimeName
    || prior.policyVersion !== next.policyVersion || oldService.networks.length !== 1 || newService.networks.length !== 1
    || oldService.volumes.length !== (command.attachmentAction === "attach" ? 0 : 1)
    || newService.volumes.length !== (command.attachmentAction === "attach" ? 1 : 0)
    || oldService.secretRefs.length !== newService.secretRefs.length || !same(oldService.secretRefs, newService.secretRefs)
    || oldService.image !== newService.image || !same(oldService.networks, newService.networks)) fail("volume replacement is outside the reconstructable Compose subset");
  const oldMounts = oldService.volumes.filter(value => value.source === command.key), newMounts = newService.volumes.filter(value => value.source === command.key);
  if ((command.attachmentAction === "attach" && (oldMounts.length !== 0 || newMounts.length !== 1))
    || (command.attachmentAction === "detach" && (oldMounts.length !== 1 || newMounts.length !== 0))) fail("volume replacement mount delta rejected");
  return { prior, next, oldService, newService, oldVolume, newVolume };
}
function observationFor(raw: unknown, command: ComposeVolumeAttachmentAgentCommandV1, preview: ComposePreviewV1, owner: string, kind: "network" | "volume", key: string): ComposeResourceObservationV1 {
  const parsed = composeResourceObservationSchema.safeParse(raw);
  if (!parsed.success) fail("volume replacement observation rejected");
  const value = parsed.data;
  const validIdentity = kind === "volume"
    ? /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value.physicalIdentity) && Number.isFinite(Date.parse(value.physicalIdentity))
    : /^[a-f0-9]{64}$/.test(value.physicalIdentity);
  const resource = (kind === "network" ? preview.networks : preview.volumes).find(item => item.key === key);
  if (digestComposeResourceObservation(value) !== value.stateDigest || value.owner !== owner || value.agentId !== command.agentId
    || value.projectId !== command.projectId || value.kind !== kind || value.key !== key || !resource
    || value.runtimeName !== resource.runtimeName || value.configDigest !== preview.configDigest || !validIdentity) fail("volume replacement observation binding rejected");
  return value;
}
function validCandidate(candidate: ComposeVolumeReplacementCandidateV1, command: ComposeVolumeAttachmentAgentCommandV1,
  preview: ComposePreviewV1, environmentDigest: string, networkName: string, owner: string): boolean {
  const service = preview.services.find(value => value.name === command.service);
  return Boolean(service && /^[a-f0-9]{64}$/.test(candidate.containerId) && candidate.owner === owner
    && candidate.projectId === command.projectId && candidate.service === command.service && candidate.commandId === command.commandId
    && candidate.revisionId === command.revisionId && candidate.configDigest === command.configDigest
    && candidate.environmentDigest === environmentDigest && candidate.image === service.image && candidate.running
    && same(candidate.networks, [networkName])
    && same(candidate.mounts, service.volumes.map(mount => ({ source: command.runtimeName, target: mount.target, readOnly: mount.readOnly }))));
}

/**
 * Replaces only a healthy, clean, revision-labelled Compose service. Every runtime
 * port is injected: unit tests cannot contact Docker, and no port can delete volumes.
 */
export function createDockerComposeVolumeAttachmentExecutor(supplied: DockerComposeVolumeAttachmentOptions) {
  const options = { ...supplied, imagePolicy: structuredClone(supplied.imagePolicy) };
  return {
    async execute(raw: ComposeVolumeAttachmentAgentCommandV1, authority: Readonly<{ assertValid(): Promise<void> }>, signal: AbortSignal): Promise<ComposeVolumeAttachmentReceiptV1> {
      const command = composeVolumeAttachmentAgentCommandSchema.parse(structuredClone(raw));
      if (!options.capabilities.has(COMPOSE_VOLUME_ATTACHMENT_CAPABILITY) || command.agentId !== options.agentId) fail("volume replacement capability or agent scope rejected");
      const { prior, next, oldService, newService } = parseBoundPreviews(command, options.imagePolicy);
      const environment = openAgentSecretEnvelope(command.sealedEnvironment, options.trustKey,
        { agentId: command.agentId, commandId: command.commandId, inputDigest: command.inputDigest, projectId: command.projectId });
      if (!same(Object.keys(environment).sort(), newService.secretRefs.map(value => value.key).sort())) fail("volume replacement secret references rejected");
      const canonicalEnvironment = Object.fromEntries(Object.entries(environment).sort(([a], [b]) => a.localeCompare(b)));
      const environmentDigest = createHash("sha256").update(JSON.stringify(canonicalEnvironment)).digest("hex");
      if (environmentDigest !== command.secretDigest) fail("volume replacement environment binding rejected");
      const networkName = next.networks.find(value => value.key === newService.networks[0])?.runtimeName;
      if (!networkName || networkName !== prior.networks.find(value => value.key === oldService.networks[0])?.runtimeName) fail("volume replacement network binding rejected");
      const inspect = async (preview: ComposePreviewV1, kind: "network" | "volume", key: string, inspectionSignal = signal) => observationFor(
        await awaitAbortable(() => options.inspector.inspect({ preview, kind, key }, inspectionSignal), inspectionSignal), command, preview, options.owner, kind, key);
      const already = await inspect(next, "volume", command.key);
      const networkBefore = await inspect(next, "network", newService.networks[0]!);
      const priorNetworkBefore = await inspect(prior, "network", oldService.networks[0]!);
      if (networkBefore.physicalIdentity !== priorNetworkBefore.physicalIdentity) fail("volume replacement network identity changed");
      const alreadyContainer = already.containers.filter(value => value.service === command.service);
      const alreadyNetworkTarget = networkBefore.containers.filter(value => value.service === command.service);
      if (alreadyNetworkTarget.length !== 1 || !alreadyNetworkTarget[0]!.attached
        || alreadyNetworkTarget[0]!.containerId !== alreadyContainer[0]?.containerId) fail("volume replacement network observation rejected");
      const deterministicName = candidateName(command.commandId);
      const existingCandidate = await options.driver.findCandidate(deterministicName, signal);
      if (existingCandidate && !validCandidate(existingCandidate, command, next, environmentDigest, networkName, options.owner)) fail("volume replacement candidate ownership conflict");
      const alreadyTarget = alreadyContainer[0];
      const alreadyMounts = newService.volumes.map(value => ({ target: value.target, readOnly: value.readOnly }));
      const verifyPriorRestored = async (recoverySignal: AbortSignal, volumeIdentity: string, networkIdentity: string) => {
        const [restoredVolume, restoredNetwork] = await Promise.all([
          inspect(prior, "volume", command.key, recoverySignal), inspect(prior, "network", oldService.networks[0]!, recoverySignal)
        ]);
        const restored = restoredVolume.containers.filter(value => value.service === command.service);
        const networkTarget = restoredNetwork.containers.filter(value => value.service === command.service);
        const priorMounts = oldService.volumes.map(value => ({ target: value.target, readOnly: value.readOnly }));
        if (restoredVolume.physicalIdentity !== volumeIdentity || restoredNetwork.physicalIdentity !== networkIdentity
          || restored.length !== 1 || restored[0]!.containerId !== command.containerId || !restored[0]!.running
          || restored[0]!.composeRevisionId !== command.priorRevisionId || restored[0]!.composeConfigDigest !== command.priorConfigDigest
          || restored[0]!.composeEnvironmentDigest !== command.secretDigest || restored[0]!.attached !== (command.attachmentAction === "detach")
          || !same(restored[0]!.mounts, priorMounts) || !same(restored[0]!.networks?.map(value => value.name).sort(), [networkName])
          || restored[0]!.networks?.find(value => value.name === networkName)?.networkId !== networkIdentity
          || networkTarget.length !== 1 || networkTarget[0]!.containerId !== command.containerId || !networkTarget[0]!.attached
          || restoredVolume.containers.some(value => value.service !== command.service && value.attached)
          || !await awaitAbortable(() => options.driver.waitUntilHealthy(command.containerId, 5_000, recoverySignal), recoverySignal)) {
          throw new Error("prior Compose service restoration could not be verified");
        }
        return restoredVolume;
      };
      if (alreadyContainer.length === 1 && alreadyTarget && existingCandidate && alreadyTarget.containerId === existingCandidate.containerId
        && alreadyTarget.composeRevisionId === command.revisionId && alreadyTarget.composeConfigDigest === command.configDigest
        && alreadyTarget.composeEnvironmentDigest === command.secretDigest && alreadyTarget.attached === (command.attachmentAction === "attach")
        && same(alreadyTarget.mounts, alreadyMounts) && same(alreadyTarget.networks?.map(value => value.name).sort(), [networkName])
        && validCandidate(existingCandidate, command, next, environmentDigest, networkName, options.owner)) {
        const health = await awaitAbortable(() => options.driver.waitUntilHealthy(existingCandidate.containerId, 5_000, signal), signal);
        if (health) return composeVolumeAttachmentReceiptSchema.parse({ schemaVersion: 1, action: "compose.volume.attachment", agentId: command.agentId,
          commandId: command.commandId, projectId: command.projectId, inputDigest: command.inputDigest, correlationId: command.context.correlationId,
          key: command.key, runtimeName: command.runtimeName, service: command.service, attachmentAction: command.attachmentAction,
          priorContainerId: command.containerId, replacementContainerId: existingCandidate.containerId, resourceCreatedAt: already.physicalIdentity,
          beforeStateDigest: command.stateDigest, afterStateDigest: already.stateDigest, observedAt: (options.clock ?? { now: Date.now }).now(),
          status: "already-satisfied", health: "passed", rollback: "not-required", reconciled: true, redacted: true, reason: null });
        const recovery = new AbortController();
        const recoveryTimer = setTimeout(() => recovery.abort(), 10_000);
        let rollback: "restored" | "failed" = "restored", afterStateDigest = already.stateDigest;
        try {
          await options.driver.restorePrior({ priorContainerId: command.containerId, candidateContainerId: existingCandidate.containerId, networkName, service: command.service }, recovery.signal);
          const restoredVolume = await verifyPriorRestored(recovery.signal, already.physicalIdentity, networkBefore.physicalIdentity);
          afterStateDigest = restoredVolume.stateDigest;
          await options.driver.removeCandidate(existingCandidate.containerId, command.commandId, recovery.signal);
        } catch { rollback = "failed"; }
        clearTimeout(recoveryTimer);
        return composeVolumeAttachmentReceiptSchema.parse({ schemaVersion: 1, action: "compose.volume.attachment", agentId: command.agentId,
          commandId: command.commandId, projectId: command.projectId, inputDigest: command.inputDigest, correlationId: command.context.correlationId,
          key: command.key, runtimeName: command.runtimeName, service: command.service, attachmentAction: command.attachmentAction,
          priorContainerId: command.containerId, replacementContainerId: existingCandidate.containerId, resourceCreatedAt: already.physicalIdentity,
          beforeStateDigest: already.stateDigest, afterStateDigest, observedAt: (options.clock ?? { now: Date.now }).now(),
          status: "failed", health: "failed", rollback, reconciled: true, redacted: true, reason: rollback === "failed" ? "rollback-failed" : "candidate-failed" });
      }

      const before = await inspect(prior, "volume", command.key);
      const priorNetwork = await inspect(prior, "network", oldService.networks[0]!);
      if (priorNetwork.physicalIdentity !== networkBefore.physicalIdentity) fail("volume replacement network identity changed");
      const targets = before.containers.filter(value => value.service === command.service);
      const expectedOldMounts = oldService.volumes.map(value => ({ target: value.target, readOnly: value.readOnly }));
      const expectedNewStateBefore = command.attachmentAction === "attach" ? false : true;
      const oldContainer = targets[0];
      if (targets.length !== 1 || !oldContainer || oldContainer.containerId !== command.containerId || !oldContainer.running
        || oldContainer.composeRevisionId !== command.priorRevisionId || oldContainer.composeConfigDigest !== command.priorConfigDigest
        || oldContainer.composeEnvironmentDigest !== command.secretDigest || oldContainer.attached !== expectedNewStateBefore
        || !same(oldContainer.mounts, expectedOldMounts) || !same(oldContainer.networks?.map(value => value.name).sort(), [networkName])
        || oldContainer.networks?.find(value => value.name === networkName)?.networkId !== priorNetwork.physicalIdentity) fail("volume replacement prior state is stale or not reconstructable");
      const oldNetworkTarget = priorNetwork.containers.filter(value => value.service === command.service);
      if (oldNetworkTarget.length !== 1 || oldNetworkTarget[0]!.containerId !== command.containerId || !oldNetworkTarget[0]!.attached) fail("volume replacement prior network attachment is stale");
      if (before.stateDigest !== command.stateDigest) fail("volume replacement observation is stale");
      const physical = await awaitAbortable(() => options.driver.inspectContainer(command.containerId, signal), signal);
      if (!physical.healthcheck || physical.health !== "healthy" || !physical.writableLayerClean) fail("volume replacement preflight rejected the current container");
      if (signal.aborted) throw signal.reason;
      const receipt = (input: { replacementId: string; status: ComposeVolumeAttachmentReceiptV1["status"]; health: ComposeVolumeAttachmentReceiptV1["health"];
        rollback: ComposeVolumeAttachmentReceiptV1["rollback"]; reason: ComposeVolumeAttachmentReceiptV1["reason"]; afterDigest: string; reconciled: boolean }) => composeVolumeAttachmentReceiptSchema.parse({
          schemaVersion: 1, action: "compose.volume.attachment", agentId: command.agentId, commandId: command.commandId, projectId: command.projectId,
          inputDigest: command.inputDigest, correlationId: command.context.correlationId, key: command.key, runtimeName: command.runtimeName,
          service: command.service, attachmentAction: command.attachmentAction, priorContainerId: command.containerId,
          replacementContainerId: input.replacementId, resourceCreatedAt: before.physicalIdentity, beforeStateDigest: before.stateDigest,
          afterStateDigest: input.afterDigest, observedAt: (options.clock ?? { now: Date.now }).now(), status: input.status,
          health: input.health, rollback: input.rollback, reconciled: input.reconciled, redacted: true, reason: input.reason
        });

      let candidateId = existingCandidate?.containerId;
      let reconciled = Boolean(candidateId);
      if (existingCandidate && !await awaitAbortable(() => options.driver.waitUntilHealthy(existingCandidate.containerId, 5_000, signal), signal)) {
        await awaitAbortable(() => options.driver.removeCandidate(existingCandidate.containerId, command.commandId, signal), signal);
        candidateId = undefined;
        reconciled = false;
      }
      if (!candidateId) {
        await awaitAbortable(() => authority.assertValid(), signal);
        candidateId = await awaitAbortable(() => options.driver.createCandidate({ name: deterministicName, command, preview: next, environment }, signal), signal);
        if (!/^[a-f0-9]{64}$/.test(candidateId)) fail("volume replacement candidate identity rejected");
      }
      let candidate = await awaitAbortable(() => options.driver.findCandidate(deterministicName, signal), signal);
      if (!candidate || candidate.containerId !== candidateId || !validCandidate(candidate, command, next, environmentDigest, networkName, options.owner)) fail("volume replacement candidate verification failed");
      const candidateHealthy = await awaitAbortable(() => options.driver.waitUntilHealthy(candidateId, 30_000, signal), signal);
      if (!candidateHealthy) {
        await awaitAbortable(() => options.driver.removeCandidate(candidateId!, command.commandId, signal), signal);
        return receipt({ replacementId: candidateId, status: "failed", health: "failed", rollback: "not-required", reason: "candidate-failed", afterDigest: before.stateDigest, reconciled });
      }
      await awaitAbortable(() => authority.assertValid(), signal);
      let cutoverAttempted = false, cutoverComplete = false;
      try {
        cutoverAttempted = true;
        await awaitAbortable(() => options.driver.cutover({ priorContainerId: command.containerId, candidateContainerId: candidateId!, networkName, service: command.service }, signal), signal);
        cutoverComplete = true;
        const after = await inspect(next, "volume", command.key);
        const afterNetwork = await inspect(next, "network", newService.networks[0]!);
        const afterNetworkTarget = afterNetwork.containers.filter(value => value.service === command.service);
        if (afterNetwork.physicalIdentity !== networkBefore.physicalIdentity || afterNetworkTarget.length !== 1
          || afterNetworkTarget[0]!.containerId !== candidateId || !afterNetworkTarget[0]!.attached) throw new Error("replacement network postcondition failed");
        const target = after.containers.filter(value => value.service === command.service);
        const priorMounts = newService.volumes.map(value => ({ target: value.target, readOnly: value.readOnly }));
        if (target.length !== 1 || target[0]!.containerId !== candidateId || !target[0]!.running
          || target[0]!.composeRevisionId !== command.revisionId || target[0]!.composeConfigDigest !== command.configDigest
          || target[0]!.composeEnvironmentDigest !== command.secretDigest || target[0]!.attached !== (command.attachmentAction === "attach")
          || !same(target[0]!.mounts, priorMounts) || !same(target[0]!.networks?.map(value => value.name).sort(), [networkName])
          || !await awaitAbortable(() => options.driver.waitUntilHealthy(candidateId!, 5_000, signal), signal)) throw new Error("replacement postcondition failed");
        return receipt({ replacementId: candidateId, status: "replaced", health: "passed", rollback: "not-required", reason: null,
          afterDigest: after.stateDigest, reconciled });
      } catch {
        let rollback: "restored" | "failed" = "restored";
        const recovery = new AbortController();
        const recoveryTimer = setTimeout(() => recovery.abort(), 10_000);
        if (cutoverAttempted) {
          try {
            await options.driver.restorePrior({ priorContainerId: command.containerId, candidateContainerId: candidateId!, networkName, service: command.service }, recovery.signal);
            await verifyPriorRestored(recovery.signal, before.physicalIdentity, priorNetwork.physicalIdentity);
            await options.driver.removeCandidate(candidateId!, command.commandId, recovery.signal);
          } catch { rollback = "failed"; }
        } else {
          try { await options.driver.removeCandidate(candidateId!, command.commandId, recovery.signal); }
          catch { rollback = "failed"; }
        }
        clearTimeout(recoveryTimer);
        return receipt({ replacementId: candidateId, status: "failed", health: "failed", rollback,
          reason: rollback === "failed" ? "rollback-failed" : cutoverComplete ? "postcondition-failed" : "cutover-failed",
          afterDigest: before.stateDigest, reconciled });
      }
    }
  };
}
