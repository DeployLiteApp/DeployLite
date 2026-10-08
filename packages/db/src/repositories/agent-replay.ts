import { randomUUID } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import { ReplayConflictError } from "@deploylite/contracts";
import type { DeployLiteDb } from "../client.js";
import { agentReplay } from "../schema.js";

export type AgentReplayReceipt = Record<string, unknown>;
export type AgentReplayClaim = { claimed: boolean; claimToken?: string; receipt?: AgentReplayReceipt };
export type AgentReplayLease = Readonly<{ leaseId: string; fence: number; expiresAt: number; deploymentId?: string; projectId?: string }>;
export type AgentReplayStore = { readonly durable: true; lookup(commandId: string, fingerprint: string): Promise<AgentReplayReceipt | null>; claim(commandId: string, fingerprint: string, lease: AgentReplayLease): Promise<AgentReplayClaim>; wait(commandId: string): Promise<AgentReplayReceipt>; complete(commandId: string, value: { fingerprint: string; claimToken: string; receipt: AgentReplayReceipt }): Promise<void>; release(commandId: string, claimToken?: string): Promise<void> };

export class DbAgentReplayStore implements AgentReplayStore {
  readonly durable = true as const;
  readonly #owned = new Set<string>();
  constructor(private readonly db: DeployLiteDb, private readonly owner: string) { if (!owner.trim()) throw new Error("replay owner is required"); }
  async lookup(commandId: string, fingerprint: string): Promise<AgentReplayReceipt | null> {
    const [row] = await this.db.select().from(agentReplay).where(eq(agentReplay.commandId, commandId)).limit(1);
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw new ReplayConflictError();
    if (row.status !== "completed") return null;
    return row.receipt ? structuredClone(row.receipt) : null;
  }
  async claim(commandId: string, fingerprint: string, lease: AgentReplayLease): Promise<AgentReplayClaim> {
    const now = new Date();
    if (lease.expiresAt <= now.getTime()) throw new Error("replay lease is expired");
    const claimToken = `${this.owner}:${randomUUID()}`;
    const [inserted] = await this.db.insert(agentReplay).values({ commandId, fingerprint, claimOwner: this.owner, leaseId: lease.leaseId, claimToken, leaseExpiresAt: new Date(lease.expiresAt), status: "in_progress" }).onConflictDoNothing().returning({ commandId: agentReplay.commandId });
    if (inserted) { this.#owned.add(commandId); return { claimed: true, claimToken }; }
    const [row] = await this.db.select().from(agentReplay).where(eq(agentReplay.commandId, commandId)).limit(1);
    if (!row || row.fingerprint !== fingerprint) throw new ReplayConflictError();
    if (row.status === "completed" && row.receipt) return { claimed: false, receipt: row.receipt };
    if (row.leaseExpiresAt <= now) {
      const [reclaimed] = await this.db.update(agentReplay).set({ claimOwner: this.owner, leaseId: lease.leaseId, claimToken, leaseExpiresAt: new Date(lease.expiresAt), claimedAt: now }).where(and(eq(agentReplay.commandId, commandId), eq(agentReplay.status, "in_progress"), lte(agentReplay.leaseExpiresAt, now))).returning({ commandId: agentReplay.commandId });
      if (reclaimed) { this.#owned.add(commandId); return { claimed: true, claimToken }; }
    }
    return { claimed: false };
  }
  async wait(commandId: string): Promise<AgentReplayReceipt> {
    for (let attempt = 0; attempt < 300; attempt++) { const [row] = await this.db.select().from(agentReplay).where(eq(agentReplay.commandId, commandId)).limit(1); if (!row) throw new Error("replay claim was released"); if (row.status === "completed" && row.receipt) return row.receipt; await new Promise((resolve) => setTimeout(resolve, 100)); }
    throw new Error("replay resolution timed out");
  }
  async complete(commandId: string, value: { fingerprint: string; claimToken: string; receipt: AgentReplayReceipt }): Promise<void> {
    const result = await this.db.update(agentReplay).set({ status: "completed", receipt: value.receipt, resolvedAt: new Date() }).where(and(eq(agentReplay.commandId, commandId), eq(agentReplay.fingerprint, value.fingerprint), eq(agentReplay.status, "in_progress"), eq(agentReplay.claimOwner, this.owner), eq(agentReplay.claimToken, value.claimToken))).returning({ commandId: agentReplay.commandId });
    if (!result.length) throw new Error("replay claim is stale or already completed");
    this.#owned.delete(commandId);
  }
  async release(commandId: string, claimToken?: string): Promise<void> { if (!claimToken) return; await this.db.delete(agentReplay).where(and(eq(agentReplay.commandId, commandId), eq(agentReplay.claimOwner, this.owner), eq(agentReplay.claimToken, claimToken), eq(agentReplay.status, "in_progress"))); }
}
