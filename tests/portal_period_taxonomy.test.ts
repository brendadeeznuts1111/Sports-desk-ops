/**
 * @file tests/portal_period_taxonomy.test.ts
 * @description Invariant tests for the canonical Fantasy402 portal period taxonomy,
 * orphan period exclusion, engine detection, and multi-family date mapping.
 */

import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import type {
  Cents,
  CustomerIdentifier,
  AgentIdentifier,
  Dollars,
} from "../design/domain-branded-types.ts";
import {
  DATE_FAMILIES,
  PORTAL_PERIOD_LABELS,
  classifyPortalPeriod,
  detectEngine,
  extractRiskDollars,
  isDerivativePointsLineWager,
  normalizeWager,
  PeriodTaxonomyInspection,
  createNormalizedWagersDirectStream,
  registerPortalPeriodSqliteFunctions,
  insertNormalizedWagers,
} from "../lib/portal_period_taxonomy.ts";

describe("Portal Period Taxonomy Enum", () => {
  it("defines the canonical 0-6 enum matching the portal dropdown", () => {
    expect(PORTAL_PERIOD_LABELS[-1]).toBe("All Periods");
    expect(PORTAL_PERIOD_LABELS[0]).toBe("Game");
    expect(PORTAL_PERIOD_LABELS[1]).toBe("1st Half");
    expect(PORTAL_PERIOD_LABELS[2]).toBe("2nd Half");
    expect(PORTAL_PERIOD_LABELS[3]).toBe("1st Qtr");
    expect(PORTAL_PERIOD_LABELS[4]).toBe("2nd Qtr");
    expect(PORTAL_PERIOD_LABELS[5]).toBe("3rd Qtr");
    expect(PORTAL_PERIOD_LABELS[6]).toBe("4th Qtr");
  });
});

describe("Three Date-Field Families", () => {
  it("correctly maps aggregate modes (CP, CPS) to disabled start/end", () => {
    expect(DATE_FAMILIES.CP).toEqual({
      family: "Aggregate",
      startField: "start",
      endField: "end",
      defaultState: "disabled",
      hasPeriodFilter: false,
    });
    expect(DATE_FAMILIES.CPS).toEqual({
      family: "Aggregate",
      startField: "start",
      endField: "end",
      defaultState: "disabled",
      hasPeriodFilter: false,
    });
  });

  it("correctly maps customer volume (CPV) to startReportVolumen/endReportVolumen with period filter", () => {
    expect(DATE_FAMILIES.CPV).toEqual({
      family: "Customer Volume",
      startField: "startReportVolumen",
      endField: "endReportVolumen",
      defaultState: "disabled",
      hasPeriodFilter: true,
    });
  });

  it("correctly maps grading (G) to user-driven startG/endG", () => {
    expect(DATE_FAMILIES.G).toEqual({
      family: "Grading",
      startField: "startG",
      endField: "endG",
      defaultState: "enabled",
      hasPeriodFilter: false,
    });
  });
});

