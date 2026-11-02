import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ANALYSIS_ACTIVITIES,
  ANALYSIS_GROUPS,
  ANALYSIS_REPORTS,
  ANALYSIS_WEEKS,
} from "../lib/analysis_filters.ts";
import { loadSportCatalog, periodsFor } from "../lib/sport_catalog.ts";

/**
 * Checks the Analysis vocabulary this repo transcribed against the screen it came from.
 *
 * The fixture is an operator paste of the portal's agent-performance filter bar (2026-11-01). The
 * library values were written earlier from the same screen, so this is a transcription check: if a
 * value here disagrees with `lib/analysis_filters.ts`, one of the two is wrong and the test says
 * which value.
 */
const html = readFileSync(
  resolve(
    import.meta.dir,
    "fixtures/portal-agent-performance-filterbar-2026-11-01.html",
  ),
  "utf8",
);

/** The portal comments out retired options; a naive regex would read them as live. */
const live = html.replaceAll(/<!--[\s\S]*?-->/g, "");

const select = (list: string): string => {
  const start = live.indexOf(`data-list="${list}"`);
  if (start === -1) throw new Error(`no select[data-list="${list}"]`);
  const open = live.lastIndexOf("<select", start);
  const close = live.indexOf("</select>", start);
  return live.slice(open, close);
};

interface Option {
  readonly value: string;
  readonly label: string;
}

const options = (list: string): Option[] => {
  const block = select(list);
  return [...block.matchAll(/<option([^>]*)>([^<]*)<\/option>/g)].map(
    (match) => {
      const attrs = match[1] ?? "";
      const value = /value="([^"]*)"/.exec(attrs)?.[1] ?? "";
      return { value, label: (match[2] ?? "").trim() };
    },
  );
};

const catalog = loadSportCatalog(
  JSON.parse(
    readFileSync(
      resolve(
        import.meta.dir,
        "fixtures/fantasy402-sport-catalog-2026-10-21.json",
      ),
      "utf8",
    ),
  ),
);
if (catalog === null) throw new Error("sport catalog fixture did not load");

describe("report kinds", () => {
  test("the data-action=filter buttons match ANALYSIS_REPORTS", () => {
    const buttons = [
      ...live.matchAll(
        /data-action="filter"\s+data-value="([^"]+)"[^>]*>([^<]+)</g,
      ),
    ].map((match) => ({
      value: match[1] ?? "",
      label: (match[2] ?? "").trim(),
    }));
    expect(buttons).toEqual([...ANALYSIS_REPORTS]);
  });

  test("the visible label defaults to Sport Performance, not the first option", () => {
    // #btnPerformance shows CPS while the first menu item is CP, so the button label is state,
    // not "whichever option is first".
    const button =
      /<button[^>]*id="btnPerformance"[^>]*>([\s\S]*?)<\/button>/.exec(live);
    expect(button?.[1]?.trim()).toBe("Sport Performance");
  });
});

describe("activity", () => {
  test("matches ANALYSIS_ACTIVITIES in order", () => {
    const values = options("activity").map((option) => option.value);
    expect(values).toEqual(ANALYSIS_ACTIVITIES.map((entry) => entry.value));
  });

  test("retired codes are commented out, not shipped", () => {
    // 6 (Prop Builder) and 9 (Extended Props) exist only inside HTML comments.
    expect(html).toContain('<!--option value="6"');
    expect(html).toContain('<!--option value="9"');
    const values = options("activity").map((option) => option.value);
    expect(values).not.toContain("6");
    expect(values).not.toContain("9");
    expect(values).toHaveLength(14);
  });
});

describe("group and week", () => {
  test("group matches ANALYSIS_GROUPS", () => {
    expect(options("group")).toEqual([...ANALYSIS_GROUPS]);
  });

  test("week matches ANALYSIS_WEEKS", () => {
    expect(options("week")).toEqual([...ANALYSIS_WEEKS]);
  });

  test("-1 means Today in the week list and All Periods in the period list", () => {
    // The same value carries different meanings in adjacent selects; conflating them would send
    // the wrong filter.
    expect(options("week")[0]).toEqual({ value: "-1", label: "Today" });
    expect(options("period")[0]).toEqual({
      value: "-1",
      label: "All Periods",
    });
  });
});

describe("sports", () => {
  test("option values are padded to 20 characters, like the wire field", () => {
    const sports = options("sports").filter((option) => option.value !== "-1");
    expect(sports).toHaveLength(19);
    for (const option of sports) {
      expect(option.value).toHaveLength(20);
      expect(option.label).toBe(option.value.trim());
    }
  });

  test("the padded names are the catalog's sports, in catalog order", () => {
    const sports = options("sports").filter((option) => option.value !== "-1");
    expect(sports.map((option) => option.value.trim())).toEqual(
      catalog.sports.map((entry) => entry.sport),
    );
  });

  test("All Sports is the -1 option", () => {
    expect(options("sports")[0]).toEqual({ value: "-1", label: "All Sports" });
  });
});

