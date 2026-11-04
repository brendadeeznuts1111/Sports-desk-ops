#!/usr/bin/env bun
/**
 * Live fetch wagers by State from the Manager Tools API — data-driven.
 *
 * POST https://plive.sportswidgets.pro/manager-tools/ajax.php
 *   body: { action: "getBetReport", state: "", dateFilterBy: "logTime", from, to, ... }
 *
 * State ordering, output layout, and date parsing come from
 * `config/wagers.json`; the pure pipeline lives in `lib/wagers_report.ts`.
 *
 * "Wager legs" = number of rows sharing the same Bet Group (parlay legs).
 * "Wager number" = the Ticket column.
 *
 * Usage:
 *   bun run scripts/wagers_by_state_live.ts --from=10/25/2026 --to=11/03/2026
 *   bun run scripts/wagers_by_state_live.ts --from=10/25/2026 --to=11/03/2026 --state=cancel
 *   bun run scripts/wagers_by_state_live.ts --from=10/25/2026 --to=11/03/2026 --nlegs=2
 *   bun run scripts/wagers_by_state_live.ts --from=10/25/2026 --to=11/03/2026 --wager-number 1069664168
 *   echo 'GSID=...' > .env   # .env is gitignored
 */

import { z } from "zod";
import {
  assertBunFloor,
  assertJsonResponse,
  postJsonWithRetry,
  requireGsid,
  writeTextFileIfChanged,
} from "../lib/manager_fetch.ts";
import {
  applyFilters,
  bucketBy,
  buildBetReportBody,
  computeGroupSizes,
  filterLabels,
  formatElapsed,
  groupValue,
  parseDateArg,
  parseFilters,
  parseFormat,
  parseGroupBy,
  parseOutArg,
  parseTopArg,
  parseWagersFromBets,
  renderReport,
  reportConfig,
  sortGroups,
  splitOutput,
  takeTop,
} from "../lib/wagers_report.ts";

import type { GroupKey, ReportFormat } from "../types/wagers";

/** Bet object returned by getBetReport (parse once at boundary with zod). */
const betSchema = z.object({
  Partner: z.string().optional(),
  EventId: z.string().optional(),
  Player: z.string().optional(),
  Agent: z.string().optional(),
  Ticket: z.string().optional(),
  BetGroup: z.string().optional(),
  Sport: z.string().optional(),
  League: z.string().optional(),
  EventDetails: z.string().optional(),
  Risk: z.string().optional(),
  ToWin: z.string().optional(),
  BetTime: z.string().optional(),
  Type: z.string().optional(),
  BetId: z.string().optional(),
  Result: z.string().optional(),
  State: z.string().optional(),
});

const betReportSchema = z.object({ bets: z.array(betSchema).optional() });

/** Shared fail-closed guard + POST, bound to the getBetReport tool name. */
function assertBetReport(response: Response): void {
  assertJsonResponse(response, "getBetReport");
}

