/** One explicit live pass: watchlist getBetReport → recent betIds → getBetLog/getEventLog → audit.
 *
 *  Read-only against GSLive Manager (Partner 118). The session comes from the existing
 *  read-only resolver (`GSID_COOKIE` / session file / Bun.secrets keychain / `GSID` env); it is
 *  never printed, never written to the artifact, and never accepted from an argument. No session
 *  means no artifact: the command exits 2 after printing the honest provisioning reason.
 *
 *  Usage:
 *    bun run scripts/gslive_weblog_refresh.ts --dry-run   # plan only: no network, no keychain
 *    bun run scripts/gslive_weblog_refresh.ts             # live pass (last 24h desk window)
 *    bun run scripts/gslive_weblog_refresh.ts --from 1793163600 --to 1793771999 --max-bets 10
 *
 *  Writes `Scratch/gslive-weblogs/latest.json` (gitignored) with mode 0600 unless `--out` names
 *  another path. A failed getBetReport pass (auth or network) writes nothing and exits non-zero,
 *  because a partial sample would be presented as a measurement.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import { argv, env } from "bun";

import {
  fetchBetLog,
  fetchEventLog,
  GSLIVE_AJAX,
} from "../lib/gslive_auto_session.ts";
import {
  parseBetLog,
  parseGsliveTimestampMs,
} from "../lib/gslive_bet_event_log.ts";
import {
  buildGsLiveGetBetReportPayload,
  fromGsLivePlayerId,
  getUnifiedWatchlistRegistry,
} from "../lib/gslive_manager_watchlist.ts";
import {
  buildGsliveWeblogArtifact,
  GSLIVE_WEBLOG_ARTIFACT_RELATIVE,
  type GsliveWeblogBetLogInput,
  type GsliveWeblogBuildInput,
  type GsliveWeblogReport,
  type GsliveWeblogSessionDescriptor,
  type GsliveWeblogSessionSource,
  type GsliveWeblogWatchlistAccount,
} from "../lib/gslive_weblog_activity.ts";
import {
  fetchBetReportRowsFromPayload,
  resolveManagerSession,
  sessionGateFromEnv,
} from "./fetch-bet-tally.ts";

export const DEFAULT_MAX_BETS = 25;
export const DEFAULT_DELAY_MS = 250;
export const DEFAULT_WINDOW_SECONDS = 24 * 60 * 60;
const REQUEST_TIMEOUT_MS = 15_000;

const USAGE = `Usage: bun run scripts/gslive_weblog_refresh.ts [options]

Audit GSLive WebLog activity for the watchlist registry and write
${GSLIVE_WEBLOG_ARTIFACT_RELATIVE} (gitignored, mode 0600).

Options:
  --dry-run            Print the planned accounts/window/endpoints only.
                       No network, no secret/keychain resolution, no write.
  --live               Explicitly run the live pass (the default; kept for scripts).
  --from <epochSec>    Window start (default: now - 24h).
  --to <epochSec>      Window end (default: now).
  --max-bets <n>       Bets to fetch getBetLog for, newest first (default: ${DEFAULT_MAX_BETS}).
  --delay-ms <n>       Delay between sequential live calls (default: ${DEFAULT_DELAY_MS}).
  --out <path>         Artifact path (default: ${GSLIVE_WEBLOG_ARTIFACT_RELATIVE} under cwd).
  --help, -h           Show this help.

Exit codes: 0 measured/written (or dry-run), 1 fetch/write failure (nothing written),
2 no usable manager session (nothing written).
Requires a GSID from the keychain (bun run secrets:gslive set), GSLIVE_SESSION_FILE /
$XDG_CONFIG_HOME/sportsdesk/gslive-session, or GSID/GSID_COOKIE in the environment.
Never pass a session value on the command line.`;

export interface RefreshPlan {
  readonly fromEpochSec: number;
  readonly toEpochSec: number;
  readonly maxBets: number;
  readonly delayMs: number;
  readonly outPath: string;
}

function fail(message: string, exitCode: number): void {
  console.error(`gslive-weblogs: ${message}`);
  process.exitCode = exitCode;
}

function parseIntOption(
  name: string,
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(
      `--${name} must be an integer (got ${JSON.stringify(raw)})`,
    );
  }
  return value;
}

/** Build the plan from CLI args; pure so a dry run and the live pass agree on the window. */
export function planRefresh(
  args: readonly string[],
  now: Date = new Date(),
): {
  readonly plan: RefreshPlan;
  readonly dryRun: boolean;
  readonly help: boolean;
} {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    options: {
      from: { type: "string" },
      to: { type: "string" },
      "max-bets": { type: "string" },
      "delay-ms": { type: "string" },
      out: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      live: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const nowSec = Math.floor(now.getTime() / 1000);
  const fromEpochSec = parseIntOption(
    "from",
    values.from,
    nowSec - DEFAULT_WINDOW_SECONDS,
  );
  const toEpochSec = parseIntOption("to", values.to, nowSec);
  if (fromEpochSec > toEpochSec) {
    throw new Error("--from must be <= --to");
  }
  const maxBets = parseIntOption(
    "max-bets",
    values["max-bets"],
    DEFAULT_MAX_BETS,
  );
  if (maxBets < 1 || maxBets > 500) {
    throw new Error("--max-bets must be between 1 and 500");
  }
  const delayMs = parseIntOption(
    "delay-ms",
    values["delay-ms"],
    DEFAULT_DELAY_MS,
  );
  if (delayMs < 0 || delayMs > 10_000) {
    throw new Error("--delay-ms must be between 0 and 10000");
  }
  const outPath =
    values.out === undefined
      ? resolve(process.cwd(), GSLIVE_WEBLOG_ARTIFACT_RELATIVE)
      : resolve(process.cwd(), values.out);
  return {
    plan: { fromEpochSec, toEpochSec, maxBets, delayMs, outPath },
    dryRun: values["dry-run"] === true,
    help: values.help === true,
  };
}

function windowIso(plan: RefreshPlan): { fromIso: string; toIso: string } {
  return {
    fromIso: new Date(plan.fromEpochSec * 1000).toISOString(),
    toIso: new Date(plan.toEpochSec * 1000).toISOString(),
  };
}

function watchlistAccount(entry: {
  readonly customerLogin: string;
  readonly gsLivePlayerId: string;
  readonly agentId: string;
  readonly sourceCategory: string;
  readonly archetype: string;
}): GsliveWeblogWatchlistAccount {
  return {
    customerLogin: entry.customerLogin,
    gsLivePlayerId: entry.gsLivePlayerId,
    agentId: entry.agentId,
    sourceCategory: entry.sourceCategory,
    archetype: entry.archetype,
  };
}

/** Extract the raw GSID from a resolved cookie header; never logged. */
function gsidFromCookieHeader(cookieHeader: string): string | null {
  const match = /(?:^|;\s*)GSID=([^;]+)/i.exec(cookieHeader);
  if (match === null) return null;
  const value = match[1] ?? "";
  if (value.trim() === "") return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sessionSourceFor(source: string): GsliveWeblogSessionSource | null {
  if (source === "env-cookie" || source === "env") return "env";
  if (source === "keychain") return "keychain";
  if (source === "session-file") return "session-file";
  return null;
}

/** An HTML login page or a 401/403 means the session is gone; the operator must re-provision. */
function isAuthFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP 40[13]\b|login page|unauthor|forbidden|session (?:has )?expired|expired session/i.test(
    message,
  );
}

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

interface CandidateBet {
  readonly account: GsliveWeblogWatchlistAccount;
  readonly betId: string;
  readonly eventId: string;
  readonly logMs: number;
}

function printDryRun(plan: RefreshPlan): void {
  const registry = getUnifiedWatchlistRegistry();
  const window = windowIso(plan);
  console.log(
    "gslive-weblogs refresh — dry run (no network, no secret resolution)",
  );
  console.log(`window:  ${window.fromIso} .. ${window.toIso}`);
  console.log(
    `         epoch ${plan.fromEpochSec} .. ${plan.toEpochSec} (dateFilterBy=calcTime)`,
  );
  console.log(
    `accounts: ${registry.length} watchlist accounts (${registry
      .map((entry) => entry.customerLogin)
      .join(", ")})`,
  );
  console.log("endpoints:");
  console.log(
    `  getBetReport -> ${GSLIVE_AJAX} (one POST per account, ${plan.delayMs}ms apart)`,
  );
  console.log(
    `  getBetLog    -> ${GSLIVE_AJAX} (up to ${plan.maxBets} sampled bets, ${plan.delayMs}ms apart)`,
  );
  console.log(
    "  getEventLog  -> " +
      `${GSLIVE_AJAX} (only when the getBetReport row carries an eventId)`,
  );
  console.log(`output:  ${plan.outPath} (mode 0600, not written in dry-run)`);
  console.log(
    "session: not resolved in dry-run; the live pass requires a GSID from the keychain, " +
      "GSLIVE_SESSION_FILE / session file, or GSID/GSID_COOKIE in the environment",
  );
}

async function livePass(plan: RefreshPlan): Promise<void> {
  const resolvedSession = await resolveManagerSession(env);
  if (resolvedSession.source === "none") {
    fail(
      "no manager session. Provision a GSID in the OS keychain via " +
        "`bun run secrets:gslive set` (service com.bookdeskops.sportsdesk, name GSID), or set " +
        "GSLIVE_SESSION_FILE / GSID in the SSOT environment. Nothing was written. " +
        "Never paste a live session cookie into chat, a commit, or a script.",
      2,
    );
    return;
  }
  const gsid = gsidFromCookieHeader(resolvedSession.cookieHeader);
  if (gsid === null) {
    fail(
      `resolved manager session source "${resolvedSession.source}" carries no GSID cookie; nothing was written`,
      2,
    );
    return;
  }
  const session: GsliveWeblogSessionDescriptor = {
    configured: true,
    source: sessionSourceFor(resolvedSession.source),
  };
  const sessionGate = sessionGateFromEnv(env);
  const window = windowIso(plan);
  const registry = getUnifiedWatchlistRegistry();

  const reports: GsliveWeblogReport[] = [];
  for (let index = 0; index < registry.length; index += 1) {
    const entry = registry[index];
    if (entry === undefined) continue;
    const account = watchlistAccount(entry);
    const payload = {
      ...buildGsLiveGetBetReportPayload({
        customerLogin: entry.customerLogin,
        agentId: entry.agentId,
        fromEpochSec: plan.fromEpochSec,
        toEpochSec: plan.toEpochSec,
      }),
      partnerUserId: fromGsLivePlayerId(entry.customerLogin),
    };
    try {
      const rows = await fetchBetReportRowsFromPayload({
        payload,
        cookieHeader: resolvedSession.cookieHeader,
        ...(sessionGate === "" ? {} : { sessionGate }),
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      reports.push({
        account,
        rows: rows.filter(
          (row): row is Record<string, unknown> =>
            typeof row === "object" && row !== null && !Array.isArray(row),
        ),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isAuthFailure(error)) {
        fail(
          `getBetReport for ${entry.customerLogin} failed with an auth error: ${message}. ` +
            "The GSID session is expired or invalid; re-provision it and retry. Nothing was written.",
          2,
        );
      } else {
        fail(
          `getBetReport for ${entry.customerLogin} failed: ${message}. ` +
            "The pass is incomplete, so nothing was written.",
          1,
        );
      }
      return;
    }
    if (index < registry.length - 1 && plan.delayMs > 0) {
      await sleep(plan.delayMs);
    }
  }

  const candidates: CandidateBet[] = [];
  for (const report of reports) {
    for (const row of report.rows) {
      const betId = String(row.id ?? "").trim();
      if (betId === "") continue;
      candidates.push({
        account: report.account,
        betId,
        eventId: String(row.eID ?? "").trim(),
        logMs: parseGsliveTimestampMs(row.logTime) ?? 0,
      });
    }
  }
  const seenBetIds = new Set<string>();
  const sampled = candidates
    .sort((a, b) => b.logMs - a.logMs)
    .filter((candidate) => {
      if (seenBetIds.has(candidate.betId)) return false;
      seenBetIds.add(candidate.betId);
      return true;
    })
    .slice(0, plan.maxBets);

  const bets: GsliveWeblogBetLogInput[] = [];
  let eventLogFailures = 0;
  for (let index = 0; index < sampled.length; index += 1) {
    const candidate = sampled[index];
    if (candidate === undefined) continue;
    let betLog: unknown = null;
    try {
      betLog = await fetchBetLog(candidate.betId, gsid);
    } catch {
      // Fetch failure is a parse error in the artifact: counted, never flagged.
      betLog = null;
    }
    let eventLog: unknown;
    if (betLog !== null && candidate.eventId !== "") {
      try {
        const parsed = parseBetLog(betLog);
        eventLog = await fetchEventLog(
          candidate.betId,
          candidate.eventId,
          String(Math.floor(parsed.placedAtMs / 1000)),
          gsid,
        );
      } catch {
        eventLogFailures += 1;
      }
    }
    bets.push({
      account: candidate.account,
      betId: candidate.betId,
      betLog,
      ...(eventLog === undefined ? {} : { eventLog }),
    });
    if (index < sampled.length - 1 && plan.delayMs > 0) {
      await sleep(plan.delayMs);
    }
  }

  const input: GsliveWeblogBuildInput = {
    reports,
    bets,
    window,
    session,
    now: new Date(),
  };
  const artifact = buildGsliveWeblogArtifact(input);
  mkdirSync(dirname(plan.outPath), { recursive: true, mode: 0o700 });
  writeFileSync(plan.outPath, `${JSON.stringify(artifact, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(plan.outPath, 0o600);

  const flags =
    Object.entries(artifact.summary.flagsByCode)
      .map(([code, count]) => `${code}=${count}`)
      .join(", ") || "none";
  console.log("gslive-weblogs: measured");
  console.log(`window: ${window.fromIso} .. ${window.toIso}`);
  console.log(
    `accounts audited: ${artifact.summary.accounts}; bets audited: ${artifact.summary.bets}; ` +
      `parse errors: ${artifact.parseErrors}`,
  );
  console.log(`flags: ${flags}`);
  if (eventLogFailures > 0) {
    console.log(
      `event log fetch failures: ${eventLogFailures} (bet-level audit still ran)`,
    );
  }
  console.log(`wrote ${plan.outPath}`);
}

async function main(args: readonly string[]): Promise<void> {
  let planned: ReturnType<typeof planRefresh>;
  try {
    planned = planRefresh(args);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), 1);
    console.error(USAGE);
    return;
  }
  if (planned.help) {
    console.log(USAGE);
    return;
  }
  if (planned.dryRun) {
    printDryRun(planned.plan);
    return;
  }
  await livePass(planned.plan);
}

if (import.meta.main) {
  try {
    await main(argv.slice(2));
  } catch (error) {
    console.error(
      `gslive-weblogs: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
