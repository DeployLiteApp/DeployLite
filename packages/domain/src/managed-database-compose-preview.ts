import type { ComposePreviewV1, ImageReferencePolicyV1 } from "@deploylite/contracts";
import { planManagedDatabaseProfile } from "./managed-database-profile.js";
import { createComposePreview } from "./compose-preview.js";
/** Resource-only bridge to the existing Compose inspection/backup ports; no runtime environment or new lifecycle. */
export function createManagedDatabaseComposePreview(input: unknown, profile: unknown, policy: ImageReferencePolicyV1): ComposePreviewV1 {
    const plan = planManagedDatabaseProfile(input, profile, policy), key = plan.volume.key;
    return createComposePreview(JSON.stringify({ services: { [key]: { image: plan.image, networks: [key], volumes: [{ type: "volume", source: key, target: plan.volume.target }] } },
        networks: { [key]: { internal: true } }, volumes: { [key]: {} } }), plan.projectId, { ...policy, allowTags: false });
}
