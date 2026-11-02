/**
 * Sentinel sweep on redacted HAR / capture JSON (load-bearing for gate i).
 */

import { scanText } from "./secret_scan.ts";

export const F402_HAR_REDACTION_SWEEP_FAILED =
  "F402_HAR_REDACTION_SWEEP_FAILED";

export interface HarRedactionSweepViolation {
  readonly code: string;
  readonly detail: string;
}

const FORBIDDEN: readonly { readonly re: RegExp; readonly label: string }[] = [
  { re: /\bset-cookie\b/i, label: "set-cookie" },
  { re: /\bauthorization\b/i, label: "authorization" },
  { re: /\bBearer\s+[A-Za-z0-9._-]{8,}/, label: "Bearer token" },
  { re: /\bcookie\s*:\s*[^"[\s]/i, label: "raw cookie header value" },
];

/** Password values in redacted output must be sentinel or [REDACTED] only. */
const BAD_PASSWORD_VALUE =
  /"Password"\s*:\s*"(?!REDACTED_PASSWORD"|\\[REDACTED\\]")[^"]+"/g;

export function sweepRedactedCaptureText(
  text: string,
): readonly HarRedactionSweepViolation[] {
  const violations: HarRedactionSweepViolation[] = [];

  for (const { re, label } of FORBIDDEN) {
    if (re.test(text)) {
      violations.push({
        code: "forbidden_substring",
        detail: `redacted file contains ${label}`,
      });
    }
  }

  const badPw = text.match(BAD_PASSWORD_VALUE);
  if (badPw !== null && badPw.length > 0) {
    violations.push({
      code: "password_leak",
      detail: `non-sentinel Password values in redacted output (count ${badPw.length})`,
    });
  }

  if (/"Password"\s*:\s*""/.test(text)) {
    violations.push({
      code: "empty_password_key",
      detail: "empty Password string — use sentinel or omit",
    });
  }

  // The `cookie` rule above matches a raw `Cookie:` header line, but a HAR stores headers as
  // {"name":"cookie","value":"…"}, so it never fired: a "redacted" HAR shipped with 311-character
  // cf_clearance and 199-character __cf_bm values and the proof still said violationCount 0.
  // The credential shapes are the check that actually sees the values.
  for (const finding of scanText(text)) {
    violations.push({
      code: "credential_shape",
      detail: `${finding.kind} at line ${finding.line} (${finding.masked})`,
    });
  }

  return violations;
}

export function assertRedactedCaptureSweep(text: string): void {
  const violations = sweepRedactedCaptureText(text);
  if (violations.length === 0) return;
  console.error(
    JSON.stringify({
      signal: F402_HAR_REDACTION_SWEEP_FAILED,
      violations,
    }),
  );
  throw new Error(F402_HAR_REDACTION_SWEEP_FAILED);
}

export interface HarRedactionProof {
  readonly schemaVersion: 1;
  readonly spec: "docs/evidence/manager-boot-har-redaction.md";
  readonly harPath: string;
  readonly harSha256: string;
  readonly capturedAt: string;
  readonly entryCount: number;
  readonly managerApiEntries: number;
  readonly listAgentsCaptured: boolean;
  readonly sweep: {
    readonly ok: boolean;
    readonly violationCount: number;
  };
}

export async function buildHarRedactionProof(options: {
  readonly harPath: string;
  readonly redactedText: string;
  readonly entryCount: number;
  readonly managerApiEntries: number;
  readonly listAgentsCaptured: boolean;
}): Promise<HarRedactionProof> {
  const violations = sweepRedactedCaptureText(options.redactedText);
  const { sha256HexText } = await import("./f402_portal_version_pin.ts");
  return {
    schemaVersion: 1,
    spec: "docs/evidence/manager-boot-har-redaction.md",
    harPath: options.harPath,
    harSha256: await sha256HexText(options.redactedText),
    capturedAt: new Date().toISOString(),
    entryCount: options.entryCount,
    managerApiEntries: options.managerApiEntries,
    listAgentsCaptured: options.listAgentsCaptured,
    sweep: { ok: violations.length === 0, violationCount: violations.length },
  };
}
