import { getTableColumns } from "drizzle-orm";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { claimDeploymentAuthority, createControlCommand, createConfirmation, digestControlInput, type ControlCommand } from "@deploylite/domain";
import { createDbClient } from "../client.js";
import { controlCommandConfirmations, controlCommands, deployments } from "../schema.js";
import { DbControlCommandRepository } from "./control-plane.js";

const id = (tail: number) => `00000000-0000-4000-8000-${tail.toString().padStart(12, "0")}`;
const actor = id(1), project = id(2), active = id(3), historical = id(4), hash = "a".repeat(64);
function command(executionId: string, overrides: { active?: string; historical?: string; snapshotHash?: string } = {}): ControlCommand {
  const A = overrides.active ?? active, H = overrides.historical ?? historical, snapshotHash = overrides.snapshotHash ?? hash;
  const input = { actorId: actor, projectId: project, activeDeploymentId: A, sourceDeploymentId: H, deploymentId: executionId, snapshotHash };
  const value = createControlCommand({ actorId: actor, action: "deployment.rollback", scope: { kind: "deployment", projectId: project, deploymentId: A }, input, idempotencyKey: "rollback-key", correlationId: "original-correlation" });
  return { ...value, result: { commandId: value.id, action: "deployment.rollback", projectId: project, activeDeploymentId: A, sourceDeploymentId: H, deploymentId: executionId, snapshotHash, status: "pending_confirmation", correlationId: value.correlationId, reason: null } } as unknown as ControlCommand;
}

