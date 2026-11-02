import { describe, expect, test } from "bun:test";
import {
  ANALYSIS_ACTIVITIES,
  ANALYSIS_GROUPS,
  ANALYSIS_REPORTS,
  ANALYSIS_REQUIRED_CAPTURE,
  ANALYSIS_WEEKS,
  describeSelection,
  parseAnalysisQuery,
} from "./analysis_filters.ts";

const parse = (query: string) => parseAnalysisQuery(new URLSearchParams(query));

describe("vocabulary matches the portal filter bar", () => {
  test("report kinds are CP, CPS, CPV and G", () => {
    expect(ANALYSIS_REPORTS.map((o) => o.value)).toEqual([
      "CP",
      "CPS",
      "CPV",
      "G",
    ]);
  });

  test("activity codes keep the portal's numeric values and labels", () => {
    const values = ANALYSIS_ACTIVITIES.map((o) => o.value);
    expect(values).toEqual([
      "-1",
      "0",
      "1",
      "5",
      "2",
      "3",
      "4",
      "7",
      "8",
      "10",
      "11",
      "12",
      "14",
      "15",
    ]);
    const byValue = new Map(ANALYSIS_ACTIVITIES.map((o) => [o.value, o.label]));
    expect(byValue.get("-1")).toBe("All Action");
    expect(byValue.get("4")).toBe("Live Betting");
    expect(byValue.get("15")).toBe("Git Casino");
  });

  test("group and week modes match the portal options", () => {
    expect(ANALYSIS_GROUPS.map((o) => o.value)).toEqual(["1", "2"]);
    expect(ANALYSIS_WEEKS.map((o) => o.value)).toEqual([
      "-1",
      "0",
      "1",
      "enter-dates",
    ]);
    expect(ANALYSIS_WEEKS[3]?.label).toBe("Entered Dates");
  });
});

describe("parseAnalysisQuery", () => {
  test("defaults to Customer Performance, all action, group agent, today", () => {
    const result = parse("");
    expect(result.ok).toBe(true);
    expect(result.selection).toEqual({
      report: "CP",
      activity: "-1",
      group: "1",
      week: "-1",
      agent: "",
    });
  });

  test("accepts every documented code", () => {
    for (const report of ANALYSIS_REPORTS) {
      for (const activity of ANALYSIS_ACTIVITIES) {
        const result = parse(
          `report=${report.value}&activity=${activity.value}`,
        );
        expect(result.ok).toBe(true);
      }
    }
  });

  test("rejects an unknown code instead of coercing it", () => {
    const result = parse("report=XX");
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("report must be one of CP, CPS, CPV, G");
  });

  test("rejects an unknown activity, group and week together", () => {
    const result = parse("activity=99&group=7&week=3");
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(3);
    expect(result.errors.join(" ")).toContain("activity must be one of");
    expect(result.errors.join(" ")).toContain("group must be 1 or 2");
  });

  test("trims the agent and keeps it optional", () => {
    expect(parse("agent=  HRGROUP  ").selection?.agent).toBe("HRGROUP");
  });
});

describe("describeSelection", () => {
  test("restates a selection in portal vocabulary", () => {
    const selection = parse(
      "report=CPV&activity=4&group=2&week=0&agent=MJ2026",
    ).selection;
    expect(describeSelection(selection!)).toBe(
      "Customer Volume · Live Betting · Sorting Columns · This Week · agent MJ2026",
    );
  });

  test("says all agents when none is chosen", () => {
    expect(describeSelection(parse("").selection!)).toContain("all agents");
  });
});

describe("required capture", () => {
  test("names the operation that serves the report and what is still missing", () => {
    // The URL is settled now: an observed request goes to Manager/getAgentPerformance.
    expect(ANALYSIS_REQUIRED_CAPTURE).toContain(
      "/cloud/api/Manager/getAgentPerformance",
    );
    // Only the response is missing, and the text must say so rather than imply a request gap.
    expect(ANALYSIS_REQUIRED_CAPTURE).toContain("only the response is missing");
    expect(ANALYSIS_REQUIRED_CAPTURE).toContain("no column set is documented");
    // The two decoys are named so nobody re-conflates them with this report.
    expect(ANALYSIS_REQUIRED_CAPTURE).toContain("Report/getAnalysis");
    expect(ANALYSIS_REQUIRED_CAPTURE).toContain("getReportPlayerAnalysis");
  });
});
