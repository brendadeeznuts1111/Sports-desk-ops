/**
 * @file lib/f402_weblog_pattern_tracker.ts
 * @description Customer WebLog + IP + Bet/Sport/SubSport + `BOT BLOCK LINE ST` pattern tracker.
 *
 * Supports:
 * 1. Copy-pasted portal Customer WebLog TSV tables (`Time(EST)\tIP Address\tAction`, including
 *    multi-line `API LOG | Bet :\n<Sport> #<Rot> ...` rows and HTML entities like `&#189;`).
 * 2. JSON/JSONL `Manager/getWebLog` activity rows (`Mode A` / `Mode C`: `{ AccessDateTime, LoginID, IPAddress, Operation }`).
 * 3. Pairing `API LOG | Ticket: <id> Risk:<cents> Win:<cents>` with `API LOG | Bet : <desc>` at the
 *    same timestamp (either order, plus multi-bet tickets such as Moneyline + Puckline on one ticket).
 * 4. Parsing `API LOG | BLOCK BET | BOT BLOCK LINE ST| #[{"key":"bot_<gameId>_<period>_<wagerType>__<idx>","val":"<customerId>"}]`
 *    collision locks and detecting post-block retry wagers within a configurable window (default 60s).
 * 5. Cross-referencing `Manager/getReportPlayerAnalysis` detail wagers (`reportType: 2`, `lineType: 2` & `3`)
 *    by timestamp + rotation number + risk/win cents to enrich WebLog bets with exact `SPORTSUBTYPE`
 *    (`NFL`, `College`, `NHL`, `NBA`, `NCAA`, `NBAPlayerPro`), closing lines (`CLOSELINE`), CLV
 *    (`POINTS`, `PRICE`), and `WAGERSTATUS`, and to attribute an anonymous WebLog table to its exact `CustomerID`.
 */

import {
  classifyIp,
  ipToUint32,
  parseAccessMs,
  parseOperation,
} from "./f402_weblog.ts";
import {
  normalizeReportPlayerAnalysisRow,
  type NormalizedReportPlayerAnalysisRow,
  type ReportPlayerAnalysisRowRaw,
} from "./f402_report_player_analysis.ts";

export interface RawWeblogInputRow {
  readonly accessDateTime: string;
  readonly accessMs: number;
  readonly loginId: string;
  readonly ip: string;
  readonly ip32: number | null;
  readonly ipv4Subnet24: string | null;
  readonly ipClass: string;
  readonly operation: string;
  readonly deviceClass: "M" | "D" | "UNKNOWN";
  readonly actionKind: string;
  readonly clientVersion: string | null;
  readonly skinDomain: string | null;
}

export type WeblogBetMarketType =
  | "SPREAD"
  | "TOTAL_OVER"
  | "TOTAL_UNDER"
  | "MONEYLINE"
  | "PUCKLINE_OR_RUNLINE"
  | "TEAM_TOTAL_OR_PROP"
  | "UNKNOWN";

export interface ParsedWeblogBetLeg {
  readonly rawText: string;
  readonly normalizedText: string;
  readonly sport: string;
  readonly rotationNumber: number | null;
  readonly inferredSubSport: string;
  readonly selectionText: string;
  readonly marketType: WeblogBetMarketType;
  readonly linePoints: number | null;
  readonly juiceOdds: number | null;
  readonly boughtPoints: number;
  readonly periodLabel: string;
  readonly periodNumber: number | null;
}

export interface PairedWeblogWager {
  readonly accessDateTime: string;
  readonly accessMs: number;
  readonly ip: string;
  readonly ipv4Subnet24: string | null;
  readonly ipClass: string;
  readonly deviceClass: "M" | "D" | "UNKNOWN";
  readonly skinDomain: string | null;
  readonly clientVersion: string | null;
  readonly loginId: string;
  readonly ticketNumber: string | null;
  readonly riskCents: number | null;
  readonly toWinCents: number | null;
  readonly bet: ParsedWeblogBetLeg;
  readonly loginToBetLatencySec: number | null;
  /** Enriched from `getReportPlayerAnalysis` detail rows when joined. */
  readonly matchedAnalysisRow: NormalizedReportPlayerAnalysisRow | null;
  readonly resolvedSubSport: string;
}

export interface ParsedBotBlockEvent {
  readonly accessDateTime: string;
  readonly accessMs: number;
  readonly ip: string;
  readonly ipv4Subnet24: string | null;
  readonly loginId: string;
  readonly blockType: string;
  readonly rawKey: string;
  readonly gameId: string | null;
  readonly periodNumber: number | null;
  readonly wagerType: string | null;
  readonly slotIndex: number | null;
  readonly blockingCustomerId: string;
  readonly isSelfCollision: boolean | null;
  /** First wager placed from the same IP within `retryWindowSec` after the block. */
  readonly postBlockRetryWager: {
    readonly delaySec: number;
    readonly ticketNumber: string | null;
    readonly description: string;
    readonly riskCents: number | null;
    readonly toWinCents: number | null;
  } | null;
}

