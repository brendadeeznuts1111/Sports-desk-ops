#!/usr/bin/env bun
/**
 * Mint or inspect the portal session the replay transport uses.
 *
 *   ./bin/dx session login --from-profile <dir>          # export a bootstrapped WebView profile
 *   F402_LIVE_LOGIN=1 F402_AGENT_ID=… F402_PASSWORD=… ./bin/dx session login
 *   F402_LIVE_LOGIN=1 ./bin/dx session login --from-keychain   # read both from the OS keychain
 *   ./bin/dx session [status] [--json]      (also: bun run session:login / session:status)
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

import { inspectReport } from "../lib/cli_inspect.ts";
import { sessionFromWebViewProfile } from "../lib/f402_profile_session.ts";
import {
  CANONICAL_SECRETS_SERVICE,
  F402_KEYCHAIN_NAMES,
  LEGACY_SECRETS_SERVICE,
  readSecretCanonicalThenLegacy,
} from "../lib/secrets.ts";
import { SECRET_NAMES } from "./capture/f402_login.ts";
import {
  describeF402Session,
  f402SessionTtlMinutesFromEnv,
  readF402Session,
  refreshF402Session,
  resolveF402SessionPath,
  writeF402Session,
  type F402Session,
} from "../lib/f402_session.ts";
import {
  chromeFailureAdvice,
  diagnoseChromeBackend,
} from "../lib/webview_backend_diagnostics.ts";

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
 * Precedence: `F402_LIVE_LOGIN=1` gate → both env values → Bun.secrets (canonical service
 * `com.bookdeskops.sportsdesk` then legacy `sportsdesk-ops`, names {@link SECRET_NAMES}).
 *
 * `--from-keychain` fails closed with a detailed message when either secret is missing.
 * Without the flag, the same keychain read still runs when env is incomplete so
 * `F402_LIVE_LOGIN=1` alone can use stored credentials.
 *
 * Env is all-or-nothing: a single env value does not mix with one keychain value.
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

  /** Test/CI hook: require both env vars; do not read the keychain unless `--from-keychain`. */
  const envOnly = (env["F402_LOGIN_ENV_ONLY"] ?? "").trim() === "1";
  if (envOnly && !options.fromKeychain) {
    return { ok: false, reason: "missing-env-credentials" };
  }

  const readSecret = options.readSecret ?? readSecretCanonicalThenLegacy;
  const agentId = (await readSecret(F402_KEYCHAIN_NAMES.agentId))?.trim() ?? "";
  const password =
    (await readSecret(F402_KEYCHAIN_NAMES.password))?.trim() ?? "";
  const missing: string[] = [];
  if (agentId === "") missing.push(SECRET_NAMES.agentId);
  if (password === "") missing.push(SECRET_NAMES.password);

  if (missing.length === 0) {
    return {
      ok: true,
      credentials: { agentId, password, source: "keychain" },
    };
  }

  if (options.fromKeychain) {
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

  return { ok: false, reason: "missing-env-credentials" };
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

type SessionTransport =
  | "proxy (F402_REPLAY_PROXY_URL)"
  | "session-file"
  | "anonymous (no session file: the transport will send no cookie)";

interface SessionStatusReport {
  readonly sessionPath: string;
  readonly session: string;
  readonly cookieNames?: readonly string[];
  readonly expiresAt?: string;
  readonly transport: SessionTransport;
  readonly env: Readonly<Record<string, boolean | string>>;
  readonly profileNote: string | null;
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
      diagnose: { type: "boolean", default: false },
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
    const report: SessionStatusReport = {
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
        ? "F402_WEBVIEW_PROFILE is set but the transport does not read it — export it with `./bin/dx session login --from-profile <dir>`, or check it with `./bin/dx shot --profile <dir>`"
        : null,
    };
    const chrome = values.diagnose
      ? await diagnoseChromeBackend({ env })
      : null;
    const fullReport = chrome === null ? report : { ...report, chrome };
    if (values.json) console.log(JSON.stringify(fullReport, null, 2));
    else {
      console.log(inspectReport(report));
      if (chrome !== null) {
        console.log(
          `chrome: ${chrome.available ? "available" : "UNAVAILABLE"} — ${chrome.reason}`,
        );
        if (chrome.binary !== null)
          console.log(`chrome binary: ${chrome.binary}`);
        for (const line of chromeFailureAdvice(chrome)) {
          console.log(`fix: ${line}`);
        }
      }
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
  let session: F402Session;
  try {
    session = await refreshF402Session({
      env,
      ...(ttlMinutes === undefined ? {} : { ttlMinutes }),
      credentials: {
        agentId: resolved.credentials.agentId,
        password: resolved.credentials.password,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`session:login failed: ${message}`);
    // The capture layer already appends the remediation to a Chrome failure; only add the
    // structured diagnosis when it did not (other failure modes have no chrome advice to give).
    if (!message.includes("outside the agent/harness sandbox")) {
      const diagnosis = await diagnoseChromeBackend({ env });
      if (!diagnosis.available) {
        console.error(`  chrome: ${diagnosis.reason}`);
        for (const line of chromeFailureAdvice(diagnosis)) {
          console.error(`  fix: ${line}`);
        }
      }
    }
    process.exit(1);
  }
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
