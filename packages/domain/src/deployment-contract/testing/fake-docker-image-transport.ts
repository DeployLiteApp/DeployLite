import type { DockerImageCandidateV1, DockerImageTransport, ProvenDockerImageExecutionReceiptV1 } from "../docker-image-executor.js";
export type DockerImageTransportCall = "start" | "health" | "promote" | "restore" | "discard";
export interface FakeDockerImageTransportScript { readonly health?: readonly boolean[]; readonly start?: Error; readonly promote?: Error; readonly restore?: Error; readonly discard?: Error; }
export class FakeDockerImageTransport implements DockerImageTransport {
  readonly calls: DockerImageTransportCall[] = []; readonly restored: ProvenDockerImageExecutionReceiptV1[] = []; #health: boolean[];
  constructor(private readonly script: FakeDockerImageTransportScript = {}) { this.#health = [...(script.health ?? [true])]; }
  startCandidate(candidate: DockerImageCandidateV1): void { this.calls.push("start"); if (this.script.start) throw this.script.start; }
  checkHealth(candidate: DockerImageCandidateV1): boolean { this.calls.push("health"); return this.#health.shift() ?? false; }
  promoteCandidate(candidate: DockerImageCandidateV1): void { this.calls.push("promote"); if (this.script.promote) throw this.script.promote; }
  restorePrior(receipt: ProvenDockerImageExecutionReceiptV1): void { this.calls.push("restore"); this.restored.push(structuredClone(receipt)); if (this.script.restore) throw this.script.restore; }
  discardCandidate(candidate: DockerImageCandidateV1): void { this.calls.push("discard"); if (this.script.discard) throw this.script.discard; }
}