export interface IpPatternSummary {
  readonly ip: string;
  readonly ipv4Subnet24: string | null;
  readonly ipClass: string;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly eventCount: number;
  readonly loginCount: number;
  readonly wagerCount: number;
  readonly botBlockCount: number;
  readonly totalRiskCents: number;
  readonly totalToWinCents: number;
  readonly deviceClasses: Readonly<Record<string, number>>;
  readonly sports: Readonly<Record<string, number>>;
  readonly subSports: Readonly<Record<string, number>>;
  readonly periods: Readonly<Record<string, number>>;
  readonly marketTypes: Readonly<Record<string, number>>;
  readonly boughtPointsWagerCount: number;
  readonly medianLoginToBetSec: number | null;
}

export interface SportSubSportPatternSummary {
  readonly sport: string;
  readonly subSport: string;
  readonly wagerCount: number;
  readonly totalRiskCents: number;
  readonly totalToWinCents: number;
  readonly ips: readonly string[];
  readonly periods: Readonly<Record<string, number>>;
  readonly marketTypes: Readonly<Record<string, number>>;
  readonly boughtPointsWagerCount: number;
  readonly beatClosingPointsCount: number;
  readonly beatClosingPriceCount: number;
  readonly playerNetCents: number;
}

export interface PeriodPatternSummary {
  readonly periodLabel: string;
  readonly periodNumber: number | null;
  readonly wagerCount: number;
  readonly totalRiskCents: number;
  readonly ips: readonly string[];
  readonly subSports: Readonly<Record<string, number>>;
  readonly marketTypes: Readonly<Record<string, number>>;
}

export interface WeblogPatternReport {
  readonly totalEvents: number;
  readonly loginCount: number;
  readonly wagerCount: number;
  readonly distinctTicketCount: number;
  readonly multiBetTicketNumbers: readonly string[];
  readonly distinctIpCount: number;
  readonly attributedCustomerId: string | null;
  readonly attributionMatchCount: number;
  readonly wagers: readonly PairedWeblogWager[];
  readonly botBlocks: readonly ParsedBotBlockEvent[];
  readonly byIp: readonly IpPatternSummary[];
  readonly bySportSubSport: readonly SportSubSportPatternSummary[];
  readonly byPeriod: readonly PeriodPatternSummary[];
  readonly ipTransitions: readonly {
    readonly fromIp: string;
    readonly toIp: string;
    readonly atDateTime: string;
    readonly gapMinutes: number;
    readonly fromDevice: string;
    readonly toDevice: string;
  }[];
}

