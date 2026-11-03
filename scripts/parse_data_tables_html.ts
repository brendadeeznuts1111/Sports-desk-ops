/**
 * @file parse_data_tables_html.ts
 * @description Parse a Fantasy402 manager DataTables wager panel (`Report/Pending`) into typed JSON.
 *
 * The live panel is server-rendered markup, not JSON: totals live in
 * `[data-field="total-risk"]` / `[data-field="total-win"]`, filters in `select[data-list]`,
 * and each wager is a `tr[data-ticket][data-type]` whose description block holds one
 * `.wager-simple` per leg (a parlay/teaser has several; a straight bet one).
 *
 * Parsing goes through Bun's native `HTMLRewriter` (the same contract as
 * `lib/ticket_html.ts` and `lib/f402_graded_wager_row.ts`): text chunks arrive
 * entity-encoded, so every buffer is joined and decoded once at the end. The external
 * shape is validated once at the boundary with a strict `zod` schema.
 *
 * The row `data-type` is carried through as a raw code. It is a different enum from the
 * filter's `type` options (`G` rows are multi-leg game combos while the filter labels `G`
 * "Racebook"), and unknown codes are kept with `wagerTypeKnown: false` instead of being
 * dropped or rejected.
 *
 * Usage:
 *   bun scripts/parse_data_tables_html.ts page.html
 *   cat page.html | bun scripts/parse_data_tables_html.ts
 */

import { z } from "zod";
import { decodeEntities } from "../lib/ticket_html.ts";

/**
 * Row `data-type` codes seen on the panel (plus the grading screen's `E`). This is a
 * membership check for `wagerTypeKnown`, not a validation gate: an unlisted code is
 * parsed and flagged, because the portal has already shipped codes the filter omits.
 */
const KNOWN_WAGER_TYPES: ReadonlySet<string> = new Set([
  "A",
  "C",
  "E",
  "G",
  "I",
  "L",
  "M",
  "N",
  "P",
  "S",
  "T",
]);

export interface PanelFilterOption {
  readonly value: string;
  readonly label: string;
}

export interface PanelLeg {
  readonly selection: string;
  readonly line: string | null;
  readonly period: string | null;
}

export interface PanelRow {
  /** `data-ticket` — the ticket number without a leg suffix. */
  readonly ticketNumber: string;
  /** `data-type` raw code (`M` moneyline, `L` total, `S` spread, `P` parlay, `T` teaser, `C` futures, `G` multi-leg combo, ...). */
  readonly wagerType: string;
  /** False when the code is outside {@link KNOWN_WAGER_TYPES}; the row is still parsed. */
  readonly wagerTypeKnown: boolean;
  /** `Ticket#` field, e.g. `9000000004` or `9000000001-1`. */
  readonly wagerNumber: string | null;
  readonly agent: string;
  readonly customer: string;
  readonly riskUsd: number;
  readonly toWinUsd: number;
  readonly status: string;
  readonly accepted: string | null;
  readonly scheduled: string | null;
  readonly note: string | null;
  /** `G####` game id for a multi-leg game ticket, else null. */
  readonly gameNumber: string | null;
  /** The `li` game lines inside a `G` row's `.choosen` (one selection each). */
  readonly gameLines: readonly string[];
  readonly legs: readonly PanelLeg[];
}

export interface PendingPanel {
  readonly totals: {
    readonly riskUsd: number;
    readonly toWinUsd: number;
  } | null;
  readonly filters: {
    readonly time: readonly PanelFilterOption[];
    readonly type: readonly PanelFilterOption[];
  };
  /** Numbered pagination labels, e.g. `["1", "2", "3", "4"]`. */
  readonly pages: readonly string[];
  readonly typeCounts: Readonly<Record<string, number>>;
  readonly rows: readonly PanelRow[];
}

/** Raised when the markup is missing a field the typed contract requires. */
export class PendingPanelParseError extends Error {
  constructor(reason: string) {
    super(`parse_data_tables_html: ${reason}`);
    this.name = "PendingPanelParseError";
  }
}

interface RawLeg {
  selection: string;
  line: string;
  period: string;
}

interface RawRow {
  readonly ticketNumber: string;
  readonly wagerType: string;
  readonly accounts: string[];
  risk: string;
  toWin: string;
  chosenText: string;
  readonly gameLines: string[];
  readonly legs: RawLeg[];
  readonly fields: Map<string, string>;
}

interface RawOption {
  readonly value: string;
  label: string;
}

function normalizeText(value: string): string {
  return decodeEntities(value).replace(/\s+/g, " ").trim();
}

/** `$61,737.70` -> `61737.7`, `$110` -> `110`. */
function parseMoney(value: string, field: string): number {
  const cleaned = value.replace(/[^0-9.-]/g, "");
  const amount = Number(cleaned);
  if (cleaned === "" || !Number.isFinite(amount)) {
    throw new PendingPanelParseError(`${field} is not numeric`);
  }
  return amount;
}

