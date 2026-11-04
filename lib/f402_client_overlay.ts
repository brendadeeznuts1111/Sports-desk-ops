/**
 * Install and verify the browser seam preload over CDP.
 *
 * Only the Chrome backend supports this: `Bun.WebView` exposes `cdp()` there (and no
 * preload/interception hook on any backend). WebKit therefore reports "not covered" instead of
 * passing, because a check that succeeds on an unpatched backend is worse than no check.
 */

import { join } from "node:path";

import {
  buildSeamProbeScript,
  evaluateSeamProbe,
  parseSeamProbe,
} from "./f402_client_seams.ts";
import type { SeamProbeOutcome } from "./f402_client_seams.ts";

export const SECURITY_SEAMS_PRELOAD_PATH = join(
  import.meta.dir,
  "..",
  "client",
  "overlay",
  "security-seams.preload.js",
);

export type WebViewBackend = "chrome" | "webkit";

export interface CdpView {
  cdp(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface EvaluateView {
  evaluate(expression: string): Promise<unknown>;
}

export interface BackendOption {
  readonly backend?: WebViewBackend;
}

export interface InstallOutcome {
  readonly installed: boolean;
  readonly reason: string | null;
}

export interface ProbeOptions extends BackendOption {
  readonly moduleLeaves: readonly string[];
}

export interface InstallOptions extends BackendOption {
  readonly source?: string;
}

export async function securitySeamsPreloadSource(
  path: string = SECURITY_SEAMS_PRELOAD_PATH,
): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`seam preload missing: ${path}`);
  return file.text();
}

/**
 * Register the preload on a Chrome-backed view. The caller must navigate afterwards; the script
 * runs before any page script on that navigation and every later one.
 */
export async function installSecuritySeamsPreload(
  view: CdpView,
  options: InstallOptions = {},
): Promise<InstallOutcome> {
  if (options.backend !== undefined && options.backend !== "chrome") {
    return {
      installed: false,
      reason:
        "webkit backend has no cdp(); the seam preload is not installed and the session is not covered",
    };
  }
  const preload = options.source ?? (await securitySeamsPreloadSource());
  await view.cdp("Page.addScriptToEvaluateOnNewDocument", {
    source: preload,
  });
  return { installed: true, reason: null };
}

/** Assert the seams after boot. WebKit returns `covered: false` with a note, never a pass. */
export async function probeSecuritySeams(
  view: EvaluateView,
  options: ProbeOptions,
): Promise<SeamProbeOutcome> {
  if (options.backend !== undefined && options.backend !== "chrome") {
    return {
      covered: false,
      issues: [],
      notes: [
        "not covered: WebKit backend has no cdp()/preload; the seam is absent on this session, not verified",
      ],
      csrf: null,
      authenticated: null,
      diag: null,
    };
  }
  const raw = await view.evaluate(buildSeamProbeScript(options.moduleLeaves));
  const probe = parseSeamProbe(raw);
  return evaluateSeamProbe(probe, options.moduleLeaves);
}
