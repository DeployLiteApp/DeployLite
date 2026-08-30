const forbidden = [
  /docker/i, /registry\.(?:pull|push|resolve)/i, /\b(?:vps|ssh)\b/i,
  /\bspawn\s*\(/i, /\bexec(?:File)?\s*\(/i, /from ["']node:fs/i,
  /fetch\s*\(/i, /https?:\/\//i, /(?:get|retrieve|load|read)Secret/i, /secretStore/i
];
export function assertNoDeploymentEffects(source: string): void {
  const match = forbidden.find((pattern) => pattern.test(source));
  if (match) throw new Error(`deployment contract contains forbidden effect: ${match}`);
}
