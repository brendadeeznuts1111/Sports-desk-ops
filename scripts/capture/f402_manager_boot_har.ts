#!/usr/bin/env bun
/**
 * Chrome WebView manager-boot HAR capture (CDP Network.*).
 * Redact → sentinel sweep → write HAR + redaction proof (never raw response on disk).
 *
 *   bun run capture:f402-har -- --login --profile scratch/f402-manager-webview-profile
 */
import { mkdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";

import { GATE_EXIT_FAILED } from "../../lib/f402_gate_exit.ts";
import { buildHarRedactionProof } from "../../lib/f402_har_redaction_sweep.ts";
import { writeRedactedHarFile } from "../../lib/f402_har_redact_stream.ts";
import { acquireProfileLock } from "../../lib/f402_profile_lock.ts";
import { resolveF402WebViewProfileDir } from "../../lib/f402_replay_transport.ts";
import { loginF402 } from "./f402_login.ts";
import { ManagedWebView } from "./webview.ts";

const REPO_ROOT = join(import.meta.dir, "../..");

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    profile: { type: "string" },
    out: { type: "string" },
    proof: { type: "string" },
    url: { type: "string" },
    login: { type: "boolean" },
    waitMs: { type: "string", default: "45000" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`f402_manager_boot_har — Chrome CDP capture + redaction proof

  --login     Refresh session via keychain or TTY (never env password by default)
  --profile   WebView dataStore (default F402_WEBVIEW_PROFILE)
  --out       Redacted HAR path (default: manifest pipeline HAR)
  --proof     Redaction proof JSON (default: sibling of --out)
  --waitMs    Wait after navigate for hierarchy XHR (default 45000)
`);
  process.exit(0);
}

const base = (Bun.env.F402_BASE_URL ?? "https://www.fantasy402.com").replace(
  /\/$/,
  "",
);
const startUrl = values.url?.trim() || `${base}/manager/manager.html`;
const profile = values.profile?.trim() || resolveF402WebViewProfileDir();
const defaultHar = join(
  REPO_ROOT,
  "docs/evidence/captures/har/manager-boot-pipeline-proven.redacted.har.json",
);
const outPath = values.out?.trim() || defaultHar;
const proofPath =
  values.proof?.trim() ||
  `${outPath.replace(/\.har\.json$/i, "")}.redaction-proof.json`;
const waitMs = Number(values.waitMs ?? "45000");

interface HarEntry {
  startedDateTime: string;
  request: {
    method: string;
    url: string;
    headers: { name: string; value: string }[];
    postData?: { mimeType: string; text: string };
  };
  response: {
    status: number;
    headers: { name: string; value: string }[];
    content: { mimeType: string; text?: string };
  };
}

const entries: HarEntry[] = [];

/**
 * CDP allows one in-flight command per session: a second concurrent `cdp()` throws
 * synchronously. Every body fetch goes through this queue, so a burst of
 * `loadingFinished` events cannot overlap.
 */
let cdpQueue: Promise<unknown> = Promise.resolve();
const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = cdpQueue.then(fn, fn);
  cdpQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

interface TrackedRequest {
  readonly method: string;
  readonly startedDateTime: string;
}

interface TrackedResponse {
  readonly url: string;
  readonly status: number;
  readonly mimeType: string;
}

/** `requestWillBeSent` → real method + start time, keyed by CDP requestId. */
const trackedRequests = new Map<string, TrackedRequest>();
/** `responseReceived` → URL/status/mimeType, keyed by the same requestId. */
const trackedResponses = new Map<string, TrackedResponse>();

// Fails fast when another capture still holds this Chrome profile.
using _lock = profile.trim() === "" ? null : acquireProfileLock(profile);

await using view = ManagedWebView.launch({
  backend: "chrome",
  dataStoreDir: profile,
  width: 1440,
  height: 900,
});

if (values.login === true) {
  console.error(
    "capture:f402-har --login (keychain secrets:f402 or TTY; MFA/CAPTCHA → bootstrap profile manually)",
  );
  await loginF402(view, { baseUrl: base, timeoutMs: 120_000 });
}

/**
 * Chrome only creates the CDP session on the first navigation, so `Network.enable`
 * rejects before one happens. Prime with `about:blank` (which still records the
 * subsequent document's response) and enable the domain before registering
 * listeners or navigating to the portal.
 */
async function enableManagerHarCapture(): Promise<void> {
  await view.primeCdpSession();
  await view.cdp("Network.enable");
}

await enableManagerHarCapture();

view.onCdpEvent<{
  requestId: string;
  request?: { url?: string; method?: string };
}>("Network.requestWillBeSent", (event) => {
  trackedRequests.set(event.requestId, {
    method: (event.request?.method ?? "POST").toUpperCase(),
    startedDateTime: new Date().toISOString(),
  });
});

