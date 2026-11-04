/**
 * Gate-side mirror of the injected seam preload.
 *
 * The runtime artifact is `client/overlay/security-seams.preload.js`; this module is what the tests,
 * the probe and the gate use to agree with it. `managerModuleLeaves` reads the pinned controller
 * bytes, so the allowlist is checked against the module graph the vendor actually ships — not a
 * hand-written list that drifts.
 */

import { z } from "zod";

/**
 * Leaf names (the last path segment of an AMD module id) the seam's dynamic-require gate accepts.
 * Seeds are the task's list; `message`, `total-active-customer` and the `customer-admin`
 * submodules were added because the pinned controller graph references them.
 */
export const ALLOWED_MODULES: readonly string[] = [
  "add-customer",
  "agent-billing",
  "agent-management-thin",
  "agent-performance",
  "agent-position",
  "analysis",
  "bet-ticker",
  "cashier",
  "crash",
  "customer-admin",
  "dashboard",
  "delete-wager",
  "dynamic-live",
  "enter-transaction",
  "extended-props",
  "game-admin",
  "graded",
  "ip-tracker",
  "live-casino",
  "master-sheet",
  "message",
  "pending-thin",
  "player-info",
  "prop-admin",
  "rules",
  "settled-figure",
  "sportbook",
  "total-active-customer",
  "transaction",
  "transaction-history",
  "weekly-figure",
  "weekly-figure-thin",
] as const;

/** Own properties the probe requires on the `system/security` singleton. */
export const SEAM_OWN_PROPERTIES: readonly string[] = [
  "escHtml",
  "escUrl",
  "csrf",
  "sessionExpired",
  "isAuthenticated",
  "requireAuth",
  "allowedModules",
  "isAllowedModule",
  "endSession",
  "flags",
] as const;

const LEAF_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Accepts a leaf (`player-info`) or a full AMD id (`manager/module/player-info`). The leaf is
 * extracted here so every caller — including `dataUrl("module")`, which can return `false` — has
 * the same behavior.
 */
export function isAllowedModule(
  moduleId: unknown,
  allowed: ReadonlySet<string> = new Set(ALLOWED_MODULES),
): boolean {
  if (typeof moduleId !== "string" || moduleId === "") return false;
  const leaf = moduleId.split("/").pop() ?? "";
  return LEAF_RE.test(leaf) && allowed.has(leaf);
}

/** `manager/module/*` ids referenced by a controller bundle, sorted and unique. */
export function managerModuleIds(managerJs: string): string[] {
  const ids = new Set<string>();
  const pattern = /["'](manager\/module\/[a-z0-9][a-z0-9/-]*)["']/g;
  for (const match of managerJs.matchAll(pattern)) {
    const id = match[1];
    if (id !== undefined) ids.add(id);
  }
  return [...ids].sort();
}

/** Leaf names of the controller's `manager/module/*` ids — what the seam gate sees. */
export function managerModuleLeaves(managerJs: string): string[] {
  return [
    ...new Set(
      managerModuleIds(managerJs).map((id) => id.split("/").pop() ?? ""),
    ),
  ]
    .filter((leaf) => LEAF_RE.test(leaf))
    .sort();
}

/** ALLOWED_LEAVES parsed out of the preload source, so the two lists cannot silently diverge. */
export function preloadAllowedLeaves(source: string): string[] {
  const match = /ALLOWED_LEAVES\s*=\s*(\[[\s\S]*?\]);/.exec(source);
  if (match?.[1] === undefined) {
    throw new Error("preload: ALLOWED_LEAVES array not found");
  }
  // The checked-in preload is formatted with a trailing comma in the array literal.
  const parsed: unknown = JSON.parse(match[1].replace(/,\s*\]$/, "]"));
  return z.array(z.string()).parse(parsed);
}

const SeamProbeSchema = z.object({
  applied: z.boolean(),
  ownProperties: z.record(z.string(), z.boolean()),
  allowed: z.record(z.string(), z.boolean()),
  authenticated: z.boolean().nullable(),
  csrf: z.string().nullable(),
  reason: z.string().nullable(),
  diag: z.record(z.string(), z.unknown()).nullable(),
});

export type SeamProbe = z.infer<typeof SeamProbeSchema>;

