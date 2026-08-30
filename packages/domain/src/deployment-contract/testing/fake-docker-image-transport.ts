import type { DockerImageCandidateV1, DockerImageTransport, ProvenDockerImageExecutionReceiptV1 } from "../docker-image-executor.js";
export type DockerImageTransportCall = "start" | "health" | "promote" | "restore" | "discard";
export interface FakeDockerImageTransportScript { readonly health?: readonly boolean[]; readonly start?: Error; readonly promote?: Error; readonly restore?: Error; readonly discard?: Error; }
export class FakeDockerImageTransport implements DockerImageTransport {
  readonly calls: DockerImageTransportCall[] = []; readonly restored: ProvenDockerImageExecutionReceiptV1[] = []; #health: boolean[];
  constructor(private readonly script: FakeDockerImageTransportScript = {}) { this.#health = [...(script.health ?? [true])]; }
  async startCandidate(candidate: DockerImageCandidateV1): Promise<void> { this.calls.push("start"); if (this.script.start) throw this.script.start; }
  async checkHealth(candidate: DockerImageCandidateV1): Promise<boolean> { this.calls.push("health"); return this.#health.shift() ?? false; }
  async promoteCandidate(candidate: DockerImageCandidateV1): Promise<void> { this.calls.push("promote"); if (this.script.promote) throw this.script.promote; }
  async restorePrior(receipt: ProvenDockerImageExecutionReceiptV1): Promise<void> { this.calls.push("restore"); this.restored.push(structuredClone(receipt)); if (this.script.restore) throw this.script.restore; }
  async discardCandidate(candidate: DockerImageCandidateV1): Promise<void> { this.calls.push("discard"); if (this.script.discard) throw this.script.discard; }
}
