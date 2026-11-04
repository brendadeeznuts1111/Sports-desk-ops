import { describe, expect, test } from "bun:test";
import {
  applyFilters,
  bucketBy,
  bucketByState,
  buildBetReportBody,
  computeGroupSizes,
  filterLabels,
  formatElapsed,
  GroupSummary,
  groupValue,
  padDisplay,
  parseDateArg,
  parseFilters,
  parseFormat,
  parseGroupBy,
  parseOutArg,
  parseTopArg,
  parseWagersFromBets,
  parseWagersFromCsvRows,
  renderGrid,
  renderReport,
  renderTable,
  sortBuckets,
  sortGroups,
  splitOutput,
  summarizeGroups,
  sumGrand,
  takeTop,
  toColumnar,
} from "../lib/wagers_report.ts";
import type { WagerRow } from "../types/wagers";
import { loadConfig, resetConfig } from "../lib/wagers_config.ts";

async function testConfig() {
  resetConfig();
  return await loadConfig("config/wagers.json");
}

function row(overrides: Partial<WagerRow>): WagerRow {
  return {
    ticket: "T1",
    betGroup: "G1",
    state: "win",
    risk: 100,
    toWin: 90,
    result: 90,
    betTime: new Date(2026, 9, 20, 12, 0, 0),
    player: "P1",
    agent: "A1",
    event: "E1",
    ...overrides,
  };
}

describe("wagers config", () => {
  test("loads and validates config/wagers.json", async () => {
    const cfg = await testConfig();
    expect(cfg.version).toBe(8);
    expect(cfg.default.days).toBe(14);
    expect(Object.keys(cfg.states)).toContain("cancel");
    expect(cfg.columns.state).toBe(40);
    expect(cfg.columns.ticket).toBe(4);
  });

  test("rejects an invalid config", async () => {
    resetConfig();
    const tmp = `scratch/wagers-bad-${Date.now()}.json`;
    await Bun.write(tmp, JSON.stringify({ version: 1 }));
    await expect(loadConfig(tmp)).rejects.toThrow(
      /wagers config validation failed/,
    );
    const { rm } = await import("node:fs/promises");
    await rm(tmp, { force: true });
    resetConfig();
  });
});

describe("date parsing", () => {
  test("accepts M/D/YYYY and YYYY-MM-DD", () => {
    expect(parseDateArg("10/25/2026")?.getDate()).toBe(25);
    expect(parseDateArg("2026-10-25")?.getDate()).toBe(25);
    expect(parseDateArg("bogus")).toBeNull();
  });
});

describe("csv row parsing (config column map)", () => {
  test("maps columns from config, skips short rows and bad times", async () => {
    const cfg = await testConfig();
    const good = Array.from({ length: 41 }, () => "");
    good[cfg.columns.ticket] = "1069664168";
    good[cfg.columns.betGroup] = "318478047";
    good[cfg.columns.state] = "pending";
    good[cfg.columns.risk] = "20";
    good[cfg.columns.toWin] = "24.8";
    good[cfg.columns.result] = "0";
    good[cfg.columns.betTime] = "20:50:49 10/24/2026";
    const badTime = [...good];
    badTime[cfg.columns.betTime] = "not a time";
    const fromDay = new Date(2026, 9, 18);
    const toDay = new Date(2026, 9, 24, 23, 59, 59, 999);
    const { wagers, shortRow, unparseableTime } = parseWagersFromCsvRows(
      [good, badTime, ["too", "short"]],
      cfg,
      fromDay,
      toDay,
    );
    expect(wagers).toHaveLength(1);
    expect(wagers[0]?.ticket).toBe("1069664168");
    expect(wagers[0]?.state).toBe("pending");
    expect(shortRow).toBe(1);
    expect(unparseableTime).toBe(1);
  });
});

