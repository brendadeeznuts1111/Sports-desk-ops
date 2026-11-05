#!/usr/bin/env bun
/**
 * Inspect one live bet ticket, or list every ticket with its leg count, from the latest
 * getBetTicker capture.
 *
 *   bun run ticket 767125863
 *   bun run ticket b767125863 --json
 *   bun run ticket --list
 *   bun run ticket --list --file tests/fixtures/live-wagers-list-sample.json --json
 *
 * Customer logins, agent logins and customer ids stay out of every view: the ticket number,
 * writer, amounts and legs are enough to identify the wager on the desk.
 */

import { parseArgs } from "node:util";

import { wagerTypeLabel } from "../lib/bet_ticker_labels.ts";
import { normalizeTicket } from "../lib/live_ticket_view.ts";
import { readWagerListArtifact, type LiveWager } from "../lib/live_wagers.ts";
import { parseBetTickerHtml, type HtmlBetTicket } from "./html.ts";
import { wagerStatusLabel } from "./enums.ts";
import {
  assessConfidence,
  CONFIDENCE_ORDER,
  confidenceReason,
  inspectPace,
  parseConfidenceArg,
  type CaptureInfo,
  type Confidence,
} from "./info.ts";

export { toSafeJson } from "../lib/live_ticket_view.ts";
import {
  coverage,
  japaneseFallbackNotice,
  label,
  labelOrKey,
  LANG_CODES,
  languageList,
  loadUiTable,
  parseLangArg,
  t,
  type LangArg,
  type UiTable,
} from "./i18n.ts";

const DEFAULT_FILE = "data/live-wagers.json";

const HELP = `ticket — inspect live bet tickets from the latest getBetTicker capture

Usage: bun run ticket <wagerNumber> [--file <artifact>] [--json]
       bun run ticket --list [--file <artifact>] [--json]
       bun run ticket --analyze [--file <artifact>] [--lang <code|keys>]
       bun run ticket --lang-coverage
       bun run ticket --html-header-map [--from-html <capture>]

  --file <path>       Capture artifact (default: ${DEFAULT_FILE})
  --list              Every ticket with its leg count (safe fields only)
  --analyze           Totals by ticket structure (Straight/Parlay/Teaser/If Bet)
  --capture-info      Print format, status, Pace and confidence diagnostics
  --require-confidence <level>  Exit 1 when confidence is below none|low|medium|high
  --normalized        Canonical public ticket shape; requires --json
  --json              Machine-readable safe view (no customer/agent identifiers)
  --lang <code>       Render labels from the portal's own ui.json: ${languageList()}
  --lang=keys         Raw L-keys instead of labels (e.g. L-1029 Source)
  --lang-coverage     Per-language ui.json coverage (present/missing keys)
  --html-header-map   HTML-capture column L-keys -> English, for reading raw captures
  --from-html <path>  With --html-header-map: extract the L-keys actually in a capture
  --ui-table <path>   Override the extracted ui.json (default: ${"tests/fixtures/ui.json"})
  --currency-scale <n> Multiply JSON amounts (e.g. 0.01 cents -> dollars); HTML ignores it
  -h, --help          This text

Labels come from the same /app/language/ui.json table the Manager app renders, so a
translated label in a screenshot resolves to the same English string here. Sport names are
NOT translated by the app either (Football/Basketball stay English in every language), which
is a client design choice, not a missing translation. JAPANESE prints an English fallback
with a warning: the web app's JAPANESE branch maps to GREEK (an upstream bug) and this CLI
deliberately does not replicate it.

The number may carry the portal's b prefix (b767125863).`;

function usage(message: string): never {
  console.error(`ticket: ${message}`);
  console.error(HELP);
  process.exit(2);
}

function fail(message: string): never {
  console.error(`ticket: ${message}`);
  process.exit(1);
}

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Avoid `1395 * 0.01 = 13.950000000000001` in JSON output. */
function scaleMoney(value: number, scale: number): number {
  return scale === 1 ? value : Number((value * scale).toFixed(6));
}

const LANG_LIST = LANG_CODES;

