import { describe, expect, test } from "bun:test";
import { formatOperatorBrief } from "../packages/ui/src/ticket_inspector.ts";
import {
  formatWagerSelection,
  selectionIncludesLine,
} from "../packages/ui/src/wager_display.ts";
import type { LiveWager } from "../packages/ui/src/types.ts";
import { FIXTURE_LIVE_WAGERS } from "./fixtures/dashboard_ui_fixtures.ts";

/** Ticket 769158444 as hydrated by GET /api/wagers: selection and line coincide. */
const TTN29_TICKET = {
  selection: "Steelers (Live) +27½ +100",
  lineDisplay: "Steelers (Live) +27½ +100",
  oddsAmerican: "-110",
};

describe("wager_display · selection/line composition", () => {
  test("prints a duplicated selection once (ticket 769158444)", () => {
    expect(formatWagerSelection(TTN29_TICKET)).toBe(
      "Steelers (Live) +27½ +100 (-110)",
    );
  });

  test("decodes capture entities before comparing the line", () => {
    expect(
      formatWagerSelection({
        selection: "Thunder/Kings U 112&#189; -110",
        lineDisplay: "Thunder/Kings U 112&#189; -110",
        oddsAmerican: "-110",
      }),
    ).toBe("Thunder/Kings U 112½ -110 (-110)");
  });

  test("composes a distinct line and price", () => {
    expect(
      formatWagerSelection({
        selection: "Over",
        lineDisplay: "44½",
        oddsAmerican: "-110",
      }),
    ).toBe("Over 44½ (-110)");
  });

  test("keeps a moneyline marker without repeating it", () => {
    expect(
      formatWagerSelection({
        selection: "KC Chiefs",
        lineDisplay: "ML",
        oddsAmerican: "-165",
      }),
    ).toBe("KC Chiefs ML (-165)");
    expect(
      formatWagerSelection({
        selection: "KC Chiefs ML",
        lineDisplay: "ML",
        oddsAmerican: "-165",
      }),
    ).toBe("KC Chiefs ML (-165)");
  });

  test("does not swallow a short numeric line as a substring", () => {
    expect(
      formatWagerSelection({
        selection: "Over 47.5",
        lineDisplay: "7",
        oddsAmerican: "-110",
      }),
    ).toBe("Over 47.5 7 (-110)");
  });

  test("tolerates padding and collapsed whitespace", () => {
    expect(
      formatWagerSelection({
        selection: "  Steelers  (Live)   +27½ +100 ",
        lineDisplay: "Steelers (Live) +27½ +100",
        oddsAmerican: "-110",
      }),
    ).toBe("Steelers (Live) +27½ +100 (-110)");
  });

  test("falls back to the line, then to an em dash", () => {
    expect(
      formatWagerSelection({
        selection: "",
        lineDisplay: "44½",
        oddsAmerican: "-110",
      }),
    ).toBe("44½ (-110)");
    expect(
      formatWagerSelection({
        selection: "",
        lineDisplay: "",
        oddsAmerican: "",
      }),
    ).toBe("—");
  });

  test("can omit the price", () => {
    expect(formatWagerSelection(TTN29_TICKET, { includeOdds: false })).toBe(
      "Steelers (Live) +27½ +100",
    );
  });

  test("line containment respects whole tokens", () => {
    expect(selectionIncludesLine("Over 47.5", "7")).toBe(false);
    expect(selectionIncludesLine("Team +3.5", "+3.5")).toBe(true);
    expect(selectionIncludesLine("+3.5 Team", "+3.5")).toBe(true);
    expect(selectionIncludesLine("Team", "")).toBe(true);
    expect(selectionIncludesLine("", "+3.5")).toBe(false);
  });
});

describe("wager_display · operator brief", () => {
  test("does not repeat the pick in the copied brief", () => {
    const ticket: LiveWager = {
      ...FIXTURE_LIVE_WAGERS[0]!,
      ticketId: "769158444",
      customerId: "TTN29",
      agentId: "APOLLO",
      masterAgent: "APOLLO",
      sport: "",
      subSport: null,
      betType: "Spread",
      event: "Event Matchup",
      selection: "Steelers (Live) +27½ +100",
      lineDisplay: "Steelers (Live) +27½ +100",
      oddsAmerican: "-110",
      alertTier: "LATENCY",
      alertBadge: "⚠️ LATENCY (In-Play)",
    };
    const brief = formatOperatorBrief(ticket);
    expect(brief).toContain("Event Matchup — Steelers (Live) +27½ +100 (-110)");
    expect(brief).not.toContain("+27½ +100 Steelers");
  });
});
