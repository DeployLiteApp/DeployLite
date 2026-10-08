export const COMPOSE_VOLUME_ATTACHMENT_ENABLED_ENV = "DEPLOYLITE_COMPOSE_VOLUME_ATTACHMENT_ENABLED" as const;

/** Volume replacement remains disabled unless explicitly enabled in a nonproduction runtime. */
export function parseComposeVolumeAttachmentEnabled(value: string | undefined, nodeEnv: string | undefined): boolean {
  if (value === undefined || value === "false") return false;
  if (value !== "true") throw new Error(`${COMPOSE_VOLUME_ATTACHMENT_ENABLED_ENV} must be true or false.`);
  if (nodeEnv === "production") throw new Error("Compose volume replacement is disabled in production.");
  return true;
}