async function fetchBetReport(
  url: string,
  cookie: string,
  body: ReturnType<typeof buildBetReportBody>,
  retry: { attempts: number; baseMs: number },
): Promise<Response> {
  return await postJsonWithRetry(url, cookie, body, "getBetReport", retry);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      `Usage: bun run scripts/wagers_by_state_live.ts [--help|-h] --from=M/D/YYYY --to=M/D/YYYY [--state=X] [--nlegs=N] [--wager-number N] [--format=table|json|csv|summary|inspect|columns|grid] [--out=PATH] [--group-by=state|day|event|player|agent] [--top=N]

Sort all wagers by state, day, event, player, or agent via the live Manager Tools API — data-driven (config/wagers.json).

  POST https://plive.sportswidgets.pro/manager-tools/ajax.php  (action: "getBetReport")

Auth: GSID session cookie from Bun.env.GSLIVE_SESSION_ID (.env, gitignored; legacy GSID also read).

"Wager legs" = number of rows sharing the same Bet Group (parlay legs).
"Wager number" = the Ticket column.

Options:
  --from=M/D/YYYY   Start date (inclusive, required)
  --to=M/D/YYYY     End date (inclusive, required)
  --state=X         Filter to one state (from config state list)
  --nlegs=N         Filter to N-leg parlay groups
  --wager-number N  Filter to a specific Ticket/wager number
  --format=F        Output format: table (default), json, csv, summary, inspect, columns, or grid
  --out=PATH        Write the stdout document to PATH as well
  --group-by=G      Dimension: state (default), day, event, player, agent
  --top=N           Show only the first N groups (after sorting)

Output: table, json, csv, one-line summaries, or full pretty-printed objects.

Exit codes:
  0  success
  1  missing GSLIVE_SESSION_ID, non-ok HTTP, non-JSON body, redirect-to-login, or invalid args`,
    );
    return;
  }

  const cfg = await reportConfig();
  assertBunFloor("wagers-by-state-live");
  const t0 = Bun.nanoseconds();
  const filters = parseFilters(args, cfg);
  let format: ReportFormat;
  let group: GroupKey;
  let top: number | undefined;
  try {
    format = parseFormat(args, cfg);
    group = parseGroupBy(args, cfg);
    top = parseTopArg(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`wagers-by-state-live: ${message}`);
    process.exit(1);
    return;
  }
  const groupLabel = cfg.groups[group].label;

  const fromArg = args.find((a) => a.startsWith("--from="));
  const toArg = args.find((a) => a.startsWith("--to="));

  if (!fromArg || !toArg) {
    console.error(
      "Usage: wagers-by-state-live --from=M/D/YYYY --to=M/D/YYYY [--state=X] [--nlegs=N] [--wager-number N] [--format=table|json|csv|summary|inspect|columns|grid] [--out=PATH] [--group-by=state|day|event|player|agent] [--top=N]",
    );
    process.exit(1);
  }

  const from = parseDateArg(fromArg.slice("--from=".length));
  const to = parseDateArg(toArg.slice("--to=".length));
  if (!from || !to) {
    console.error(
      "wagers-by-state-live: invalid --from/--to date (use M/D/YYYY or YYYY-MM-DD)",
    );
    process.exit(1);
  }

  const gsid = requireGsid("wagers-by-state-live");

  // Epoch seconds for start of `from` day and end of `to` day (local time).
  const fromDay = new Date(from);
  fromDay.setHours(0, 0, 0, 0);
  const toDay = new Date(to);
  toDay.setHours(23, 59, 59, 999);
  const fromEpoch = Math.floor(fromDay.getTime() / 1000);
  const toEpoch = Math.floor(toDay.getTime() / 1000);

  const label = `${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}`;

  const activeLabels = filterLabels(cfg, filters);
  const filterTxt = activeLabels.length ? ` (${activeLabels.join(", ")})` : "";

  const body = buildBetReportBody(cfg, fromEpoch, toEpoch);
  const response = await fetchBetReport(
    cfg.live.url,
    gsid,
    body,
    cfg.live.retry,
  );
  assertBetReport(response);

  const raw: unknown = await response.json();
  const parsed = betReportSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `getBetReport: unexpected response shape — ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  }

  const bets = parsed.data.bets ?? [];

  // ---- Shared data-driven pipeline (same as CSV script) ----
  const { wagers, unparseableTime } = parseWagersFromBets(
    bets,
    cfg,
    fromDay,
    toDay,
  );
  const groupSize = computeGroupSizes(wagers);
  const filtered = applyFilters(wagers, groupSize, filters);
  const buckets = bucketBy(filtered, groupSize, (w) => groupValue(w, group));
  const sorted = takeTop(sortGroups([...buckets.values()], cfg, group), top);
  const outPath = parseOutArg(args);

  const title = `Wagers by ${groupLabel} (live) — ${label}${filterTxt}`;
  const docLines = renderReport(sorted, cfg, format, group);
  const metaLines = [
    ...(unparseableTime > 0
      ? [
          `⚠️  ${unparseableTime} wager(s) had an unparseable Bet Time and were skipped.`,
        ]
      : []),
    `Source: ${cfg.live.url} (getBetReport, dateFilterBy=${cfg.live.dateFilterBy})`,
    `Bets returned: ${bets.length}`,
    `Wagers in window: ${wagers.length}`,
    `After filters: ${filtered.length}`,
    `Computed in ${formatElapsed(t0, Bun.nanoseconds())}`,
  ];

  const { stdout, stderr } = splitOutput(format, title, docLines, metaLines);
  for (const line of stdout) console.log(line);
  for (const line of stderr) console.error(line);

  if (outPath) {
    const wrote = await writeTextFileIfChanged(
      outPath,
      `${stdout.join("\n")}\n`,
    );
    console.error(wrote ? `wrote ${outPath}` : `${outPath} unchanged`);
  }
}

void (async () => {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`wagers-by-state-live: ${message}`);
    process.exit(1);
  }
})();
