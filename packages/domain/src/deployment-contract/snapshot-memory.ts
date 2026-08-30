import type { DeploymentSnapshotV1 } from "@deploylite/contracts";
export class InMemorySnapshotStore {
  readonly #snapshots = new Map<string, DeploymentSnapshotV1>();
  save(snapshot: DeploymentSnapshotV1): DeploymentSnapshotV1 { if (this.#snapshots.has(snapshot.hash)) throw new Error("snapshot hash already exists"); const copy = structuredClone(snapshot); this.#snapshots.set(snapshot.hash, copy); return structuredClone(copy); }
  get(hash: string): DeploymentSnapshotV1 | null { const value = this.#snapshots.get(hash); return value ? structuredClone(value) : null; }
}
