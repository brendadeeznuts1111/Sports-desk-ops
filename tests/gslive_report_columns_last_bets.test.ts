import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  canonicalizeGsLiveHeader,
  LAST_BETS_COLUMNS,
  LAST_BETS_FILTER_COUNT,
  LAST_BETS_FILTERS,
  ROW_SELECTION_COLUMN,
  UI_LAST_BETS_NAMED_COLUMN_COUNT,
  UI_LAST_BETS_SLOT_COUNT,
  verifyLastBetsCatalog,
} from "../lib/gslive_report_columns.ts";

const root = resolve(import.meta.dir, "..");
const scratch = (name: string) => resolve(root, "Scratch", name);

describe("Last Bets 53-column catalog", () => {
  test("has 52 named columns plus the row-selection slot = 53", () => {
    expect(UI_LAST_BETS_SLOT_COUNT).toBe(53);
    expect(UI_LAST_BETS_NAMED_COLUMN_COUNT).toBe(52);
    expect(LAST_BETS_COLUMNS).toHaveLength(52);
    expect(ROW_SELECTION_COLUMN.index).toBe(53);
    expect(LAST_BETS_COLUMNS.map((c) => c.index)).toEqual(
      Array.from({ length: 52 }, (_, i) => i + 1),
    );
    expect(LAST_BETS_COLUMNS.map((c) => c.label)).toContain("Logs");
    expect(LAST_BETS_COLUMNS.map((c) => c.label)).toContain("Actions");
  });

  test("defines all 15 filters including Grade/Bet time and Max Time Until Score", () => {
    expect(LAST_BETS_FILTER_COUNT).toBe(15);
    expect(LAST_BETS_FILTERS).toHaveLength(15);
    const labels = LAST_BETS_FILTERS.map((f) => f.label);
    expect(labels).toContain("Date range (with Grade time / Bet time basis)");
    expect(labels).toContain("Max Time Until Score");
    const dateBasis = LAST_BETS_FILTERS.find((f) => f.control === "dateRange");
    expect(dateBasis?.bodyKeys).toEqual(["from", "to", "dateFilterBy"]);
    const maxTime = LAST_BETS_FILTERS.find(
      (f) => f.control === "maxTimeUntilScore",
    );
    expect(maxTime?.bodyKeys).toEqual(["maxTimeUntilScore"]);
  });

  test("reconciles every mapped wire key against the raw capture and body", () => {
    if (
      !existsSync(scratch("betReport-all.json")) ||
      !existsSync(scratch("ajax-getBetReport-body.json"))
    )
      return;
    const rawKeys = new Set(
      Object.keys(
        (
          JSON.parse(readFileSync(scratch("betReport-all.json"), "utf8")) as {
            r: { bets: Record<string, unknown>[] };
          }
        ).r.bets[0] ?? {},
      ),
    );
    const bodyKeys = new Set(
      Object.keys(
        JSON.parse(
          readFileSync(scratch("ajax-getBetReport-body.json"), "utf8"),
        ) as Record<string, unknown>,
      ),
    );
    for (const column of LAST_BETS_COLUMNS) {
      if (column.wireKey === null || column.wireKey.includes(".")) continue;
      expect(rawKeys.has(column.wireKey)).toBe(true);
    }
    for (const filter of LAST_BETS_FILTERS)
      for (const key of filter.bodyKeys) expect(bodyKeys.has(key)).toBe(true);
    expect(rawKeys.size).toBe(69);
    expect(bodyKeys.size).toBe(20);
  });

  test("maps the 18 CSV headers and the 52 labels", () => {
    for (const column of LAST_BETS_COLUMNS)
      expect(canonicalizeGsLiveHeader(column.label)).toBe(column.column);
    expect(canonicalizeGsLiveHeader("Player Name")).toBe("player");
    expect(canonicalizeGsLiveHeader("Sports")).toBe("sportLeague");
    expect(canonicalizeGsLiveHeader("Not a column")).toBeNull();
    if (!existsSync(scratch("gslive-wagers-by-state.csv"))) return;
    const header = (
      readFileSync(scratch("gslive-wagers-by-state.csv"), "utf8").split(
        "\n",
      )[0] ?? ""
    ).split(",");
    expect(header).toHaveLength(18);
    for (const label of header)
      expect(canonicalizeGsLiveHeader(label)).not.toBeNull();
  });

  test("structural self-check", () => {
    expect(verifyLastBetsCatalog()).toEqual({
      slots: 53,
      named: 52,
      filters: 15,
      mapped: 38,
      unmapped: 14,
    });
  });
});
