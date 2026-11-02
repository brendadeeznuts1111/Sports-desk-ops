/**
 * @file f402_flag_values.ts
 * @description The portal's on/off flag values, and the padding they arrive with.
 *
 * The Manager API writes `"on "` and `"off"` — sometimes `"off       "` — into fields that read
 * like booleans. Two separate consequences, both silent:
 *
 *  - equality fails: `"on " !== "on"`, so a naive check reports every enabled flag as disabled;
 *  - the padding is asymmetric, so the naive check looks *half* right — `"off"` happens to compare
 *    equal, which is why the bug survives a casual test.
 *
 * This module exists so the trim rule is written once. It came from
 * `f402_config_web_reports_customer_admin.ts`, which needed it for the web-reports grid, after the
 * bet-ticker config turned out to need exactly the same rule.
 */

/** Strips the portal's padding from a flag. `null`/`undefined` become `""`. */
export function trimFlag(raw: string | undefined | null): string {
  return (raw ?? "").trim();
}

/**
 * Normalises a flag to `"on"` | `"off"` (lower-cased and trimmed).
 *
 * Anything else is returned trimmed but otherwise verbatim, because the portal has flag fields with
 * other vocabularies and silently mapping them to a boolean would hide a changed contract.
 */
export function normalizeOnOffFlag(raw: string | undefined | null): string {
  const trimmed = trimFlag(raw);
  const lowered = trimmed.toLowerCase();
  if (lowered === "on" || lowered === "off") return lowered;
  return trimmed;
}

/**
 * True only for the portal's `on` flag, however it is padded.
 *
 * `"on"`, `"on "`, `" ON "` → true. `"off"`, `""`, `"1"`, `undefined` → false. A flag with an
 * unknown value is *not* treated as on: an unrecognised value is a contract change, not consent.
 */
export function isFlagOn(raw: string | undefined | null): boolean {
  return normalizeOnOffFlag(raw) === "on";
}
