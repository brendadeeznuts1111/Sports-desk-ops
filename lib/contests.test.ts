import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  contestsInGroup,
  extractContests,
  parseContestType,
  readContestFile,
  searchContests,
  stripPadding,
  summarizeContests,
  type ContestFile,
} from "./contests.ts";

const markup = readFileSync(
  resolve(import.meta.dir, "../tests/fixtures/contests-markup-sample.html"),
  "utf8",
);

const file: ContestFile = {
  schemaVersion: 1,
  source: "markup:fixture",
  extractedAt: null,
  entries: extractContests(markup),
};

describe("stripPadding", () => {
  test("turns single separators into spaces and collapses runs", () => {
    expect(stripPadding("Odds‡to‡win‡Mexico‡Open")).toBe(
      "Odds to win Mexico Open",
    );
    expect(stripPadding("GOLF‡‡‡‡Mexico‡Open")).toBe("GOLF Mexico Open");
    expect(stripPadding(undefined)).toBe("");
  });
});

describe("parseContestType", () => {
  test("splits on runs, not on single separators", () => {
    const parsed = parseContestType(
      "FOOTBALL‡‡‡‡‡‡‡‡NFL‡1st‡TD‡Scorer‡‡‡‡‡‡‡‡Chargers‡vs‡Rams",
    );
    expect(parsed.sport).toBe("FOOTBALL");
    expect(parsed.market).toBe("NFL 1st TD Scorer");
    expect(parsed.subject).toBe("Chargers vs Rams");
    expect(parsed.partial).toBe(false);
  });

  test("keeps multi-word markets intact", () => {
    const parsed = parseContestType(
      "GOLF‡‡‡‡‡‡‡Mexico‡Open‡Futures‡‡‡‡‡‡‡To‡Win‡Outright",
    );
    expect(parsed.market).toBe("Mexico Open Futures");
    expect(parsed.subject).toBe("To Win Outright");
  });

  test("flags a type with fewer than three fields instead of inventing one", () => {
    const parsed = parseContestType("GOLF‡‡‡‡Mexico");
    expect(parsed.sport).toBe("GOLF");
    expect(parsed.market).toBe("Mexico");
    expect(parsed.subject).toBeNull();
    expect(parsed.partial).toBe(true);
  });
});

describe("extractContests", () => {
  test("reads every anchor and inherits its data-group", () => {
    expect(file.entries).toHaveLength(4);
    expect(file.entries.map((entry) => entry.group).sort()).toEqual([
      "FOOTBALL",
      "GOLF",
      "GOLF",
      "RUGBY",
    ]);
  });

  test("keeps the contest number as the key", () => {
    const football = file.entries.find((entry) => entry.group === "FOOTBALL");
    expect(football?.contestNum).toBe(235759423);
    expect(football?.description).toBe("Chargers vs Rams 1st TD Scorer");
  });

  test("decodes HTML entities inside data-param", () => {
    // The fixture stores data-param with &quot; escapes; a failed decode yields no entries.
    expect(file.entries.every((entry) => entry.type.includes("‡"))).toBe(true);
  });

  test("ignores anchors without a usable contestNum", () => {
    const html = `<div data-group="X"><a data-param="{&quot;contestNum&quot;:0}"></a>
      <a data-param="{&quot;contestNum&quot;:&quot;abc&quot;}"></a>
      <a data-param="not json"></a></div>`;
    expect(extractContests(html)).toEqual([]);
  });

  test("deduplicates a contest linked from two groups, first wins", () => {
    const html = `<div data-group="A"><a data-param="{&quot;contestNum&quot;:5,&quot;contestDesc&quot;:&quot;One&quot;}"></a></div>
      <div data-group="B"><a data-param="{&quot;contestNum&quot;:5,&quot;contestDesc&quot;:&quot;One&quot;}"></a></div>`;
    const entries = extractContests(html);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.group).toBe("A");
  });

  test("sorts by contest number", () => {
    const numbers = file.entries.map((entry) => entry.contestNum);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
  });
});

describe("queries", () => {
  test("filters by group, case-insensitively", () => {
    expect(contestsInGroup(file, "golf")).toHaveLength(2);
    expect(contestsInGroup(file, "")).toHaveLength(4);
    expect(contestsInGroup(file, "CRICKET")).toEqual([]);
  });

  test("searches description, group, and parsed segments", () => {
    expect(searchContests(file, "mexico")).toHaveLength(2);
    expect(searchContests(file, "chargers")).toHaveLength(1);
    expect(searchContests(file, "rugby")).toHaveLength(1);
    expect(searchContests(file, "235759244")).toHaveLength(1);
    expect(searchContests(file, "")).toHaveLength(4);
  });

  test("summarises totals and partial entries", () => {
    const summary = summarizeContests(file);
    expect(summary.total).toBe(4);
    expect(summary.byGroup.GOLF).toBe(2);
    expect(summary.partial).toBe(0);
  });

  test("readContestFile rejects foreign payloads", () => {
    expect(readContestFile(null)).toBeNull();
    expect(readContestFile({})).toBeNull();
    expect(readContestFile({ entries: [] })?.entries).toEqual([]);
  });
});
