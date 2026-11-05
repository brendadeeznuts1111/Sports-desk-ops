#!/usr/bin/env bun
/**
 * Terminal/browser dashboard rendered from the daemon's own APIs.
 *
 * The CLI is three layers (lib/dashboard_cli.ts): a command says what to render, flags only
 * modify it, and the runtime supplies TTY width, colour support and the admin token.
 *
 *   bun run dashboard:view                     # ansi, the default command
 *   bun run dashboard:view html --out dist/dashboard-view.html
 *   bun run dashboard:view markdown | less
 *   bun run dashboard:view watch --interval 10
 *
 * The section order is operational-first (Live Desk, Watchlist, WebLog, Review, Live Wagers) and
 * reference/admin last, matching the review of the interactive page. Tables are capped by --rows.
 */
import { printHelp } from "../lib/cli_args.ts";
import {
  BridgeChannelRouteColumnStore,
  EMPTY_R2_OBJECT_KEY_SENTINEL,
  SIGNAL_CHANNEL_POLICY_SPECIFICATION_TABLE,
  TRANSPORT_BRIDGE_SPECIFICATION_TABLE,
  asCents,
  resolveSeparatedBridgeAndChannelEnvelope,
} from "../lib/bridge_and_channel_router.ts";
import {
  helpText,
  parseDashboardInvocation,
  resolveDashboardRuntime,
} from "../lib/dashboard_cli.ts";
import {
  buildDashboardMarkdown,
  markdownTable,
  type DashboardSection,
  type DashboardSectionState,
  type DashboardSnapshot,
} from "../lib/dashboard_markdown.ts";
import {
  renderDashboardAnsi,
  renderDashboardHtml,
} from "../lib/dashboard_render.ts";
import {
  assertBridgeAndChannelTaxonomicSeparation,
  assertColumnStoreNamingAndUnsignedHandles,
} from "../lib/specification_naming_police.ts";

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
  const flagsBody = rec(results["flags"]?.body);
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

  // Transport Bridges vs. Signal Channels — DOD6 v5.4 Taxonomy & Naming Police
  let namingPoliceVerdict = "PASS (NAMING-GATE-01..04)";
  try {
    const sampleStore = new BridgeChannelRouteColumnStore(1);
    assertColumnStoreNamingAndUnsignedHandles(
      sampleStore as unknown as Record<string, unknown>,
      "BridgeChannelRouteColumnStore",
    );
    assertBridgeAndChannelTaxonomicSeparation();
  } catch (err) {
    namingPoliceVerdict = `FAIL (${err instanceof Error ? err.message : String(err)})`;
  }

  const transportBridgeRows = Object.values(
    TRANSPORT_BRIDGE_SPECIFICATION_TABLE,
  ).map((spec) => [
    String(spec.bridgeOrdinal4),
    spec.bridgeId,
    spec.originDomain,
    spec.webSocketSubscriptionTopic,
    spec.r2LatestObjectKey === EMPTY_R2_OBJECT_KEY_SENTINEL
      ? "(stream-only)"
      : spec.r2LatestObjectKey,
    spec.deduplicationWatermarkContract,
    `${spec.freshnessSlaDurationMs.toLocaleString("en-US")} ms`,
  ]);

  const signalChannelRows = Object.values(
    SIGNAL_CHANNEL_POLICY_SPECIFICATION_TABLE,
  ).map((spec) => [
    String(spec.channelOrdinal5),
    spec.channelCode,
    spec.kind,
    spec.routingDisposition,
    spec.treasuryCapitalSilo,
    `+${spec.vigSurchargeBasisPoints} bps / ${spec.executionSlaDurationMs.toLocaleString("en-US")} ms`,
    spec.neuronTokenIdentifier,
    `0x${spec.permittedBridgeBitMask32.toString(16).padStart(3, "0")}`,
  ]);

  sections.push({
    id: "bridge-channel-taxonomy",
    title:
      "Transport Bridges vs. Signal Channels — DOD6 v5.4 Taxonomy & Naming Police",
    group: "ops",
    state: "measured",
    provenance: `source: lib/bridge_and_channel_router.ts + lib/specification_naming_police.ts · Naming Police: ${namingPoliceVerdict}`,
    body: [
      `**Naming Police Status:** \`${namingPoliceVerdict}\` · **10 Transport Ingestion Bridges** (\`TransportBridgeId\`) × **16 Signal Channel Policies** (\`ExtendedSignalChannelCode\`)`,
      "",
      "### Axis 1 — Transport Ingestion Bridges (`TransportBridgeId` · Provenance Layer)",
      "",
      ...markdownTable(
        [
          "Ord",
          "TransportBridgeId",
          "Origin Domain",
          "WebSocket Topic",
          "R2 Object Key",
          "Watermark Contract",
          "Freshness SLA",
        ],
        transportBridgeRows,
      ),
      "",
      "### Axis 2 — Signal Channel Policies (`ExtendedSignalChannelCode` · Stage 1/1b Policy Layer)",
      "",
      ...markdownTable(
        [
          "Ord",
          "ExtendedSignalChannelCode",
          "Policy Kind",
          "Disposition",
          "Treasury Silo",
          "Vig / SLA",
          "Neuron Token",
          "Bridge Mask",
        ],
        signalChannelRows,
      ),
    ],
  });

  const wagersSummary = rec(liveWagersBody?.["summary"]);
  const wagers = arr(liveWagersBody?.["wagers"]);
  const liveWagersResult = results["liveWagers"];
  const wagerRows = wagers.slice(0, maxRows).map((value) => {
    const row = rec(value);
    const legs = arr(row?.["legs"]);
    const rawWriter =
      str(row?.["ticketWriter"]) ?? str(row?.["writer"]) ?? "Internet";
    const resolvedEnvelope = resolveSeparatedBridgeAndChannelEnvelope({
      transportBridgeId: "BRIDGE_01_F402_BET_TICKER_STREAM",
      ticketWriterToken: rawWriter,
      wagerTypeCode: str(row?.["wagerType"]) ?? "S",
      shortDescriptionPrefix: str(row?.["descCode"]) ?? "",
      ticketLegCount: legs.length > 0 ? legs.length : 1,
      amountWageredCents: asCents(numeric(row?.["amountWagered"]) ?? 100),
    });
    return [
      `#${String(row?.["wagerNumber"] ?? "—")}`,
      str(row?.["agentId"]) ?? "—",
      str(row?.["customerId"]) ?? "—",
      str(row?.["wagerType"]) ?? "—",
      money(row?.["amountWagered"]),
      money(row?.["toWinAmount"]),
      str(row?.["writer"]) ?? "—",
      `${resolvedEnvelope.channelSpecification.channelCode} (${resolvedEnvelope.channelSpecification.neuronTokenIdentifier})`,
      count(legs.length),
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
                    "Signal Channel",
                    "Legs",
                  ],
                  wagerRows,
                )),
            "",
            `_Showing ${wagerRows.length} of ${wagers.length}; raise \`--rows\` for more._`,
          ],
        },
  );

  const flagsResult = results["flags"];
  const flagItems = arr(flagsBody?.["flags"]);
  const flagsByRule = new Map<
    string,
    { severity: string; hits: number; wagers: string[] }
  >();
  for (const value of flagItems) {
    const item = rec(value);
    const rule = str(item?.["rule"]) ?? "?";
    const entry = flagsByRule.get(rule) ?? {
      severity: str(item?.["severity"]) ?? "notice",
      hits: 0,
      wagers: [],
    };
    entry.hits += 1;
    entry.severity = str(item?.["severity"]) ?? entry.severity;
    for (const wager of arr(item?.["wagerNumbers"])) {
      if (entry.wagers.length < 6) entry.wagers.push(String(wager));
    }
    flagsByRule.set(rule, entry);
  }
  sections.push(
    flagsResult?.ok !== true
      ? missingSection(
          "flags",
          "Anomaly Signatures — Deterministic Rules",
          "risk",
          flagsResult?.error ?? "no /api/flags response",
        )
      : {
          id: "flags",
          title: "Anomaly Signatures — Deterministic Rules",
          group: "risk",
          state: "measured",
          provenance: `source: /api/flags · ${count(flagsBody?.["wagerCount"])} wagers · generated ${str(flagsBody?.["generatedAt"]) ?? "—"}`,
          body: [
            `**${count(flagsBody?.["totalFlags"])} flags · ${count(flagsBody?.["wagerCount"])} wagers**`,
            "",
            ...(flagsByRule.size === 0
              ? ["> No deterministic signatures fired."]
              : markdownTable(
                  ["Rule", "Severity", "Hits", "Sample wagers"],
                  [...flagsByRule].map(([rule, entry]) => [
                    rule,
                    entry.severity,
                    entry.hits,
                    `${entry.wagers.join(", ")}${
                      entry.hits > entry.wagers.length ? " …" : ""
                    }`,
                  ]),
                )),
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
    source: `${base} · /api/kpis + /api/flags + /api/live-bets + /api/live-wagers + /api/contests + /api/game-admin/board + /api/sports/catalog + /api/graph/summary`,
    sections,
  };
}

async function load(
  base: string,
  token: string,
): Promise<Readonly<Record<string, ApiResult>>> {
  const paths = {
    kpis: "/api/kpis",
    flags: "/api/flags",
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
  const invocation = parseDashboardInvocation(process.argv.slice(2));
  if (!invocation.ok) {
    console.error(`dashboard:view: ${invocation.error}`);
    return 2;
  }
  const { command, source, flags } = invocation.value;
  if (flags.help) {
    printHelp(helpText(source === "default" ? null : command));
    return 0;
  }

  const runtime = resolveDashboardRuntime(command, flags, {
    stdoutIsTTY: process.stdout.isTTY === true,
    stdoutColumns: process.stdout.columns,
    env: Bun.env,
  });

  const renderOnce = async (): Promise<void> => {
    const results = await load(flags.url, runtime.token);
    const snapshot = buildSnapshot(flags.url, results, flags.rows, Date.now());
    switch (command) {
      case "markdown": {
        const markdown = buildDashboardMarkdown(snapshot);
        if (flags.out === "") process.stdout.write(markdown);
        else await Bun.write(flags.out, markdown);
        return;
      }
      case "html": {
        const html = renderDashboardHtml(snapshot);
        if (flags.out === "") process.stdout.write(html);
        else await Bun.write(flags.out, html);
        return;
      }
      case "ansi":
      case "watch": {
        process.stdout.write(
          renderDashboardAnsi(snapshot, {
            colors: runtime.color,
            columns: runtime.columns,
            light: flags.light,
          }),
        );
        return;
      }
    }
  };

  if (command !== "watch") {
    await renderOnce();
    return 0;
  }

  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
  });
  while (!stopping) {
    if (runtime.tty && runtime.color) process.stdout.write("\x1b[2J\x1b[H");
    try {
      await renderOnce();
    } catch (error) {
      console.error(
        `dashboard:view: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await Bun.sleep(flags.intervalSeconds * 1000);
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