describe("Portal Period Classification & Orphan Periods", () => {
  it("folds incl_ot silently into 0 Game", () => {
    const res = classifyPortalPeriod({
      WagerType: "E",
      Period: "incl_ot",
      ShortDesc: "E.Football #101 Patriots - For Game",
    });
    expect(res.portalPeriod).toBe(0);
    expect(res.portalLabel).toBe("Game");
    expect(res.half).toBe("FG");
    expect(res.isOrphanOutOfPortal).toBe(false);
  });

  it("maps 1st Half and 1h to 1", () => {
    const resNative = classifyPortalPeriod({
      WagerType: "E",
      ShortDesc: "E.Basketball #501 Lakers O 55 - For 1st Half",
    });
    expect(resNative.portalPeriod).toBe(1);
    expect(resNative.portalLabel).toBe("1st Half");
    expect(resNative.half).toBe("1H");

    const resGansrow = classifyPortalPeriod({
      WagerType: "M",
      ShortDesc: "Soccer - France vs Italy / 1st Half / Total / Over 1.5",
      TicketWriter: "GSLIVE",
    });
    expect(resGansrow.portalPeriod).toBe(1);
    expect(resGansrow.half).toBe("1H");
  });

  it("maps 2nd Half and 2h to 2", () => {
    const res = classifyPortalPeriod({
      WagerType: "E",
      ShortDesc: "E.Basketball #501 Lakers O 55 - For 2nd Half",
    });
    expect(res.portalPeriod).toBe(2);
    expect(res.portalLabel).toBe("2nd Half");
    expect(res.half).toBe("2H");
  });

  it("maps quarters 1Q-4Q to 3-6", () => {
    expect(
      classifyPortalPeriod({
        WagerType: "E",
        ShortDesc: "Lakers - For 1st Quarter",
      }).portalPeriod,
    ).toBe(3);
    expect(
      classifyPortalPeriod({
        WagerType: "E",
        ShortDesc: "Lakers - For 2nd Quarter",
      }).portalPeriod,
    ).toBe(4);
    expect(
      classifyPortalPeriod({
        WagerType: "E",
        ShortDesc: "Lakers - For 3rd Quarter",
      }).portalPeriod,
    ).toBe(5);
    expect(
      classifyPortalPeriod({
        WagerType: "E",
        ShortDesc: "Lakers - For 4th Quarter",
      }).portalPeriod,
    ).toBe(6);
  });

  it("treats sets (set1, set2, set3) as null out-of-portal scope", () => {
    const set1 = classifyPortalPeriod({
      WagerType: "E",
      Period: "set1",
      ShortDesc: "Tennis - Player A - For Set 1",
    });
    expect(set1.portalPeriod).toBeNull();
    expect(set1.isOrphanOutOfPortal).toBe(true);
    expect(set1.half).toBe("OUT_OF_PORTAL");

    const set2 = classifyPortalPeriod({
      WagerType: "M",
      ShortDesc: "Tennis - Player A vs Player B / Set 2 / Over 4.5",
      TicketWriter: "GSLIVE",
    });
    expect(set2.portalPeriod).toBeNull();
    expect(set2.isOrphanOutOfPortal).toBe(true);
  });

  it("assumes empty period defaults to 0 Game", () => {
    const res = classifyPortalPeriod({
      WagerType: "E",
      ShortDesc: "E.Football #101 Patriots - For Game",
      Period: "",
    });
    expect(res.portalPeriod).toBe(0);
    expect(res.portalLabel).toBe("Game");
    expect(res.half).toBe("FG");
  });
});

