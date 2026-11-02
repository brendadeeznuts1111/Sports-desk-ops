#!/usr/bin/env bun
/**
 * Mint or inspect the portal session the replay transport uses.
 *
 *   bun run session:login --from-profile <dir>           # export a bootstrapped WebView profile
 *   F402_LIVE_LOGIN=1 F402_AGENT_ID=… F402_PASSWORD=… bun run session:login
 *   bun run session:status [--json]
 *
 * `--ttl-min <minutes>` sets the session lifetime on both mint paths (default
 * `F402_SESSION_TTL_MIN`, then 30); it is not a login timeout.
 *
 * Why this exists: `F402_WEBVIEW_PROFILE` names a WebView `dataStore` directory, and that directory
 * holds the cookies after a sign-in — but `createF402ReplayTransport()` never reads it
 * (Bun.FetchSession has no dataStore). A profile alone therefore yields **no** HTTP session, which
 * is why a machine with only a profile still gets 401s.
 *
 * There are two bridges into the 0600 session file the transport does read (`F402_SESSION_FILE`,
 * default `~/.cache/sportsdesk/f402-session.json`):
 *
 *   1. `--from-profile <dir>` launches the existing profile, copies its cookies, closes the view.
 *      Use this when MFA was bootstrapped by hand. No credentials, no `F402_LIVE_LOGIN`.
 *   2. No flag: one fresh credential login (`F402_LIVE_LOGIN=1` + `F402_AGENT_ID`/`F402_PASSWORD`).
 *
 * Nothing here prints a cookie value — only names and expiry.
 */

import { join } from "node:path";
import { parseArgs } from "node:util";

import { sessionFromWebViewProfile } from "../lib/f402_profile_session.ts";
import {
  describeF402Session,
  f402SessionTtlMinutesFromEnv,
  readF402Session,
  refreshF402Session,
  resolveF402SessionPath,
  writeF402Session,
  type F402Session,
} from "../lib/f402_session.ts";

const REPO = join(import.meta.dir, "..");
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    status: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    "ttl-min": { type: "string" },
    out: { type: "string" },
    "from-profile": { type: "string" },
  },
});

const env = Bun.env;
const configured = {
  liveLogin: env.F402_LIVE_LOGIN?.trim() === "1",
  agentId: (env.F402_AGENT_ID ?? "").trim() !== "",
  password: (env.F402_PASSWORD ?? "").trim() !== "",
  baseUrl: (env.F402_BASE_URL ?? "").trim() || "https://www.fantasy402.com",
  sessionFileEnv: (env.F402_SESSION_FILE ?? "").trim() !== "",
  proxy: (env.F402_REPLAY_PROXY_URL ?? "").trim() !== "",
  profile: (env.F402_WEBVIEW_PROFILE ?? "").trim() !== "",
};

if (values.status) {
  const session = readF402Session(
    values.out === undefined ? undefined : { path: values.out },
  );
  const report = {
    sessionPath: values.out ?? resolveF402SessionPath(),
    session: describeF402Session(session),
    ...(session === null
      ? {}
      : { cookieNames: session.cookieNames, expiresAt: session.expiresAtIso }),
    transport: configured.proxy
      ? "proxy (F402_REPLAY_PROXY_URL)"
      : session !== null
        ? "session-file"
        : "anonymous (no session file: the transport will send no cookie)",
    env: configured,
    profileNote: configured.profile
      ? "F402_WEBVIEW_PROFILE is set but the transport does not read it — export it with `bun run session:login --from-profile <dir>`"
      : null,
  };
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`session:status: ${report.session}`);
    console.log(`  file: ${report.sessionPath}`);
    console.log(`  transport would use: ${report.transport}`);
    if (report.profileNote !== null)
      console.log(`  note: ${report.profileNote}`);
  }
  process.exit(session !== null || configured.proxy ? 0 : 1);
}

const sessionPathOptions =
  values.out === undefined ? undefined : { path: values.out };

/**
 * `--ttl-min` is the session lifetime on both mint paths. A bad value is a
 * usage error: the credential path used to read it as a login timeout, which
 * silently left the TTL at the 30-minute default.
 */
function parseTtlMinutes(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    console.error(
      `session:login: --ttl-min must be a positive number of minutes (got ${JSON.stringify(raw)})`,
    );
    process.exit(2);
  }
  return minutes;
}

const ttlMinutes = parseTtlMinutes(values["ttl-min"]);

if (values["from-profile"] !== undefined) {
  // Profile export: the cookies already exist in the profile, so no credential login runs.
  let session: F402Session;
  try {
    session = await sessionFromWebViewProfile({
      profileDir: values["from-profile"],
      baseUrl: configured.baseUrl,
      ttlMinutes: ttlMinutes ?? f402SessionTtlMinutesFromEnv(env),
    });
  } catch (error) {
    console.error(
      `session:login --from-profile failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error(
      "  fix: run a WebView login with that profile (bun run capture:f402-har or scripts/capture/webview.ts), then retry; or check --from-profile / F402_WEBVIEW_PROFILE points at the dataStore dir.",
    );
    process.exit(1);
  }
  writeF402Session(session, sessionPathOptions);
  console.log(`session:login: ${describeF402Session(session)}`);
  process.exit(0);
}

if (!configured.liveLogin) {
  console.error(
    [
      "session:login needs F402_LIVE_LOGIN=1 to allow one WebView login.",
      "If a WebView profile already holds the cookies, export it instead:",
      "  bun run session:login --from-profile <dir>",
      "Otherwise set, in the environment of this command only:",
      "  F402_LIVE_LOGIN=1",
      "  F402_AGENT_ID=<login>",
      "  F402_PASSWORD=<password>        (never commit it; .env is gitignored)",
      "Optional: F402_BASE_URL, F402_SESSION_FILE, F402_SESSION_TTL_MIN",
      "Then: bun run session:status",
    ].join("\n"),
  );
  process.exit(2);
}
if (!configured.agentId || !configured.password) {
  console.error(
    "session:login needs F402_AGENT_ID and F402_PASSWORD (F402_LIVE_LOGIN=1 is set).",
  );
  process.exit(2);
}

const session = await refreshF402Session({
  env,
  ...(ttlMinutes === undefined ? {} : { ttlMinutes }),
});
const path = writeF402Session(session, sessionPathOptions);
console.log(`session:login: ${describeF402Session(session)}`);
console.log(
  `  written to ${path} (0600, inside ${REPO === "" ? "the repo" : "the cache dir"})`,
);
console.log("  next: bun run session:status, then bun run customers:crawl");
