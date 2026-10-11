import {createHash} from "node:crypto";
import { managedDatabaseStopPreparationSchema, managedDatabaseStopReceiptQuerySchema, managedDatabaseStopReceiptSchema,protocolPayloadFingerprint } from "@deploylite/contracts";
import { digestControlInput } from "./control-plane.js";
import { composeRuntimeResourceName } from "./compose-preview.js";
import { managedDatabaseRuntimeExecutionDigest } from "./managed-database-runtime-binding.js";
/** Original apply proof only; no secret read, credential replacement or effect is authorized by preparation. */
export function managedDatabaseStopExecutionBinding(raw: unknown) {
    try {
        const preparation = managedDatabaseStopPreparationSchema.parse(raw);
        const {originalReceipt,originalReplayFingerprint,...input} = preparation;
        if (originalReceipt.inputDigest !== managedDatabaseRuntimeExecutionDigest(input)
            || originalReceipt.volumeName !== composeRuntimeResourceName(input.projectId,"volume",`db-${input.databaseId}`)
            || originalReceipt.networkName !== composeRuntimeResourceName(input.projectId,"network",`db-${input.databaseId}`)) throw new Error("detached");
        return {...preparation,action:"project.update" as const,scope:{kind:"project" as const,projectId:input.projectId},operation:"database.runtime.stop" as const};
    } catch {throw new Error("Database stop preparation is unavailable.");}
}
export function managedDatabaseStopExecutionDigest(raw: unknown): string {
    return digestControlInput(managedDatabaseStopExecutionBinding(raw));
}
/** Validate every original/new dimension before a stopped receipt can complete its existing project command. */
export function managedDatabaseStopReceiptMatches(rawQuery: unknown, rawReceipt: unknown): boolean {
    try {
        const query=managedDatabaseStopReceiptQuerySchema.parse(rawQuery),receipt=managedDatabaseStopReceiptSchema.parse(rawReceipt);
        const preparation={schemaVersion:query.schemaVersion,projectId:query.projectId,databaseId:query.databaseId,engine:query.engine,
            profileId:query.profileId,planDigest:query.planDigest,environmentFingerprint:query.environmentFingerprint,
            originalReceipt:query.originalReceipt,originalReplayFingerprint:query.originalReplayFingerprint};
        if (query.inputDigest !== managedDatabaseStopExecutionDigest(preparation)) return false;
        const original=query.originalReceipt;
        return receipt.agentId===query.agentId && receipt.commandId===query.commandId && receipt.originalCommandId===original.commandId
            && receipt.projectId===query.projectId && receipt.databaseId===query.databaseId && receipt.engine===query.engine && receipt.profileId===query.profileId
            && receipt.inputDigest===query.inputDigest && receipt.planDigest===query.planDigest && receipt.environmentFingerprint===query.environmentFingerprint
            && receipt.correlationId===query.context.correlationId && receipt.containerId===original.containerId && receipt.imageId===original.imageId
            && receipt.volumeName===original.volumeName && receipt.networkName===original.networkName && receipt.networkId===original.networkId
            && receipt.volumeCreatedAt===original.volumeCreatedAt && receipt.observedAt>=original.observedAt;
    } catch {return false;}
}

/** Preserve existing stopped replay bytes; this selector grants no new execution authority. */
export function managedDatabaseStopReplayFingerprint(raw:unknown):string {
    const value=managedDatabaseStopReceiptQuerySchema.parse(raw);
    return protocolPayloadFingerprint({schemaVersion:value.schemaVersion,projectId:value.projectId,databaseId:value.databaseId,engine:value.engine,
        profileId:value.profileId,planDigest:value.planDigest,environmentFingerprint:value.environmentFingerprint,
        originalReceipt:value.originalReceipt,originalReplayFingerprint:value.originalReplayFingerprint,
        action:value.action,agentId:value.agentId,commandId:value.commandId,idempotencyKey:value.idempotencyKey,inputDigest:value.inputDigest,
        correlationId:value.context.correlationId,authority:value.authority,lease:value.lease});
}
export function managedDatabaseStopReplayFingerprintDigest(raw:unknown):string {return createHash("sha256").update(managedDatabaseStopReplayFingerprint(raw)).digest("hex");}