function recordingDatabase() {
  const rows: Array<Record<string, any>> = [], confirmations: Array<Record<string, any>> = [];
  const queries: Array<{ connection: number; text: string; values: unknown[] }> = [];
  const locks = new Map<string, { owner: number; waiting: Array<() => void> }>();
  const held = new Map<number, string>();
  const columns = Object.keys(getTableColumns(controlCommands));
  const camel = (text: string) => text.replace(/_([a-z])/g, (_, value: string) => value.toUpperCase());
  function release(connection: number) {
    const key = held.get(connection); if (!key) return;
    held.delete(connection); const lock = locks.get(key)!;
    const next = lock.waiting.shift(); if (next) next(); else locks.delete(key);
  }
  const repository = (connection: number) => {
    const client = { query: async (query: string | { text: string }, values: unknown[] = []) => {
      const text = typeof query === "string" ? query : query.text; queries.push({ connection, text, values });
      if (text.includes("pg_advisory_xact_lock")) {
        const key = String(values[0]); const old = locks.get(key);
        if (old && old.owner !== connection) await new Promise<void>((resolve) => old.waiting.push(() => { old.owner = connection; resolve(); }));
        else if (!old) locks.set(key, { owner: connection, waiting: [] });
        held.set(connection, key); return { rows: [] };
      }
      if (["commit", "rollback"].includes(text.toLowerCase())) { release(connection); return { rows: [] }; }
      if (text.includes('from "control_commands"') && text.endsWith("for update")) {
        const key = `command:${values[0]}`, old = locks.get(key);
        if (old && old.owner !== connection) await new Promise<void>((resolve) => old.waiting.push(() => { old.owner = connection; resolve(); }));
        else if (!old) locks.set(key, { owner: connection, waiting: [] });
        held.set(connection, key);
      }
      if (text.startsWith('insert into "control_command_confirmations"')) {
        const names = [...text.slice(text.indexOf("(") + 1, text.indexOf(")")).matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
        const expressions = text.split(" values (")[1]!.split(")")[0]!.split(", "), row: Record<string, any> = { consumedAt: null, createdAt: new Date() };
        names.forEach((name, index) => { const parameter = /\$(\d+)/.exec(expressions[index] ?? ""); if (parameter) row[camel(name)] = values[Number(parameter[1]) - 1]; });
        if (confirmations.some((old) => old.commandId === row.commandId)) throw new Error("duplicate confirmation commandId");
        confirmations.push(row); return { rows: [Object.keys(getTableColumns(controlCommandConfirmations)).map((name) => row[name])] };
      }
      if (text.startsWith("select") && text.includes('from "control_command_confirmations"')) {
        const conditions = [...text.matchAll(/"control_command_confirmations"\."([^"]+)" = \$(\d+)/g)];
        const selected = confirmations.filter((row) => conditions.every((match) => row[camel(match[1]!)] === values[Number(match[2]) - 1]));
        return { rows: selected.map((row) => Object.keys(getTableColumns(controlCommandConfirmations)).map((name) => row[name])) };
      }
      if (text.startsWith('insert into "control_commands"')) {
        const names = [...text.slice(text.indexOf("(") + 1, text.indexOf(")")).matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
        const expressions = text.split(" values (")[1]!.split(")")[0]!.split(", ");
        const row: Record<string, any> = { createdAt: new Date(), updatedAt: new Date(), executionAuthority: null };
        names.forEach((name, index) => { const parameter = /\$(\d+)/.exec(expressions[index] ?? ""); if (parameter) { const value = values[Number(parameter[1]) - 1]; row[camel(name)] = name === "result" && typeof value === "string" ? JSON.parse(value) : value; } });
        // Faithful existing SQL uniqueness includes scopeKey, not actor/action/key alone.
        if (rows.some((old) => old.actorUserId === row.actorUserId && old.action === row.action && old.scopeKey === row.scopeKey && old.idempotencyKey === row.idempotencyKey)) return { rows: [] };
        rows.push(row); return { rows: [columns.map((name) => row[name])] };
      }
      if (text.startsWith("select") && text.includes('from "control_commands"')) {
        const conditions = [...text.matchAll(/"control_commands"\."([^"]+)" = \$(\d+)/g)];
        const selected = rows.filter((row) => conditions.every((match) => row[camel(match[1]!)] === values[Number(match[2]) - 1]));
        return { rows: selected.map((row) => columns.map((name) => row[name])) };
      }
      return { rows: [] };
    } };
    return new DbControlCommandRepository(createDbClient(client as unknown as Pool));
  };
  return { rows, confirmations, queries, first: repository(1), second: repository(2) };
}

describe("rollback reservation through actual Drizzle mapping", () => {
  it("converges concurrent same-key tentative UUIDs to one persisted R and digest", async () => {
    const db = recordingDatabase(), first = command(id(10)), second = command(id(11));
    const outcomes = await Promise.all([db.first.resolve(first), db.second.resolve(second)].map((work) => work.then((value) => ({ value, error: null }), (error: Error) => ({ value: null, error: error.message }))));
    expect(outcomes.map((outcome) => outcome.error)).toEqual([null, null]);
    expect(db.rows).toHaveLength(1);
    const persisted = outcomes[0]!.value!.command;
    expect(outcomes[1]!.value!.command).toEqual(persisted);
    expect(persisted.inputDigest).toBe(digestControlInput({ actorId: actor, projectId: project, activeDeploymentId: active, sourceDeploymentId: historical, deploymentId: id(10), snapshotHash: hash }));
    expect(persisted.result).toMatchObject({ deploymentId: id(10), activeDeploymentId: active, sourceDeploymentId: historical, status: "pending_confirmation" });
  });
  it("conflicts changed active A under the same actor/action/key rather than reserving another command", async () => {
    const db = recordingDatabase(); await db.first.resolve(command(id(10)));
    const result = await db.second.resolve(command(id(11), { active: id(5) })).then(() => "resolved", () => "conflict");
    expect(result).toBe("conflict"); expect(db.rows).toHaveLength(1);
  });
});
function admissionFixture() {
  const current = command(id(10)), confirmation = createConfirmation({ command: current, classification: "destructive" });
  const deployment = { id: id(10), projectId: project, agentId: id(20), status: "queued" as const, commitSha: "abcdef1", startedAt: new Date().toISOString(), finishedAt: null, activeDeploymentId: active, sourceDeploymentId: historical, snapshotOriginId: id(99), snapshotHash: hash };
  const row: Record<string, any> = { id: current.id, actorUserId: actor, action: current.action, scopeKind: "deployment", scopeKey: JSON.stringify([project, active]), inputDigest: current.inputDigest, idempotencyKey: current.idempotencyKey, correlationId: current.correlationId, status: current.status, result: current.result, executionAuthority: null, expiresAt: current.expiresAt, createdAt: new Date(), updatedAt: new Date() };
  const writes: Array<Record<string, any>> = [], queries: string[] = [];
  const historicalRow = { ...deployment, id: historical, status: "succeeded", activeDeploymentId: undefined, sourceDeploymentId: id(99) };
  const client = { query: async (query: string | { text: string }, values: unknown[] = []) => {
    const text = typeof query === "string" ? query : query.text; queries.push(text);
    if (text.startsWith('insert into "deployments"')) {
      const names = [...text.slice(text.indexOf("(") + 1, text.indexOf(")")).matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
      const expressions = text.split(" values (")[1]!.split(")")[0]!.split(", "); const inserted: Record<string, any> = {};
      names.forEach((name, index) => { const parameter = /\$(\d+)/.exec(expressions[index] ?? ""); if (parameter) { const value = values[Number(parameter[1]) - 1]; inserted[name] = name === "metadata" && typeof value === "string" ? JSON.parse(value) : value; } });
      expect(inserted.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); writes.push(inserted);
    }
    if (text.startsWith('update "control_command_confirmations"')) return { rows: [[confirmation.id]] };
    if (text.startsWith('update "control_commands"')) for (const match of (text.split(" set ")[1]?.split(" where ")[0] ?? "").matchAll(/"(\w+)" = \$(\d+)/g)) {
      const name = match[1]!.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()); const value = values[Number(match[2]) - 1]; row[name] = ["result", "executionAuthority"].includes(name) && typeof value === "string" ? JSON.parse(value) : value;
    }
    if (text.startsWith("select") && text.includes('from "deployments"')) {
      const selected = values.includes(historical) ? historicalRow : deployment;
      const physicalRow = { ...selected, startedAt: new Date(deployment.startedAt), snapshotEvidence: null, executionReceipt: null, metadata: { activeDeploymentId: selected.activeDeploymentId, sourceDeploymentId: selected.sourceDeploymentId, snapshotOriginId: id(99) }, createdAt: new Date(), updatedAt: new Date() };
      return { rows: [Object.keys(getTableColumns(deployments)).map((name) => (physicalRow as any)[name])] };
    }
    if ((text.startsWith("select") || text.startsWith('update "control_commands"')) && text.includes('"control_commands"')) return { rows: [Object.keys(getTableColumns(controlCommands)).map((name) => row[name])] };
    return { rows: [] };
  } };
  return { repository: new DbControlCommandRepository(createDbClient(client as unknown as Pool)), current, confirmation, deployment, row, writes, queries };
}
describe("rollback confirmed admission and active source authority", () => {
  it("inserts the reserved R once with H immediate lineage, H canonical origin and independent active A", async () => {
    const f = admissionFixture();
    const admitted = await f.repository.executeConfirmedDeploymentRollback({ command: f.current, confirmation: f.confirmation, deployment: f.deployment, requestId: "confirm-request" });
    expect(admitted.accepted).toBe(true); expect(f.writes).toHaveLength(1);
    expect(f.writes[0]).toMatchObject({ id: f.deployment.id, snapshot_hash: hash, metadata: { activeDeploymentId: active, sourceDeploymentId: historical, snapshotOriginId: id(99) } });
    expect(admitted.result).toMatchObject({ deploymentId: f.deployment.id, activeDeploymentId: active, sourceDeploymentId: historical, status: "eligible" });
    expect(f.queries[0]).toBe("begin"); expect(f.queries.at(-1)).toBe("commit");
  });
  it("claims persisted project/A/R authority without assigning historical H as the recovery lease", async () => {
    const f = admissionFixture(); f.row.status = "eligible"; f.row.result = { ...f.current.result, status: "eligible" }; const current = { ...f.current, status: "eligible" as const, result: f.row.result };
    const claimed = await f.repository.claimDeploymentRollback(current);
    expect(claimed).toMatchObject({ claimed: true, deployment: { activeDeploymentId: active, sourceDeploymentId: historical }, authority: { sourceLease: { deploymentId: active }, executionLease: { deploymentId: f.deployment.id } } });
  });
});


describe("rollback admission binds the supplied execution to the durable reservation", () => {
  it.each(["execution", "active", "source", "project", "hash", "origin", "agent", "status"])("rejects changed %s before confirmation consumption or insertion", async (variant) => {
    const f = admissionFixture(), changed = { ...f.deployment };
    if (variant === "execution") changed.id = id(11);
    if (variant === "active") changed.activeDeploymentId = historical;
    if (variant === "source") changed.sourceDeploymentId = active;
    if (variant === "project") changed.projectId = id(55);
    if (variant === "hash") changed.snapshotHash = "b".repeat(64);
    if (variant === "origin") changed.snapshotOriginId = historical;
    if (variant === "agent") changed.agentId = id(21);
    if (variant === "status") changed.status = "running" as "queued";
    const admitted = await f.repository.executeConfirmedDeploymentRollback({ command: f.current, confirmation: f.confirmation, deployment: changed, requestId: "invalid-admission" }).then((value) => value.accepted, () => false);
    expect(admitted).toBe(false); expect(f.writes).toHaveLength(0);
    expect(f.queries.some((text) => text.startsWith('update "control_command_confirmations"'))).toBe(false); expect(f.row.status).toBe("pending_confirmation");
    expect((await f.repository.executeConfirmedDeploymentRollback({ command: f.current, confirmation: f.confirmation, deployment: f.deployment, requestId: "valid-admission" })).accepted).toBe(true);
  });
});


describe("rollback reviewed retry persistence", () => {
  it.each(["expired", "consumed", "actor", "scope"])("keeps an original %s confirmation unavailable without inserting a replacement", async (variant) => {
    const db = recordingDatabase(), original = (await db.first.resolve(command(id(10)))).command;
    const confirmation = createConfirmation({ command: original, classification: "destructive" });
    await db.first.bind(confirmation); expect(db.confirmations).toHaveLength(1);
    const row = db.confirmations[0]!;
    if (variant === "expired") row.expiresAt = new Date(Date.now() - 1);
    if (variant === "consumed") row.consumedAt = new Date();
    if (variant === "actor") row.actorUserId = id(70);
    if (variant === "scope") row.scopeKey = JSON.stringify([project, historical]);
    expect(await db.second.resolveRollbackConfirmation(original)).toBeNull();
    expect(db.confirmations).toHaveLength(1); expect(db.confirmations[0]!.id).toBe(confirmation.id);
  });

  it("binds one original confirmation under the command row lock across two connections", async () => {
    const db = recordingDatabase(), original = (await db.first.resolve(command(id(10)))).command;
    const confirmations = await Promise.all([db.first.resolveRollbackConfirmation(original), db.second.resolveRollbackConfirmation(original)]);
    expect(confirmations[0]).not.toBeNull(); expect(confirmations[1]).toEqual(confirmations[0]);
    expect(confirmations[0]).toMatchObject({ commandId: original.id, actorId: original.actorId, inputDigest: original.inputDigest, expiresAt: original.expiresAt, consumedAt: null });
    expect(db.confirmations).toHaveLength(1); expect(db.rows).toHaveLength(1);
    expect(db.queries.filter((query) => query.text.endsWith("for update"))).toHaveLength(2);
  });
  it.each(["running", "authority", "hash", "active"])("does not claim a previously admitted R whose %s changed before claim", async (variant) => {
    const f = admissionFixture(); f.row.status = "eligible"; f.row.result = { ...f.current.result, status: "eligible" };
    const submitted = { ...f.current, status: "eligible" as const, result: structuredClone(f.row.result) };
    if (variant === "running") f.deployment.status = "running" as "queued";
    if (variant === "hash") f.deployment.snapshotHash = "b".repeat(64);
    if (variant === "active") f.deployment.activeDeploymentId = historical;
    if (variant === "authority") {
      const claimed = structuredClone(submitted); f.row.executionAuthority = claimDeploymentAuthority([claimed], claimed, f.deployment.id);
    }
    expect((await f.repository.claimDeploymentRollback(submitted)).claimed).toBe(false);
    expect(f.row.status).toBe("eligible"); expect(f.queries.some((query) => query.startsWith('update "control_commands"'))).toBe(false);
  });
});