describe("wager types and bet types", () => {
  test("the wagers select offers seven codes and repeats I", () => {
    const wagers = options("wagers");
    expect(wagers.map((option) => option.value)).toEqual([
      "-1",
      "S",
      "P",
      "T",
      "I",
      "I",
      "C",
      "A",
    ]);
    // If-Bets and Action Reverses share the code I, so a code is not a unique label.
    expect(wagers.filter((option) => option.value === "I")).toHaveLength(2);
  });

  test("betType labels M as Money Line — a different field from the ticker's WagerType", () => {
    const betTypes = Object.fromEntries(
      options("betType").map((option) => [option.value, option.label]),
    );
    expect(betTypes).toEqual({
      "-1": "All",
      S: "Spread",
      M: "Money Line",
      L: "Total",
      E: "Team Total",
    });
  });

  test("the grading panel's Straight is a comma-separated list", () => {
    // One select value can carry five codes; a builder that assumes a single code is wrong.
    const straight = options("wager-type").find(
      (option) => option.label === "Straight",
    );
    expect(straight?.value).toBe("S,M,L,E,C");
    expect(straight?.value.split(",")).toHaveLength(5);
  });
});

describe("periods", () => {
  test("the static menu is Football's period list", () => {
    const periods = options("period");
    expect(periods[0]).toEqual({ value: "-1", label: "All Periods" });
    const numbers = periods.slice(1).map((option) => ({
      number: Number(option.value),
      name: option.label,
    }));
    const football = periodsFor(catalog, "Football").map((entry) => ({
      number: entry.number,
      name: entry.name,
    }));
    // The screen says "1st Qtr" where the catalog says "1st Quarter": same number, shorter label.
    expect(numbers.map((entry) => entry.number)).toEqual(
      football.map((entry) => entry.number),
    );
    expect(numbers.map((entry) => entry.name)).toEqual([
      "Game",
      "1st Half",
      "2nd Half",
      "1st Qtr",
      "2nd Qtr",
      "3rd Qtr",
      "4th Qtr",
    ]);
  });
});

describe("results grid", () => {
  test("the header names seven columns", () => {
    const headers = [...live.matchAll(/<th[^>]*>([^<]+)<\/th>/g)].map((match) =>
      (match[1] ?? "").trim(),
    );
    expect(headers).toEqual([
      "All Players and Agents",
      "Won",
      "Lost",
      "# of Bets",
      "Risk",
      "Net",
      "Hold %age",
    ]);
  });

  test("headers are not a response schema", () => {
    // The DOM names the columns the screen renders; it says nothing about the JSON keys, and no
    // response has been observed. The fixture must not be read as a schema.
    expect(html).toContain("No Information to Display");
    expect(html).not.toContain("LIST");
    expect(html).not.toContain("holdPct");
  });
});

describe("the grading panel, which serves the export", () => {
  test("its label is Graded Wagers and it has its own search action", () => {
    // Report kind G renders this panel, so the button label and the action differ from the
    // analysis panel's.
    const gradeBtn = /<button[^>]*id="gradeBtn"[^>]*>([\s\S]*?)<\/button>/.exec(
      live,
    );
    expect(gradeBtn?.[1]?.trim()).toBe("Graded Wagers");
    expect(live).toContain('data-action="search-grading"');
    expect(live).toContain('data-action="search"');
  });

  test("its date fields are startG/endG, not start/end", () => {
    // Two panels, two sets of pickers. A builder that reads `start` would read the wrong input.
    expect(live).toContain('data-field="startG"');
    expect(live).toContain('data-field="endG"');
    expect(live).toContain('data-field="start"');
    expect(live).toContain('data-field="end"');
  });

  test("the export icon is shown in the grading panel and hidden in the analysis panel", () => {
    // The graded export exists only because a search ran and un-hid the icon; the analysis panel's
    // icon keeps `hide` and never appears. That is the difference between "export available" and
    // "export column present but disabled".
    const exports = [
      ...live.matchAll(/<i[^>]*data-export="excel-action"[^>]*>/g),
    ].map((match) => match[0]);
    expect(exports).toHaveLength(2);
    expect(exports.filter((tag) => /\bhide\b/.test(tag))).toHaveLength(1);
    expect(exports.filter((tag) => !/\bhide\b/.test(tag))).toHaveLength(1);
  });
});

describe("the report-kind marker", () => {
  test("the table container names the report that is loaded", () => {
    // The screen stamps TYPE-REPORT-<label> on the container, so the rendered report is readable
    // from the DOM without inferring it from the selected button.
    const match = /class="TYPE-REPORT-([A-Za-z-]+)"/.exec(live);
    expect(match?.[1]).toBe("Customer-Volume");
    const label = ANALYSIS_REPORTS.find(
      (entry) => entry.value === "CPV",
    )?.label;
    expect(label?.replaceAll(" ", "-")).toBe(match?.[1]);
  });
});

describe("header actions", () => {
  const actions = [...live.matchAll(/data-action="(show-[a-z]+)"/g)].map(
    (match) => match[1] ?? "",
  );

  test("Configuration and Vip List are the two header actions", () => {
    expect(actions).toEqual(["show-config", "show-vip"]);
  });

  test("they open panels; they are not the report search", () => {
    // Distinct from data-action="search" / "search-grading": neither action sends the report call.
    expect(actions).not.toContain("search");
    expect(live).toContain('data-language="L-1027"');
    expect(live).toContain('data-language="L-1028"');
  });
});