describe("bet object parsing (live API)", () => {
  test("maps Bet* fields and trims state", async () => {
    const cfg = await testConfig();
    const fromDay = new Date(2026, 9, 18);
    const toDay = new Date(2026, 9, 24, 23, 59, 59, 999);
    const { wagers } = parseWagersFromBets(
      [
        {
          Ticket: "1069664168",
          BetGroup: "318478047",
          State: " win ",
          Risk: "20",
          ToWin: "24.8",
          Result: "24.8",
          BetTime: "20:50:49 10/24/2026",
        },
      ],
      cfg,
      fromDay,
      toDay,
    );
    expect(wagers).toHaveLength(1);
    expect(wagers[0]?.state).toBe("win");
    expect(wagers[0]?.ticket).toBe("1069664168");
  });
});

describe("group sizes, filters, buckets", () => {
  test("legs = bet-group size across the full window", () => {
    const wagers = [
      row({ ticket: "T1", betGroup: "G1", state: "cancel" }),
      row({ ticket: "T2", betGroup: "G1", state: "cancel" }),
      row({ ticket: "T3", betGroup: "G2", state: "win" }),
    ];
    const sizes = computeGroupSizes(wagers);
    expect(sizes.get("G1")).toBe(2);
    expect(sizes.get("G2")).toBe(1);
  });

  test("state + legs + wager-number filters compose", () => {
    const wagers = [
      row({ ticket: "T1", betGroup: "G1", state: "cancel" }),
      row({ ticket: "T2", betGroup: "G1", state: "cancel" }),
      row({ ticket: "T3", betGroup: "G2", state: "win" }),
    ];
    const sizes = computeGroupSizes(wagers);
    const filtered = applyFilters(wagers, sizes, {
      stateFilter: "cancel",
      wagerNumberFilter: undefined,
      legsFilter: 2,
    });
    expect(filtered.map((w) => w.ticket).sort()).toEqual(["T1", "T2"]);

    const byNumber = applyFilters(wagers, sizes, {
      stateFilter: undefined,
      wagerNumberFilter: "T3",
      legsFilter: undefined,
    });
    expect(byNumber).toHaveLength(1);
  });

  test("parseFilters is driven by cfg.filters (= and space-separated)", async () => {
    const cfg = await testConfig();
    expect(parseFilters(["--state=cancel"], cfg).stateFilter).toBe("cancel");
    expect(parseFilters(["--nlegs", "2"], cfg).legsFilter).toBe(2);
    expect(
      parseFilters(["--wager-number", "1069664168"], cfg).wagerNumberFilter,
    ).toBe("1069664168");
    expect(parseFilters(["--state", "win"], cfg).stateFilter).toBe("win");
    // unknown flags are ignored, not errors
    expect(parseFilters(["--bogus=1"], cfg)).toEqual({
      stateFilter: undefined,
      wagerNumberFilter: undefined,
      legsFilter: undefined,
    });
  });

  test("filterLabels derives from config filter keys", async () => {
    const cfg = await testConfig();
    expect(
      filterLabels(cfg, {
        stateFilter: "cancel",
        wagerNumberFilter: undefined,
        legsFilter: 2,
      }),
    ).toEqual(["state=cancel", "legs=2"]);
  });

  test("parseFormat defaults from config and rejects unknown", async () => {
    const cfg = await testConfig();
    expect(parseFormat([], cfg)).toBe(cfg.default.format);
    expect(parseFormat(["--format=json"], cfg)).toBe("json");
    expect(parseFormat(["--format", "csv"], cfg)).toBe("csv");
    expect(() => parseFormat(["--format=xml"], cfg)).toThrow(
      /invalid --format/,
    );
  });

  test("buildBetReportBody comes from cfg.live", async () => {
    const cfg = await testConfig();
    const body = buildBetReportBody(cfg, 1792904400, 1793771999);
    expect(body.action).toBe("getBetReport");
    expect(body.dateFilterBy).toBe("logTime");
    expect(body.from).toBe(1792904400);
    expect(body.to).toBe(1793771999);
    expect(body.fromTime).toBe(cfg.live.fromTime);
    expect(body.toTime).toBe(cfg.live.toTime);
  });

  test("buckets sum risk/toWin/result and sort by config order", async () => {
    const cfg = await testConfig();
    const wagers = [
      row({ state: "lose", risk: 100, result: -100 }),
      row({ state: "win", risk: 50, result: 45 }),
      row({ state: "bogus-state", risk: 10, result: 0 }),
    ];
    const sizes = computeGroupSizes(wagers);
    const buckets = bucketByState(wagers, sizes);
    expect(buckets.get("lose")?.riskDollars).toBe(100);
    const sorted = sortBuckets([...buckets.values()], cfg);
    // win (sortOrder 1) before lose (2); unknown last
    expect(sorted.map((b) => b.state)).toEqual(["win", "lose", "bogus-state"]);
  });

  test("renderTable prints header, rows, and TOTAL", async () => {
    const cfg = await testConfig();
    const { lines } = renderTable(
      [
        {
          state: "cancel",
          count: 2,
          riskDollars: 40,
          toWinDollars: 81.2,
          resultDollars: 0,
          legsTotal: 4,
        },
      ],
      cfg,
    );
    const text = lines.join("\n");
    expect(text).toContain("State");
    expect(text).toContain("cancel");
    expect(text).toContain("TOTAL");
    expect(text).toContain("$40.00");
  });

  test("renderReport json/csv round-trip the same buckets", async () => {
    const cfg = await testConfig();
    const buckets = [
      {
        state: "cancel",
        count: 2,
        riskDollars: 40,
        toWinDollars: 81.2,
        resultDollars: 0,
        legsTotal: 4,
      },
    ];
    const [jsonDoc = ""] = renderReport(buckets, cfg, "json");
    const parsed = JSON.parse(jsonDoc);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].state).toBe("cancel");
    expect(parsed.total.count).toBe(2);
    expect(parsed.total.legsTotal).toBe(4);

    const [csvDoc = ""] = renderReport(buckets, cfg, "csv");
    const csvLines = csvDoc.split("\n");
    expect(csvLines[0] ?? "").toContain("State");
    expect(csvLines[1]).toContain("cancel");
    expect(csvLines[csvLines.length - 1]).toContain("TOTAL");
  });

  test("sumGrand totals every bucket once", () => {
    const grand = sumGrand([
      {
        state: "win",
        count: 2,
        riskDollars: 50,
        toWinDollars: 45,
        resultDollars: 45,
        legsTotal: 3,
      },
      {
        state: "lose",
        count: 1,
        riskDollars: 100,
        toWinDollars: 90,
        resultDollars: -100,
        legsTotal: 1,
      },
    ]);
    expect(grand).toMatchObject({
      state: "TOTAL",
      count: 3,
      legsTotal: 4,
      riskDollars: 150,
      resultDollars: -55,
    });
  });

  test("splitOutput keeps machine formats parseable", async () => {
    const cfg = await testConfig();
    const buckets = [
      {
        state: "cancel",
        count: 1,
        riskDollars: 10,
        toWinDollars: 9,
        resultDollars: 0,
        legsTotal: 2,
      },
    ];
    const table = splitOutput(
      "table",
      "title",
      renderReport(buckets, cfg, "table"),
      ["meta"],
    );
    expect(table.stderr).toEqual([]);
    expect(table.stdout[0]).toBe("title");

    const json = splitOutput(
      "json",
      "title",
      renderReport(buckets, cfg, "json"),
      ["meta"],
    );
    expect(() => JSON.parse(json.stdout.join("\n"))).not.toThrow();
    expect(json.stderr).toContain("title");
    expect(json.stderr).toContain("meta");

    const csv = splitOutput(
      "csv",
      "title",
      renderReport(buckets, cfg, "csv"),
      [],
    );
    expect(csv.stdout[0]).toContain("State");
    expect(csv.stderr).toEqual(["title"]);
  });

  test("parseOutArg reads = and space-separated paths", () => {
    expect(parseOutArg([])).toBeUndefined();
    expect(parseOutArg(["--out=scratch/a.json"])).toBe("scratch/a.json");
    expect(parseOutArg(["--out", "scratch/b.csv"])).toBe("scratch/b.csv");
  });

  test("parseGroupBy defaults from config and validates", async () => {
    const cfg = await testConfig();
    expect(parseGroupBy([], cfg)).toBe(cfg.default.groupBy);
    expect(parseGroupBy(["--group-by=day"], cfg)).toBe("day");
    expect(parseGroupBy(["--group-by", "event"], cfg)).toBe("event");
    expect(() => parseGroupBy(["--group-by=bogus"], cfg)).toThrow(
      /invalid --group-by/,
    );
  });

  test("groupValue reads the right dimension", () => {
    const r = row({
      state: "win",
      player: "NIPS214",
      agent: "NOASTE50",
      event: "Wisconsin vs USC",
      betTime: new Date(2026, 9, 24, 20, 50, 49),
    });
    expect(groupValue(r, "state")).toBe("win");
    expect(groupValue(r, "day")).toBe("2026-10-24");
    expect(groupValue(r, "event")).toBe("Wisconsin vs USC");
    expect(groupValue(r, "player")).toBe("NIPS214");
    expect(groupValue(r, "agent")).toBe("NOASTE50");
  });

  test("bucketBy + sortGroups honor the group strategy", async () => {
    const cfg = await testConfig();
    const wagers = [
      row({ event: "E-small", risk: 10, betTime: new Date(2026, 9, 20) }),
      row({ event: "E-big", risk: 500, betTime: new Date(2026, 9, 21) }),
      row({ event: "E-big", risk: 100, betTime: new Date(2026, 9, 21) }),
    ];
    const sizes = computeGroupSizes(wagers);
    const byEvent = bucketBy(wagers, sizes, (w) => groupValue(w, "event"));
    expect(byEvent.get("E-big")?.count).toBe(2);
    const sortedEvents = sortGroups([...byEvent.values()], cfg, "event");
    expect(sortedEvents.map((b) => b.state)).toEqual(["E-big", "E-small"]);

    const byDay = bucketBy(wagers, sizes, (w) => groupValue(w, "day"));
    const sortedDays = sortGroups([...byDay.values()], cfg, "day");
    expect(sortedDays.map((b) => b.state)).toEqual([
      "2026-10-20",
      "2026-10-21",
    ]);
  });

  test("renderReport labels the group column", async () => {
    const cfg = await testConfig();
    const buckets = [
      {
        state: "2026-10-24",
        count: 2,
        riskDollars: 40,
        toWinDollars: 81.2,
        resultDollars: 0,
        legsTotal: 4,
      },
    ];
    const [table = ""] = renderReport(buckets, cfg, "table", "day");
    expect(table).toContain("Day");
    const [csv = ""] = renderReport(buckets, cfg, "csv", "day");
    expect(csv.split("\n")[0] ?? "").toContain("Day");
    const [summary = ""] = renderReport(buckets, cfg, "summary", "day");
    expect(summary).toContain("2026-10-24");
    expect(summary).toContain("risk=$");
    expect(summary).toContain("legs=");
  });

  test("GroupSummary honors the Bun.inspect.custom contract", async () => {
    const { inspect: nodeInspect } = await import("node:util");
    // Same symbol as Node's util.inspect.custom — one override covers both.
    expect(Bun.inspect.custom).toBe(nodeInspect.custom);

    const s = new GroupSummary("state", "cancel", 9897.83, 51, 37, 11019.74, 0);
    const line = `${"cancel".padEnd(20)} risk=$${(9897.83).toString().padStart(7)} legs=51`;
    // console.log, Bun.inspect, and Node's util.inspect all use the override.
    expect(Bun.inspect(s)).toBe(line);
    expect(nodeInspect(s)).toBe(line);
    // Nested containers and depth limits compose; the line stays atomic.
    expect(Bun.inspect({ rows: [s], total: 1 })).toContain(line);
    expect(Bun.inspect(s, { colors: true })).toBe(`\u001b[1m${line}\u001b[22m`);
    expect(s.toJSON()).toMatchObject({
      group: "state",
      label: "cancel",
      risk: 9897.83,
      legs: 51,
      count: 37,
    });
    expect(JSON.parse(JSON.stringify(s)).group).toBe("state");
    // Plain objects keep Bun's multi-line default.
    expect(Bun.inspect({ foo: "bar" })).toContain('foo: "bar"');
  });

  test("inspect format pretty-prints full GroupSummary objects", async () => {
    const cfg = await testConfig();
    const buckets = [
      {
        state: "cancel",
        count: 37,
        riskDollars: 9897.83,
        toWinDollars: 11019.74,
        resultDollars: 0,
        legsTotal: 51,
      },
    ];
    // toJSON keeps the class machine-readable: serializing summaries
    // yields group/label objects, not custom-inspect strings.
    const [summaryJson] = [JSON.stringify(summarizeGroups(buckets, "state"))];
    expect(JSON.parse(summaryJson)[0]).toMatchObject({
      group: "state",
      label: "cancel",
      risk: 9897.83,
      legs: 51,
    });
    const [jsonDoc = ""] = renderReport(buckets, cfg, "json", "state");
    expect(JSON.parse(jsonDoc).rows[0]).toMatchObject({
      state: "cancel",
      riskDollars: 9897.83,
    });

    // inspect format uses Bun's pretty-printer over real objects, so the
    // one-line custom inspect appears once per element inside the array.
    const [pretty = ""] = renderReport(buckets, cfg, "inspect", "state");
    expect(pretty).toContain("cancel");
    expect(pretty).toContain("risk=$");
    // Plain objects still get the multi-line treatment (Bun default).
    expect(Bun.inspect({ foo: "bar" })).toContain('foo: "bar"');
  });

  test("summarizeGroups preserves order and carries totals", () => {
    const summaries = summarizeGroups(
      [
        {
          state: "win",
          count: 2,
          riskDollars: 50,
          toWinDollars: 45,
          resultDollars: 45,
          legsTotal: 3,
        },
      ],
      "state",
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toBeInstanceOf(GroupSummary);
    expect(summaries[0]?.group).toBe("state");
    expect(summaries[0]?.label).toBe("win");
    expect(summaries[0]?.risk).toBe(50);
    expect(summaries[0]?.legs).toBe(3);
  });

  test("formatElapsed renders Bun.nanoseconds deltas without sleeping", () => {
    expect(formatElapsed(0, 0)).toBe("0.00ms");
    expect(formatElapsed(0, 5_000_000)).toBe("5.00ms");
    expect(formatElapsed(0, 42_000_000)).toBe("42ms");
    expect(formatElapsed(0, 1_420_000_000)).toBe("1.42s");
    expect(formatElapsed(10, 5)).toBe("0.00ms"); // clamped, never negative
    const t0 = Bun.nanoseconds();
    expect(formatElapsed(t0, Bun.nanoseconds())).toMatch(/^\d+(\.\d+)?m?s$/);
  });

  test("takeTop and parseTopArg bound the view", () => {
    const buckets = [
      {
        state: "a",
        count: 1,
        riskDollars: 1,
        toWinDollars: 1,
        resultDollars: 0,
        legsTotal: 1,
      },
      {
        state: "b",
        count: 2,
        riskDollars: 2,
        toWinDollars: 2,
        resultDollars: 0,
        legsTotal: 2,
      },
    ];
    expect(takeTop(buckets, undefined)).toHaveLength(2);
    expect(takeTop(buckets, 1)).toHaveLength(1);
    expect(parseTopArg([])).toBeUndefined();
    expect(parseTopArg(["--top=3"])).toBe(3);
    expect(parseTopArg(["--top", "5"])).toBe(5);
    expect(parseTopArg(["--top=nope"])).toBeUndefined();
  });

  test("toColumnar packs exact ints and float dollars", () => {
    const col = toColumnar([
      {
        state: "cancel",
        count: 37,
        riskDollars: 9897.83,
        toWinDollars: 11019.74,
        resultDollars: 0,
        legsTotal: 51,
      },
      {
        state: "win",
        count: 8281,
        riskDollars: 1643813.93,
        toWinDollars: 1237089.49,
        resultDollars: 1237089.43,
        legsTotal: 11375,
      },
    ]);
    expect(col.groups).toEqual(["cancel", "win"]);
    expect(col.count).toBeInstanceOf(Uint32Array);
    expect(col.legs).toBeInstanceOf(Uint32Array);
    expect(col.risk).toBeInstanceOf(Float64Array);
    expect([...col.count]).toEqual([37, 8281]);
    expect([...col.legs]).toEqual([51, 11375]);
    expect(col.risk[0]).toBeCloseTo(9897.83, 10);
    expect(col.result[1]).toBeCloseTo(1237089.43, 10);
  });

  test("typed arrays inspect in compact Type(n) form", () => {
    expect(Bun.inspect(new Uint8Array([1, 2, 3]))).toBe(
      "Uint8Array(3) [ 1, 2, 3 ]",
    );
    expect(Bun.inspect(new Uint16Array([1, 2, 3]))).toBe(
      "Uint16Array(3) [ 1, 2, 3 ]",
    );
    expect(Bun.inspect(new Float64Array([1.5, 28868.41]))).toBe(
      "Float64Array(2) [ 1.5, 28868.41 ]",
    );
  });

  test("columns format renders the packed arrays", async () => {
    const cfg = await testConfig();
    const [doc = ""] = renderReport(
      [
        {
          state: "cancel",
          count: 37,
          riskDollars: 9897.83,
          toWinDollars: 11019.74,
          resultDollars: 0,
          legsTotal: 51,
        },
      ],
      cfg,
      "columns",
      "state",
    );
    expect(doc).toContain("Uint32Array(1) [ 37 ]");
    expect(doc).toContain("Float64Array(1) [ 9897.83 ]");
  });

  test("padDisplay aligns by terminal columns, not code units", () => {
    expect(Bun.stringWidth("🎰 win")).toBe(6); // wide emoji counts 2
    expect(padDisplay("🎰 win", 10, "left")).toBe("🎰 win    ");
    expect(Bun.stringWidth(padDisplay("🎰 win", 10, "left"))).toBe(10);
    expect(padDisplay("ab", 5, "right")).toBe("   ab");
    const bold = "\u001b[1mcancel\u001b[22m";
    expect(Bun.stringWidth(bold)).toBe(6); // ANSI codes ignored
    expect(Bun.stringWidth(padDisplay(bold, 10, "left"))).toBe(10);
  });

  test("grid format draws a native box table with all groups", async () => {
    const cfg = await testConfig();
    const buckets = [
      {
        state: "cancel",
        count: 37,
        riskDollars: 9897.83,
        toWinDollars: 11019.74,
        resultDollars: 0,
        legsTotal: 51,
      },
      {
        state: "win",
        count: 8281,
        riskDollars: 1643813.93,
        toWinDollars: 1237089.49,
        resultDollars: 1237089.43,
        legsTotal: 11375,
      },
    ];
    const [doc = ""] = renderReport(buckets, cfg, "grid", "state");
    expect(doc).toContain("┌");
    expect(doc).toContain("cancel");
    expect(doc).toContain("TOTAL");
    const grid = renderGrid(buckets, sumGrand(buckets), cfg, "State");
    expect(grid).toContain("Risk ($)");
    // Piped (non-TTY) output carries no ANSI: the enableANSIColors gate holds.
    expect(Bun.stripANSI(doc)).toBe(doc);
  });
});
