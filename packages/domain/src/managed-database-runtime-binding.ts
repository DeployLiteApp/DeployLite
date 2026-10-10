import { managedDatabaseRuntimePreparationSchema } from "@deploylite/contracts";
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
