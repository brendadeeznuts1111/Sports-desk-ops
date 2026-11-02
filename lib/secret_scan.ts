/**
 * Credential shapes that must never reach a tracked file.
 *
 * Written after a `curl` pasted into chat carried a live manager JWT plus `cf_clearance` and
 * `__cf_bm` — and after finding that `docs/evidence/captures/har/manager-boot-pipeline-proven.redacted.har.json`,
 * a file with "redacted" in its name, still held 311-character `cf_clearance` and 199-character
 * `__cf_bm` values. The existing redaction gates cover request/response bodies, not cookie headers.
 *
 * The rules are length- and shape-based so the repository's own fixtures keep passing:
 * `cf_clearance=live123` is a test value, a 40+ character base64url blob is not.
 */

export type SecretKind =
  | "jwt"
  | "cloudflare-clearance"
  | "cloudflare-bot-management"
  | "bearer-token"
  | "private-key";

export interface SecretFinding {
  readonly kind: SecretKind;
  readonly line: number;
  /** Masked evidence: shape and length, never the value. */
  readonly masked: string;
}

interface Rule {
  readonly kind: SecretKind;
  readonly pattern: RegExp;
}

/** A JWT is three base64url segments; the header segment always starts with `eyJ`. */
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;

const RULES: readonly Rule[] = [
  { kind: "jwt", pattern: JWT },
  // A live Cloudflare clearance cookie is ~200-400 characters; the test fixtures use short ones.
  {
    kind: "cloudflare-clearance",
    pattern: /cf_clearance=([A-Za-z0-9_-]{40,})/,
  },
  {
    kind: "cloudflare-bot-management",
    pattern: /__cf_bm=([A-Za-z0-9_.-]{40,})/,
  },
  // `Bearer <SPORTSDESK_ADMIN_TOKEN>` and `${TOKEN}` placeholders stay below the length floor.
  { kind: "bearer-token", pattern: /[Bb]earer\s+([A-Za-z0-9._~+/-]{40,})/ },
  { kind: "private-key", pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/ },
];

/**
 * Values their authors publish as examples; they are not credentials. Exact match only — a
 * near-miss is still a finding, so a real token cannot hide behind a similar string.
 */
const PUBLIC_EXAMPLE_TOKENS: ReadonlySet<string> = new Set([
  // jwt.io's default HS256 sample (sub 1234567890, secret "your-256-bit-secret").
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
]);

function mask(value: string): string {
  const visible = value.slice(0, 4);
  return `${visible}… (${value.length} chars)`;
}

/** Scan one file's text; returns findings ordered by line. */
export function scanText(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const rule of RULES) {
      const match = rule.pattern.exec(line);
      if (match === null) continue;
      const value = match[1] ?? match[0];
      if (
        PUBLIC_EXAMPLE_TOKENS.has(value) ||
        PUBLIC_EXAMPLE_TOKENS.has(match[0])
      ) {
        continue;
      }
      findings.push({ kind: rule.kind, line: i + 1, masked: mask(value) });
    }
  }
  return findings;
}

/** True for a file we cannot read as text (a NUL byte in the first block). */
export function looksBinary(bytes: Uint8Array): boolean {
  const window = bytes.subarray(0, 8192);
  for (const byte of window) if (byte === 0) return true;
  return false;
}
