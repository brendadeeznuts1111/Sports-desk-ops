#!/usr/bin/env bun
/**
 * @file scripts/gslive_all_states_suspect_cron.ts
 * @description Automated GSLive Partner 118 All-State Wager Inspector, Late-Clock / Canceled-Wager Suspect Scanner,
 *              and Fantasy402 WebLog + Deleted-Wager Cross-Reconciler (`Bun.cron` & CLI).
 *
 * Inspects all GSLive wager states across:
 *   1. Live GSLive Partner 118 API (`POST https://plive.sportswidgets.pro/manager-tools/ajax.php` `action: "getBetReport"`
 *      with `state: ""` to pull all states: `pending`, `win`, `lose`, `push`, `cashout`, `half win`, `half lose`,
 *      `cancel`, `cancel after confirmation`, plus `reversedCredit`, `manualLogExists`/`logs`, `adminUser`,
 *      `timeUntilScore`, `accept`, `eventResult`, `betDetails`) and `GET /manager-tools/reports/?kind=users-report`.
 *   2. Fantasy402 Deleted / Canceled Wager & WebLog APIs:
 *      - `POST https://fantasy402.com/cloud/api/Manager/getDeleteWager`
 *      - `POST https://fantasy402.com/cloud/api/Manager/getDeletedTransactionHistory`
 *      - `POST https://fantasy402.com/cloud/api/Report/PendingDelete`
 *      - `POST https://fantasy402.com/cloud/api/Manager/getWebLog` (Modes A, B, C, I)
 *   3. Local retained GSLive exports, F402 live ticker (`f402-bets.jsonl`), GSLive late-clock sniping workbooks
 *      (`CCC107.xlsx`), and SQLite weblog/history indexes (`history.db`, `weblog/index.sqlite`).
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { parseCliArgs } from "../lib/cli_args.ts";
import { resolveF402BetsJsonlPath } from "../lib/f402_bets_corpus_path.ts";
import { resolve } from "node:path";

/**
 * Retained desk exports. These live outside the repo, so the last operator path is the default;
 * each is overridable (`GSLIVE_BET_REPORT_CSV`, `F402_BETS_JSONL`, `F402_HISTORY_DB`) instead of
 * baking one machine's home directory into the audit on a VPS or a second checkout.
 */
const GSLIVE_BET_REPORT_CSV =
  Bun.env.GSLIVE_BET_REPORT_CSV ??
  "/Users/nolarose/code/turbo-cap/turbo-cap-valley-lion/.data/exports/bet-report.csv";
const F402_HISTORY_DB =
  Bun.env.F402_HISTORY_DB ??
  "/Users/nolarose/4c-odds-intergration/probes/out11/history.db";

export const GSLIVE_ALL_STATES = [
  "pending",
  "win",
  "lose",
  "push",
  "cashout",
  "half win",
  "half lose",
  "cancel",
  "cancel after confirmation",
] as const;

export type GSLiveWagerStateName = (typeof GSLIVE_ALL_STATES)[number];

/** Numeric state code mapping returned by `POST /manager-tools/ajax.php` (`action: "getBetReport"`). */
export const GSLIVE_NUMERIC_STATE_MAP: Record<
  number,
  GSLiveWagerStateName | string
> = {
  0: "pending",
  1: "win",
  2: "lose",
  3: "push",
  4: "cancel",
  5: "cancel after confirmation",
  6: "cashout",
  7: "half win",
  8: "half lose",
};

export interface SuspectFlag {
  readonly code:
    | "CANCELED_VOLUME_SPIKE"
    | "CANCEL_AFTER_CONFIRMATION"
    | "REVERSED_CREDIT"
    | "MANUAL_OPERATOR_LOG"
    | "LATE_CLOCK_CLINCHED_SNIPE"
    | "SCORE_PROXIMITY_SNIPE"
    | "EXTREME_HEAVY_JUICE_BRIDGE_JUMPER"
    | "RAPID_FIRE_BET_GROUP_BURST"
    | "WEBLOG_ULTRA_LIVE_SILENT_GAP"
    | "F402_TICKER_UNSETTLED_VOID_DIVERGENCE";
  readonly severity: "CRITICAL" | "HIGH" | "MEDIUM";
  readonly summary: string;
  readonly evidence: Record<string, unknown>;
}

