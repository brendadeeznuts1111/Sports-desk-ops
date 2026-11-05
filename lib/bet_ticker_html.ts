/**
 * @file bet_ticker_html.ts
 * @description Parse the server-rendered bet-ticker table and load either that HTML or the
 * `getBetTicker` JSON capture through one entry point.
 *
 * The table row is:
 *   `<tr data-vip data-risk data-wager-number>`
 *   `<td>AgentID</td><td>Straight|Parlay|…</td><td>AgentLogin</td>`
 *   `<td class="col-desc">G320201427Basketball - …</td>`
 *   `<td>Risk</td><td>To Win</td><td>GSLIVE|Internet|…</td><td class="time-col">9:55:08 PM</td>`
 *
 * The agent and agent-login cells are deliberately never stored: the parser reads only the
 * type, description, writer, time and `data-*` attributes. HTML amounts are display-only, so
 * `stake` stays `null` and `amountSource` says `html-display`; `loadCapture` applies
 * `currencyScale` only to the JSON path.
 */

import { decodeEntities } from "./ticket_html.ts";
import { getTicketInternal, setTicketInternal } from "./ticket_internal.ts";
import {
  normalizeLeg,
  normalizeTicket,
  type NormalizedTicket,
  type NormalizedTicketLeg,
} from "./live_ticket_view.ts";
import { parseShortDesc, readWagerListArtifact } from "./live_wagers.ts";

export interface HtmlBetTicket {
  readonly wagerNumber: string;
  /** Trimmed writer cell (`GSLIVE`, `Internet`, …). */
  readonly source: string;
  /** The HTML "Type" column: `Straight`, `Parlay`, `Prop`, `Teaser`. Not a wire code. */
  readonly ticketStructure: string;
  /** The same display label, for callers that use the normalized ticket field name. */
  readonly wagerTypeLabel: string;
  readonly timeOnly: string | null;
  /** `G320198818` / `#500016` → the digits only. */
  readonly descCode: string | null;
  /** HTML amounts are display-only until reconciled with the JSON ticker. */
  readonly stake: null;
  readonly amountSource: "html-display";
  readonly legs: readonly NormalizedTicketLeg[];
  readonly vip: boolean;
  readonly live: boolean;
}

export interface LoadCaptureOptions {
  /** Applied to JSON amounts only; the HTML table never produces a numeric stake. */
  readonly currencyScale?: number;
}

export interface LoadedJsonTicket extends NormalizedTicket {
  readonly amountSource: "json";
}

export interface CaptureProvenance {
  readonly file: string;
  readonly source: string;
  readonly capturedAt: string | null;
}

export interface LoadedCapture {
  readonly format: "html" | "json";
  readonly tickets: readonly (HtmlBetTicket | LoadedJsonTicket)[];
  readonly provenance: CaptureProvenance;
}

const ROW = /<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi;
const CELL = /<td\b([^>]*)>([\s\S]*?)<\/td>/gi;

/** Decode repeatedly: the portal sometimes double-encodes `&amp;#038;aacute;`. */
function decodeDeep(text: string): string {
  let current = text;
  for (let pass = 0; pass < 5; pass++) {
    const next = decodeEntities(current);
    if (next === current) return current;
    current = next;
  }
  return current;
}

function cellText(html: string): string {
  return decodeDeep(html.replace(/<[^>]*>/g, " "))
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strip row markup, treat only `<br>` as a leg boundary, decode and drop the portal's `Top` lines. */
function descriptionText(html: string): string {
  const withBreaks = html.replace(/<br\s*\/?>/gi, "\u0000");
  return decodeDeep(withBreaks.replace(/<[^>]*>/g, " "))
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .split("\u0000")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "" && line.toLowerCase() !== "top")
    .join("\n");
}

function descCodeOf(description: string): string | null {
  const code = /G(\d{6,})/.exec(description) ?? /#(\d{5,})/.exec(description);
  return code?.[1] ?? null;
}

function parseDescription(description: string): readonly NormalizedTicketLeg[] {
  const body = description.replace(/^G\d{6,}\s*/, "");
  if (body === "") return [];
  return parseShortDesc(body).legs.map((leg, index) =>
    normalizeLeg(leg, index + 1),
  );
}

interface Cell {
  readonly attrs: string;
  readonly html: string;
}

function cellsOf(rowHtml: string): Cell[] {
  const cells: Cell[] = [];
  for (const match of rowHtml.matchAll(CELL)) {
    cells.push({ attrs: match[1] ?? "", html: match[2] ?? "" });
  }
  return cells;
}

function classMatch(attrs: string, name: string): boolean {
  const className = /class="([^"]*)"/i.exec(attrs)?.[1] ?? "";
  return className.split(/\s+/).includes(name);
}

export interface HtmlHeader {
  readonly index: number;
  /** `data-language="L-xxx"` when present. */
  readonly key: string | null;
  readonly text: string;
}