/**
 * The HTML capture's column headers, as verified against the 2026-11-04 ui.json extraction:
 * Show Bets Over, Vip Only, Configuration, Vip List, Customer, Type, Agent, Description,
 * Risk, Win, Source, Time (ET).
 */
const HTML_HEADER_KEYS = [
  "L-1025",
  "L-1026",
  "L-1027",
  "L-1028",
  "L-213",
  "L-152",
  "L-318",
  "L-207",
  "L-244",
  "L-393",
  "L-1029",
  "L-1030",
] as const;

/**
 * Ticket structure, the HTML "Type" column: Teaser/If-Bet/Reverse keep their wire code, a
 * multi-leg ticket is a Parlay, everything else is Straight. The wire `WagerType` S is a
 * *leg* sub-type (Spread), not a ticket structure, so it is never mapped to "Straight" here.
 */
function ticketStructure(wager: LiveWager): { english: string; key: string } {
  const code = wager.wagerType.trim().toUpperCase();
  const legs = wager.legs.length;
  if (code === "T") return { english: "Teaser", key: "L-85" };
  if (code === "I") return { english: "If Bet", key: "L-86" };
  if (code === "R") return { english: "Reverse", key: "L-87" };
  if (code === "P" || legs > 1) return { english: "Parlay", key: "L-84" };
  return { english: "Straight", key: "L-83" };
}

/** The HTML "Type" column already carries ticket structure; map only the known L-keys. */
function htmlStructure(ticket: HtmlBetTicket): {
  english: string;
  key: string;
} {
  const english = ticket.ticketStructure;
  const key =
    english === "Straight"
      ? "L-83"
      : english === "Parlay"
        ? "L-84"
        : english === "Teaser"
          ? "L-85"
          : english === "If Bet"
            ? "L-86"
            : english === "Reverse"
              ? "L-87"
              : "";
  return { english, key };
}

/** Structure label in the requested language; `keys` shows the L-key. */
function structureLabel(
  structure: { english: string; key: string },
  lang: LangArg,
  table: UiTable | undefined,
): string {
  if (lang === "ENGLISH") return structure.english;
  if (lang === "keys")
    return structure.key === "" ? structure.english : structure.key;
  const translated = t(structure.key, lang, table);
  return translated === structure.key ? structure.english : translated;
}

/** The only shape either view emits; identifiers from the wire are deliberately absent. */
function safeWagerView(wager: LiveWager, scale = 1) {
  return {
    wagerNumber: wager.wagerNumber,
    ticketWriter: wager.ticketWriter.trim(),
    writer: wager.writer,
    wagerType: wager.wagerType,
    wagerTypeLabel: wagerTypeLabel(wager.wagerType),
    live: wager.live,
    vip: wager.vip,
    amountWagered: scaleMoney(wager.amountWagered, scale),
    toWinAmount: scaleMoney(wager.toWinAmount, scale),
    volumeAmount: scaleMoney(wager.volumeAmount, scale),
    volumeDiffers: wager.volumeDiffers,
    insertedAt: wager.insertedAt,
    descCode: wager.descCode,
    wagerStatus: {
      code:
        wager.wagerStatus === undefined || wager.wagerStatus === ""
          ? null
          : wager.wagerStatus,
      label: wagerStatusLabel(wager.wagerStatus ?? null),
    },
    legs: wager.legs.map((leg) => ({
      sport: leg.sport,
      game: leg.game,
      period: leg.period,
      market: leg.market,
      pick: leg.pick,
      live: leg.live,
      gameNumber: leg.gameNumber,
      compact: leg.compact,
      raw: leg.raw,
    })),
  };
}

function normalizedView(
  wager: LiveWager,
  meta: { file: string; source: string; capturedAt: string | null },
  scale = 1,
) {
  const view = normalizeTicket(wager, meta);
  if (scale === 1) return view;
  return {
    ...view,
    stake: scaleMoney(view.stake, scale),
    toWin: scaleMoney(view.toWin, scale),
    volume: view.volume === null ? null : scaleMoney(view.volume, scale),
  };
}

function enforceConfidence(
  info: CaptureInfo,
  required: Confidence | undefined,
  file: string,
): void {
  if (required === undefined) return;
  const level = assessConfidence(info);
  if (CONFIDENCE_ORDER[level] < CONFIDENCE_ORDER[required]) {
    console.error(
      `capture confidence ${level} is below required ${required}\n` +
        `  reason: ${confidenceReason(info)}\n` +
        `  file:   ${file}`,
    );
    process.exit(1);
  }
}