function extract(html: string): {
  readonly rows: RawRow[];
  readonly totalRisk: string;
  readonly totalWin: string;
  readonly time: RawOption[];
  readonly type: RawOption[];
  readonly pages: string[];
} {
  const rows: RawRow[] = [];
  const time: RawOption[] = [];
  const type: RawOption[] = [];
  const pages: string[] = [];
  let totalRisk = "";
  let totalWin = "";
  let current: number | null = null;
  let labelText = "";
  let valueText = "";

  const rowAt = (): RawRow | undefined => {
    const index = current;
    return index === null ? undefined : rows[index];
  };

  const rewriter = new HTMLRewriter()
    .on("tr[data-ticket]", {
      element(element) {
        rows.push({
          ticketNumber: (element.getAttribute("data-ticket") ?? "").trim(),
          wagerType: (element.getAttribute("data-type") ?? "").trim(),
          accounts: [],
          risk: "",
          toWin: "",
          chosenText: "",
          gameLines: [],
          legs: [],
          fields: new Map(),
        });
        current = rows.length - 1;
      },
    })
    .on("tr[data-ticket] span[data-account]", {
      element() {
        rowAt()?.accounts.push("");
      },
      text(chunk) {
        if (chunk.removed) return;
        const row = rowAt();
        if (row === undefined) return;
        const index = row.accounts.length - 1;
        row.accounts[index] = (row.accounts[index] ?? "") + chunk.text;
      },
    })
    .on("tr[data-ticket] td.to-risk", {
      text(chunk) {
        if (chunk.removed) return;
        const row = rowAt();
        if (row !== undefined) row.risk += chunk.text;
      },
    })
    .on("tr[data-ticket] td.to-win", {
      text(chunk) {
        if (chunk.removed) return;
        const row = rowAt();
        if (row !== undefined) row.toWin += chunk.text;
      },
    })
    .on("tr[data-ticket] .wager-simple", {
      element() {
        rowAt()?.legs.push({ selection: "", line: "", period: "" });
      },
    })
    .on("tr[data-ticket] .wager-simple .choosen", {
      text(chunk) {
        if (chunk.removed) return;
        const row = rowAt();
        if (row === undefined) return;
        row.chosenText += chunk.text;
        const leg = row.legs[row.legs.length - 1];
        if (leg !== undefined) leg.selection += chunk.text;
      },
    })
    .on("tr[data-ticket] .wager-simple .choosen li", {
      element() {
        rowAt()?.gameLines.push("");
      },
      text(chunk) {
        if (chunk.removed) return;
        const row = rowAt();
        if (row === undefined) return;
        const index = row.gameLines.length - 1;
        row.gameLines[index] = (row.gameLines[index] ?? "") + chunk.text;
      },
    })
    .on("tr[data-ticket] .wager-simple .line-selected", {
      text(chunk) {
        if (chunk.removed) return;
        const row = rowAt();
        const leg = row?.legs[row.legs.length - 1];
        if (leg !== undefined) leg.line += chunk.text;
      },
    })
    .on("tr[data-ticket] .wager-simple .period-description-s", {
      text(chunk) {
        if (chunk.removed) return;
        const row = rowAt();
        const leg = row?.legs[row.legs.length - 1];
        if (leg !== undefined) leg.period += chunk.text;
      },
    })
    .on("tr[data-ticket] .header-bet .ln", {
      element(element) {
        labelText = "";
        valueText = "";
        if (element.canHaveContent === false) return;
        element.onEndTag(() => {
          const row = rowAt();
          if (row === undefined) return;
          const label = normalizeText(labelText);
          if (label !== "") row.fields.set(label, normalizeText(valueText));
        });
      },
    })
    .on("tr[data-ticket] .header-bet .d-l", {
      text(chunk) {
        if (!chunk.removed) labelText += chunk.text;
      },
    })
    .on("tr[data-ticket] .header-bet .d-r", {
      text(chunk) {
        if (!chunk.removed) valueText += chunk.text;
      },
    })
    .on('[data-field="total-risk"]', {
      text(chunk) {
        if (!chunk.removed) totalRisk += chunk.text;
      },
    })
    .on('[data-field="total-win"]', {
      text(chunk) {
        if (!chunk.removed) totalWin += chunk.text;
      },
    })
    .on('select[data-list="time"] option', {
      element(element) {
        time.push({ value: element.getAttribute("value") ?? "", label: "" });
      },
      text(chunk) {
        if (chunk.removed) return;
        const option = time[time.length - 1];
        if (option !== undefined) option.label += chunk.text;
      },
    })
    .on('select[data-list="type"] option', {
      element(element) {
        type.push({ value: element.getAttribute("value") ?? "", label: "" });
      },
      text(chunk) {
        if (chunk.removed) return;
        const option = type[type.length - 1];
        if (option !== undefined) option.label += chunk.text;
      },
    })
    .on('[id$="_paginate"] a', {
      element() {
        pages.push("");
      },
      text(chunk) {
        if (chunk.removed) return;
        const index = pages.length - 1;
        pages[index] = (pages[index] ?? "") + chunk.text;
      },
    });

  rewriter.transform(html);
  return { rows, totalRisk, totalWin, time, type, pages };
}

