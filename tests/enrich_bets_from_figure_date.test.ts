/**
 * @file tests/enrich_bets_from_figure_date.test.ts
 * @description Invariant tests for the streaming enrichment CLI.
 */

import { describe, expect, it, onTestFinished } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runEnrichment } from "../scripts/enrich_bets_from_figure_date.ts";

const TMP_DIR = join(process.cwd(), "scratch/test_enrich_tmp");

describe("Streaming Enrichment CLI Pipeline", () => {
  it("streams and joins ticker rows against figure date report", async () => {
    mkdirSync(TMP_DIR, { recursive: true });
    onTestFinished(() => {
      rmSync(TMP_DIR, { recursive: true, force: true });
    });

    const figurePath = join(TMP_DIR, "figure.json");
    const tickerPath = join(TMP_DIR, "ticker.jsonl");
    const outPath = join(TMP_DIR, "enriched.jsonl");

    const figureData = {
      LIST: {
        INFO: [
          {
            TicketNumber: 1075710577,
            WagerNumber: 1,
            PlayNumber: 1,
            AmountWagered: 230000,
            ToWinAmount: 200000,
            WagerType: "S",
            AmountWon: 0,
            AmountLost: 230000,
            WagerStatus: "L",
            Description: "Basketball #546 Grizzlies +1 -115 - For 1st Quarter",
            AcceptedDateTime: "2026-11-06 20:09:35.077",
            CustomerID: "DAN245    ",
            TicketWriter: "Internet",
            GameDateTime: "2026-11-06 20:10:00.000",
            SportType: "Basketball          ",
            SportSubType: "NBA                 ",
            AdjSpread: 1,
            AdjTotalPoints: 0,
            FinalMoney: -115,
            ChosenTeamID: "Memphis Grizzlies",
            Outcome: "L",
            PeriodDescription: "1st Quarter         ",
            Team1ID: "Oklahoma City Thunder",
            Team1FinalScore: 35,
            Team2ID: "Memphis Grizzlies",
            Team2FinalScore: 28,
          },
        ],
      },
    };

    const tickerData = [
      JSON.stringify({
        WagerNumber: 767671190,
        CustomerID: "DAN245    ",
        AmountWagered: 230000,
        ToWinAmount: 200000,
        VolumeAmount: 0,
        InsertDateTime: "2026-11-06 20:09:29.680",
        TicketWriter: "ALERT",
        ShortDesc: "S:Basketball #546 Grizzlies +1 -115 - For 1st Quarter ",
      }),
      JSON.stringify({
        WagerNumber: 767671201,
        CustomerID: "DAN245    ",
        AmountWagered: 230000,
        ToWinAmount: 200000,
        VolumeAmount: 200000,
        InsertDateTime: "2026-11-06 20:09:35.080",
        TicketWriter: "Internet",
        ShortDesc: "S.Basketball #546 Grizzlies +1 -115 - For 1st Quarter",
      }),
      JSON.stringify({
        WagerNumber: 767671999,
        CustomerID: "OTHER1    ",
        AmountWagered: 10000,
        ToWinAmount: 9091,
        VolumeAmount: 10000,
        InsertDateTime: "2026-11-06 21:00:00.000",
        TicketWriter: "Internet",
        ShortDesc: "S.Football #101 Patriots -3 -110 - For Game",
      }),
    ].join("\n");

    writeFileSync(figurePath, JSON.stringify(figureData), "utf-8");
    writeFileSync(tickerPath, tickerData, "utf-8");

    const result = await runEnrichment({
      figurePath,
      tickerPath,
      outputPath: outPath,
      stats: false,
      format: "summary",
      inspect: false,
      sampleCount: 5,
    });

    expect(result.totalTickerRows).toBe(3);
    // ALERT row was skipped from output, 1 matched, 1 unmatched
    expect(result.matchedRows).toBe(1);
    expect(result.unmatchedRows).toBe(1);
    expect(result.inspection).toBeDefined();
    expect(result.inspection.stats.exactMatchedRows).toBe(1);
    expect(Number(result.inspection.stats.totalRiskCents)).toBe(230000);
    expect(result.inspection.samples.length).toBe(1);

    const outLines = readFileSync(outPath, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(outLines.length).toBe(2);

    const matched = outLines[0];
    expect(matched.ticketNumber).toBe("1075710577");
    expect(matched.liveWagerNumber).toBe(767671201);
    expect(matched.eventId).toBe(
      "NBA-20261106-OklahomaCityThunder@MemphisGrizzlies",
    );
    expect(matched.settlement.isSettled).toBe(true);
    expect(matched.settlement.awayScore).toBe(35);
    expect(matched.settlement.homeScore).toBe(28);

    const unmatched = outLines[1];
    expect(unmatched.ticketNumber).toBe("767671999");
    expect(unmatched.settlement.isSettled).toBe(false);
  });

  it("streams and enriches records directly from in-memory web File instances", async () => {
    const figureData = {
      LIST: {
        INFO: [
          {
            TicketNumber: 1075710577,
            WagerNumber: 1,
            PlayNumber: 1,
            AmountWagered: 230000,
            ToWinAmount: 200000,
            WagerType: "S",
            AmountWon: 0,
            AmountLost: 230000,
            WagerStatus: "L",
            Description: "Basketball #546 Grizzlies +1 -115 - For 1st Quarter",
            AcceptedDateTime: "2026-11-06 20:09:35.077",
            CustomerID: "DAN245    ",
            TicketWriter: "Internet",
            GameDateTime: "2026-11-06 20:10:00.000",
            SportType: "Basketball          ",
            SportSubType: "NBA                 ",
            AdjSpread: 1,
            AdjTotalPoints: 0,
            FinalMoney: -115,
            ChosenTeamID: "Memphis Grizzlies",
            Outcome: "L",
            PeriodDescription: "1st Quarter         ",
            Team1ID: "Oklahoma City Thunder",
            Team1FinalScore: 35,
            Team2ID: "Memphis Grizzlies",
            Team2FinalScore: 28,
          },
        ],
      },
    };

    const tickerData = [
      JSON.stringify({
        WagerNumber: 767671190,
        CustomerID: "DAN245    ",
        AmountWagered: 230000,
        ToWinAmount: 200000,
        VolumeAmount: 0,
        InsertDateTime: "2026-11-06 20:09:29.680",
        TicketWriter: "ALERT",
        ShortDesc: "S:Basketball #546 Grizzlies +1 -115 - For 1st Quarter ",
      }),
      JSON.stringify({
        WagerNumber: 767671201,
        CustomerID: "DAN245    ",
        AmountWagered: 230000,
        ToWinAmount: 200000,
        VolumeAmount: 200000,
        InsertDateTime: "2026-11-06 20:09:35.080",
        TicketWriter: "Internet",
        ShortDesc: "S.Basketball #546 Grizzlies +1 -115 - For 1st Quarter",
      }),
    ].join("\n");

    const figureFile = new File([JSON.stringify(figureData)], "figure.json", {
      type: "application/json",
    });
    const tickerFile = new File([tickerData], "ticker.jsonl", {
      type: "application/x-ndjson",
    });

    expect(figureFile.name).toBe("figure.json");
    expect(figureFile.type).toContain("application/json");
    expect(figureFile.size).toBeGreaterThan(0);
    expect(await figureFile.text()).toContain("DAN245");

    expect(tickerFile.name).toBe("ticker.jsonl");
    expect(tickerFile.type).toContain("application/x-ndjson");
    expect(tickerFile.size).toBeGreaterThan(0);
    expect(await tickerFile.text()).toContain("767671201");

    const result = await runEnrichment({
      figurePath: figureFile,
      tickerPath: tickerFile,
      outputPath: null,
      stats: false,
      format: "summary",
      inspect: false,
      sampleCount: 5,
    });

    expect(result.totalTickerRows).toBe(2);
    expect(result.matchedRows).toBe(1);
    expect(result.unmatchedRows).toBe(0);
    expect(result.inspection.stats.exactMatchedRows).toBe(1);
    expect(Number(result.inspection.stats.totalRiskCents)).toBe(230000);
    expect(result.inspection.samples.length).toBe(1);
    expect(result.inspection.samples[0]!.ticketNumber).toBe("1075710577");
  });
});