view.onCdpEvent<{
  requestId: string;
  response?: { url: string; status: number; mimeType: string };
}>("Network.responseReceived", (event) => {
  if (event.response === undefined) return;
  trackedResponses.set(event.requestId, {
    url: event.response.url,
    status: event.response.status,
    mimeType: event.response.mimeType,
  });
});

// Bodies are only readable once the response is complete; fetch them here, queued,
// so the request map still has the real method and start time.
view.onCdpEvent<{ requestId: string }>("Network.loadingFinished", (event) => {
  const tracked = trackedResponses.get(event.requestId);
  const request = trackedRequests.get(event.requestId);
  trackedResponses.delete(event.requestId);
  trackedRequests.delete(event.requestId);
  if (tracked === undefined) return;
  const { url, status, mimeType } = tracked;
  if (!url.includes("/cloud/api/Manager/")) return;
  void enqueue(async () => {
    try {
      const body = (await view.cdp("Network.getResponseBody", {
        requestId: event.requestId,
      })) as { body?: string; base64Encoded?: boolean };
      let text = body.body ?? "";
      if (body.base64Encoded === true) {
        text = Buffer.from(text, "base64").toString("utf8");
      }
      let postText = "";
      try {
        const post = (await view.cdp("Network.getRequestPostData", {
          requestId: event.requestId,
        })) as { postData?: string };
        postText = post.postData ?? "";
      } catch {
        // Post body unavailable (evicted).
      }
      entries.push({
        startedDateTime: request?.startedDateTime ?? new Date().toISOString(),
        request: {
          method: request?.method ?? "POST",
          url,
          headers: [{ name: "x-requested-with", value: "XMLHttpRequest" }],
          ...(postText !== ""
            ? {
                postData: {
                  mimeType: "application/x-www-form-urlencoded",
                  text: postText,
                },
              }
            : {}),
        },
        response: {
          status,
          headers: [{ name: "content-type", value: mimeType }],
          content: { mimeType, text },
        },
      });
    } catch {
      // Body evicted: skip the entry.
    }
  });
});

view.onCdpEvent<{ requestId: string }>("Network.loadingFailed", (event) => {
  trackedRequests.delete(event.requestId);
  trackedResponses.delete(event.requestId);
});

console.error(`capture:f402-har navigate ${startUrl} profile=${profile}`);
await view.navigate(startUrl);
await Bun.sleep(Number.isFinite(waitMs) ? waitMs : 45_000);
/**
 * Let queued body fetches finish so the HAR does not drop late responses. A plain
 * `await cdpQueue` only drains the current tail: a `loadingFinished` delivered after the
 * snapshot enqueues onto a later tail and would be lost at exit. Wait until one quiet
 * bound passes with no new tail.
 */
let tail = cdpQueue;
for (;;) {
  await tail;
  await Bun.sleep(250);
  if (tail === cdpQueue) break;
  tail = cdpQueue;
}

const managerEntries = entries.filter((e) =>
  e.request.url.includes("/cloud/api/Manager/"),
);

/**
 * Derived from the entries that actually survived the body fetch, never from the
 * `responseReceived` event: a HAR that dropped the list-agents body must not pass the
 * redaction-proof gate's `listAgentsCaptured` check.
 */
const listAgentsCaptured = managerEntries.some(
  (e) =>
    e.request.url.includes("getListAgenstByAgent") ||
    e.request.url.includes("getListAgentByAgent"),
);

if (managerEntries.length === 0) {
  console.error(
    JSON.stringify({
      signal: "F402_HAR_CAPTURE_EMPTY",
      gateOutcome: "FAILED",
      hint: "No Manager API entries — sign in (--login) or use a profile with an active session",
    }),
  );
  process.exit(GATE_EXIT_FAILED);
}

const har = {
  log: {
    version: "1.2",
    creator: { name: "f402_manager_boot_har", redacted: true },
    entries,
  },
};

await mkdir(dirname(outPath), { recursive: true });

let prepared;
try {
  prepared = await writeRedactedHarFile(outPath, har);
} catch (e) {
  console.error(
    JSON.stringify({
      signal: "F402_HAR_REDACTION_SWEEP_FAILED",
      gateOutcome: "FAILED",
      error: String(e),
    }),
  );
  process.exit(GATE_EXIT_FAILED);
}

const proof = await buildHarRedactionProof({
  harPath: relative(REPO_ROOT, outPath),
  redactedText: prepared.redactedText,
  entryCount: entries.length,
  managerApiEntries: managerEntries.length,
  listAgentsCaptured,
});

if (!proof.sweep.ok) {
  console.error(JSON.stringify({ gateOutcome: "FAILED", proof }));
  process.exit(GATE_EXIT_FAILED);
}

await Bun.write(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
console.error(
  JSON.stringify({
    signal: "F402_HAR_CAPTURE_OK",
    har: relative(REPO_ROOT, outPath),
    proof: relative(REPO_ROOT, proofPath),
    listAgentsCaptured,
    managerApiEntries: managerEntries.length,
  }),
);
