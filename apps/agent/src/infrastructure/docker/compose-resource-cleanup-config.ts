export const COMPOSE_RESOURCE_CLEANUP_ENABLED_ENV = "DEPLOYLITE_COMPOSE_RESOURCE_CLEANUP_ENABLED" as const;

/** Confirmed cleanup is disabled by default and remains opt-in outside production until P3 acceptance closes. */
export function parseComposeResourceCleanupEnabled(value: string | undefined, nodeEnv: string | undefined): boolean {
  if (value === undefined || value === "false") return false;
  if (value !== "true") throw new Error(`${COMPOSE_RESOURCE_CLEANUP_ENABLED_ENV} must be true or false.`);
  if (nodeEnv === "production") throw new Error("Compose resource cleanup is disabled in production.");
  return true;
}
