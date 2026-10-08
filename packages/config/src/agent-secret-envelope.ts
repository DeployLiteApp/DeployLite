import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { validateAgentTransportKey } from "./crypto.js";

const envelopeVersion = 1 as const;
const maxEntries = 64;
const maxBytes = 65_536;
const environmentKey = /^[A-Z_][A-Z0-9_]{0,127}$/;
const identity = /^[A-Za-z0-9_-]{1,200}$/;
const digest = /^[a-f0-9]{64}$/;

export type AgentSecretEnvelopeBinding = Readonly<{ agentId: string; commandId: string; inputDigest: string; projectId: string }>;
type WireEnvelope = Readonly<{ schemaVersion: 1; algorithm: "A256GCM"; iv: string; tag: string; ciphertext: string }>;

function fail(): never { throw new Error("agent secret envelope rejected"); }
function validateBinding(value: AgentSecretEnvelopeBinding): AgentSecretEnvelopeBinding {
  if (!value || !identity.test(value.agentId) || !identity.test(value.commandId) || !identity.test(value.projectId) || !digest.test(value.inputDigest)) fail();
  return value;
}
function associatedData(binding: AgentSecretEnvelopeBinding): Buffer {
  const value = validateBinding(binding);
  return Buffer.from(JSON.stringify({ schemaVersion: envelopeVersion, ...value }), "utf8");
}
function keyFor(trustKey: string): Buffer {
  try { validateAgentTransportKey(trustKey); } catch { return fail(); }
  return Buffer.from(hkdfSync("sha256", Buffer.from(trustKey, "utf8"), Buffer.from("DeployLite agent secret envelope v1", "utf8"), Buffer.from("compose-service-environment", "utf8"), 32));
}
function canonicalEnvironment(raw: unknown): Readonly<Record<string, string>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail();
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > maxEntries) fail();
  const sorted: Record<string, string> = {};
  for (const [name, value] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    if (!environmentKey.test(name) || typeof value !== "string" || value.includes("\u0000")) fail();
    sorted[name] = value;
  }
  const encoded = Buffer.from(JSON.stringify(sorted), "utf8");
  if (encoded.length > maxBytes) fail();
  return sorted;
}
function base64(value: string, bytes: number): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail();
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== bytes || decoded.toString("base64") !== value) fail();
  return decoded;
}

/** Encrypts a short-lived environment payload using a purpose-derived key from the existing authenticated agent transport key. */
export function sealAgentSecretEnvelope(environment: Readonly<Record<string, string>>, trustKey: string, binding: AgentSecretEnvelopeBinding): string {
  try {
    const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", keyFor(trustKey), nonce);
    cipher.setAAD(associatedData(binding));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(canonicalEnvironment(environment)), "utf8"), cipher.final()]);
    const wire: WireEnvelope = { schemaVersion: envelopeVersion, algorithm: "A256GCM", iv: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
    const result = JSON.stringify(wire);
    if (Buffer.byteLength(result, "utf8") > maxBytes * 2) fail();
    return result;
  } catch { return fail(); }
}

/** Opens only an envelope bound to the exact authenticated agent command. Errors never reflect payload or secret material. */
export function openAgentSecretEnvelope(raw: string, trustKey: string, binding: AgentSecretEnvelopeBinding): Readonly<Record<string, string>> {
  try {
    if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > maxBytes * 2) fail();
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail();
    const value = parsed as Record<string, unknown>;
    if (Object.keys(value).sort().join(",") !== "algorithm,ciphertext,iv,schemaVersion,tag" || value.schemaVersion !== envelopeVersion || value.algorithm !== "A256GCM"
      || typeof value.iv !== "string" || typeof value.tag !== "string" || typeof value.ciphertext !== "string") fail();
    const nonce = base64(value.iv, 12), tag = base64(value.tag, 16);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.ciphertext)) fail();
    const ciphertext = Buffer.from(value.ciphertext, "base64");
    if (!ciphertext.length || ciphertext.length > maxBytes || ciphertext.toString("base64") !== value.ciphertext) fail();
    const decipher = createDecipheriv("aes-256-gcm", keyFor(trustKey), nonce);
    decipher.setAAD(associatedData(binding)); decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    return Object.freeze({ ...canonicalEnvironment(JSON.parse(plaintext)) });
  } catch { return fail(); }
}