function printCaptureInfo(file: string, info: CaptureInfo, rows: number): void {
  const level = assessConfidence(info);
  const lines = [`Capture: ${file}`, `Format: ${info.format}`, `Rows: ${rows}`];
  if (info.format === "json") {
    lines.push(
      `Status: ${
        info.statusOk === true
          ? "1 (OK)"
          : info.statusOk === false
            ? "not 1"
            : "(not present)"
      }`,
    );
    lines.push(`Amounts: ${info.hasAmounts ? "present" : "none"}`);
  } else {
    lines.push("Status: (not present — HTML capture)");
    lines.push("Amounts: none (HTML display scale)");
  }
  if (info.pace !== undefined) {
    lines.push(
      `Pace: ${info.pace.elementCount} .pace elements, ${info.pace.activeCount} active at ${
        info.pace.activeProgress ?? "?"
      }%, ${info.pace.runningTokens}× pace-running, ${info.pace.doneTokens}× pace-done`,
    );
    lines.push(`  version: ${info.pace.version}`);
    if (info.pace.version === "0.4.x") {
      lines.push(
        "  note: this Pace version tracks AJAX only — restarts are pure ajaxComplete + pushState/replaceState",
      );
    } else if (info.pace.version === "1.x") {
      lines.push(
        "  note: this Pace version also restarts on WebSocket activity — restarts may mix AJAX and WS",
      );
    }
    lines.push(`  cause: ${info.pace.cause}`);
  } else {
    lines.push("Pace: (not applicable — JSON capture)");
  }
  lines.push("", `Confidence: ${level}`, `  reason: ${confidenceReason(info)}`);
  if (info.pace?.verdict === "mid-load") {
    const versionNote =
      info.pace.version === "0.4.x"
        ? "; this Pace version tracks AJAX only — restarts are pure ajaxComplete + pushState/replaceState"
        : info.pace.version === "1.x"
          ? "; this Pace version also restarts on WebSocket activity — restarts may mix AJAX and WS"
          : "";
    lines.push(
      `⚠ capture was taken mid-load: .pace-active at ${info.pace.activeProgress}% (Pace ${info.pace.version}, ${info.pace.runningTokens} accumulated restarts${versionNote}) — rows may be incomplete`,
    );
  }
  console.log(lines.join("\n"));
}

function sourceLine(
  provenance: {
    readonly source: string;
    readonly observedAt: string | null;
  },
  lang: LangArg,
  table: UiTable | undefined,
): string {
  const labelText =
    lang === "ENGLISH" ? "Source" : label("Source", lang, table);
  return `${labelText}: ${provenance.source}${
    provenance.observedAt === null ? "" : ` · observed ${provenance.observedAt}`
  }`;
}

let values: {
  readonly file?: string;
  readonly json?: boolean;
  readonly list?: boolean;
  readonly normalized?: boolean;
  readonly analyze?: boolean;
  readonly lang?: string;
  readonly langCoverage?: boolean;
  readonly htmlHeaderMap?: boolean;
  readonly fromHtml?: string | undefined;
  readonly uiTable?: string | undefined;
  readonly currencyScale?: string | undefined;
  readonly captureInfo?: boolean;
  readonly requireConfidence?: string | undefined;
  readonly help?: boolean;
};
let positionals: string[];
try {
  const parsed = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      file: { type: "string", default: DEFAULT_FILE },
      json: { type: "boolean", default: false },
      list: { type: "boolean", default: false },
      normalized: { type: "boolean", default: false },
      analyze: { type: "boolean", default: false },
      lang: { type: "string", default: "ENGLISH" },
      "lang-coverage": { type: "boolean", default: false },
      "html-header-map": { type: "boolean", default: false },
      "from-html": { type: "string" },
      "ui-table": { type: "string" },
      "currency-scale": { type: "string" },
      "capture-info": { type: "boolean", default: false },
      "require-confidence": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  values = {
    file: parsed.values.file,
    json: parsed.values.json,
    list: parsed.values.list,
    normalized: parsed.values.normalized,
    analyze: parsed.values.analyze,
    lang: parsed.values.lang,
    langCoverage: parsed.values["lang-coverage"],
    htmlHeaderMap: parsed.values["html-header-map"],
    fromHtml: parsed.values["from-html"],
    uiTable: parsed.values["ui-table"],
    currencyScale: parsed.values["currency-scale"],
    captureInfo: parsed.values["capture-info"],
    requireConfidence: parsed.values["require-confidence"],
    help: parsed.values.help,
  };
  positionals = parsed.positionals;
} catch (error) {
  usage(error instanceof Error ? error.message : String(error));
}

