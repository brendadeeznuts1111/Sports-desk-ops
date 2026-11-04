#!/usr/bin/env bun
/**
 * Probe the injected client seams on a live Manager page (Chrome/CDP only).
 *
 *   bun run probe:client-seams -- --profile scratch/webview-profile --login
 *   bun run probe:client-seams -- --url '<bet-ticker URL>' --profile <dir> --login
 *   bun run probe:client-seams -- --profile <dir> --login --no-seam   # negative control
 *
 * The probe is the precondition for migrating a call site: it proves, on a booted session, that the
 * seam is present as own properties, that every leaf the pinned controller references passes the
 * allowlist, and that `isAuthenticated()` returns true on the page the fix will guard. WebKit has no
 * cdp(), so this runner only launches Chrome and reports `covered: false` for any other backend.
 *
 * Exit: 0 covered + authenticated + clean; 1 covered but a structural assertion failed;
 *       2 covered, structural pass, authenticated path unverified; 3 not covered (WebKit);
 *       4 probe could not run (login/boot). No credential is printed; login uses the keychain/TTY
 * path in scripts/capture/f402_login.ts.
 */

import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  checkExpectedRendered,
  installSecuritySeamsPreload,
  probeSecuritySeams,
} from "../../lib/f402_client_overlay.ts";
import {
  canaryExitCode,
  managerModuleLeaves,
} from "../../lib/f402_client_seams.ts";
import { acquireProfileLock } from "../../lib/f402_profile_lock.ts";
import { resolveF402WebViewProfileDir } from "../../lib/f402_replay_transport.ts";
import { loginF402 } from "../capture/f402_login.ts";
import { ManagedWebView } from "../capture/webview.ts";

const REPO_ROOT = join(import.meta.dir, "../..");
const PINNED_MANAGER = join(
  REPO_ROOT,
  "verification/manager-boot-oracle/pinned/manager.js",
);

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    profile: { type: "string" },
    url: { type: "string" },
    base: { type: "string" },
    login: { type: "boolean" },
    waitMs: { type: "string", default: "30000" },
    "no-seam": { type: "boolean" },
    "expect-rendered": { type: "string" },
    guard: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help === true) {
  console.log(`probe:client-seams — verify the client seam preload on a live Chrome session

  --profile <dir>  Chrome dataStore (default F402_WEBVIEW_PROFILE or scratch/f402-manager-webview-profile)
  --url <url>      page to probe (default: manager.html?external-view=active&module=bet-ticker)
  --base <url>     portal base (default F402_BASE_URL or https://www.fantasy402.com)
  --login          sign in first via keychain/TTY (optional: omit when the profile already
                   has a live session)
  --waitMs <ms>    boot wait after the probed navigation (default 30000)
  --no-seam        negative control: skip the preload, expect the probe to fail
  --expect-rendered <css>
                   canary acceptance: this selector must match after the guarded render
                   (bet ticker example: '[data-wager-number]'; an empty ticker matches
                   nothing, so run the canary during active wagering)
  --guard          append external-view-guard=1 to the probed URL (canary mode)
  --help           this text

  Exit: 0 covered+authenticated+clean; 1 structural failure; 2 structural pass, authenticated
  unverified; 3 not covered (WebKit); 4 could not run.`);
  process.exit(0);
}

const base = (
  values.base?.trim() ||
  Bun.env.F402_BASE_URL?.trim() ||
  "https://www.fantasy402.com"
).replace(/\/$/, "");
const profile = values.profile?.trim() || resolveF402WebViewProfileDir();
const requestedUrl =
  values.url?.trim() ||
  `${base}/manager.html?external-view=active&module=bet-ticker`;
const targetUrl =
  values.guard === true && !/[?&]external-view-guard=/.test(requestedUrl)
    ? `${requestedUrl}${requestedUrl.includes("?") ? "&" : "?"}external-view-guard=1`
    : requestedUrl;
const bootWaitMs = Number(values.waitMs ?? "30000");
const waitMs =
  Number.isFinite(bootWaitMs) && bootWaitMs > 0 ? bootWaitMs : 30_000;

const managerJs = await Bun.file(PINNED_MANAGER).text();
const moduleLeaves = managerModuleLeaves(managerJs);

const lock = acquireProfileLock(profile);
const view = ManagedWebView.launch({
  backend: "chrome",
  dataStoreDir: profile,
  navigateTimeoutMs: 30_000,
  consoleLimit: 100,
});

async function waitForSecurityModule(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ready = await view.evaluateIife(
        'try { return !!(window.require && window.require("system/security")); } catch (error) { return false; }',
      );
      if (ready === true) return true;
    } catch {
      // The page may be mid-navigation; keep polling until the deadline.
    }
    await Bun.sleep(500);
  }
  return false;
}

try {
  // Chrome only exposes a CDP session after the first navigation, so create one before
  // registering the preload. Warm up on manager.html itself: the portal root can redirect to a
  // destination Chrome will not settle on, which leaves the view at about:blank.
  //
  // The first navigation also trips `waitForLoad` on some Bun/Chrome builds: the document commits
  // (the title is set) but `view.url` still reports about:blank, so the settle check times out.
  // The CDP session exists at that point, which is all the preload registration needs.
  try {
    await view.navigate(`${base}/manager.html`, { timeoutMs: 30_000 });
  } catch (error) {
    if (view.title.trim() === "" && !String(error).includes("did not settle")) {
      throw error;
    }
    console.error(
      JSON.stringify({
        signal: "CLIENT_SEAM_WARMUP_SETTLE_TIMEOUT",
        url: view.url,
        title: view.title,
        note: "first navigation committed but Bun reported about:blank; continuing after CDP session creation",
      }),
    );
  }

  let installed = false;
  let installReason: string | null = null;
  if (values["no-seam"] !== true) {
    const outcome = await installSecuritySeamsPreload(view, {
      backend: "chrome",
    });
    installed = outcome.installed;
    installReason = outcome.reason;
    if (!installed) {
      console.error(
        JSON.stringify({
          signal: "CLIENT_SEAM_NOT_COVERED",
          reason: installReason,
        }),
      );
      process.exit(3);
    }
  }

  if (values.login === true) {
    await loginF402(view, { baseUrl: base, timeoutMs: 120_000 });
  }

  await view.navigate(targetUrl);
  const booted = await waitForSecurityModule(waitMs);
  const probe = await probeSecuritySeams(view, {
    moduleLeaves,
    backend: "chrome",
  });
  const expectRendered = values["expect-rendered"]?.trim();
  const rendered =
    expectRendered === undefined || expectRendered === ""
      ? null
      : await checkExpectedRendered(view, expectRendered);

  console.log(
    JSON.stringify(
      {
        signal: "CLIENT_SEAM_PROBE",
        backend: "chrome",
        profile,
        url: view.url,
        title: view.title,
        preloadInstalled: installed,
        securityModuleLoaded: booted,
        canaryGuard: values.guard === true,
        structural: probe.structural,
        authenticated: probe.authenticated === true ? "verified" : "unverified",
        probe,
      },
      null,
      2,
    ),
  );

  process.exit(canaryExitCode(probe, rendered));
} catch (error) {
  console.error(
    JSON.stringify({
      signal: "CLIENT_SEAM_PROBE_FAILED",
      error: String(error).slice(0, 400),
    }),
  );
  process.exit(4);
} finally {
  view.close();
  lock.release();
}