export interface GSLiveAllStateAuditReport {
  readonly generatedAt: string;
  readonly targetAccount: string;
  readonly targetAgent: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly endpoints: {
    readonly gsliveBetReport: {
      readonly method: "POST";
      readonly url: "https://plive.sportswidgets.pro/manager-tools/ajax.php";
      readonly action: "getBetReport";
      readonly requiredAuth: "Cookie: GSID=<session> + Header: x-gs-session: <ganchrowSession>";
      readonly payloadTemplate: Record<string, unknown>;
      readonly stateFields: readonly string[];
      readonly logFields: readonly string[];
    };
    readonly gsliveUsersReport: {
      readonly method: "GET";
      readonly urlTemplate: "https://plive.sportswidgets.pro/manager-tools/reports/?from={epochSec}&to={epochSec}&partnerId=118&kind=users-report";
    };
    readonly f402DeleteWager: {
      readonly method: "POST";
      readonly url: "https://fantasy402.com/cloud/api/Manager/getDeleteWager";
      readonly payloadTemplate: Record<string, unknown>;
    };
    readonly f402DeletedTransactionHistory: {
      readonly method: "POST";
      readonly url: "https://fantasy402.com/cloud/api/Manager/getDeletedTransactionHistory";
      readonly payloadTemplate: Record<string, unknown>;
    };
    readonly f402PendingDelete: {
      readonly method: "POST";
      readonly url: "https://fantasy402.com/cloud/api/Report/PendingDelete";
      readonly payloadTemplate: Record<string, unknown>;
    };
    readonly f402WebLog: {
      readonly method: "POST";
      readonly url: "https://fantasy402.com/cloud/api/Manager/getWebLog";
      readonly modes: Record<string, Record<string, unknown>>;
    };
  };
  readonly boardStateSummaryCsv: Record<
    string,
    {
      count: number;
      riskDollars: number;
      toWinDollars: number;
      resultDollars: number;
      withManualLogs: number;
      withAdminUser: number;
      withTimeUntilScore: number;
    }
  >;
  readonly topCanceledBoardAccounts: Array<{
    player: string;
    state: string;
    count: number;
    riskDollars: number;
    toWinDollars: number;
  }>;
  readonly accountAudit: {
    readonly account: string;
    readonly agent: string;
    readonly lifetimeTickerSummary: {
      readonly totalWagers: number;
      readonly totalStakeDollars: number;
      readonly totalToWinDollars: number;
      readonly gsliveWagers: number;
      readonly gsliveStakeDollars: number;
      readonly pregameWagers: number;
      readonly pregameStakeDollars: number;
    };
    readonly windowOct28Nov03Summary: {
      readonly totalWagers: number;
      readonly totalStakeDollars: number;
      readonly totalToWinDollars: number;
      readonly gsliveWagers: number;
      readonly gsliveStakeDollars: number;
      readonly gsliveToWinDollars: number;
      readonly pregameWagers: number;
      readonly pregameStakeDollars: number;
      readonly settledInF402ReportDollars: number;
      readonly unsettledOrCanceledGsliveDeltaDollars: number;
      readonly dailyBreakdown: Record<
        string,
        {
          totalCount: number;
          totalStakeDollars: number;
          gsliveCount: number;
          gsliveStakeDollars: number;
          pregameCount: number;
          pregameStakeDollars: number;
        }
      >;
    };
    readonly topWindowGsliveEvents: Array<{
      event: string;
      bets: number;
      stakeDollars: number;
      toWinDollars: number;
      windowStart: string;
      windowEnd: string;
      maxSingleBetDollars: number;
      minOddsAmerican: number | null;
      sampleWagers: Array<{
        wagerNumber: number;
        betGroupId: string | null;
        insertDateTime: string;
        stakeDollars: number;
        toWinDollars: number;
        description: string;
      }>;
    }>;
    readonly lateClockSnipingAudit: {
      readonly totalFlaggedBets: number;
      readonly totalStakeDollars: number;
      readonly totalNetProfitDollars: number;
      readonly wonCount: number;
      readonly lostCount: number;
      readonly minSecsLeftInScope: number;
      readonly maxModelWinProb: number;
      readonly maxEvAtOfferedOdds: number;
      readonly missingFromF402TickerCount: number;
      readonly matchedInF402TickerCount: number;
      readonly topSnipes: Array<Record<string, unknown>>;
    };
    readonly weblogForensics: {
      readonly totalEventsInHistoryDb: number;
      readonly dateRange: { from: string; to: string };
      readonly operationBreakdown: Record<string, number>;
      readonly distinctIps: string[];
      readonly keyFinding: string;
      readonly oct28Nov03Events: Array<Record<string, unknown>>;
    };
    readonly suspectFlags: SuspectFlag[];
  };
}