if (values.help === true) {
  console.log(HELP);
  process.exit(0);
}
if (values.normalized === true && values.json !== true) {
  usage("--normalized requires --json");
}

/*
 * i18n wiring. The table is the same one the Manager app renders from; `--ui-table` points at
 * a newer extraction, and every label below resolves through the shared fallback chain.
 */
const langArg: LangArg =
  parseLangArg(values.lang ?? "ENGLISH") ??
  usage(
    `unknown --lang ${JSON.stringify(values.lang)}; expected ${languageList()} or keys`,
  );
const japaneseNotice = japaneseFallbackNotice(langArg);
if (japaneseNotice !== null) console.error(japaneseNotice);
let uiTable: UiTable | undefined;
if (values.uiTable !== undefined) {
  try {
    uiTable = loadUiTable(values.uiTable);
  } catch (error) {
    fail(
      `cannot read --ui-table ${values.uiTable}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
/** Localize one canonical label; the literal is preserved for ENGLISH. */
const L = (english: string): string => label(english, langArg, uiTable);

const currencyScale =
  values.currencyScale === undefined ? 1 : Number(values.currencyScale);
if (!Number.isFinite(currencyScale) || currencyScale <= 0) {
  usage("--currency-scale must be a positive number");
}

let requiredConfidence: Confidence | undefined;
if (values.requireConfidence !== undefined) {
  const parsed = parseConfidenceArg(values.requireConfidence);
  if (parsed === null) {
    usage("--require-confidence: one of none|low|medium|high");
  }
  requiredConfidence = parsed;
}

const LANG_COVERAGE_SAMPLE = 5;

if (values.langCoverage === true) {
  let table: UiTable;
  try {
    table = uiTable ?? loadUiTable();
  } catch (error) {
    fail(
      `cannot read the ui table: ${error instanceof Error ? error.message : String(error)}; pass --ui-table <path>`,
    );
  }
  const result = coverage(table);
  const rows = LANG_LIST.map((lang) => ({
    Language: lang,
    Present: result.byLang[lang].present,
    Missing: result.byLang[lang].missing,
    "Sample missing": result.byLang[lang].missingKeys
      .slice(0, LANG_COVERAGE_SAMPLE)
      .join(", "),
  }));
  console.log(
    [
      `UI language coverage · ${result.totalKeys.toLocaleString("en-US")} keys`,
      "",
      Bun.inspect.table(rows, { colors: false }).trimEnd(),
      result.unknownLanguageTags.length === 0
        ? ""
        : `note: unknown language tag(s) present in ui.json: ${result.unknownLanguageTags.join(", ")}`,
    ]
      .filter((line) => line !== "")
      .join("\n"),
  );
  process.exit(0);
}

if (values.htmlHeaderMap === true) {
  let keys: readonly string[];
  if (values.fromHtml !== undefined) {
    let html: string;
    try {
      html = await Bun.file(values.fromHtml).text();
    } catch (error) {
      fail(
        `cannot read --from-html ${values.fromHtml}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const found: string[] = [];
    for (const match of html.matchAll(/data-language="(L-[0-9]+)"/g)) {
      const key = match[1];
      if (key !== undefined && !found.includes(key)) found.push(key);
    }
    if (found.length === 0) {
      fail(
        `${values.fromHtml}: no data-language="L-..." attributes found; is this a Manager capture?`,
      );
    }
    keys = found;
  } else {
    keys = HTML_HEADER_KEYS;
  }
  for (const key of keys) {
    console.log(`${key}  ${labelOrKey(key, "ENGLISH", uiTable)}`);
  }
  process.exit(0);
}

const analyze = values.analyze === true;
const listing = values.list === true;
const captureInfo = values.captureInfo === true;
if (analyze && listing) usage("--analyze and --list are mutually exclusive");
if ((analyze || captureInfo) && positionals.length !== 0) {
  usage(
    captureInfo
      ? "--capture-info takes no wager number"
      : "--analyze takes no wager number",
  );
}

let target: number | null = null;
if (!analyze && !captureInfo) {
  if (listing) {
    if (positionals.length !== 0) usage("--list takes no wager number");
  } else {
    if (positionals.length !== 1) usage("expected exactly one wager number");
    const rawWager = positionals[0]!.trim();
    const parsed = Number(rawWager.replace(/^b/i, ""));
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      usage(`invalid wager number ${JSON.stringify(rawWager)}`);
    }
    target = parsed;
  }
}

