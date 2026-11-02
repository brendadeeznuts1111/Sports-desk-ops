/**
 * Hierarchy hashes — Web Crypto (`crypto.subtle`) for portable SHA-256.
 * (Bun.CryptoHasher lives under Hashing docs, not Utils.)
 */

import type { ListAgentsByAgentEnvelope } from "./f402_list_agents_by_agent.ts";
import { normalizeAgentTreeGeneralRows } from "./f402_list_agents_by_agent.ts";

export function stableStringify(value: unknown): string {
  return `${JSON.stringify(value, stableReplacer)}\n`;
}

function stableReplacer(_key: string, val: unknown): unknown {
  if (val === null || typeof val !== "object") return val;
  if (Array.isArray(val)) return val.map((item) => item);
  const obj = val as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = obj[k];
  return out;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("hex");
}

export async function sha256Hex(
  data: Uint8Array<ArrayBuffer> | string,
): Promise<string> {
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(digest);
}

/** Short fingerprint for pre-dedupe (first 8 bytes of SHA-256). */
export async function fastBodyFingerprint(
  body: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", body);
  return bytesToHex(digest).slice(0, 16);
}

export async function envelopeTreeHash(
  envelope: ListAgentsByAgentEnvelope,
): Promise<string> {
  const tree = normalizeAgentTreeGeneralRows(envelope.GENERAL);
  return sha256Hex(stableStringify(tree));
}