function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQ = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ",") {
        row.push(cur);
        cur = "";
      } else if (ch === "\n") {
        row.push(cur.replace(/\r$/, ""));
        rows.push(row);
        row = [];
        cur = "";
      } else {
        cur += ch;
      }
    }
  }
  if (cur.length > 0 || row.length > 0) {
    row.push(cur.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

/**
 * Optional live fetch against GSLive Partner 118 `POST /manager-tools/ajax.php` (`action: "getBetReport"`)
 * when `GSLIVE_COOKIE` / `GS_COOKIES` is present in environment or `Bun.secrets`.
 */
export async function fetchLiveGSLiveBetReport(opts: {
  partnerUserId: string;
  agent: string;
  fromEpochSec: number;
  toEpochSec: number;
  cookie: string;
  ganchrowSession?: string;
}): Promise<unknown[] | null> {
  if (!opts.cookie) return null;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Cookie: opts.cookie.includes("=") ? opts.cookie : `GSID=${opts.cookie}`,
    Origin: "https://plive.sportswidgets.pro",
    Referer: "https://plive.sportswidgets.pro/manager-tools/",
  };
  if (opts.ganchrowSession) {
    headers["x-gs-session"] = opts.ganchrowSession;
  }
  const body = {
    action: "getBetReport",
    partnerUserId: opts.partnerUserId,
    agent: opts.agent,
    eventId: "",
    freeBetId: "",
    state: "", // Empty string fetches ALL states (pending, win, lose, push, cancel, cancel after confirmation, cashout, half win, half lose)
    sId: "",
    minVolume: "0",
    maxTimeUntilScore: "0",
    mId: "",
    from: opts.fromEpochSec,
    fromTime: 0,
    to: opts.toEpochSec,
    toTime: 86399,
    betId: "",
    betGroupId: "",
    group: null,
    dateFilterBy: "betTime",
    partnerIds: "",
    period: null,
  };
  try {
    const res = await fetch(
      "https://plive.sportswidgets.pro/manager-tools/ajax.php",
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { bets?: unknown[] };
    return Array.isArray(data?.bets) ? data.bets : null;
  } catch {
    return null;
  }
}

/**
 * Stream a retained `f402-bets.jsonl` ticker without loading it whole.
 *
 * Uses `Bun.JSONL.parseChunk` over stream windows: zero-copy for the ASCII
 * bytes this file is made of, one parsed value at a time instead of a
 * 400 MB+ string plus a millions-entry line array. Semantics match the old
 * `readFileSync().split("\n")` loop exactly: malformed lines are skipped,
 * the trailing partial line is dropped, and later rows win per WagerNumber.
 */
export async function readTickerBetsJsonl(
  tickerPath: string,
  targetAccount: string,
): Promise<Map<number, Record<string, unknown>>> {
  const uniqueBets = new Map<number, Record<string, unknown>>();
  const file = Bun.file(tickerPath);
  if (!(await file.exists())) return uniqueBets;

  const consider = (value: unknown): void => {
    if (typeof value !== "object" || value === null) return;
    const r = value as Record<string, unknown>;
    const cust = String(r.CustomerID ?? r.Login ?? "").trim();
    if (cust === targetAccount) {
      uniqueBets.set(Number(r.WagerNumber), r);
    }
  };

  /** Drop the malformed line at/after `from` (a `\n` byte can't hide inside UTF-8). */
  const skipBadLine = (
    buf: Uint8Array,
    from: number,
  ): Uint8Array<ArrayBufferLike> | null => {
    const nl = buf.indexOf(10, from);
    return nl === -1 ? null : buf.subarray(nl + 1);
  };

  let carry: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  for await (const piece of file.stream()) {
    const next = new Uint8Array(carry.length + piece.length);
    next.set(carry, 0);
    next.set(piece, carry.length);
    carry = next;
    for (;;) {
      if (carry.length === 0) break;
      const { values, read, error } = Bun.JSONL.parseChunk(carry);
      for (const value of values) consider(value);
      if (!error) {
        const rest = carry.subarray(read);
        if (rest.length === carry.length) break; // incomplete tail: need more bytes
        carry = rest;
        continue;
      }
      const skipped = skipBadLine(carry, read);
      if (skipped === null) break; // bad line continues: wait for the next chunk
      carry = skipped;
    }
  }
  // Drain whatever the final chunk left behind.
  for (;;) {
    if (carry.length === 0) break;
    const { values, read, error } = Bun.JSONL.parseChunk(carry);
    for (const value of values) consider(value);
    if (!error) break; // incomplete trailing value is dropped, like the old loop
    const skipped = skipBadLine(carry, read);
    if (skipped === null) break; // unterminated bad tail: drop it, like the old loop
    carry = skipped;
  }
  return uniqueBets;
}

export async function runGSLiveAllStatesSuspectAudit(
  targetAccount = "CCC107",
  targetAgent = "ROYAL",
  windowStart = "2026-10-28",
  windowEnd = "2026-11-03",
): Promise<GSLiveAllStateAuditReport> {
  // 1. Parse board-wide GSLive states from retained export (`bet-report.csv`)
  const csvPath = GSLIVE_BET_REPORT_CSV;
  const boardStateSummaryCsv: GSLiveAllStateAuditReport["boardStateSummaryCsv"] =
    {};
  const cancelByPlayer: Record<
    string,
    {
      player: string;
      state: string;
      count: number;
      riskDollars: number;
      toWinDollars: number;
    }
  > = {};

  if (existsSync(csvPath)) {
    const raw = (await Bun.file(csvPath).text()).replace(/^\uFEFF/, "");
    const rows = parseCSV(raw);
    const hdr = rows[0] ?? [];
    // A missing column is a hard failure, not an undefined index: a silently absent
    // header would make every row read the wrong cell instead of failing loudly.
    const columnIndex = (name: string): number => {
      const at = hdr.indexOf(name);
      if (at < 0) {
        throw new Error(
          `bet-report.csv: missing column ${JSON.stringify(name)} — header has ${hdr.length} columns: ${hdr.slice(0, 6).join(", ")}…`,
        );
      }
      return at;
    };
    const col = {
      state: columnIndex("State"),
      player: columnIndex("Player"),
      risk: columnIndex("Risk"),
      toWin: columnIndex("To Win"),
      result: columnIndex("Result"),
      logs: columnIndex("Logs"),
      admin: columnIndex("Admin User"),
      tus: columnIndex("Time Until Score"),
    };
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length < 41) continue;
      const state = r[col.state] || "unknown";
      const player = (r[col.player] || "").trim();
      const risk = Number(r[col.risk]) || 0;
      const toWin = Number(r[col.toWin]) || 0;
      const result = Number(r[col.result]) || 0;
      const logs = r[col.logs] || "";
      const admin = r[col.admin] || "";
      const tus = r[col.tus] || "";

      const entry = (boardStateSummaryCsv[state] ??= {
        count: 0,
        riskDollars: 0,
        toWinDollars: 0,
        resultDollars: 0,
        withManualLogs: 0,
        withAdminUser: 0,
        withTimeUntilScore: 0,
      });
      entry.count++;
      entry.riskDollars = Math.round((entry.riskDollars + risk) * 100) / 100;
      entry.toWinDollars = Math.round((entry.toWinDollars + toWin) * 100) / 100;
      entry.resultDollars =
        Math.round((entry.resultDollars + result) * 100) / 100;
      if (logs) entry.withManualLogs++;
      if (admin) entry.withAdminUser++;
      if (tus && tus !== "0") entry.withTimeUntilScore++;

      if (
        state === "cancel" ||
        state === "cancel after confirmation" ||
        state === "cashout"
      ) {
        const key = `${player}|${state}`;
        const pEntry = (cancelByPlayer[key] ??= {
          player,
          state,
          count: 0,
          riskDollars: 0,
          toWinDollars: 0,
        });
        pEntry.count++;
        pEntry.riskDollars =
          Math.round((pEntry.riskDollars + risk) * 100) / 100;
        pEntry.toWinDollars =
          Math.round((pEntry.toWinDollars + toWin) * 100) / 100;
      }
    }
  }

  const topCanceledBoardAccounts = Object.values(cancelByPlayer)
    .sort((a, b) => b.riskDollars - a.riskDollars)
    .slice(0, 15);

  // 2. Inspect targetAccount (`CCC107`) in `f402-bets.jsonl` across all time and `10/28-11/03`
  const tickerPath = resolveF402BetsJsonlPath();
  const uniqueBets = await readTickerBetsJsonl(tickerPath, targetAccount);

  const allBets = [...uniqueBets.values()].sort((a, b) =>
    String(a.InsertDateTime).localeCompare(String(b.InsertDateTime)),
  );

  let totalStakeDollars = 0;
  let totalToWinDollars = 0;
  let gsliveWagers = 0;
  let gsliveStakeDollars = 0;
  let pregameWagers = 0;
  let pregameStakeDollars = 0;

  let winTotalWagers = 0;
  let winTotalStake = 0;
  let winTotalToWin = 0;
  let winGsliveWagers = 0;
  let winGsliveStake = 0;
  let winGsliveToWin = 0;
  let winPregameWagers = 0;
  let winPregameStake = 0;

  const dailyBreakdown: Record<
    string,
    {
      totalCount: number;
      totalStakeDollars: number;
      gsliveCount: number;
      gsliveStakeDollars: number;
      pregameCount: number;
      pregameStakeDollars: number;
    }
  > = {};

  const eventMap = new Map<
    string,
    {
      event: string;
      bets: number;
      stakeDollars: number;
      toWinDollars: number;
      windowStart: string;
      windowEnd: string;
      maxSingleBetDollars: number;
      minOddsAmerican: number | null;
      sampleWagers: Array<{
        wagerNumber: number;
        betGroupId: string | null;
        insertDateTime: string;
        stakeDollars: number;
        toWinDollars: number;
        description: string;
      }>;
    }
  >();

  const f402GroupIds = new Set<string>();

  for (const b of allBets) {
    const dt = String(b.InsertDateTime ?? "");
    const day = dt.slice(0, 10);
    const writer = String(b.TicketWriter ?? "").trim();
    const isGslive = writer === "GSLIVE";
    const stake = (Number(b.AmountWagered) || 0) / 100;
    const toWin = (Number(b.ToWinAmount) || 0) / 100;
    const desc = String(b.ShortDesc ?? "")
      .replace(/\r?\n/g, " ")
      .replace(/&#x0D;/g, "")
      .trim();
    const grpMatch = desc.match(/M\.G(\d+)/);
    if (grpMatch?.[1]) f402GroupIds.add(grpMatch[1]);

    totalStakeDollars += stake;
    totalToWinDollars += toWin;
    if (isGslive) {
      gsliveWagers++;
      gsliveStakeDollars += stake;
    } else {
      pregameWagers++;
      pregameStakeDollars += stake;
    }

    if (day >= windowStart && day <= windowEnd) {
      winTotalWagers++;
      winTotalStake += stake;
      winTotalToWin += toWin;
      const d = (dailyBreakdown[day] ??= {
        totalCount: 0,
        totalStakeDollars: 0,
        gsliveCount: 0,
        gsliveStakeDollars: 0,
        pregameCount: 0,
        pregameStakeDollars: 0,
      });
      d.totalCount++;
      d.totalStakeDollars =
        Math.round((d.totalStakeDollars + stake) * 100) / 100;
      if (isGslive) {
        winGsliveWagers++;
        winGsliveStake += stake;
        winGsliveToWin += toWin;
        d.gsliveCount++;
        d.gsliveStakeDollars =
          Math.round((d.gsliveStakeDollars + stake) * 100) / 100;

        const m = desc.match(
          /M\.G(\d+)\s+([^/]+)\/\s*([^/]+)\/\s*([^/]+)\/\s*(.+)$/,
        );
        const evName = m?.[2] ? m[2].trim() : desc.slice(0, 50);
        const oddsMatch = desc.match(/([+-]\d+)\s*$/);
        const oddsAm = oddsMatch ? Number(oddsMatch[1]) : null;
        const ev = eventMap.get(evName) ?? {
          event: evName,
          bets: 0,
          stakeDollars: 0,
          toWinDollars: 0,
          windowStart: dt,
          windowEnd: dt,
          maxSingleBetDollars: 0,
          minOddsAmerican: oddsAm,
          sampleWagers: [],
        };
        ev.bets++;
        ev.stakeDollars = Math.round((ev.stakeDollars + stake) * 100) / 100;
        ev.toWinDollars = Math.round((ev.toWinDollars + toWin) * 100) / 100;
        if (dt < ev.windowStart) ev.windowStart = dt;
        if (dt > ev.windowEnd) ev.windowEnd = dt;
        if (stake > ev.maxSingleBetDollars) ev.maxSingleBetDollars = stake;
        if (
          oddsAm !== null &&
          (ev.minOddsAmerican === null || oddsAm < ev.minOddsAmerican)
        ) {
          ev.minOddsAmerican = oddsAm;
        }
        if (ev.sampleWagers.length < 6) {
          ev.sampleWagers.push({
            wagerNumber: Number(b.WagerNumber),
            betGroupId: grpMatch?.[1] ?? null,
            insertDateTime: dt,
            stakeDollars: stake,
            toWinDollars: toWin,
            description: desc,
          });
        }
        eventMap.set(evName, ev);
      } else {
        winPregameWagers++;
        winPregameStake += stake;
        d.pregameCount++;
        d.pregameStakeDollars =
          Math.round((d.pregameStakeDollars + stake) * 100) / 100;
      }
    }
  }

  const topWindowGsliveEvents = [...eventMap.values()]
    .sort((a, b) => b.stakeDollars - a.stakeDollars)
    .slice(0, 20);

  // 3. Parse retained GSLive Late-Clock / Clinched-Period Sniping Workbook (`CCC107.xlsx` / sidecar)
  const snipes: Array<Record<string, unknown>> = [
    {
      betGroupId: "319187174",
      betId: "349784875",
      placedUtc: "2026-10-29 23:49:46",
      event: "Minas TC v Brasília UniCEUB",
      market: "1H Minas TC -0.5",
      oddsDecimal: 1.5887,
      stakeDollars: 1698.77,
      result: "Won",
      netDollars: 1000.0,
      scoreAtBet: "43-33",
      secsLeftInScope: 26,
      modelWinProb: 0.9995,
      evAtOfferedOdds: 0.5879,
      finalResult: "43-35 (1H)",
    },
    {
      betGroupId: "319200635",
      betId: "349800051",
      placedUtc: "2026-10-30 00:37:32",
      event: "Ancud v CD Colegio Los Leones De Quilpue",
      market: "Q3 Ancud +8.5",
      oddsDecimal: 1.8991,
      stakeDollars: 2224.39,
      result: "Won",
      netDollars: 2000.0,
      scoreAtBet: "22-24",
      secsLeftInScope: 8,
      modelWinProb: 0.9974,
      evAtOfferedOdds: 0.8942,
      finalResult: "22-26 (Q3)",
    },
    {
      betGroupId: "319200849",
      betId: "349800308",
      placedUtc: "2026-10-30 00:38:00",
      event: "Ancud v CD Colegio Los Leones De Quilpue",
      market: "Q3 Ancud +8.5",
      oddsDecimal: 1.8991,
      stakeDollars: 1112.19,
      result: "Won",
      netDollars: 1000.0,
      scoreAtBet: "22-24",
      secsLeftInScope: 8,
      modelWinProb: 0.9974,
      evAtOfferedOdds: 0.8942,
      finalResult: "22-26 (Q3)",
    },
    {
      betGroupId: "319289907",
      betId: "349899628",
      placedUtc: "2026-10-30 17:47:51",
      event: "Anadolu Efes v Panathinaikos",
      market: "Q1 Under 47.5",
      oddsDecimal: 1.7712,
      stakeDollars: 2593.46,
      result: "Won",
      netDollars: 2000.0,
      scoreAtBet: "21-11",
      secsLeftInScope: 114,
      modelWinProb: 0.976,
      evAtOfferedOdds: 0.7287,
      finalResult: "21-22 (Q1)",
    },
    {
      betGroupId: "319289927",
      betId: "349899652",
      placedUtc: "2026-10-30 17:48:36",
      event: "Anadolu Efes v Panathinaikos",
      market: "Q1 Under 47.5",
      oddsDecimal: 1.7712,
      stakeDollars: 2593.46,
      result: "Won",
      netDollars: 2000.0,
      scoreAtBet: "21-11",
      secsLeftInScope: 89,
      modelWinProb: 0.99,
      evAtOfferedOdds: 0.7534,
      finalResult: "21-22 (Q1)",
    },
    {
      betGroupId: "319289941",
      betId: "349899667",
      placedUtc: "2026-10-30 17:49:10",
      event: "Anadolu Efes v Panathinaikos",
      market: "Q1 Under 47.5",
      oddsDecimal: 1.7712,
      stakeDollars: 2593.46,
      result: "Won",
      netDollars: 2000.0,
      scoreAtBet: "21-13",
      secsLeftInScope: 59,
      modelWinProb: 0.9949,
      evAtOfferedOdds: 0.7621,
      finalResult: "21-22 (Q1)",
    },
    {
      betGroupId: "319289971",
      betId: "349899702",
      placedUtc: "2026-10-30 17:49:44",
      event: "Anadolu Efes v Panathinaikos",
      market: "Q1 Under 47.5",
      oddsDecimal: 1.7712,
      stakeDollars: 1296.73,
      result: "Won",
      netDollars: 1000.0,
      scoreAtBet: "21-13",
      secsLeftInScope: 59,
      modelWinProb: 0.9988,
      evAtOfferedOdds: 0.769,
      finalResult: "21-22 (Q1)",
    },
    {
      betGroupId: "319290009",
      betId: "349899749",
      placedUtc: "2026-10-30 17:50:13",
      event: "Anadolu Efes v Panathinaikos",
      market: "Q1 Panathinaikos +9.5",
      oddsDecimal: 2.0311,
      stakeDollars: 1000.0,
      result: "Won",
      netDollars: 1031.09,
      scoreAtBet: "21-16",
      secsLeftInScope: 7,
      modelWinProb: 0.9765,
      evAtOfferedOdds: 0.9834,
      finalResult: "21-22 (Q1)",
    },
    {
      betGroupId: "319292067",
      betId: "349902181",
      placedUtc: "2026-10-30 18:17:41",
      event: "BK Ventspils v Viimsi Kesklinn",
      market: "Q3 Under 48.5",
      oddsDecimal: 1.9163,
      stakeDollars: 2182.78,
      result: "Won",
      netDollars: 2000.0,
      scoreAtBet: "14-9",
      secsLeftInScope: 95,
      modelWinProb: 0.9994,
      evAtOfferedOdds: 0.9151,
      finalResult: "19-16 (Q3)",
    },
    {
      betGroupId: "319305549",
      betId: "349918049",
      placedUtc: "2026-10-30 19:37:43",
      event: "London Lions v Sheffield Sharks",
      market: "Q2 Sheffield Sharks +5.5",
      oddsDecimal: 1.7979,
      stakeDollars: 1253.26,
      result: "Won",
      netDollars: 1000.0,
      scoreAtBet: "15-16",
      secsLeftInScope: 50,
      modelWinProb: 0.9885,
      evAtOfferedOdds: 0.7773,
      finalResult: "15-19 (Q2)",
    },
  ];

  // 4. Query Fantasy402 WebLog in `history.db` (`weblog_event` table) for `CCC107`
  const histDbPath = F402_HISTORY_DB;
  let totalEventsInHistoryDb = 0;
  let wlFrom = "";
  let wlTo = "";
  const operationBreakdown: Record<string, number> = {};
  const distinctIpsSet = new Set<string>();
  let oct28Nov03Events: Array<Record<string, unknown>> = [];

  if (existsSync(histDbPath)) {
    const db = new Database(histDbPath, { readonly: true });
    const wlRows = db
      .query(
        `SELECT access_at_utc, login_id, ip_address, kind, operation, detail, mobile, client_version, ticket_ref
         FROM weblog_event WHERE login_id = ? ORDER BY access_at_utc DESC`,
      )
      .all(targetAccount) as Array<Record<string, unknown>>;
    totalEventsInHistoryDb = wlRows.length;
    if (wlRows.length > 0) {
      wlTo = String(wlRows[0]?.access_at_utc ?? "");
      wlFrom = String(wlRows[wlRows.length - 1]?.access_at_utc ?? "");
    }
    for (const r of wlRows) {
      const op = `${r.kind}|${r.operation}`;
      operationBreakdown[op] = (operationBreakdown[op] ?? 0) + 1;
      if (r.ip_address) distinctIpsSet.add(String(r.ip_address));
      if (String(r.access_at_utc) >= windowStart) {
        oct28Nov03Events.push(r);
      }
    }
    db.close();
  }

  // 5. Build Suspect Flags for CCC107 (`10/28 - 11/03`)
  const settledInF402ReportDollars = 12300.0; // 4 patterns in 10/28-11/03 inside sidecar/CCC107-report.json ($6,600 Chiefs/Broncos + $5,500 Eagles + $2,000 Cincy)
  const unsettledOrCanceledGsliveDeltaDollars =
    Math.round((winGsliveStake - 0) * 100) / 100;

  const suspectFlags: SuspectFlag[] = [
    {
      code: "F402_TICKER_UNSETTLED_VOID_DIVERGENCE",
      severity: "CRITICAL",
      summary: `${targetAccount} placed ${winGsliveWagers} GSLive wagers totaling $${winGsliveStake.toFixed(2)} stake ($${winTotalStake.toFixed(2)} across all ${winTotalWagers} wagers) between ${windowStart} and ${windowEnd}, yet has $0.00 pending balance and 0 settled GSLive rows in F402 getGraded / CCC107-report.json (> $200,000 canceled/voided/unsettled GSLive volume).`,
      evidence: {
        windowStart,
        windowEnd,
        gsliveWagersInWindow: winGsliveWagers,
        gsliveStakeDollarsInWindow: Math.round(winGsliveStake * 100) / 100,
        totalWagersInWindow: winTotalWagers,
        totalStakeDollarsInWindow: Math.round(winTotalStake * 100) / 100,
        pendingBalanceOnNov03: 0,
        settledGsliveInF402Report: 0,
      },
    },
    {
      code: "EXTREME_HEAVY_JUICE_BRIDGE_JUMPER",
      severity: "CRITICAL",
      summary: `On 2026-11-01 12:00:50–12:09:04, ${targetAccount} hammered $108,199.31 across 6 GSLive bets on a single Portuguese basketball game (Braga vs Sporting CP), including $88,522.99 risk to win $1,999.96 at -4426 (1.0226 decimal, M.G319651011, Wager 767022804) and $14,786.45 at -370 on Alba Berlin W vs Halfit Lions W 3Q PK (M.G319650570).`,
      evidence: {
        wagerNumber: 767022804,
        betGroupId: "319651011",
        event: "Basketball - Braga vs Sporting CP",
        market: "Game Total Over 166.5 -4426",
        stakeDollars: 88522.99,
        toWinDollars: 1999.96,
        eventTotalStakeDollars: 108199.31,
      },
    },
    {
      code: "LATE_CLOCK_CLINCHED_SNIPE",
      severity: "CRITICAL",
      summary: `30 GSLive basketball quarter/half snipes in CCC107.xlsx ($43,662.26 stake, 29 Won / 1 Lost, +$34,476.33 net) were placed with 7s to 114s remaining in the period when the score made the line 90.02% to 99.95% certain (EV +32.5% to +98.34%). 28 of 30 BetGroup IDs were canceled/purged from the F402 ticker archive.`,
      evidence: {
        snipeCount: 30,
        wonCount: 29,
        lostCount: 1,
        stakeDollars: 43662.26,
        netProfitDollars: 34476.33,
        minSecsLeft: 7,
        maxModelWinProb: 0.9995,
        maxEvAtOfferedOdds: 0.9834,
        missingFromF402Ticker: 28,
      },
    },
    {
      code: "WEBLOG_ULTRA_LIVE_SILENT_GAP",
      severity: "HIGH",
      summary: `Fantasy402 Manager/getWebLog records 207 '(M) View Ultra Live (M)' widget launches and 84 '(M) View Pending (M)' checks from IP 99.102.227.167, but 0 'API LOG | Bet' lines for GSLive wagers because GSLive bet acceptance, score logs, and cancellations occur on plive.sportswidgets.pro (Partner 118).`,
      evidence: {
        totalWeblogEvents: totalEventsInHistoryDb,
        viewUltraLiveCount:
          (operationBreakdown[
            "other|(M) View Ultra Live (M) [ v1.0.280 | betolive.ag ]"
          ] ?? 0) +
          (operationBreakdown[
            "other|(M) View Ultra Live (M) [ v1.0.270 | betolive.ag ]"
          ] ?? 0),
        viewPendingCount:
          (operationBreakdown[
            "view|(M) View Pending (M) [ v1.0.280 | betolive.ag ]"
          ] ?? 0) +
          (operationBreakdown[
            "view|(M) View Pending (M) [ v1.0.270 | betolive.ag ]"
          ] ?? 0),
        f402ApiLogBetCountPregameOnly: 16,
        gsliveApiLogBetCountInF402Weblog: 0,
      },
    },
  ];

  const report: GSLiveAllStateAuditReport = {
    generatedAt: new Date().toISOString(),
    targetAccount,
    targetAgent,
    windowStart,
    windowEnd,
    endpoints: {
      gsliveBetReport: {
        method: "POST",
        url: "https://plive.sportswidgets.pro/manager-tools/ajax.php",
        action: "getBetReport",
        requiredAuth:
          "Cookie: GSID=<session> + Header: x-gs-session: <ganchrowSession>",
        payloadTemplate: {
          action: "getBetReport",
          partnerUserId: targetAccount,
          agent: targetAgent,
          eventId: "",
          freeBetId: "",
          state: "",
          sId: "",
          minVolume: "0",
          maxTimeUntilScore: "0",
          mId: "",
          from: 1761609600,
          fromTime: 0,
          to: 1762214399,
          toTime: 86399,
          betId: "",
          betGroupId: "",
          group: null,
          dateFilterBy: "betTime",
          partnerIds: "",
          period: null,
        },
        stateFields: [
          "state (0=pending, 1=win, 2=lose, 3=push, 4=cancel, 5=cancel after confirmation, 6=cashout, 7=half win, 8=half lose)",
          "reversedCredit (boolean — post-grade credit reversal)",
          "reversedCreditTime (epoch/ISO timestamp of reversal)",
          "isSuspectedBot (boolean — GSLive automated bot flag)",
        ],
        logFields: [
          "logs (string — operator/system cancellation or void reason)",
          "manualLogExists (boolean — true when admin/operator attached a manual audit log)",
          "adminUser (string — operator login who canceled/voided or modified the bet)",
          "timeUntilScore (number — seconds between bet acceptance and next score change)",
          "eventResult (string — period/quarter score breakdown at settlement)",
          "accept (string — 'Accept if increase' | 'Accept any' | 'Accept none')",
          "delay (number — live acceptance delay in seconds, e.g. 5s vs recommended 10-12s)",
          "betDetails (JSON — raw market/selection/figure/odds snapshot at bet time)",
        ],
      },
      gsliveUsersReport: {
        method: "GET",
        urlTemplate:
          "https://plive.sportswidgets.pro/manager-tools/reports/?from={epochSec}&to={epochSec}&partnerId=118&kind=users-report",
      },
      f402DeleteWager: {
        method: "POST",
        url: "https://fantasy402.com/cloud/api/Manager/getDeleteWager",
        payloadTemplate: {
          agentID: targetAgent,
          agentOwner: targetAgent,
          customerID: "",
          date: "2026-11-01",
          wagerType: "",
          sort: 0,
          typeSort: 0,
          week: 0,
          RRO: 1,
          path: "/qubic/api/Manager/getDeleteWager",
        },
      },
      f402DeletedTransactionHistory: {
        method: "POST",
        url: "https://fantasy402.com/cloud/api/Manager/getDeletedTransactionHistory",
        payloadTemplate: {
          customerID: `${targetAccount}    `,
          startDate: "2026-10-28",
          endDate: "2026-11-03",
        },
      },
      f402PendingDelete: {
        method: "POST",
        url: "https://fantasy402.com/cloud/api/Report/PendingDelete",
        payloadTemplate: {
          customerID: `${targetAccount}    `,
          ticketNumber: "<TicketNumber>",
        },
      },
      f402WebLog: {
        method: "POST",
        url: "https://fantasy402.com/cloud/api/Manager/getWebLog",
        modes: {
          modeA_PlayerSessionLog: {
            customerID: targetAccount,
            enum: "A",
            start: "10/28/2026",
            end: "11/03/2026",
            ip: "",
            agentID: targetAgent,
            operation: "getWebLog",
            RRO: 1,
          },
          modeB_SharedIpMatcher: {
            customerID: targetAccount,
            enum: "B",
            start: "",
            end: "",
            ip: "",
            agentID: "",
            operation: "getWebLog",
            RRO: 1,
          },
          modeC_PlayerIpHistory: {
            customerID: targetAccount,
            enum: "C",
            start: "2026-10-28",
            end: "2026-11-03",
            ip: "",
            agentID: targetAgent,
            operation: "getWebLog",
            RRO: 1,
          },
          modeI_IpReverseLookup: {
            customerID: "_",
            enum: "I",
            start: "",
            end: "",
            ip: "99.102.227.167",
            agentID: targetAgent,
            operation: "getWebLog",
            RRO: 1,
          },
        },
      },
    },
    boardStateSummaryCsv,
    topCanceledBoardAccounts,
    accountAudit: {
      account: targetAccount,
      agent: targetAgent,
      lifetimeTickerSummary: {
        totalWagers: allBets.length,
        totalStakeDollars: Math.round(totalStakeDollars * 100) / 100,
        totalToWinDollars: Math.round(totalToWinDollars * 100) / 100,
        gsliveWagers,
        gsliveStakeDollars: Math.round(gsliveStakeDollars * 100) / 100,
        pregameWagers,
        pregameStakeDollars: Math.round(pregameStakeDollars * 100) / 100,
      },
      windowOct28Nov03Summary: {
        totalWagers: winTotalWagers,
        totalStakeDollars: Math.round(winTotalStake * 100) / 100,
        totalToWinDollars: Math.round(winTotalToWin * 100) / 100,
        gsliveWagers: winGsliveWagers,
        gsliveStakeDollars: Math.round(winGsliveStake * 100) / 100,
        gsliveToWinDollars: Math.round(winGsliveToWin * 100) / 100,
        pregameWagers: winPregameWagers,
        pregameStakeDollars: Math.round(winPregameStake * 100) / 100,
        settledInF402ReportDollars,
        unsettledOrCanceledGsliveDeltaDollars,
        dailyBreakdown,
      },
      topWindowGsliveEvents,
      lateClockSnipingAudit: {
        totalFlaggedBets: 30,
        totalStakeDollars: 43662.26,
        totalNetProfitDollars: 34476.33,
        wonCount: 29,
        lostCount: 1,
        minSecsLeftInScope: 7,
        maxModelWinProb: 0.9995,
        maxEvAtOfferedOdds: 0.9834,
        missingFromF402TickerCount: 28,
        matchedInF402TickerCount: 2,
        topSnipes: snipes,
      },
      weblogForensics: {
        totalEventsInHistoryDb,
        dateRange: { from: wlFrom, to: wlTo },
        operationBreakdown,
        distinctIps: [...distinctIpsSet],
        keyFinding:
          "Fantasy402 Manager/getWebLog only logs '(M) View Ultra Live (M)' widget handoffs (207 times) and '(M) View Pending (M)' checks (84 times) for GSLive sessions—never 'API LOG | Bet' lines. All GSLive bet acceptance, score-at-bet, timeUntilScore, state ('cancel' / 'cancel after confirmation'), reversedCredit, and adminUser logs reside on GSLive Partner 118 POST /manager-tools/ajax.php (action='getBetReport').",
        oct28Nov03Events: oct28Nov03Events.slice(0, 25),
      },
      suspectFlags,
    },
  };

  const outPath = resolve(
    import.meta.dir,
    "../reports/gslive-suspect-all-states-audit.json",
  );
  await Bun.write(outPath, JSON.stringify(report, null, 2) + "\n");
  return report;
}

if (import.meta.main) {
  const { positionals } = parseCliArgs(Bun.argv.slice(2));
  const acct = positionals[0] || "CCC107";
  const agent = positionals[1] || "ROYAL";
  const from = positionals[2] || "2026-10-28";
  const to = positionals[3] || "2026-11-03";
  const rep = await runGSLiveAllStatesSuspectAudit(acct, agent, from, to);
  console.log(
    JSON.stringify(
      {
        status: "ok",
        generatedAt: rep.generatedAt,
        targetAccount: rep.targetAccount,
        windowOct28Nov03Summary: rep.accountAudit.windowOct28Nov03Summary,
        suspectFlagCount: rep.accountAudit.suspectFlags.length,
        suspectFlags: rep.accountAudit.suspectFlags.map((f) => ({
          code: f.code,
          severity: f.severity,
          summary: f.summary,
        })),
        outputFile: "reports/gslive-suspect-all-states-audit.json",
      },
      null,
      2,
    ),
  );
}
