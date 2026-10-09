import type { ComposeVolumeBackupPlanV1 } from "@deploylite/contracts";
import { digestControlInput } from "./control-plane.js";

export type ComposeVolumeBackupExecutionIntent = Readonly<{
  projectId: string;
  idempotencyKey: string;
  plan: Pick<ComposeVolumeBackupPlanV1, "planDigest" | "destinationId" | "configDigest" | "stateDigest" | "volumeKey">;
}>;

/** Stable across retries: command identity is bound separately by the shared control ledger. */
export function composeVolumeBackupExecutionBinding(input: ComposeVolumeBackupExecutionIntent) {
  return { operation: "compose.volume.backup.execute" as const, projectId: input.projectId, idempotencyKey: input.idempotencyKey,
    planDigest: input.plan.planDigest, destinationId: input.plan.destinationId, configDigest: input.plan.configDigest,
    stateDigest: input.plan.stateDigest, volumeKey: input.plan.volumeKey };
}

export function composeVolumeBackupExecutionDigest(input: ComposeVolumeBackupExecutionIntent): string {
  return digestControlInput(composeVolumeBackupExecutionBinding(input));
}