describe("Engine Detection & Risk Dollars", () => {
  it("detects Native ASI desk from WagerType E", () => {
    expect(detectEngine({ WagerType: "E" })).toBe("native");
  });

  it("detects Gansrow feed from TicketWriter or Gansrow pattern", () => {
    expect(detectEngine({ WagerType: "M", TicketWriter: "GSLIVE" })).toBe(
      "gansrow",
    );
    expect(
      detectEngine({
        WagerType: "P",
        ShortDesc: "Belgium Over 1.5",
      }),
    ).toBe("gansrow");
  });

  it("identifies Derivative Points Lines across both ingestion feeds", () => {
    expect(isDerivativePointsLineWager({ WagerType: "E" })).toBe(true);
    expect(
      isDerivativePointsLineWager({
        WagerType: "M",
        ShortDesc: "France derivative points Over 1.5",
      }),
    ).toBe(true);
    expect(
      isDerivativePointsLineWager({
        WagerType: "S",
        ShortDesc: "Patriots -3.5",
      }),
    ).toBe(false);
  });

  it("normalizes cents to dollars when AmountWagered is provided", () => {
    expect(extractRiskDollars({ AmountWagered: 2300 })).toBe(23.0);
    expect(extractRiskDollars({ Risk: 23.5 })).toBe(23.5);
  });

  it("normalizes a full wager row", () => {
    const norm = normalizeWager({
      WagerNumber: 991001,
      WagerType: "E",
      ShortDesc: "E.Football #101 Patriots O 24½ -110 - For 1st Half",
      AmountWagered: 5000,
      Login: "VIP101",
      AgentLogin: "BOSS1",
      InsertDateTime: "2026-11-01 12:00:00.000",
      TicketWriter: "Internet",
    });

    expect(norm).toEqual({
      wagerNumber: 991001,
      engine: "native",
      wagerType: "E",
      portalPeriod: 1,
      half: "1H",
      market: "Native Desk Derivative Points Line (1st Half)",
      customer: "VIP101",
      customerId: "VIP101" as unknown as CustomerIdentifier,
      agent: "BOSS1",
      agentId: "BOSS1" as unknown as AgentIdentifier,
      sport: "Football",
      subSport: "CFB",
      risk: 50.0,
      riskDollars: 50.0 as unknown as Dollars,
      riskCents: 5000 as unknown as Cents,
      ticketWriter: "Internet",
      insertedAt: "2026-11-01 12:00:00.000",
    });
  });

  it("formats normalized wagers and honors Bun.inspect.custom on PeriodTaxonomyInspection", () => {
    const norm = normalizeWager({
      WagerNumber: 991001,
      WagerType: "E",
      ShortDesc: "E.Football #101 Patriots O 24½ -110 - For 1st Half",
      AmountWagered: 5000,
      Login: "VIP101",
      AgentLogin: "BOSS1",
      InsertDateTime: "2026-11-01 12:00:00.000",
      TicketWriter: "Internet",
    });

    const singleInspect = norm;
    expect(String(singleInspect.customerId)).toBe("VIP101");
    expect(Number(singleInspect.riskCents)).toBe(5000);
    expect(Number(singleInspect.riskDollars)).toBe(50.0);

    const inspection = new PeriodTaxonomyInspection(
      {
        capturedAt: "2026-11-09T00:00:00.000Z",
        reportMode: "CPV",
        wagerType: "E",
        filtersExpanded: true,
        period: "1",
        portalPeriod: 1,
        portalPeriodLabel: "1st Half",
        engineFilter: "native",
        dateFamily: "Customer Volume",
        dateFields: {
          start: null,
          end: null,
          startG: null,
          endG: null,
          startReportVolumen: "2026-10-01",
          endReportVolumen: "2026-10-31",
        },
        stats: {
          totalProcessed: 1,
          matchedRows: 1,
          totalRisk: 50.0,
          avgRisk: 50.0,
          periodBreakdown: { "1st Half": { count: 1, risk: 50.0 } },
          detailedBreakdown: {
            "native:1:Derivative": {
              engine: "native",
              code: "1",
              label: "1st Half",
              market: "Derivative Points Line",
              count: 1,
              risk: 50.0,
            },
          },
        },
      },
      [norm],
    );

    const rendered = Bun.inspect(inspection, { colors: false });
    expect(rendered).toContain(
      "=== Portal Period Taxonomy Inspection Report ===",
    );
    expect(rendered).toContain(
      "Report Mode       : CPV (Customer Volume Family)",
    );
    expect(rendered).toContain("Period Filter     : [1] 1st Half");
    expect(rendered).toContain("Sample Normalized Records (1):");
    expect(rendered).toContain("#991001");
    expect(rendered).toContain("[VIP101]");

    const json = inspection.toJSON();
    expect(json.provenance.reportMode).toBe("CPV");
    expect(json.sample.length).toBe(1);
  });

  it("streams normalized records via Bun native direct ReadableStream (type: direct)", async () => {
    const raw = {
      WagerNumber: 991001,
      WagerType: "E",
      ShortDesc: "E.Football #101 Patriots - For 1st Half",
      AmountWagered: 5000,
      Login: "VIP101",
      AgentLogin: "AG7",
      InsertDateTime: "2026-10-20 14:00:00.000",
      TicketWriter: "Internet",
    };
    const norm = normalizeWager(raw);
    const stream = createNormalizedWagersDirectStream([norm]);
    expect(stream).toBeInstanceOf(ReadableStream);

    const text = await new Response(stream).text();
    expect(text).toContain("VIP101");
    expect(text).toContain("991001");
    expect(text.endsWith("\n")).toBe(true);

    const parsed = JSON.parse(text.trim());
    expect(parsed.wagerNumber).toBe(991001);
    expect(parsed.portalPeriod).toBe(1);
    expect(parsed.risk).toBe(50.0);
  });

  it("guarantees PeriodTaxonomyInspection is strictly pure and mutation-free during Bun.inspect", () => {
    const raw = {
      WagerNumber: 991001,
      WagerType: "E",
      ShortDesc: "E.Football #101 Patriots - For 1st Half",
      AmountWagered: 5000,
      Login: "VIP101",
      AgentLogin: "AG7",
      InsertDateTime: "2026-10-20 14:00:00.000",
      TicketWriter: "Internet",
    };
    const norm = normalizeWager(raw);
    const inspection = new PeriodTaxonomyInspection(
      {
        capturedAt: "2026-10-20T14:00:00.000Z",
        reportMode: "CPV",
        wagerType: "E",
        filtersExpanded: true,
        period: "1",
        portalPeriod: 1,
        portalPeriodLabel: "1st Half",
        engineFilter: "native",
        dateFamily: "Customer Volume",
        dateFields: {
          start: null,
          end: null,
          startG: null,
          endG: null,
          startReportVolumen: null,
          endReportVolumen: null,
        },
        stats: {
          totalProcessed: 1,
          matchedRows: 1,
          totalRisk: 50.0,
          avgRisk: 50.0,
          periodBreakdown: { "1st Half": { count: 1, risk: 50.0 } },
          detailedBreakdown: {},
        },
      },
      [norm],
    );

    const before = JSON.stringify(inspection);
    Bun.inspect(inspection, { colors: true });
    Bun.inspect(inspection, { colors: false });
    expect(JSON.stringify(inspection)).toBe(before);
  });

  it("registers and executes portal period taxonomy SQLite user-defined functions", () => {
    const db = new Database(":memory:");
    registerPortalPeriodSqliteFunctions(db);

    const row = db
      .query(
        "SELECT portal_period_label(1) as h1, portal_period_label(0) as game, is_derivative_points_line('Patriots derivative points Over 24.5') as is_dt, is_derivative_points_line('Patriots -3 -110') as not_dt",
      )
      .get() as {
      h1: string;
      game: string;
      is_dt: number;
      not_dt: number;
    } | null;

    expect(row?.h1).toBe("1st Half");
    expect(row?.game).toBe("Game");
    expect(row?.is_dt).toBe(1);
    expect(row?.not_dt).toBe(0);
    db.close();
  });

  it("registers and executes aggregate SQLite user-defined functions (sum_risk_cents, count_derivative_points)", () => {
    const db = new Database(":memory:");
    registerPortalPeriodSqliteFunctions(db);

    db.run("CREATE TABLE bets (risk REAL, desc TEXT)");
    db.run(
      "INSERT INTO bets VALUES (50.25, 'Team A derivative points Over 20')",
    );
    db.run(
      "INSERT INTO bets VALUES (100.50, 'Team B derivative points Over 21')",
    );
    db.run("INSERT INTO bets VALUES (25.00, 'Team C -3 -110')");

    const row = db
      .query(
        "SELECT sum_risk_cents(risk) as total_cents, count_derivative_points(desc) as dt_count FROM bets",
      )
      .get() as { total_cents: number; dt_count: number } | null;

    expect(row?.total_cents).toBe(17575); // 5025 + 10050 + 2500 = 17575 cents
    expect(row?.dt_count).toBe(2);
    db.close();
  });

  it("ingests normalized wager records into SQLite via atomic transaction (insertNormalizedWagers)", () => {
    const db = new Database(":memory:");
    registerPortalPeriodSqliteFunctions(db);

    const norm1 = normalizeWager({
      WagerNumber: "W1001",
      WagerType: "E",
      Period: "1H",
      ShortDesc: "Celtics derivative points Over 55.5 -110",
      Risk: 75.5,
      CustomerID: "VIP99",
      AgentID: "BOSS",
      Sport: "Basketball",
      TicketWriter: "Internet",
      InsertDateTime: "2026-11-02 19:00:00",
    });

    const norm2 = normalizeWager({
      WagerNumber: "W1002",
      WagerType: "E",
      Period: "2H",
      ShortDesc: "Warriors derivative points Under 52 -115",
      Risk: 125.0,
      CustomerID: "VIP99",
      AgentID: "BOSS",
      Sport: "Basketball",
      TicketWriter: "Internet",
      InsertDateTime: "2026-11-02 20:00:00",
    });

    const result = insertNormalizedWagers(db, [norm1, norm2]);
    expect(result.insertedCount).toBe(2);

    const query = db
      .query(
        "SELECT wager_number, portal_period_label(portal_period) as period_label, sum_risk_cents(risk) as cents FROM normalized_wagers GROUP BY portal_period ORDER BY portal_period ASC",
      )
      .all() as Array<{
      wager_number: string;
      period_label: string;
      cents: number;
    }>;

    expect(query.length).toBe(2);
    expect(query[0]!.period_label).toBe("1st Half");
    expect(query[0]!.cents).toBe(7550);
    expect(query[1]!.period_label).toBe("2nd Half");
    expect(query[1]!.cents).toBe(12500);

    db.close();
  });

  it("formats throughput rows per second in PeriodTaxonomyInspection when present", () => {
    const norm = normalizeWager({
      WagerNumber: "W1",
      WagerType: "E",
      Period: "1H",
      ShortDesc: "Bills derivative points Over 14.5",
      AmountWagered: "100.00",
    });

    const provenance = {
      capturedAt: "2026-11-09T08:00:00.000Z",
      reportMode: "CPV" as const,
      wagerType: "E (native) / M,P (Gansrow TT)",
      filtersExpanded: true,
      period: "1",
      portalPeriod: 1 as const,
      portalPeriodLabel: "1st Half",
      engineFilter: "native" as const,
      dateFamily: "Customer Volume" as const,
      dateFields: {
        start: null,
        end: null,
        startG: null,
        endG: null,
        startReportVolumen: "2026-11-01",
        endReportVolumen: "2026-11-09",
      },
      stats: {
        totalProcessed: 1000,
        matchedRows: 1,
        totalRisk: 100,
        avgRisk: 100,
        durationMs: 2.5,
        throughputRowsPerSec: 400000,
        periodBreakdown: {},
      },
    };

    const inspection = new PeriodTaxonomyInspection(provenance, [norm]);
    const report = Bun.inspect(inspection, { colors: false });
    expect(report).toContain(
      "Throughput        : 400,000 wagers/sec (2.5ms total)",
    );
  });
});