const panelLegSchema = z.object({
  selection: z.string().min(1),
  line: z.string().nullable(),
  period: z.string().nullable(),
});

const panelRowSchema = z.object({
  ticketNumber: z.string().regex(/^\d+$/),
  wagerType: z.string().regex(/^[A-Z]$/),
  wagerTypeKnown: z.boolean(),
  wagerNumber: z.string().nullable(),
  agent: z.string().min(1),
  customer: z.string().min(1),
  riskUsd: z.number().finite(),
  toWinUsd: z.number().finite(),
  status: z.string().min(1),
  accepted: z.string().nullable(),
  scheduled: z.string().nullable(),
  note: z.string().nullable(),
  gameNumber: z.string().nullable(),
  gameLines: z.array(z.string()),
  legs: z.array(panelLegSchema).min(1),
});

const pendingPanelSchema = z.object({
  totals: z
    .object({ riskUsd: z.number().finite(), toWinUsd: z.number().finite() })
    .nullable(),
  filters: z.object({
    time: z.array(z.object({ value: z.string(), label: z.string() })),
    type: z.array(z.object({ value: z.string(), label: z.string() })),
  }),
  pages: z.array(z.string()),
  typeCounts: z.record(z.string(), z.number().int().nonnegative()),
  rows: z.array(panelRowSchema),
});

/** Parse one panel page (HTML) into the typed contract. */
export function parsePendingPanelHtml(html: string): PendingPanel {
  const raw = extract(html);
  if (raw.rows.length === 0) {
    throw new PendingPanelParseError("no tr[data-ticket] rows found");
  }

  const rows: PanelRow[] = raw.rows.map((row) => {
    const gameLines = row.gameLines
      .map((line) => normalizeText(line))
      .filter((line) => line !== "");
    const gameNumber =
      /^G(\d+)/.exec(normalizeText(row.chosenText))?.[1] ?? null;
    const wagerLegs: PanelLeg[] = row.legs.map((leg) => ({
      selection: normalizeText(leg.selection),
      line: normalizeText(leg.line) === "" ? null : normalizeText(leg.line),
      period:
        normalizeText(leg.period) === "" ? null : normalizeText(leg.period),
    }));
    // A `G` row is one `.wager-simple` whose `.choosen` lists the game lines; those
    //`li` entries are the selections, not the single wrapper block.
    const legs: PanelLeg[] =
      row.wagerType === "G" && gameLines.length > 0
        ? gameLines.map((line) => ({
            selection: line,
            line: null,
            period: null,
          }))
        : wagerLegs;
    if (legs.length === 0) {
      throw new PendingPanelParseError(
        `ticket ${row.ticketNumber}: no wager blocks`,
      );
    }
    return {
      ticketNumber: row.ticketNumber,
      wagerType: row.wagerType,
      wagerTypeKnown: KNOWN_WAGER_TYPES.has(row.wagerType),
      wagerNumber: row.fields.get("Ticket#") ?? null,
      agent: normalizeText(row.accounts[0] ?? ""),
      customer: normalizeText(row.accounts[1] ?? ""),
      riskUsd: parseMoney(row.risk, "risk"),
      toWinUsd: parseMoney(row.toWin, "toWin"),
      status: row.fields.get("Status") ?? "",
      accepted: row.fields.get("Accepted") ?? null,
      scheduled: row.fields.get("Scheduled") ?? null,
      note:
        row.fields.get("Note") === "" ? null : (row.fields.get("Note") ?? null),
      gameNumber,
      gameLines,
      legs,
    };
  });

  const typeCounts: Record<string, number> = {};
  for (const row of rows) {
    typeCounts[row.wagerType] = (typeCounts[row.wagerType] ?? 0) + 1;
  }

  const totals =
    raw.totalRisk === "" && raw.totalWin === ""
      ? null
      : {
          riskUsd: parseMoney(raw.totalRisk, "total-risk"),
          toWinUsd: parseMoney(raw.totalWin, "total-win"),
        };

  return pendingPanelSchema.parse({
    totals,
    filters: {
      time: raw.time.map((option) => ({
        value: option.value,
        label: normalizeText(option.label),
      })),
      type: raw.type.map((option) => ({
        value: option.value,
        label: normalizeText(option.label),
      })),
    },
    pages: raw.pages
      .map((page) => page.trim())
      .filter((page) => /^\d+$/.test(page)),
    typeCounts,
    rows,
  });
}

if (import.meta.main) {
  const [path] = Bun.argv.slice(2);
  const html =
    path === undefined || path === "-"
      ? await Bun.stdin.text()
      : await Bun.file(path).text();
  const panel = parsePendingPanelHtml(html);
  console.log(JSON.stringify(panel, null, 2));
}