const file = values.file ?? DEFAULT_FILE;
const handle = Bun.file(file);
if (!(await handle.exists())) {
  fail(`${file} not found; run bun run capture:bet-ticker or pass --file`);
}

const text = await handle.text();
if (text.trimStart().startsWith("<")) {
  const tickets = parseBetTickerHtml(text);
  const provenance = { source: "html-capture", observedAt: null };
  const info: CaptureInfo = {
    format: "html",
    statusOk: null,
    hasAmounts: false,
    pace: inspectPace(text),
  };
  if (values.captureInfo === true) {
    printCaptureInfo(file, info, tickets.length);
    process.exit(0);
  }
  enforceConfidence(info, requiredConfidence, file);

  if (analyze) {
    const groups = new Map<
      string,
      { english: string; key: string; tickets: number; legs: number }
    >();
    for (const ticket of tickets) {
      const structure = htmlStructure(ticket);
      const groupKey = structure.key === "" ? structure.english : structure.key;
      const entry = groups.get(groupKey) ?? {
        ...structure,
        tickets: 0,
        legs: 0,
      };
      entry.tickets += 1;
      entry.legs += ticket.legs.length;
      groups.set(groupKey, entry);
    }
    const rows = [...groups.values()]
      .sort(
        (a, b) => b.tickets - a.tickets || a.english.localeCompare(b.english),
      )
      .map((entry) => ({
        Type:
          langArg === "keys"
            ? entry.key === ""
              ? entry.english
              : `${entry.key} ${entry.english}`
            : structureLabel(entry, langArg, uiTable),
        Tickets: entry.tickets,
        Legs: entry.legs,
      }));
    const legs = tickets.reduce((sum, ticket) => sum + ticket.legs.length, 0);
    console.log(
      [
        `Ticket structures · ${tickets.length} tickets · ${legs} legs`,
        "",
        Bun.inspect.table(rows, { colors: false }).trimEnd(),
        sourceLine(provenance, langArg, uiTable),
      ].join("\n"),
    );
    process.exit(0);
  }

  if (listing) {
    const legs = tickets.reduce((sum, ticket) => sum + ticket.legs.length, 0);
    if (values.json === true) {
      console.log(
        JSON.stringify(
          {
            tickets,
            totals: { tickets: tickets.length, legs },
            provenance,
          },
          null,
          2,
        ),
      );
      process.exit(0);
    }
    const rows =
      langArg === "ENGLISH" || langArg === "JAPANESE"
        ? tickets.map((ticket) => ({
            ticket: ticket.wagerNumber,
            type: ticket.ticketStructure,
            live: ticket.live,
            legs: ticket.legs.length,
            stake: ticket.stake,
          }))
        : tickets.map((ticket) => {
            const row: Record<string, unknown> = {};
            row[L("Ticket")] = ticket.wagerNumber;
            row[L("Type")] = ticket.ticketStructure;
            row[L("Live")] = ticket.live;
            row["Legs"] = ticket.legs.length;
            row["Stake"] = ticket.stake;
            return row;
          });
    console.log(
      [
        Bun.inspect.table(rows, { colors: false }).trimEnd(),
        `${tickets.length} tickets · ${legs} legs`,
        sourceLine(provenance, langArg, uiTable),
      ].join("\n"),
    );
    process.exit(0);
  }

  if (target === null) fail("internal: missing wager number");
  const ticket = tickets.find(
    (candidate) => candidate.wagerNumber === String(target),
  );
  if (ticket === undefined) {
    fail(`wager ${target} not found in ${file}`);
  }
  if (values.json === true) {
    console.log(JSON.stringify(ticket, null, 2));
    process.exit(0);
  }
  const typeLabel =
    langArg === "ENGLISH" || langArg === "JAPANESE"
      ? ticket.ticketStructure
      : label(ticket.ticketStructure, langArg, uiTable);
  const lines = [
    `${L("Ticket")} ${ticket.wagerNumber} · ${ticket.source} · ${typeLabel} · ${ticket.live ? L("Live") : "Pregame"}`,
    `${L("Stake")} — · ${L("To Win")} —`,
    ticket.legs.length === 0 ? "Legs: —" : "Legs:",
    ...ticket.legs.map((leg, index) => {
      const parts = [
        leg.sport,
        leg.eventName,
        leg.period,
        leg.market,
        `${leg.selection}${leg.price === null ? "" : ` ${leg.price}`}`,
      ]
        .map((part) => part.trim())
        .filter((part) => part !== "");
      return `  ${index + 1}. ${parts.join(" · ")}${leg.live ? " · LIVE" : ""}`;
    }),
    `${L("Source")}: ${ticket.source}`,
  ];
  console.log(lines.join("\n"));
  process.exit(0);
}

