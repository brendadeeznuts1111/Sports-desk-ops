#!/usr/bin/env bun
/**
 * Terminal/browser dashboard rendered from the daemon's own APIs.
 *
 * One Markdown snapshot feeds both surfaces:
 *   bun run dashboard:view                 # ANSI in this terminal
 *   bun run dashboard:view --watch 10      # re-render every 10 seconds
 *   bun run dashboard:view --format html --out dist/dashboard-view.html
 *   bun run dashboard:view --format markdown | less
 *
 * The section order is operational-first (Live Desk, Watchlist, WebLog, Review, Live Wagers) and
 * reference/admin last, matching the review of the interactive page. Tables are capped by --rows.
 */
import {
  flagValue,
  hasFlag,
  parseCliArgs,
  printHelp,
  wantsHelp,
} from "../lib/cli_args.ts";
import {
  markdownTable,
  type DashboardSection,
  type DashboardSectionState,
  type DashboardSnapshot,
} from "../lib/dashboard_markdown.ts";
import {
  renderDashboardAnsi,
  renderDashboardHtml,
} from "../lib/dashboard_render.ts";

const HELP = `
dashboard:view — render the SportsDesk/F402 dashboard to ANSI, HTML or Markdown

Usage:
  bun run dashboard:view [options]

Options:
  --format <ansi|html|markdown>  Output format (default: ansi)
  --url <url>                    Daemon base URL (default: http://127.0.0.1:4020)
  --rows <n>                     Rows per table (default: 25, max: 200)
  --columns <n>                  ANSI wrap width; 0 disables wrapping (default: terminal width or 100)
  --no-color                     Disable ANSI colour and OSC 8 links
  --light                        Light ANSI palette
  --out <path>                   Write html/markdown to a file instead of stdout
  --watch <seconds>              Re-render ansi every N seconds (0 = once)
  -h, --help                     This text

The API token is read from SPORTSDESK_ADMIN_TOKEN, never from argv. Without it, PII panels
(watchlist, WebLog, telegram) render as LOCKED instead of leaking a request.
`.trim();

interface ApiResult {
  readonly path: string;
  readonly ok: boolean;
  readonly status: number;
  readonly body: Record<string, unknown> | null;
  readonly error: string | null;
}

type Json = Record<string, unknown>;

