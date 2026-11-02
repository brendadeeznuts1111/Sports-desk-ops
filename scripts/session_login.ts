#!/usr/bin/env bun
/**
 * Mint or inspect the portal session the replay transport uses.
 *
 *   F402_LIVE_LOGIN=1 F402_AGENT_ID=… F402_PASSWORD=… bun run session:login
 *   bun run session:status [--json]
 *
 * Why this exists: `F402_WEBVIEW_PROFILE` names a WebView `dataStore` directory, and that directory
 * holds the cookies after a sign-in — but `createF402ReplayTransport()` never reads it
 * (lib/f402_replay_transport.ts:2-3: "Bun.FetchSession has no dataStore, so WebView profile cookies
 * never reach it"). A profile alone therefore yields **no** HTTP session, which is why a machine with
 * only a profile still gets 401s.
 *
 * The bridge is this command: one WebView login, then the cookies are written to the 0600 session
 * file the transport does read (`F402_SESSION_FILE`, default ~/.cache/sportsdesk/f402-session.json`).
 * Nothing here prints a cookie value — only names and expiry.
 */

import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  describeF402Session,
  readF402Session,
  refreshF402Session,
  resolveF402SessionPath,
  writeF402Session,
} from "../lib/f402_session.ts";

const REPO = join(import.meta.dir, "..");
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    status: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    "ttl-min": { type: "string" },
    out: { type: "string" },
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
      ? "F402_WEBVIEW_PROFILE is set but the transport does not read it — export its cookies with `bun run session:login`"
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

if (!configured.liveLogin) {
  console.error(
    [
      "session:login needs F402_LIVE_LOGIN=1 to allow one WebView login.",
      "Set, in the environment of this command only:",
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

const ttlOverride = Number(values["ttl-min"] ?? "");
const session = await refreshF402Session({
  env,
  ...(Number.isFinite(ttlOverride) && ttlOverride > 0
    ? { timeoutMs: ttlOverride * 60_000 }
    : {}),
});
const path = writeF402Session(
  session,
  values.out === undefined ? undefined : { path: values.out },
);
console.log(`session:login: ${describeF402Session(session)}`);
console.log(
  `  written to ${path} (0600, inside ${REPO === "" ? "the repo" : "the cache dir"})`,
);
console.log("  next: bun run session:status, then bun run customers:crawl");
