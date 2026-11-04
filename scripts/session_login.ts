#!/usr/bin/env bun
/**
 * Mint or inspect the portal session the replay transport uses.
 *
 *   bun run session:login --from-profile <dir>           # export a bootstrapped WebView profile
 *   F402_LIVE_LOGIN=1 F402_AGENT_ID=… F402_PASSWORD=… bun run session:login
 *   F402_LIVE_LOGIN=1 bun run session:login --from-keychain   # read both from the OS keychain
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
 * There are three bridges into the 0600 session file the transport does read (`F402_SESSION_FILE`,
 * default `~/.cache/sportsdesk/f402-session.json`):
 *
 *   1. `--from-profile <dir>` launches the existing profile, copies its cookies, closes the view.
 *      Use this when MFA was bootstrapped by hand. No credentials, no `F402_LIVE_LOGIN`.
 *   2. No flag: one fresh credential login (`F402_LIVE_LOGIN=1` + `F402_AGENT_ID`/`F402_PASSWORD`).
 *      The same gate applies here; env credentials win when both are present.
 *   3. `--from-keychain`: one fresh credential login whose credential SOURCE is the OS keychain
 *      (`secrets:f402`, canonical service then the legacy fallback). `F402_LIVE_LOGIN=1` is still
 *      required — the flag selects a source, it does not bypass the live-login gate. This is
 *      session-only: no bearer token is minted.
 *
 * Nothing here prints a cookie value or a credential — only names, expiry and the credential
 * source (`env` / `keychain`).
 */

import { join } from "node:path";
import { parseArgs } from "node:util";

import { sessionFromWebViewProfile } from "../lib/f402_profile_session.ts";
import {
  CANONICAL_SECRETS_SERVICE,
  F402_KEYCHAIN_NAMES,
  LEGACY_SECRETS_SERVICE,
  readSecretCanonicalThenLegacy,
} from "../lib/secrets.ts";
import {
  describeF402Session,
  f402SessionTtlMinutesFromEnv,
  readF402Session,
  refreshF402Session,
  resolveF402SessionPath,
  writeF402Session,
  type F402Session,
} from "../lib/f402_session.ts";

export type LoginCredentialSource = "env" | "keychain";

export interface LoginCredentials {
  readonly agentId: string;
  readonly password: string;
  /** Safe to log; never includes the password. */
  readonly source: LoginCredentialSource;
}

export type LoginCredentialResolution =
  | { readonly ok: true; readonly credentials: LoginCredentials }
  | { readonly ok: false; readonly reason: "live-login-disabled" }
  | { readonly ok: false; readonly reason: "missing-env-credentials" }
  | {
      readonly ok: false;
      readonly reason: "missing-keychain-credentials";
      readonly missing: readonly string[];
      readonly service: string;
      readonly message: string;
    };

export interface ResolveLoginCredentialsOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** `--from-keychain`: use the keychain as the credential SOURCE (the gate still applies). */
  readonly fromKeychain: boolean;
  /** Default: `readSecretCanonicalThenLegacy` from lib/secrets.ts (injectable for tests). */
  readonly readSecret?: (name: string) => Promise<string | null>;
}

/**
 * Pure credential resolution for the two fresh-login paths. Never writes a file, never logs a
 * value, and reads no keychain when the live-login gate is closed.
 *
 * Precedence: `F402_LIVE_LOGIN=1` gate → both env values → both keychain values (canonical then
 * legacy). Env is all-or-nothing: a single env value does not mix with one keychain value.
 */
export async function resolveLoginCredentials(
  options: ResolveLoginCredentialsOptions,
): Promise<LoginCredentialResolution> {
  const env = options.env;
  if ((env["F402_LIVE_LOGIN"] ?? "").trim() !== "1") {
    return { ok: false, reason: "live-login-disabled" };
  }

  const envAgentId = (env["F402_AGENT_ID"] ?? "").trim();
  const envPassword = (env["F402_PASSWORD"] ?? "").trim();
  if (envAgentId !== "" && envPassword !== "") {
    return {
      ok: true,
      credentials: {
        agentId: envAgentId,
        password: envPassword,
        source: "env",
      },
    };
  }
  if (!options.fromKeychain) {
    return { ok: false, reason: "missing-env-credentials" };
  }

  const readSecret = options.readSecret ?? readSecretCanonicalThenLegacy;
  const agentId = (await readSecret(F402_KEYCHAIN_NAMES.agentId))?.trim() ?? "";
  const password =
    (await readSecret(F402_KEYCHAIN_NAMES.password))?.trim() ?? "";
  const missing: string[] = [];
  if (agentId === "") missing.push(F402_KEYCHAIN_NAMES.agentId);
  if (password === "") missing.push(F402_KEYCHAIN_NAMES.password);
  if (missing.length > 0) {
    return {
      ok: false,
      reason: "missing-keychain-credentials",
      missing,
      service: CANONICAL_SECRETS_SERVICE,
      message:
        `session:login --from-keychain: missing ${missing.join(", ")} in keychain service ` +
        `${CANONICAL_SECRETS_SERVICE} (legacy fallback ${LEGACY_SECRETS_SERVICE}); store both with: ` +
        "bun run secrets:f402 set --agent-id <id>",
    };
  }
  return {
    ok: true,
    credentials: { agentId, password, source: "keychain" },
  };
}

function liveLoginGateMessage(): string {
  return [
    "session:login needs F402_LIVE_LOGIN=1 to allow one WebView login.",
    "If a WebView profile already holds the cookies, export it instead:",
    "  bun run session:login --from-profile <dir>",
    "Otherwise set, in the environment of this command only:",
    "  F402_LIVE_LOGIN=1",
    "  F402_AGENT_ID=<login>",
    "  F402_PASSWORD=<password>        (never commit it; .env is gitignored)",
    "Or read both credentials from the OS keychain (secrets:f402):",
    "  F402_LIVE_LOGIN=1 bun run session:login --from-keychain",
    "Optional: F402_BASE_URL, F402_SESSION_FILE, F402_SESSION_TTL_MIN",
    "Then: bun run session:status",
  ].join("\n");
}

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

async function main(): Promise<void> {
  const REPO = join(import.meta.dir, "..");
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      status: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "ttl-min": { type: "string" },
      out: { type: "string" },
      "from-profile": { type: "string" },
      "from-keychain": { type: "boolean", default: false },
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
        : {
            cookieNames: session.cookieNames,
            expiresAt: session.expiresAtIso,
          }),
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

  const resolved = await resolveLoginCredentials({
    env,
    fromKeychain: values["from-keychain"],
  });
  if (!resolved.ok) {
    if (resolved.reason === "live-login-disabled") {
      console.error(liveLoginGateMessage());
    } else if (resolved.reason === "missing-env-credentials") {
      console.error(
        "session:login needs F402_AGENT_ID and F402_PASSWORD (F402_LIVE_LOGIN=1 is set).",
      );
    } else {
      console.error(resolved.message);
    }
    process.exit(2);
  }

  // Source only — never a value.
  console.log(`credentials: ${resolved.credentials.source}`);
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
}

if (import.meta.main) {
  await main();
}
