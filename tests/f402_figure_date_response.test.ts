/**
 * Operator-supplied 2026-11-12 getWagersByFigureDate response for BRT106.
 *
 * Observed body, not a probe capture (no headers/status). Two things it pins:
 * the LIST.INFO envelope parses to six rows, and the settled sums agree with the
 * performance endpoint's 11/12 row — two independent reads of the same day.
 */
import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import {
  enrichWagerRecord,
  parseFigureDateWagersPayload,
  type LiveTickerWager,
} from "../lib/f402_figure_date_enricher.ts";
import {
  parsePlayerPerformancePayload,
  summarizePlayerPerformance,
} from "../lib/f402_player_performance.ts";
import { buildManagerWagersByFigureDatePayload } from "../lib/f402_probe.ts";

const FIGURE = resolve(
  import.meta.dir,
  "fixtures/f402-get-wagers-by-figure-date.response.json",
);
const PERFORMANCE = resolve(
  import.meta.dir,
  "fixtures/f402-get-performance-player.response.json",
);

describe("getWagersByFigureDate response", () => {
  it("parses the envelope and ignores the casino arrays", async () => {
    const raw = (await Bun.file(FIGURE).json()) as unknown;
    const rows = parseFigureDateWagersPayload(raw);
    expect(rows.length).toBe(6);
    expect(rows[0]?.TicketNumber).toBe(1078795022);
    expect(rows[0]?.CustomerID).toBe("BRT106    ");
    expect(rows[0]?.WagerStatus).toBe("W");
    expect(rows[3]?.Outcome).toBe("L");
  });

  it("settled sums match the performance endpoint's 11/12 row", async () => {
    const figureRows = parseFigureDateWagersPayload(
      (await Bun.file(FIGURE).json()) as unknown,
    );
    const won = figureRows.reduce((sum, r) => sum + r.AmountWon, 0);
    const lost = figureRows.reduce((sum, r) => sum + r.AmountLost, 0);

    const perf = parsePlayerPerformancePayload(
      (await Bun.file(PERFORMANCE).json()) as unknown,
    );
    const day = perf.find((d) => d.Date.startsWith("11/12/2026"));
    expect(day).toBeDefined();
    expect(won).toBe(day!.Won);
    expect(lost).toBe(day!.Lost);
    expect(summarizePlayerPerformance(perf).days).toBe(31);
  });

  it("enriches a matching ticker row through the real pipeline", async () => {
    const rows = parseFigureDateWagersPayload(
      (await Bun.file(FIGURE).json()) as unknown,
    );
    const figure = rows[0]!;
    const ticker: LiveTickerWager = {
      WagerNumber: 1078800001,
      AgentID: "BILLY666",
      AgentLogin: "BILLY666",
      CustomerID: "BRT106    ",
      Login: "BRT106",
      WagerType: "S",
      AmountWagered: 275000,
      ToWinAmount: 250000,
      InsertDateTime: "2026-11-12 21:07:00.000",
      TicketWriter: "Internet",
      ShortDesc: "S.Basketball #758 Texas A&M -1&#189; -110 - For 2nd Half",
    };
    const enriched = enrichWagerRecord(ticker, figure);
    expect(enriched.ticketNumber).toBe("1078795022");
    expect<string>(enriched.customerId).toBe("BRT106");
    expect(enriched.eventId).toBe("NCAA-20261112-OklahomaSt@TexasA&M");
    expect(enriched.marketType).toBe("spread");
    expect(enriched.selection.chosenTeam).toBe("Texas A&M");
  });
});

describe("probe builder matches the observed request", () => {
  it("reproduces the 2026-11-13 body shape", () => {
    expect(
      buildManagerWagersByFigureDatePayload({
        agentID: "BILLY666",
        customerID: "BRT106",
        date: "2026-11-13",
        figureDate: "2026-11-12",
      }),
    ).toEqual({
      RRO: 1,
      agentID: "BILLY666",
      agentOwner: "BILLY666",
      customerID: "BRT106",
      date: "2026-11-13",
      figureDate: "2026-11-12",
      graded: 0,
      path: "/cloud/api/Report/getWagersByFigureDate",
      sort: 1,
      typeSort: 2,
      week: 0,
    });
  });
});