const TIME_12H_RE = /^(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i;
const TSV_ROW_RE =
  /^(\d{1,2}:\d{2}:\d{2}\s*(?:AM|PM)|\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)\t([^\t]+)\t(.*)$/i;

const TICKET_LOG_RE =
  /^API LOG\s*\|\s*Ticket:\s*(\d+)\s+Risk:\s*(-?\d+)\s+Win:\s*(-?\d+)/i;
const BET_LOG_PREFIX_RE = /^API LOG\s*\|\s*Bet\s*:\s*(.*)$/is;
const BOT_BLOCK_RE =
  /^API LOG\s*\|\s*BLOCK BET\s*\|\s*([^|]+)\|\s*#(\[.*\])\s*$/is;
const BOT_KEY_RE = /^bot_(\d+)_(\d+)_([A-Z]+)__(\d+)$/i;

export function decodeHtmlFractionEntities(text: string): string {
  return text
    .replace(/&#189;|&frac12;/gi, "½")
    .replace(/&#188;|&frac14;/gi, "¼")
    .replace(/&#190;|&frac34;/gi, "¾")
    .replace(/&#x0D;/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseFractionNumber(raw: string): number | null {
  const cleaned = decodeHtmlFractionEntities(raw).replace(/\s+/g, "");
  if (/^pk$/i.test(cleaned)) return 0;
  const match = /^([+-]?)(\d+)?([½¼¾])?(?:\.(\d+))?$/.exec(cleaned);
  if (match === null) return null;
  const signStr = match[1] ?? "";
  const wholeStr = match[2] ?? "";
  const fracChar = match[3] ?? "";
  const decStr = match[4] ?? "";
  if (wholeStr === "" && fracChar === "" && decStr === "") return null;
  const sign = signStr === "-" ? -1 : 1;
  const whole = wholeStr !== "" ? Number(wholeStr) : 0;
  const frac =
    fracChar === "½"
      ? 0.5
      : fracChar === "¼"
        ? 0.25
        : fracChar === "¾"
          ? 0.75
          : decStr !== ""
            ? Number(`0.${decStr}`)
            : 0;
  return sign * (whole + frac);
}

export function ipv4Subnet24(ip: string): string | null {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return `${nums[0]}.${nums[1]}.${nums[2]}.0/24`;
}

/**
 * Extended IP classifier that layers datacenter/VPN and AT&T residential/mobility ranges
 * onto `classifyIp` from `lib/f402_weblog.ts`.
 */
export function classifyWeblogIpExtended(ip: string): string {
  const base = classifyIp(ip);
  if (base !== "OTHER") return base;
  const val = ipToUint32(ip);
  if (val === null) return base;
  // 156.146.0.0/16 = M247 / Datacenter VPN exit nodes (NordVPN / Surfshark / ExpressVPN)
  if ((val & 0xffff0000) >>> 0 === ipToUint32("156.146.0.0")!) {
    return "VPN_DATACENTER_156_146";
  }
  // 107.112.0.0/12 = AT&T Mobility cellular IPv4
  if ((val & 0xfff00000) >>> 0 === ipToUint32("107.112.0.0")!) {
    return "ATT_MOBILITY_107_112";
  }
  // 70.128.0.0/11 = AT&T / Sonic residential broadband
  if ((val & 0xffe00000) >>> 0 === ipToUint32("70.128.0.0")!) {
    return "ATT_BROADBAND_70_128";
  }
  return base;
}

export function inferSubSportFromRotation(
  sport: string,
  rotationNumber: number | null,
): string {
  const s = sport.trim().toUpperCase();
  if (s === "HOCKEY") {
    if (
      rotationNumber !== null &&
      rotationNumber >= 1 &&
      rotationNumber <= 99
    ) {
      return "NHL";
    }
    return "Hockey";
  }
  if (s === "FOOTBALL") {
    if (rotationNumber !== null) {
      // Standard DonBest / F402 rotation bands:
      // 101-208: College Football (with occasional Tue/Wed MAC or Thursday NFL #101-#114)
      // 231-280 / 451-480: NFL
      if (
        (rotationNumber >= 231 && rotationNumber <= 290) ||
        (rotationNumber >= 451 && rotationNumber <= 499)
      ) {
        return "NFL";
      }
      if (rotationNumber >= 101 && rotationNumber <= 230) {
        return "College";
      }
      if (rotationNumber >= 301 && rotationNumber <= 450) {
        return "College";
      }
    }
    return "Football";
  }
  if (s === "BASKETBALL") {
    if (rotationNumber !== null) {
      if (rotationNumber >= 501 && rotationNumber <= 599) return "NBA";
      if (rotationNumber >= 601 && rotationNumber <= 899) return "NCAA";
      if (rotationNumber >= 1000) return "NBAPlayerPro";
    }
    return "Basketball";
  }
  if (s === "SOCCER") return "Soccer";
  if (s === "BASEBALL") return "MLB";
  return sport.trim() || "UNKNOWN";
}

export function periodNumberFromLabel(label: string): number | null {
  const norm = label.trim().toLowerCase();
  if (norm === "game") return 0;
  if (norm === "1st half" || norm === "1st 5 innings") return 1;
  if (norm === "2nd half") return 2;
  if (norm === "1st quarter" || norm === "1st period") return 3;
  if (norm === "2nd quarter" || norm === "2nd period") return 4;
  if (norm === "3rd quarter" || norm === "3rd period") return 5;
  if (norm === "4th quarter") return 6;
  return null;
}

/**
 * Parse a `Bet :` description string such as:
 * - `"Football #263 Eagles 6 -120 - buying &#189; For Game"`
 * - `"Hockey #88 Senators/Ducks U 6&#189; +120 - For Game"`
 * - `"Hockey #83 Utah Mammoth -1&#189; +145 - For Game"`
 * - `"Hockey #83 Utah Mammoth -170 - For Game"`
 * - `"Football #240 Lions -3 -110 - For 2nd Half"`
 */
export function parseWeblogBetLeg(rawBetText: string): ParsedWeblogBetLeg {
  const normalizedText = decodeHtmlFractionEntities(rawBetText);
  const periodMatch = /\s-\s(?:buying\s+([0-9½¼¾.]+)\s+)?For\s+(.+)$/i.exec(
    normalizedText,
  );
  const boughtPoints =
    periodMatch?.[1] !== undefined
      ? (parseFractionNumber(periodMatch[1]) ?? 0)
      : 0;
  const periodLabel = (periodMatch?.[2] ?? "Game").trim();
  const periodNumber = periodNumberFromLabel(periodLabel);

  const head =
    periodMatch !== null
      ? normalizedText.slice(0, periodMatch.index).trim()
      : normalizedText;

  const sportRotMatch = /^([A-Za-z]+)\s+#(\d+)\s+(.+)$/.exec(head);
  const sport = sportRotMatch?.[1] ?? "UNKNOWN";
  const rotationNumber =
    sportRotMatch?.[2] !== undefined ? Number(sportRotMatch[2]) : null;
  const remainder = (sportRotMatch?.[3] ?? head).trim();

  // Extract trailing American odds (`-110`, `+145`, `100`)
  const oddsMatch = /\s([+-]\d{3,4}|\b100)\s*$/.exec(remainder);
  const juiceOdds = oddsMatch?.[1] !== undefined ? Number(oddsMatch[1]) : null;
  const beforeOdds =
    oddsMatch !== null ? remainder.slice(0, oddsMatch.index).trim() : remainder;

  let marketType: WeblogBetMarketType = "UNKNOWN";
  let linePoints: number | null = null;
  let selectionText = beforeOdds;

  // Check Total Over/Under: `<Team1>/<Team2> O 26½` or `<Team> U 6½`
  const totalMatch = /^(.+?)\s+([OU])\s+([0-9½¼¾.]+)$/i.exec(beforeOdds);
  if (totalMatch !== null) {
    selectionText = `${totalMatch[1]!.trim()} ${totalMatch[2]!.toUpperCase()}`;
    const ou = totalMatch[2]!.toUpperCase();
    marketType = beforeOdds.includes("/")
      ? ou === "O"
        ? "TOTAL_OVER"
        : "TOTAL_UNDER"
      : "TEAM_TOTAL_OR_PROP";
    linePoints = parseFractionNumber(totalMatch[3]!);
  } else {
    // Check Spread / Puckline (`Eagles 6`, `Lions -3`, `Raiders +½`, `Utah Mammoth -1½`, `Chiefs PK`)
    const spreadMatch = /^(.+?)\s+([+-]?[0-9½¼¾.]+|PK)$/i.exec(beforeOdds);
    if (spreadMatch !== null) {
      selectionText = spreadMatch[1]!.trim();
      linePoints = parseFractionNumber(spreadMatch[2]!);
      if (
        sport.toUpperCase() === "HOCKEY" &&
        linePoints !== null &&
        Math.abs(linePoints) === 1.5
      ) {
        marketType = "PUCKLINE_OR_RUNLINE";
      } else {
        marketType = "SPREAD";
      }
    } else {
      marketType = "MONEYLINE";
      linePoints = null;
    }
  }

  return {
    rawText: rawBetText.trim(),
    normalizedText,
    sport,
    rotationNumber,
    inferredSubSport: inferSubSportFromRotation(sport, rotationNumber),
    selectionText,
    marketType,
    linePoints,
    juiceOdds,
    boughtPoints,
    periodLabel,
    periodNumber,
  };
}

function to24hTime(timeStr: string, defaultDateYmd: string): string {
  const trimmed = timeStr.trim();
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/.test(trimmed)) {
    return trimmed.length === 19 ? `${trimmed}.000` : trimmed;
  }
  const m = TIME_12H_RE.exec(trimmed);
  if (m === null) return `${defaultDateYmd} 00:00:00.000`;
  let hour = Number(m[1]);
  const min = m[2]!;
  const sec = m[3]!;
  const ampm = m[4]!.toUpperCase();
  if (ampm === "PM" && hour < 12) hour += 12;
  if (ampm === "AM" && hour === 12) hour = 0;
  return `${defaultDateYmd} ${String(hour).padStart(2, "0")}:${min}:${sec}.000`;
}

/**
 * Parse a copy-pasted portal Customer WebLog TSV table (`Time(EST)\tIP Address\tAction`),
 * stitch continuation lines (such as `API LOG | Bet :\nFootball #263 ...`), and return normalized
 * `RawWeblogInputRow` entries sorted chronologically (`accessMs` ascending).
 */
export function parsePastedWeblogTable(
  rawText: string,
  options?: {
    readonly dateYmd?: string;
    readonly loginId?: string;
  },
): RawWeblogInputRow[] {
  const dateYmd = options?.dateYmd ?? "2026-11-01";
  const defaultLoginId = options?.loginId ?? "";
  const lines = rawText.split(/\r\n|\r|\n/);

  const rawEntries: {
    readonly timeCol: string;
    readonly ipCol: string;
    operationCol: string;
  }[] = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed === "") continue;
    if (/^time\s*\(/i.test(trimmed) && /ip\s*address/i.test(trimmed)) {
      continue;
    }
    const rowMatch = TSV_ROW_RE.exec(rawLine);
    if (rowMatch !== null) {
      rawEntries.push({
        timeCol: rowMatch[1]!.trim(),
        ipCol: rowMatch[2]!.trim(),
        operationCol: rowMatch[3]!.trim(),
      });
    } else if (rawEntries.length > 0) {
      // Continuation line of a multi-line `API LOG | Bet :\nFootball #263 ...`
      const prev = rawEntries[rawEntries.length - 1]!;
      prev.operationCol = `${prev.operationCol} ${trimmed}`.trim();
    }
  }

  // Portal displays newest-first; if timestamps are descending, reverse before assigning sequence offsets
  const rows: RawWeblogInputRow[] = rawEntries.map((entry) => {
    const accessDateTime = to24hTime(entry.timeCol, dateYmd);
    const accessMs = parseAccessMs(accessDateTime);
    const ip = entry.ipCol;
    const opMeta = parseOperation(entry.operationCol);
    return {
      accessDateTime,
      accessMs,
      loginId: defaultLoginId,
      ip,
      ip32: ipToUint32(ip),
      ipv4Subnet24: ipv4Subnet24(ip),
      ipClass: classifyWeblogIpExtended(ip),
      operation: entry.operationCol,
      ...opMeta,
    };
  });

  // Sort chronologically (oldest first) while preserving relative order at identical timestamps
  return rows
    .map((r, idx) => ({ r, idx }))
    .sort((a, b) => a.r.accessMs - b.r.accessMs || b.idx - a.idx)
    .map((x) => x.r);
}

/**
 * Convert JSON/JSONL `getWebLog` rows (`{ AccessDateTime, LoginID, IPAddress, Operation }`)
 * into `RawWeblogInputRow[]` sorted chronologically.
 */
export function normalizeJsonWeblogRows(
  jsonRows: readonly Record<string, unknown>[],
): RawWeblogInputRow[] {
  const out: RawWeblogInputRow[] = [];
  for (const raw of jsonRows) {
    const accessDateTime = String(raw.AccessDateTime ?? "").trim();
    const accessMs = parseAccessMs(accessDateTime);
    if (!Number.isFinite(accessMs)) continue;
    const loginId = String(raw.LoginID ?? "").trim();
    const ip = String(raw.IPAddress ?? "").trim();
    const operation = String(raw.Operation ?? "").trim();
    const opMeta = parseOperation(operation);
    out.push({
      accessDateTime,
      accessMs,
      loginId,
      ip,
      ip32: ipToUint32(ip),
      ipv4Subnet24: ipv4Subnet24(ip),
      ipClass: classifyWeblogIpExtended(ip),
      operation,
      ...opMeta,
    });
  }
  return out.sort((a, b) => a.accessMs - b.accessMs);
}

function isNormalizedAnalysisRow(
  row: ReportPlayerAnalysisRowRaw | NormalizedReportPlayerAnalysisRow,
): row is NormalizedReportPlayerAnalysisRow {
  return (
    typeof (row as NormalizedReportPlayerAnalysisRow).customerId === "string" &&
    ((row as NormalizedReportPlayerAnalysisRow).mode === "detail" ||
      (row as NormalizedReportPlayerAnalysisRow).mode === "summary")
  );
}

/**
 * Build a comprehensive WebLog + IP + Bet/Sport/SubSport + `BOT BLOCK LINE ST` pattern report,
 * optionally joining against `getReportPlayerAnalysis` detail rows (`reportType: 2`).
 */
export function analyzeWeblogPatterns(
  events: readonly RawWeblogInputRow[],
  options?: {
    readonly analysisDetailRows?: readonly (
      ReportPlayerAnalysisRowRaw | NormalizedReportPlayerAnalysisRow
    )[];
    readonly postBlockRetryWindowSec?: number;
  },
): WeblogPatternReport {
  const retryWindowSec = options?.postBlockRetryWindowSec ?? 60;
  const sorted = [...events].sort((a, b) => a.accessMs - b.accessMs);

  const normalizedAnalysis: NormalizedReportPlayerAnalysisRow[] = (
    options?.analysisDetailRows ?? []
  ).map((row) =>
    isNormalizedAnalysisRow(row) ? row : normalizeReportPlayerAnalysisRow(row),
  );

  // Track latest login and UI metadata per IP
  const lastLoginMsByIp = new Map<string, number>();
  const lastDeviceByIp = new Map<string, "M" | "D" | "UNKNOWN">();
  const lastSkinByIp = new Map<string, string>();
  const lastVersionByIp = new Map<string, string>();

  // Group Ticket and Bet rows within 2 seconds on the same IP
  interface PendingTicket {
    readonly accessDateTime: string;
    readonly accessMs: number;
    readonly ip: string;
    readonly loginId: string;
    readonly ticketNumber: string;
    readonly riskCents: number;
    readonly toWinCents: number;
    used: boolean;
  }
  interface PendingBet {
    readonly accessDateTime: string;
    readonly accessMs: number;
    readonly ip: string;
    readonly loginId: string;
    readonly bet: ParsedWeblogBetLeg;
    readonly deviceClass: "M" | "D" | "UNKNOWN";
    readonly skinDomain: string | null;
    readonly clientVersion: string | null;
    readonly loginToBetLatencySec: number | null;
  }

  const tickets: PendingTicket[] = [];
  const bets: PendingBet[] = [];
  const rawBlocks: {
    readonly row: RawWeblogInputRow;
    readonly blockType: string;
    readonly rawKey: string;
    readonly blockingCustomerId: string;
  }[] = [];

  let loginCount = 0;

  for (const row of sorted) {
    if (row.deviceClass !== "UNKNOWN") {
      lastDeviceByIp.set(row.ip, row.deviceClass);
    }
    if (row.skinDomain !== null) {
      lastSkinByIp.set(row.ip, row.skinDomain);
    }
    if (row.clientVersion !== null) {
      lastVersionByIp.set(row.ip, row.clientVersion);
    }
    if (
      row.actionKind === "LOGIN" ||
      row.actionKind === "UI:login_successful"
    ) {
      lastLoginMsByIp.set(row.ip, row.accessMs);
      if (row.actionKind === "UI:login_successful") {
        loginCount++;
      }
    }

    const ticketMatch = TICKET_LOG_RE.exec(row.operation);
    if (ticketMatch !== null) {
      tickets.push({
        accessDateTime: row.accessDateTime,
        accessMs: row.accessMs,
        ip: row.ip,
        loginId: row.loginId,
        ticketNumber: ticketMatch[1]!,
        riskCents: Number(ticketMatch[2]),
        toWinCents: Number(ticketMatch[3]),
        used: false,
      });
      continue;
    }

    const betMatch = BET_LOG_PREFIX_RE.exec(row.operation);
    if (betMatch !== null) {
      const loginMs = lastLoginMsByIp.get(row.ip);
      const latencySec =
        loginMs !== undefined && row.accessMs >= loginMs
          ? Math.round((row.accessMs - loginMs) / 1000)
          : null;
      bets.push({
        accessDateTime: row.accessDateTime,
        accessMs: row.accessMs,
        ip: row.ip,
        loginId: row.loginId,
        bet: parseWeblogBetLeg(betMatch[1]!),
        deviceClass: lastDeviceByIp.get(row.ip) ?? row.deviceClass,
        skinDomain: lastSkinByIp.get(row.ip) ?? row.skinDomain,
        clientVersion: lastVersionByIp.get(row.ip) ?? row.clientVersion,
        loginToBetLatencySec: latencySec,
      });
      continue;
    }

    const blockMatch = BOT_BLOCK_RE.exec(row.operation);
    if (blockMatch !== null) {
      const blockType = blockMatch[1]!.trim();
      let entries: Array<{ key?: string; val?: string }> = [];
      try {
        entries = JSON.parse(blockMatch[2]!) as Array<{
          key?: string;
          val?: string;
        }>;
      } catch {
        entries = [{ key: blockMatch[2]!, val: "" }];
      }
      for (const entry of entries) {
        rawBlocks.push({
          row,
          blockType,
          rawKey: String(entry.key ?? ""),
          blockingCustomerId: String(entry.val ?? "").trim(),
        });
      }
    }
  }

  // Pair each Bet with its matching Ticket at the same timestamp (within 2000ms on same IP)
  const usedAnalysisIndices = new Set<number>();
  const attributionVotes = new Map<string, number>();

  const pairedWagers: PairedWeblogWager[] = bets.map((b) => {
    let matchedTicket = tickets.find(
      (t) =>
        !t.used && t.ip === b.ip && Math.abs(t.accessMs - b.accessMs) <= 2_000,
    );
    if (matchedTicket !== undefined) {
      matchedTicket.used = true;
    }

    // Match against `getReportPlayerAnalysis` detail rows by timestamp (within 5s) + rotation number + risk
    let matchedAnalysis: NormalizedReportPlayerAnalysisRow | null = null;
    for (let i = 0; i < normalizedAnalysis.length; i++) {
      if (usedAnalysisIndices.has(i)) continue;
      const cand = normalizedAnalysis[i]!;
      const candMs = parseAccessMs(cand.postedDateTime);
      const timeDiff = Math.abs(candMs - b.accessMs);
      const rotStr =
        b.bet.rotationNumber !== null ? `#${b.bet.rotationNumber}` : null;
      const rotMatches =
        rotStr !== null ? cand.description.includes(rotStr) : true;
      const riskMatches =
        matchedTicket !== undefined
          ? cand.riskCents === matchedTicket.riskCents &&
            cand.toWinCents === matchedTicket.toWinCents
          : true;
      if (timeDiff <= 5_000 && rotMatches && riskMatches) {
        matchedAnalysis = cand;
        usedAnalysisIndices.add(i);
        attributionVotes.set(
          cand.customerId,
          (attributionVotes.get(cand.customerId) ?? 0) + 1,
        );
        break;
      }
    }

    const resolvedSubSport =
      matchedAnalysis?.sportSubType.trim() || b.bet.inferredSubSport;

    return {
      accessDateTime: b.accessDateTime,
      accessMs: b.accessMs,
      ip: b.ip,
      ipv4Subnet24: ipv4Subnet24(b.ip),
      ipClass: classifyWeblogIpExtended(b.ip),
      deviceClass: b.deviceClass,
      skinDomain: b.skinDomain,
      clientVersion: b.clientVersion,
      loginId: b.loginId || matchedAnalysis?.customerId || "",
      ticketNumber: matchedTicket?.ticketNumber ?? null,
      riskCents: matchedTicket?.riskCents ?? null,
      toWinCents: matchedTicket?.toWinCents ?? null,
      bet: b.bet,
      loginToBetLatencySec: b.loginToBetLatencySec,
      matchedAnalysisRow: matchedAnalysis,
      resolvedSubSport,
    };
  });

  // Determine top attributed CustomerID
  let attributedCustomerId: string | null = null;
  let attributionMatchCount = 0;
  for (const [cid, count] of attributionVotes.entries()) {
    if (count > attributionMatchCount) {
      attributedCustomerId = cid;
      attributionMatchCount = count;
    }
  }
  if (attributedCustomerId === null) {
    const firstNonEmpty = sorted.find((r) => r.loginId !== "")?.loginId ?? null;
    attributedCustomerId = firstNonEmpty;
  }

  // Build BotBlock events with post-block retry detection
  const botBlocks: ParsedBotBlockEvent[] = rawBlocks.map((rb) => {
    const keyMatch = BOT_KEY_RE.exec(rb.rawKey);
    const gameId = keyMatch?.[1] ?? null;
    const periodNumber =
      keyMatch?.[2] !== undefined ? Number(keyMatch[2]) : null;
    const wagerType = keyMatch?.[3] ?? null;
    const slotIndex = keyMatch?.[4] !== undefined ? Number(keyMatch[4]) : null;

    const retryWager = pairedWagers.find(
      (w) =>
        w.ip === rb.row.ip &&
        w.accessMs >= rb.row.accessMs &&
        w.accessMs - rb.row.accessMs <= retryWindowSec * 1_000,
    );

    const ownerId = rb.row.loginId || attributedCustomerId;
    const isSelfCollision =
      ownerId !== null && ownerId !== ""
        ? ownerId.toUpperCase() === rb.blockingCustomerId.toUpperCase()
        : null;

    return {
      accessDateTime: rb.row.accessDateTime,
      accessMs: rb.row.accessMs,
      ip: rb.row.ip,
      ipv4Subnet24: rb.row.ipv4Subnet24,
      loginId: ownerId ?? "",
      blockType: rb.blockType,
      rawKey: rb.rawKey,
      gameId,
      periodNumber,
      wagerType,
      slotIndex,
      blockingCustomerId: rb.blockingCustomerId,
      isSelfCollision,
      postBlockRetryWager:
        retryWager !== undefined
          ? {
              delaySec: Math.round(
                (retryWager.accessMs - rb.row.accessMs) / 1_000,
              ),
              ticketNumber: retryWager.ticketNumber,
              description: retryWager.bet.normalizedText,
              riskCents: retryWager.riskCents,
              toWinCents: retryWager.toWinCents,
            }
          : null,
    };
  });

  // Roll up by IP
  const ipGroups = new Map<string, RawWeblogInputRow[]>();
  for (const row of sorted) {
    const list = ipGroups.get(row.ip) ?? [];
    list.push(row);
    ipGroups.set(row.ip, list);
  }

  const byIp: IpPatternSummary[] = [...ipGroups.entries()].map(
    ([ip, ipEvents]) => {
      const ipWagers = pairedWagers.filter((w) => w.ip === ip);
      const ipBlocks = botBlocks.filter((b) => b.ip === ip);
      const deviceClasses: Record<string, number> = {};
      let ipLogins = 0;
      for (const e of ipEvents) {
        if (e.deviceClass !== "UNKNOWN") {
          deviceClasses[e.deviceClass] =
            (deviceClasses[e.deviceClass] ?? 0) + 1;
        }
        if (e.actionKind === "UI:login_successful") ipLogins++;
      }
      const sports: Record<string, number> = {};
      const subSports: Record<string, number> = {};
      const periods: Record<string, number> = {};
      const marketTypes: Record<string, number> = {};
      let totalRiskCents = 0;
      let totalToWinCents = 0;
      let boughtPointsWagerCount = 0;
      const latencies: number[] = [];

      for (const w of ipWagers) {
        sports[w.bet.sport] = (sports[w.bet.sport] ?? 0) + 1;
        subSports[w.resolvedSubSport] =
          (subSports[w.resolvedSubSport] ?? 0) + 1;
        periods[w.bet.periodLabel] = (periods[w.bet.periodLabel] ?? 0) + 1;
        marketTypes[w.bet.marketType] =
          (marketTypes[w.bet.marketType] ?? 0) + 1;
        totalRiskCents += w.riskCents ?? 0;
        totalToWinCents += w.toWinCents ?? 0;
        if (w.bet.boughtPoints > 0) boughtPointsWagerCount++;
        if (w.loginToBetLatencySec !== null) {
          latencies.push(w.loginToBetLatencySec);
        }
      }
      latencies.sort((a, b) => a - b);
      const medianLoginToBetSec =
        latencies.length > 0
          ? latencies[Math.floor(latencies.length / 2)]!
          : null;

      return {
        ip,
        ipv4Subnet24: ipv4Subnet24(ip),
        ipClass: classifyWeblogIpExtended(ip),
        firstSeen: ipEvents[0]?.accessDateTime ?? "",
        lastSeen: ipEvents[ipEvents.length - 1]?.accessDateTime ?? "",
        eventCount: ipEvents.length,
        loginCount: ipLogins,
        wagerCount: ipWagers.length,
        botBlockCount: ipBlocks.length,
        totalRiskCents,
        totalToWinCents,
        deviceClasses,
        sports,
        subSports,
        periods,
        marketTypes,
        boughtPointsWagerCount,
        medianLoginToBetSec,
      };
    },
  );

  // Roll up by Sport + SubSport
  const sportSubGroups = new Map<string, PairedWeblogWager[]>();
  for (const w of pairedWagers) {
    const key = `${w.bet.sport}|${w.resolvedSubSport}`;
    const list = sportSubGroups.get(key) ?? [];
    list.push(w);
    sportSubGroups.set(key, list);
  }
  const bySportSubSport: SportSubSportPatternSummary[] = [
    ...sportSubGroups.entries(),
  ]
    .map(([key, list]) => {
      const [sport, subSport] = key.split("|") as [string, string];
      const periods: Record<string, number> = {};
      const marketTypes: Record<string, number> = {};
      const ips = new Set<string>();
      let totalRiskCents = 0;
      let totalToWinCents = 0;
      let boughtPointsWagerCount = 0;
      let beatClosingPointsCount = 0;
      let beatClosingPriceCount = 0;
      let playerNetCents = 0;

      for (const w of list) {
        ips.add(w.ip);
        periods[w.bet.periodLabel] = (periods[w.bet.periodLabel] ?? 0) + 1;
        marketTypes[w.bet.marketType] =
          (marketTypes[w.bet.marketType] ?? 0) + 1;
        totalRiskCents += w.riskCents ?? 0;
        totalToWinCents += w.toWinCents ?? 0;
        if (w.bet.boughtPoints > 0) boughtPointsWagerCount++;
        if (w.matchedAnalysisRow?.beatClosingPoints) beatClosingPointsCount++;
        if (w.matchedAnalysisRow?.beatClosingPrice) beatClosingPriceCount++;
        playerNetCents += w.matchedAnalysisRow?.playerNetCents ?? 0;
      }

      return {
        sport,
        subSport,
        wagerCount: list.length,
        totalRiskCents,
        totalToWinCents,
        ips: [...ips],
        periods,
        marketTypes,
        boughtPointsWagerCount,
        beatClosingPointsCount,
        beatClosingPriceCount,
        playerNetCents,
      };
    })
    .sort((a, b) => b.wagerCount - a.wagerCount);

  // Roll up by Period
  const periodGroups = new Map<string, PairedWeblogWager[]>();
  for (const w of pairedWagers) {
    const list = periodGroups.get(w.bet.periodLabel) ?? [];
    list.push(w);
    periodGroups.set(w.bet.periodLabel, list);
  }
  const byPeriod: PeriodPatternSummary[] = [...periodGroups.entries()]
    .map(([periodLabel, list]) => {
      const ips = new Set<string>();
      const subSports: Record<string, number> = {};
      const marketTypes: Record<string, number> = {};
      let totalRiskCents = 0;
      for (const w of list) {
        ips.add(w.ip);
        subSports[w.resolvedSubSport] =
          (subSports[w.resolvedSubSport] ?? 0) + 1;
        marketTypes[w.bet.marketType] =
          (marketTypes[w.bet.marketType] ?? 0) + 1;
        totalRiskCents += w.riskCents ?? 0;
      }
      return {
        periodLabel,
        periodNumber: list[0]?.bet.periodNumber ?? null,
        wagerCount: list.length,
        totalRiskCents,
        ips: [...ips],
        subSports,
        marketTypes,
      };
    })
    .sort((a, b) => b.wagerCount - a.wagerCount);

  // Detect IP transitions
  const ipTransitions: {
    readonly fromIp: string;
    readonly toIp: string;
    readonly atDateTime: string;
    readonly gapMinutes: number;
    readonly fromDevice: string;
    readonly toDevice: string;
  }[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const curr = sorted[i]!;
    if (prev.ip !== curr.ip) {
      ipTransitions.push({
        fromIp: prev.ip,
        toIp: curr.ip,
        atDateTime: curr.accessDateTime,
        gapMinutes:
          Math.round(((curr.accessMs - prev.accessMs) / 60_000) * 10) / 10,
        fromDevice: lastDeviceByIp.get(prev.ip) ?? prev.deviceClass,
        toDevice: curr.deviceClass,
      });
    }
  }

  // Ticket counts and multi-bet tickets
  const ticketCounts = new Map<string, number>();
  for (const w of pairedWagers) {
    if (w.ticketNumber !== null) {
      ticketCounts.set(
        w.ticketNumber,
        (ticketCounts.get(w.ticketNumber) ?? 0) + 1,
      );
    }
  }
  const multiBetTicketNumbers = [...ticketCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([t]) => t);

  return {
    totalEvents: sorted.length,
    loginCount,
    wagerCount: pairedWagers.length,
    distinctTicketCount: ticketCounts.size,
    multiBetTicketNumbers,
    distinctIpCount: ipGroups.size,
    attributedCustomerId,
    attributionMatchCount,
    wagers: pairedWagers,
    botBlocks,
    byIp,
    bySportSubSport,
    byPeriod,
    ipTransitions,
  };
}