function rec(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function arr(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function money(cents: unknown): string {
  const value = numeric(cents);
  return value === null
    ? "—"
    : `$${(value / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function dollars(value: unknown): string {
  const number = numeric(value);
  return number === null
    ? "—"
    : `$${number.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function count(value: unknown): string {
  const number = numeric(value);
  return number === null ? "—" : number.toLocaleString("en-US");
}

function age(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function agoFromIso(iso: string | null, now: number): string {
  if (iso === null) return "—";
  const ms = Date.parse(iso);
  return Number.isFinite(ms)
    ? age(Math.max(0, Math.floor((now - ms) / 1000)))
    : "—";
}

function stateFrom(ok: boolean, p: Json | null): DashboardSectionState {
  if (!ok) return "unavailable";
  if (p === null) return "not_measured";
  return p.stale === true || p.basis === "fixture" ? "measured" : "measured";
}

async function fetchJson(
  base: string,
  path: string,
  token: string,
): Promise<ApiResult> {
  try {
    const response = await fetch(`${base}${path}`, {
      headers: token === "" ? {} : { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
    });
    const text = await response.text();
    let body: Json | null = null;
    try {
      body = rec(JSON.parse(text));
    } catch {
      body = null;
    }
    return {
      path,
      ok: response.ok,
      status: response.status,
      body,
      error: response.ok
        ? null
        : (str(body?.["error"]) ?? `HTTP ${response.status}`),
    };
  } catch (error) {
    return {
      path,
      ok: false,
      status: 0,
      body: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function lockedSection(
  id: string,
  title: string,
  group: DashboardSection["group"],
  result: ApiResult,
): DashboardSection {
  return {
    id,
    title,
    group,
    state: "locked",
    provenance: `${result.path} → ${result.error ?? `HTTP ${result.status}`}`,
    body: [
      "> **LOCKED.** Set `SPORTSDESK_ADMIN_TOKEN` on the server and in this shell to unlock.",
    ],
  };
}

function missingSection(
  id: string,
  title: string,
  group: DashboardSection["group"],
  reason: string,
): DashboardSection {
  return {
    id,
    title,
    group,
    state: "not_measured",
    body: [`> **NOT MEASURED.** ${reason}`],
  };
}

function buildSnapshot(
  base: string,
  results: Readonly<Record<string, ApiResult>>,
  maxRows: number,
  now: number,
): DashboardSnapshot {
  const kpis = rec(results["kpis"]?.body?.["kpis"]);
  const agents = rec(kpis?.["agents"]);
  const pending = rec(kpis?.["pending"]);
  const ticker = rec(kpis?.["ticker"]);
  const book = rec(kpis?.["customerBook"]);
  const weblog = rec(results["kpis"]?.body?.["weblog"]);
  const summary = rec(results["summary"]?.body);
  const liveBetsBody = rec(results["liveBets"]?.body);
  const liveWagersBody = rec(results["liveWagers"]?.body);
  const contestsBody = rec(results["contests"]?.body);
  const boardBody = rec(results["gameBoard"]?.body);
  const catalogBody = rec(results["catalog"]?.body);
  const filters = rec(results["analysisFilters"]?.body);
  const automation = rec(summary?.["automation"]);
  const sections: DashboardSection[] = [];

  const kpiRows: Array<readonly unknown[]> = [];
  const addKpi = (
    label: string,
    block: Json | null,
    value: string,
    detail: string,
  ): void => {
    const p = rec(block?.["provenance"]);
    const source = str(p?.["source"]) ?? "—";
    kpiRows.push([
      label,
      value,
      detail,
      source,
      agoFromIso(str(p?.["asOf"]), now),
      p?.["stale"] === true ? "STALE" : (str(p?.["basis"]) ?? "—"),
    ]);
  };
  addKpi(
    "Agent tree",
    agents,
    count(agents?.["total"]),
    `${count(agents?.["agents"])} agent · ${count(agents?.["masters"])} master · ${count(agents?.["unclassified"])} unclassified`,
  );
  addKpi(
    "Open wagers (Pending)",
    pending,
    money(pending?.["wageredCents"]),
    `${count(pending?.["wagers"])} wagers · to win ${money(pending?.["toWinCents"])}`,
  );
  addKpi(
    "Bet ticker",
    ticker,
    money(ticker?.["riskCents"]),
    `${count(ticker?.["wagers"])} wagers · volume ${money(ticker?.["volumeCents"])}`,
  );
  addKpi(
    "Customer book",
    book,
    money(book?.["customerNetCents"]),
    `${count(book?.["customers"])} customers · ${count(book?.["tickets"])} tickets`,
  );
  const headlineProvenance = rec(pending?.["provenance"]);
  sections.push({
    id: "headline",
    title: "Headline",
    group: "headline",
    state: stateFrom(results["kpis"]?.ok === true, headlineProvenance),
    provenance: `source: /api/kpis · generated ${new Date(now).toISOString()}`,
    body: markdownTable(
      ["Metric", "Value", "Detail", "Source", "Age", "State"],
      kpiRows,
    ),
  });

  // Live Desk — pending exposure, operational first.
  const liveBetsResult = results["liveBets"];
  const betsSummary = rec(liveBetsBody?.["summary"]);
  if (liveBetsResult?.ok !== true) {
    sections.push(
      liveBetsResult?.status === 503
        ? lockedSection(
            "live-desk",
            "Live Desk — Pending Exposure",
            "live",
            liveBetsResult,
          )
        : missingSection(
            "live-desk",
            "Live Desk — Pending Exposure",
            "live",
            liveBetsResult?.error ?? "no /api/live-bets response",
          ),
    );
  } else {
    const bySubSport = rec(betsSummary?.["bySubSport"]) ?? {};
    const subRows = Object.entries(bySubSport)
      .slice(0, 5)
      .map(([name, value]) => {
        const v = rec(value);
        return [
          name,
          count(v?.["games"]),
          money(v?.["wagered"]),
          money(v?.["toWin"]),
        ];
      });
    const body = [
      ...markdownTable(
        ["Metric", "Value"],
        [
          ["Pending wagers", count(betsSummary?.["totalPending"])],
          ["Wagered", money(betsSummary?.["totalWagered"])],
          ["To win", money(betsSummary?.["totalToWin"])],
        ],
      ),
      "",
      ...(subRows.length === 0
        ? []
        : [
            "### By sub-sport",
            "",
            ...markdownTable(
              ["Sub-sport", "Games", "Wagered", "To win"],
              subRows,
            ),
          ]),
    ];
    sections.push({
      id: "live-desk",
      title: "Live Desk — Pending Exposure",
      group: "live",
      state: "measured",
      provenance: `${str(betsSummary?.["dataSource"]) ?? "source: —"} · captured ${str(betsSummary?.["capturedAt"]) ?? "—"}`,
      body,
    });
  }

  const watchlist = results["watchlist"] ?? {
    path: "/api/watchlist",
    ok: false,
    status: 0,
    body: null,
    error: "no /api/watchlist response",
  };
  if (watchlist?.ok !== true) {
    sections.push(
      lockedSection(
        "watchlist",
        "High-Exposure Accounts — Watch List",
        "risk",
        watchlist,
      ),
    );
  } else {
    const rows = arr(watchlist.body?.["rows"]).slice(0, maxRows);
    const body =
      rows.length === 0
        ? ["> No watchlist rows in the response."]
        : markdownTable(
            ["Customer", "Agent", "Archetype", "Tier", "Handle", "Net"],
            rows.map((value) => {
              const row = rec(value);
              return [
                str(row?.["customerId"]) ?? "—",
                str(row?.["agentId"]) ?? "—",
                str(row?.["archetype"]) ?? "—",
                str(row?.["riskTier"]) ?? "—",
                dollars(row?.["sportsHandleUSD"]),
                dollars(row?.["netUSD"]),
              ];
            }),
          );
    sections.push({
      id: "watchlist",
      title: "High-Exposure Accounts — Watch List",
      group: "risk",
      state: "measured",
      body,
    });
  }

  const weblogRows = rec(weblog?.["rows"]);
  const weblogJoin = rec(weblog?.["join"]);
  sections.push(
    weblog === null || results["kpis"]?.ok !== true
      ? missingSection(
          "weblog",
          "WebLog & Session Overlap (Mode 6)",
          "ops",
          "no weblog counters on /api/kpis",
        )
      : {
          id: "weblog",
          title: "WebLog & Session Overlap (Mode 6)",
          group: "ops",
          state: "measured",
          provenance: "source: /api/kpis · rollup window",
          body: markdownTable(
            ["Metric", "Value"],
            [
              ["Rows", count(weblogRows?.["total"])],
              ["Parsed", count(weblogRows?.["parsed"])],
              ["Matched wagers", count(weblogJoin?.["matched"])],
              ["Window wagers", count(weblogJoin?.["totalWindowWagers"])],
            ],
          ),
        },
  );

  const bridges = arr(summary?.["bridges"]);
  sections.push({
    id: "review",
    title: "Bridge Review Queue",
    group: "ops",
    state: bridges.length === 0 ? "not_measured" : "measured",
    provenance: "source: /api/graph/summary · bridges",
    body:
      bridges.length === 0
        ? ["> No bridge rows reported."]
        : markdownTable(
            ["Bridge", "State", "Value", "Age", "Stale"],
            bridges.map((value) => {
              const bridge = rec(value);
              const val = rec(bridge?.["value"]);
              const detail =
                val === null
                  ? (str(bridge?.["reason"]) ?? "—")
                  : Object.entries(val)
                      .slice(0, 2)
                      .map(([k, v]) => `${k}=${String(v)}`)
                      .join(" · ");
              return [
                str(bridge?.["label"]) ?? str(bridge?.["id"]) ?? "—",
                str(bridge?.["state"]) ?? "—",
                detail,
                age(numeric(bridge?.["ageSeconds"])),
                bridge?.["state"] === "measured"
                  ? bridge?.["stale"] === true
                    ? "STALE"
                    : "fresh"
                  : "—",
              ];
            }),
          ),
  });

  const wagersSummary = rec(liveWagersBody?.["summary"]);
  const wagers = arr(liveWagersBody?.["wagers"]);
  const liveWagersResult = results["liveWagers"];
  const wagerRows = wagers.slice(0, maxRows).map((value) => {
    const row = rec(value);
    return [
      `#${String(row?.["wagerNumber"] ?? "—")}`,
      str(row?.["agentId"]) ?? "—",
      str(row?.["customerId"]) ?? "—",
      str(row?.["wagerType"]) ?? "—",
      money(row?.["amountWagered"]),
      money(row?.["toWinAmount"]),
      str(row?.["writer"]) ?? "—",
      count(arr(row?.["legs"]).length),
    ];
  });
  const wagersProvenance = rec(liveWagersBody?.["provenance"]);
  const wagersFreshness = rec(liveWagersBody?.["freshness"]);
  sections.push(
    liveWagersResult?.ok !== true
      ? missingSection(
          "live-wagers",
          "Live Wagers — Bet Ticker",
          "markets",
          liveWagersResult?.error ?? "no /api/live-wagers response",
        )
      : {
          id: "live-wagers",
          title: "Live Wagers — Bet Ticker",
          group: "markets",
          state: "measured",
          provenance: `${str(wagersProvenance?.["source"]) ?? "source: —"} · ${str(wagersProvenance?.["observedAt"]) ?? "no observation time"} · ${wagersFreshness?.["stale"] === true ? "STALE" : "fresh"}${wagersProvenance?.["partial"] === true ? " · partial" : ""}`,
          body: [
            `**${count(wagersSummary?.["counted"])} counted / ${count(wagersSummary?.["count"])} rows** · risk ${money(wagersSummary?.["risk"])} · volume ${money(wagersSummary?.["volume"])} · ${count(wagersSummary?.["legs"])} legs`,
            "",
            ...(wagerRows.length === 0
              ? ["> No wager rows in the response."]
              : markdownTable(
                  [
                    "Wager",
                    "Agent",
                    "Customer",
                    "Type",
                    "Risk",
                    "To win",
                    "Writer",
                    "Legs",
                  ],
                  wagerRows,
                )),
            "",
            `_Showing ${wagerRows.length} of ${wagers.length}; raise \`--rows\` for more._`,
          ],
        },
  );

  const contestSummary = rec(contestsBody?.["summary"]);
  const contestEntries = arr(contestsBody?.["entries"]).slice(0, maxRows);
  const contestsResult = results["contests"];
  sections.push(
    contestsResult?.ok !== true
      ? missingSection(
          "contests",
          "Contests — Futures & Props",
          "markets",
          contestsResult?.error ?? "no /api/contests response",
        )
      : {
          id: "contests",
          title: "Contests — Futures & Props",
          group: "markets",
          state: "measured",
          provenance: `${str(contestsBody?.["source"]) ?? "source: —"} · extracted ${str(contestsBody?.["extractedAt"]) ?? "—"}`,
          body: [
            `**${count(contestSummary?.["total"])} contests**${contestEntries.length > 0 ? ` · showing ${contestEntries.length}` : ""}`,
            "",
            ...(contestEntries.length === 0
              ? ["> No contests in the response."]
              : markdownTable(
                  ["Contest", "Group", "Description"],
                  contestEntries.map((value) => {
                    const row = rec(value);
                    return [
                      String(row?.["contestNum"] ?? "—"),
                      str(row?.["group"]) ?? "—",
                      str(row?.["description"]) ?? "—",
                    ];
                  }),
                )),
          ],
        },
  );

  const boardSummary = rec(boardBody?.["summary"]);
  const games = arr(boardBody?.["games"]).slice(0, maxRows);
  const boardResult = results["gameBoard"];
  sections.push(
    boardResult?.ok !== true
      ? missingSection(
          "game-admin",
          "Game Admin — Board & Exposure",
          "markets",
          boardResult?.error ?? "no /api/game-admin/board response",
        )
      : {
          id: "game-admin",
          title: "Game Admin — Board & Exposure",
          group: "markets",
          state: "measured",
          provenance: `${str(boardBody?.["source"]) ?? "source: —"} · observed ${str(boardBody?.["observedAt"]) ?? "—"}`,
          body: [
            `**${count(boardSummary?.["games"])} games** · live ${count(boardSummary?.["live"])} · scheduled ${count(boardSummary?.["scheduled"])}`,
            "",
            ...(games.length === 0
              ? ["> No games in this window."]
              : markdownTable(
                  ["Game", "Status", "Score", "Spread exposure"],
                  games.map((value) => {
                    const game = rec(value);
                    const teams = arr(game?.["teams"]);
                    const score = arr(game?.["score"]);
                    const spread = arr(game?.["spread"]);
                    const exposure = spread
                      .map((side) => {
                        const s = rec(side);
                        return `${str(s?.["side"]) ?? "?"} ${str(s?.["line"]) ?? ""} ${str(s?.["amount"]) ?? ""}`;
                      })
                      .join(" · ");
                    return [
                      `${String(teams[0] ?? "?")} vs ${String(teams[1] ?? "?")}`,
                      str(game?.["status"]) ?? "—",
                      `${String(score[0] ?? "—")}–${String(score[1] ?? "—")}`,
                      exposure,
                    ];
                  }),
                )),
          ],
        },
  );

  const catalogSummary = rec(catalogBody?.["summary"]);
  const catalogResult = results["catalog"];
  sections.push(
    catalogResult?.ok !== true
      ? missingSection(
          "sports-catalog",
          "Sport Catalog — Sub-Sports & Periods",
          "markets",
          catalogResult?.error ?? "no /api/sports/catalog response",
        )
      : {
          id: "sports-catalog",
          title: "Sport Catalog — Sub-Sports & Periods",
          group: "markets",
          state: "measured",
          provenance: `${str(catalogBody?.["source"]) ?? "source: —"} · captured ${str(catalogBody?.["capturedAt"]) ?? "—"}`,
          body: markdownTable(
            ["Metric", "Value"],
            [
              ["Sports", count(catalogSummary?.["sports"])],
              ["Sub-sports", count(catalogSummary?.["subSports"])],
              ["Period entries", count(catalogSummary?.["periodEntries"])],
              ["Collisions", count(catalogSummary?.["collisions"])],
            ],
          ),
        },
  );

  const analysisResult = results["analysisFilters"] ?? {
    path: "/api/analysis/filters",
    ok: false,
    status: 0,
    body: null,
    error: "no /api/analysis/filters response",
  };
  sections.push(
    filters === null
      ? lockedSection(
          "analysis",
          "Analysis — Report Filters",
          "ops",
          analysisResult,
        )
      : {
          id: "analysis",
          title: "Analysis — Report Filters",
          group: "ops",
          state: "measured",
          provenance: `${str(filters["provenance"]) ?? "source: —"} · captured=${String(filters["captured"] === true)}`,
          body: markdownTable(
            ["Vocabulary", "Count"],
            [
              ["Reports", count(arr(filters["reports"]).length)],
              ["Activities", count(arr(filters["activities"]).length)],
              ["Groups", count(arr(filters["groups"]).length)],
              ["Weeks", count(arr(filters["weeks"]).length)],
            ],
          ),
        },
  );

  const relay = rec(automation?.["wsRelay"]);
  const cron = rec(automation?.["cron"]);
  const telegram = rec(automation?.["telegram"]);
  const repo = rec(summary?.["repo"]);
  sections.push({
    id: "automation",
    title: "Automation & Server",
    group: "admin",
    state: summary === null ? "not_measured" : "measured",
    provenance: "source: /api/graph/summary",
    body: markdownTable(
      ["Item", "Value"],
      [
        ["Relay", str(relay?.["status"]) ?? "—"],
        ["Relay frames", str(relay?.["lastFrameAtIso"]) ?? "none"],
        [
          "Cron schedules",
          `${count(cron?.["enabled"])} / ${count(cron?.["total"])} enabled`,
        ],
        ["Telegram", str(telegram?.["mode"]) ?? "—"],
        ["Head", str(repo?.["head"]) ?? "—"],
        ["Branch", str(repo?.["branch"]) ?? "—"],
        ["Routes", count(rec(repo?.["routes"])?.["served"])],
      ],
    ),
  });

  const telegramResult = results["telegram"] ?? {
    path: "/api/telegram/status",
    ok: false,
    status: 0,
    body: null,
    error: "no /api/telegram/status response",
  };
  sections.push(
    telegramResult?.ok !== true
      ? lockedSection(
          "admin",
          "Telegram & Bot Activity",
          "admin",
          telegramResult,
        )
      : {
          id: "admin",
          title: "Telegram & Bot Activity",
          group: "admin",
          state: "measured",
          provenance: "source: /api/telegram/status",
          body: markdownTable(
            ["Item", "Value"],
            [
              [
                "Mode",
                str(rec(telegramResult.body?.["status"])?.["mode"]) ?? "—",
              ],
              [
                "Token configured",
                String(
                  rec(telegramResult.body?.["status"])?.["tokenConfigured"] ===
                    true,
                ),
              ],
              [
                "Default chat",
                String(
                  rec(telegramResult.body?.["status"])?.[
                    "defaultChatConfigured"
                  ] === true,
                ),
              ],
            ],
          ),
        },
  );

  return {
    generatedAt: new Date(now).toISOString(),
    source: `${base} · /api/kpis + /api/live-bets + /api/live-wagers + /api/contests + /api/game-admin/board + /api/sports/catalog + /api/graph/summary`,
    sections,
  };
}

async function load(
  base: string,
  token: string,
): Promise<Readonly<Record<string, ApiResult>>> {
  const paths = {
    kpis: "/api/kpis",
    liveBets: "/api/live-bets",
    liveWagers: "/api/live-wagers",
    contests: "/api/contests",
    gameBoard: "/api/game-admin/board",
    catalog: "/api/sports/catalog",
    summary: "/api/graph/summary",
    watchlist: "/api/watchlist",
    telegram: "/api/telegram/status",
    analysisFilters: "/api/analysis/filters",
  } as const;
  const entries = await Promise.all(
    Object.entries(paths).map(
      async ([key, path]) => [key, await fetchJson(base, path, token)] as const,
    ),
  );
  return Object.fromEntries(entries);
}

async function main(): Promise<number> {
  const parsed = parseCliArgs(process.argv.slice(2), {
    valueFlags: [
      "--format",
      "--url",
      "--rows",
      "--columns",
      "--out",
      "--watch",
    ],
  });
  if (wantsHelp(parsed)) {
    printHelp(HELP);
    return 0;
  }

  const format = flagValue(parsed, "--format", "ansi");
  if (format !== "ansi" && format !== "html" && format !== "markdown") {
    console.error(
      `dashboard:view: unknown --format "${format}" (ansi|html|markdown)`,
    );
    return 2;
  }
  const base = flagValue(parsed, "--url", "http://127.0.0.1:4020").replace(
    /\/+$/,
    "",
  );
  const maxRows = Math.min(
    200,
    Math.max(1, Number(flagValue(parsed, "--rows", "25")) || 25),
  );
  const columns = Number(
    flagValue(parsed, "--columns", String(process.stdout.columns ?? 100)),
  );
  const out = flagValue(parsed, "--out", "");
  const watchSeconds = Math.max(
    0,
    Number(flagValue(parsed, "--watch", "0")) || 0,
  );
  const colors = !hasFlag(parsed, "--no-color");
  const light = hasFlag(parsed, "--light");
  const token = Bun.env.SPORTSDESK_ADMIN_TOKEN?.trim() ?? "";

  const renderOnce = async (): Promise<void> => {
    const results = await load(base, token);
    const snapshot = buildSnapshot(base, results, maxRows, Date.now());
    if (format === "markdown") {
      const { buildDashboardMarkdown } =
        await import("../lib/dashboard_markdown.ts");
      const markdown = buildDashboardMarkdown(snapshot);
      if (out === "") process.stdout.write(markdown);
      else await Bun.write(out, markdown);
      return;
    }
    if (format === "html") {
      const html = renderDashboardHtml(snapshot);
      if (out === "") process.stdout.write(html);
      else await Bun.write(out, html);
      return;
    }
    const ansi = renderDashboardAnsi(snapshot, {
      colors,
      columns: Number.isFinite(columns) ? Math.max(0, columns) : 100,
      light,
    });
    process.stdout.write(ansi);
  };

  if (watchSeconds === 0 || format !== "ansi") {
    await renderOnce();
    return 0;
  }

  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
  });
  while (!stopping) {
    if (process.stdout.isTTY && colors) process.stdout.write("\x1b[2J\x1b[H");
    try {
      await renderOnce();
    } catch (error) {
      console.error(
        `dashboard:view: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await Bun.sleep(watchSeconds * 1000);
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
