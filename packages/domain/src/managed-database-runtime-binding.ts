import {createHash} from "node:crypto";
import { managedDatabaseRuntimePreparationSchema, managedDatabaseRuntimeReceiptQuerySchema, protocolPayloadFingerprint } from "@deploylite/contracts";
import { digestControlInput } from "./control-plane.js";
/** Public immutable preparation only; the existing cipher/envelope carries actual environment values. */
export function managedDatabaseRuntimeExecutionBinding(raw: unknown) {
    try {
        const input = managedDatabaseRuntimePreparationSchema.parse(raw);
        return { ...input, action: "project.update" as const, scope: { kind: "project" as const, projectId: input.projectId }, operation: "database.runtime.apply" as const };
    }
    catch {
        throw new Error("Database runtime preparation is unavailable.");
    }
}
export function managedDatabaseRuntimeExecutionDigest(raw: unknown): string {
    return digestControlInput(managedDatabaseRuntimeExecutionBinding(raw));
}

/** Same immutable claim fingerprint used by the existing native apply receiver; read request/timeout may change. */
export function managedDatabaseRuntimeReplayFingerprint(raw: unknown): string {
    const value = managedDatabaseRuntimeReceiptQuerySchema.parse(raw);
    return protocolPayloadFingerprint({action:value.action,agentId:value.agentId,commandId:value.commandId,projectId:value.projectId,
        databaseId:value.databaseId,engine:value.engine,profileId:value.profileId,planDigest:value.planDigest,environmentFingerprint:value.environmentFingerprint,
        idempotencyKey:value.idempotencyKey,inputDigest:value.inputDigest,correlationId:value.context.correlationId,authority:value.authority,lease:value.lease});
}

/** Opaque selector for read-only corroboration; existing canonical replay bytes stay unchanged. */
export function managedDatabaseRuntimeReplayFingerprintDigest(raw:unknown):string {return createHash("sha256").update(managedDatabaseRuntimeReplayFingerprint(raw)).digest("hex");}