/** The captured table's `<th data-language="L-…">` headers, in column order. */
export function htmlHeaderMap(html: string): HtmlHeader[] {
  const rows = html.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi);
  for (const row of rows) {
    const headers = [
      ...(row[2] ?? "").matchAll(/<th\b([^>]*)>([\s\S]*?)<\/th>/gi),
    ];
    if (headers.length === 0) continue;
    return headers.map((header, index) => ({
      index,
      key: /data-language="([^"]+)"/i.exec(header[1] ?? "")?.[1] ?? null,
      text: cellText(header[2] ?? ""),
    }));
  }
  return [];
}

export interface HtmlFilters {
  readonly vipOnly: boolean;
  readonly betsOver: number | null;
  /** Type checkboxes that are off; empty when the capture has no type controls. */
  readonly hiddenWagerTypes: readonly string[];
}

const TYPE_FILTERS = [
  ["flag-straight", "Straight"],
  ["flag-parlay", "Parlay"],
  ["flag-teaser", "Teaser"],
  ["flag-if-bet", "If-Bet"],
  ["flag-prop", "Prop"],
] as const;

function checkedAttr(html: string, selector: string): boolean {
  const forward = new RegExp(
    `<input\\b[^>]*${selector}[^>]*\\bchecked\\b`,
    "i",
  );
  const reverse = new RegExp(
    `<input\\b[^>]*\\bchecked\\b[^>]*${selector}`,
    "i",
  );
  return forward.test(html) || reverse.test(html);
}

/** Client-side table filters operate after the AJAX response, so the HTML is a subset. */
export function inspectHtmlFilters(html: string): HtmlFilters {
  const vipOnly = checkedAttr(html, 'data-action="vip-active"');
  const betsOverRaw =
    /data-field="bets-over"[^>]*value="(\d+)"/i.exec(html)?.[1] ??
    /value="(\d+)"[^>]*data-field="bets-over"/i.exec(html)?.[1];
  const hasTypeControls = TYPE_FILTERS.some(([field]) =>
    new RegExp(`<input\\b[^>]*data-field="${field}"`, "i").test(html),
  );
  const hiddenWagerTypes = hasTypeControls
    ? TYPE_FILTERS.filter(
        ([field]) => !checkedAttr(html, `data-field="${field}"`),
      ).map(([, label]) => label)
    : [];
  return {
    vipOnly,
    betsOver: betsOverRaw === undefined ? null : Number(betsOverRaw),
    hiddenWagerTypes,
  };
}

/** Parse every `<tr data-wager-number="…">` in the table. */
export function parseBetTickerHtml(html: string): HtmlBetTicket[] {
  const tickets: HtmlBetTicket[] = [];
  for (const match of html.matchAll(ROW)) {
    const attrs = match[1] ?? "";
    const wagerNumber = /data-wager-number="([^"]+)"/i.exec(attrs)?.[1];
    if (wagerNumber === undefined) continue;

    const cells = cellsOf(match[2] ?? "");
    const descCell = cells.find((cell) => classMatch(cell.attrs, "col-desc"));
    const timeCell = cells.find((cell) => classMatch(cell.attrs, "time-col"));
    if (descCell === undefined) continue;

    const typeLabel = cellText(cells[1]?.html ?? "");
    const writer = cellText(cells[6]?.html ?? "");
    const description = descriptionText(descCell.html);
    const ticketStructure = typeLabel === "" ? "Other" : typeLabel;

    const ticket: HtmlBetTicket = {
      wagerNumber,
      source: writer,
      ticketStructure,
      wagerTypeLabel: ticketStructure,
      timeOnly: timeCell === undefined ? null : cellText(timeCell.html) || null,
      descCode: descCodeOf(description),
      stake: null,
      amountSource: "html-display",
      legs: parseDescription(description),
      vip: /data-vip="true"/i.test(attrs),
      live: /\bLIVE\b|\(live\)/i.test(description),
    };
    setTicketInternal(ticket, {
      customer: cellText(cells[0]?.html ?? ""),
      agent: cellText(cells[2]?.html ?? ""),
    });
    tickets.push(ticket);
  }
  return tickets;
}

/** Read either the HTML table or a JSON `getBetTicker` capture. */
export async function loadCapture(
  path: string,
  options: LoadCaptureOptions = {},
): Promise<LoadedCapture> {
  const text = await Bun.file(path).text();
  const trimmed = text.trimStart();

  if (trimmed.startsWith("<")) {
    return {
      format: "html",
      tickets: parseBetTickerHtml(text),
      provenance: { file: path, source: "html-capture", capturedAt: null },
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `${path}: expected HTML or a JSON getBetTicker capture: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }

  const artifact = readWagerListArtifact(payload);
  const scale = options.currencyScale ?? 1;
  const meta = {
    file: path,
    source: artifact.provenance.source,
    capturedAt: artifact.provenance.observedAt,
  };
  const tickets: LoadedJsonTicket[] = artifact.wagers.map((wager) => {
    const view = normalizeTicket(wager, meta);
    const ticket: LoadedJsonTicket = {
      ...view,
      stake: view.stake * scale,
      toWin: view.toWin * scale,
      volume: view.volume === null ? null : view.volume * scale,
      amountSource: "json",
    };
    const internal = getTicketInternal(view);
    if (internal !== undefined) setTicketInternal(ticket, internal);
    return ticket;
  });

  return { format: "json", tickets, provenance: meta };
}
