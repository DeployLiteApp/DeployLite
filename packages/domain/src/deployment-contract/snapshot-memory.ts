import type { DeploymentSnapshotV1 } from "@deploylite/contracts";
export class InMemorySnapshotStore {
  readonly #snapshots = new Map<string, DeploymentSnapshotV1>();
  save(snapshot: DeploymentSnapshotV1): DeploymentSnapshotV1 {
    const copy = structuredClone(snapshot);
    const current = this.#snapshots.get(copy.hash);
    if (current) {
      if (JSON.stringify(current) !== JSON.stringify(copy)) throw new Error("Deployment snapshot is immutable");
      return structuredClone(current);
    }
    this.#snapshots.set(copy.hash, copy);
    return structuredClone(copy);
  }
  get(hash: string): DeploymentSnapshotV1 | null { const value = this.#snapshots.get(hash); return value ? structuredClone(value) : null; }
}