/** Browser expression: reads the live singleton and reports only serializable facts. */
export function buildSeamProbeScript(leaves: readonly string[]): string {
  const properties = JSON.stringify(SEAM_OWN_PROPERTIES);
  const expectedLeaves = JSON.stringify(leaves);
  return `(function () {
  var out = { applied: false, ownProperties: {}, allowed: {}, authenticated: null, csrf: null, reason: null };
  var exported = null;
  try { exported = window.require ? window.require("system/security") : null; } catch (error) { out.reason = "require-threw"; }
  if (!exported) { out.reason = out.reason || "security-module-not-loaded"; return JSON.stringify(out); }
  var n = exported;
  if (typeof exported === "function") {
    try { n = new exported(); } catch (error0) { out.reason = "security-instantiate-threw"; }
  }
  var properties = ${properties};
  for (var i = 0; i < properties.length; i += 1) {
    try { var touched = n[properties[i]]; void touched; } catch (error1) {}
    out.ownProperties[properties[i]] = Object.prototype.hasOwnProperty.call(n, properties[i]);
  }
  out.applied = !!(out.ownProperties.escHtml && out.ownProperties.isAllowedModule && out.ownProperties.allowedModules);
  var leaves = ${expectedLeaves};
  for (var j = 0; j < leaves.length; j += 1) {
    try { out.allowed[leaves[j]] = n.isAllowedModule(leaves[j]) === true; } catch (error2) { out.allowed[leaves[j]] = false; }
  }
  try { out.authenticated = n.isAuthenticated() === true; } catch (error3) { out.reason = out.reason || "isAuthenticated-threw"; }
  try { out.csrf = n.csrf(); } catch (error4) { out.reason = out.reason || "csrf-threw"; }
  out.diag = {
    preload: !!window.__F402_SEAMS__,
    seamDisabled: window.__F402_SEAM_DISABLED__ === true,
    requirejs: !!window.requirejs,
    hasOnResourceLoad: !!(window.requirejs && typeof window.requirejs.onResourceLoad === "function"),
    exportedType: typeof exported,
    keys: Object.keys(n).slice(0, 30),
    seam: window.__F402_SEAMS__ && typeof window.__F402_SEAMS__.diag === "function"
      ? window.__F402_SEAMS__.diag()
      : null
  };
  return JSON.stringify(out);
})()`;
}

export function parseSeamProbe(raw: unknown): SeamProbe {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  return SeamProbeSchema.parse(value);
}

export type ProbeStructural = "pass" | "fail" | "not-covered";

export interface SeamProbeOutcome {
  readonly covered: boolean;
  /** Structural verdict: own properties, allowlist coverage and installation. */
  readonly structural: ProbeStructural;
  readonly issues: readonly string[];
  readonly notes: readonly string[];
  readonly csrf: string | null;
  readonly authenticated: boolean | null;
  readonly diag: Readonly<Record<string, unknown>> | null;
}

function seamDiagnostics(probe: SeamProbe): Record<string, unknown> | null {
  const seam = probe.diag?.["seam"];
  return typeof seam === "object" && seam !== null
    ? (seam as Record<string, unknown>)
    : null;
}

/**
 * Exit-code contract shared by the probe runner:
 *   0 covered, authenticated and clean
 *   1 covered, structural failure
 *   2 covered, structural pass, authenticated path unverified
 *   3 not covered (WebKit)
 * (4 is reserved for "could not run" and lives in the runner.)
 */
export function seamProbeExitCode(outcome: SeamProbeOutcome): 0 | 1 | 2 | 3 {
  if (!outcome.covered) return 3;
  if (outcome.structural === "fail") return 1;
  if (outcome.authenticated !== true) return 2;
  return 0;
}

/** Turn a probe result into gate issues and explicit notes. A dormant control is a note, never a pass. */
export function evaluateSeamProbe(
  probe: SeamProbe,
  leaves: readonly string[],
): SeamProbeOutcome {
  const issues: string[] = [];
  const notes: string[] = [];

  if (!probe.applied) {
    issues.push(probe.reason ?? "seam not applied to system/security");
  }
  for (const [key, present] of Object.entries(probe.ownProperties)) {
    if (!present) issues.push(`seam member is not an own property: ${key}`);
  }
  for (const leaf of leaves) {
    if (probe.allowed[leaf] !== true) {
      issues.push(`isAllowedModule(${leaf}) did not return true`);
    }
  }
  if (probe.authenticated !== true) {
    notes.push(
      "authenticated path unverified: isAuthenticated() returned false/null; the seam is structurally installed but the session check was not exercised",
    );
  }
  const seam = seamDiagnostics(probe);
  if (seam?.["registryDegraded"] === true) {
    notes.push(
      "requirejs registry degraded: requirejs.s.contexts is unavailable, so the watchdog could not verify the loaded security module; the onResourceLoad path still applies",
    );
  }
  if (probe.csrf === "") {
    notes.push(
      "csrf dormant: no <meta name=csrf-token> and no csrf cookie; the Bearer lives in sessionStorage.credentials.code, so there is no cookie CSRF surface",
    );
  }
  if (probe.reason !== null) notes.push(`probe note: ${probe.reason}`);

  return {
    covered: true,
    structural: issues.length === 0 ? "pass" : "fail",
    issues,
    notes,
    csrf: probe.csrf,
    authenticated: probe.authenticated,
    diag: probe.diag,
  };
}