let payload: unknown;
try {
  payload = JSON.parse(text);
} catch (error) {
  fail(
    `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
  );
}

const artifact = readWagerListArtifact(payload);
const meta = {
  file,
  source: artifact.provenance.source,
  capturedAt: artifact.provenance.observedAt,
};

const rawStatus =
  typeof payload === "object" && payload !== null && "status" in payload
    ? (payload as { status?: unknown }).status
    : undefined;
const statusOk =
  rawStatus === undefined ? null : rawStatus === 1 || rawStatus === true;
const hasAmounts = artifact.wagers.some(
  (wager) => wager.amountWagered > 0 || wager.toWinAmount > 0,
);
const info: CaptureInfo = { format: "json", statusOk, hasAmounts };
if (values.captureInfo === true) {
  printCaptureInfo(file, info, artifact.wagers.length);
  process.exit(0);
}
enforceConfidence(info, requiredConfidence, file);

if (analyze) {
  const groups = new Map<
    string,
    { english: string; key: string; tickets: number; legs: number }
  >();
  for (const candidate of artifact.wagers) {
    const structure = ticketStructure(candidate);
    const entry = groups.get(structure.key) ?? {
      ...structure,
      tickets: 0,
      legs: 0,
    };
    entry.tickets += 1;
    entry.legs += candidate.legs.length;
    groups.set(structure.key, entry);
  }
  const rows = [...groups.values()]
    .sort((a, b) => b.tickets - a.tickets || a.english.localeCompare(b.english))
    .map((entry) => ({
      Type:
        langArg === "keys"
          ? `${entry.key} ${entry.english}`
          : structureLabel(entry, langArg, uiTable),
      Tickets: entry.tickets,
      Legs: entry.legs,
    }));
  const analyzeLegs = artifact.wagers.reduce(
    (sum, candidate) => sum + candidate.legs.length,
    0,
  );
  console.log(
    [
      `Ticket structures · ${artifact.wagers.length} tickets · ${analyzeLegs} legs`,
      "",
      Bun.inspect.table(rows, { colors: false }).trimEnd(),
      sourceLine(artifact.provenance, langArg, uiTable),
    ].join("\n"),
  );
  process.exit(0);
}

if (listing) {
  if (values.json === true) {
    if (values.normalized === true) {
      const tickets = artifact.wagers.map((wager) =>
        normalizedView(wager, meta, currencyScale),
      );
      const legs = tickets.reduce(
        (total, ticket) => total + ticket.legs.length,
        0,
      );
      console.log(
        JSON.stringify(
          {
            tickets,
            totals: { tickets: tickets.length, legs },
            provenance: artifact.provenance,
          },
          null,
          2,
        ),
      );
    } else {
      const tickets = artifact.wagers.map((candidate) =>
        safeWagerView(candidate, currencyScale),
      );
      const legs = tickets.reduce(
        (total, ticket) => total + ticket.legs.length,
        0,
      );
      console.log(
        JSON.stringify(
          {
            tickets,
            totals: { tickets: tickets.length, legs },
            provenance: artifact.provenance,
          },
          null,
          2,
        ),
      );
    }
    process.exit(0);
  }

  const tickets = artifact.wagers.map((candidate) =>
    safeWagerView(candidate, currencyScale),
  );
  const legs = tickets.reduce((total, ticket) => total + ticket.legs.length, 0);
  const tableRows =
    langArg === "ENGLISH"
      ? tickets.map((ticket) => ({
          ticket: ticket.wagerNumber,
          writer: ticket.writer,
          type: ticket.wagerType,
          live: ticket.live,
          legs: ticket.legs.length,
          stake: ticket.amountWagered,
          toWin: ticket.toWinAmount,
        }))
      : tickets.map((ticket) => {
          const row: Record<string, unknown> = {};
          row[L("Ticket")] = ticket.wagerNumber;
          row["Writer"] = ticket.writer;
          row[L("Type")] = ticket.wagerType;
          row[L("Live")] = ticket.live;
          row["Legs"] = ticket.legs.length;
          row["Stake"] = ticket.amountWagered;
          row[L("To Win")] = ticket.toWinAmount;
          return row;
        });
  const table = Bun.inspect.table(tableRows, { colors: false });
  const average = tickets.length === 0 ? 0 : legs / tickets.length;
  console.log(
    [
      table.trimEnd(),
      `${tickets.length} tickets · ${legs} legs · avg ${average.toFixed(2)} legs/ticket`,
      sourceLine(artifact.provenance, langArg, uiTable),
    ].join("\n"),
  );
  process.exit(0);
}

if (target === null) fail("internal: missing wager number");
const wager = artifact.wagers.find(
  (candidate) => candidate.wagerNumber === target,
);
if (wager === undefined) {
  fail(`wager ${target} not found in ${file}`);
}

const view = safeWagerView(wager, currencyScale);

if (values.json === true) {
  console.log(
    JSON.stringify(
      values.normalized === true
        ? normalizedView(wager, meta, currencyScale)
        : { wager: view, provenance: artifact.provenance },
      null,
      2,
    ),
  );
  process.exit(0);
}

const localized = langArg !== "ENGLISH" && langArg !== "JAPANESE";
const typeLabel = structureLabel(ticketStructure(wager), langArg, uiTable);
const liveLabel = localized
  ? view.live
    ? label("Live", langArg, uiTable)
    : "Pregame"
  : view.live
    ? "live"
    : "pregame";
const statusCode = view.wagerStatus.code;
const statusLine =
  statusCode === null
    ? []
    : [`${L("Status")}: ${wagerStatusLabel(statusCode, langArg, uiTable)}`];
const lines = [
  `${localized ? L("Ticket") : "Ticket"} ${wager.wagerNumber} · ${view.ticketWriter || view.writer.toUpperCase()} · ${typeLabel} (${view.wagerType}) · ${liveLabel}${view.vip ? " · VIP" : ""}`,
  ...statusLine,
  localized
    ? `${L("Stake")} ${money.format(view.amountWagered)} · ${L("To Win")} ${money.format(view.toWinAmount)}${view.volumeDiffers ? ` · Volume ${money.format(view.volumeAmount)}` : ""}`
    : `Stake ${money.format(view.amountWagered)} · To win ${money.format(view.toWinAmount)}${view.volumeDiffers ? ` · Volume ${money.format(view.volumeAmount)}` : ""}`,
  view.legs.length === 0 ? "Legs: —" : "Legs:",
  ...view.legs.map((leg, index) => {
    const parts = [leg.sport, leg.game, leg.period, leg.market, leg.pick]
      .map((part) => part.trim())
      .filter((part) => part !== "");
    return `  ${index + 1}. ${parts.join(" · ")}${leg.live ? " · LIVE" : ""}`;
  }),
  sourceLine(artifact.provenance, langArg, uiTable),
];
console.log(lines.join("\n"));
