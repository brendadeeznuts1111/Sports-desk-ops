import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ALL_PERIODS,
  DEFAULT_TIPO,
  SPORT_FIELD_WIDTH,
  buildAgentPerformanceRequest,
  padSportField,
} from "./f402_agent_performance_request.ts";
import { loadSportCatalog } from "./sport_catalog.ts";

const fixture = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dir,
      "../tests/fixtures/f402-report-requests-observed-2026-11-01.json",
    ),
    "utf8",
  ),
) as {
  agentPlaceholder: string;
  requests: Array<{
    operation: string;
    fields: Record<string, string>;
    filteredFields?: Record<string, string>;
  }>;
};

const observed = fixture.requests.find(
  (entry) => entry.operation === "getAgentPerformance",
);
if (observed === undefined)
  throw new Error("fixture has no getAgentPerformance");

const catalog = loadSportCatalog(
  JSON.parse(
    readFileSync(
      resolve(
        import.meta.dir,
        "../tests/fixtures/fantasy402-sport-catalog-2026-10-21.json",
      ),
      "utf8",
    ),
  ),
);
if (catalog === null) throw new Error("sport catalog fixture did not load");

const agent = fixture.agentPlaceholder;

const base = {
  start: "10/21/2026",
  end: "11/01/2026",
  agentId: agent,
  report: "CP" as const,
  freePlay: "Y" as const,
  sport: "Football",
};

describe("buildAgentPerformanceRequest", () => {
  test("reproduces the observed all-periods body byte for byte", () => {
    const built = buildAgentPerformanceRequest(base, { catalog });

    const expected = new URLSearchParams(
      Object.entries(observed.fields) as [string, string][],
    ).toString();

    expect(built.body).toBe(expected);
    expect(built.catalogChecked).toBe(true);
  });

  test("reproduces the observed filtered body byte for byte", () => {
    const filtered = observed.filteredFields;
    if (filtered === undefined)
      throw new Error("no filtered variant in fixture");

    const built = buildAgentPerformanceRequest(
      { ...base, subSport: "NFL", period: 1, wagerType: "M", betType: "S" },
      { catalog },
    );

    const expected = new URLSearchParams(
      Object.entries(filtered) as [string, string][],
    ).toString();

    expect(built.body).toBe(expected);
  });

  test("keeps the wire field order", () => {
    const built = buildAgentPerformanceRequest(base, { catalog });
    expect(built.fields.map(([key]) => key)).toEqual([
      "start",
      "end",
      "agentID",
      "type",
      "freePlay",
      "store",
      "sport",
      "subsport",
      "period",
      "wagerType",
      "betType",
      "tipo",
      "debug",
      "operation",
      "RRO",
      "agentOwner",
    ]);
  });

  test("pads sport to 20 characters and refuses a longer one", () => {
    expect(padSportField("Football")).toHaveLength(SPORT_FIELD_WIDTH);
    expect(padSportField("Football")).toBe("Football".padEnd(20, " "));
    expect(padSportField("  Football  ")).toBe("Football".padEnd(20, " "));
    expect(() => padSportField("A".repeat(21))).toThrow(/holds 20/);
    expect(() => padSportField("   ")).toThrow(/required/);
  });

  test("always sends subsport, wagerType and betType, empty when unfiltered", () => {
    const built = buildAgentPerformanceRequest(base, { catalog });
    const fields = Object.fromEntries(built.fields);
    expect(fields.subsport).toBe("");
    expect(fields.wagerType).toBe("");
    expect(fields.betType).toBe("");
  });

  test("defaults store and agentOwner to agentId", () => {
    const fields = Object.fromEntries(
      buildAgentPerformanceRequest(base, { catalog }).fields,
    );
    expect(fields.store).toBe(agent);
    expect(fields.agentOwner).toBe(agent);
  });

  test("all periods is -1, not an absent field", () => {
    const fields = Object.fromEntries(
      buildAgentPerformanceRequest(base, { catalog }).fields,
    );
    expect(fields.period).toBe("-1");
    expect(ALL_PERIODS).toBe(-1);
  });

  test("passes wagerType and betType through without translating them", () => {
    // M has no documented meaning here; a builder that guessed "Moneyline" would be wrong.
    const fields = Object.fromEntries(
      buildAgentPerformanceRequest(
        { ...base, wagerType: "M", betType: "Z" },
        { catalog },
      ).fields,
    );
    expect(fields.wagerType).toBe("M");
    expect(fields.betType).toBe("Z");
  });

  test("validates subsport against the chosen sport", () => {
    expect(
      buildAgentPerformanceRequest({ ...base, subSport: "NFL" }, { catalog })
        .catalogChecked,
    ).toBe(true);

    // NFL is a Football code; the same code is not valid for Hockey.
    expect(() =>
      buildAgentPerformanceRequest(
        { ...base, sport: "Hockey", subSport: "NFL" },
        { catalog },
      ),
    ).toThrow(/not one of Hockey's catalog codes/);
  });

  test("validates period against the sport's own menu", () => {
    // 1 is valid for Football (1st Half). 99 is not.
    expect(() =>
      buildAgentPerformanceRequest({ ...base, period: 99 }, { catalog }),
    ).toThrow(/not in Football's period menu/);

    expect(() =>
      buildAgentPerformanceRequest({ ...base, period: 1.5 }, { catalog }),
    ).toThrow(/integer/);
  });

  test("rejects a malformed or inverted date range", () => {
    expect(() =>
      buildAgentPerformanceRequest(
        { ...base, start: "2026-10-21" },
        { catalog },
      ),
    ).toThrow(/M\/D\/YYYY/);
    expect(() =>
      buildAgentPerformanceRequest(
        { ...base, start: "11/01/2026", end: "10/21/2026" },
        { catalog },
      ),
    ).toThrow(/after/);
  });

  test("rejects an unknown report kind and freePlay flag", () => {
    expect(() =>
      buildAgentPerformanceRequest(
        { ...base, report: "ZZ" as typeof base.report },
        { catalog },
      ),
    ).toThrow(/unknown report kind/);
    expect(() =>
      buildAgentPerformanceRequest(
        { ...base, freePlay: "X" as typeof base.freePlay },
        { catalog },
      ),
    ).toThrow(/freePlay must be Y or N/);
  });

  test("builds without a catalog but says it did not verify", () => {
    const built = buildAgentPerformanceRequest({ ...base, period: 2 });
    expect(built.catalogChecked).toBe(false);
    expect(Object.fromEntries(built.fields).period).toBe("2");
  });

  test("never emits a credential-shaped field", () => {
    const built = buildAgentPerformanceRequest(
      { ...base, subSport: "NFL", period: 1, wagerType: "M", betType: "S" },
      { catalog },
    );
    for (const key of Object.keys(Object.fromEntries(built.fields))) {
      expect(["authorization", "cookie", "token"]).not.toContain(
        key.toLowerCase(),
      );
    }
  });
});

describe("sport padding, from both observed calls", () => {
  test("a two-word sport pads after both words", () => {
    // Second observation: sport=Auto+Racing+++++++++ — "Auto Racing" plus 9 spaces, still 20.
    const built = buildAgentPerformanceRequest(
      { ...base, sport: "Auto Racing" },
      { catalog },
    );
    expect(built.sportPadded).toBe("Auto Racing".padEnd(20, " "));
    expect(built.body).toContain("sport=Auto+Racing+++++++++");
  });

  test("wider sports still fit, and the field never exceeds 20", () => {
    for (const entry of catalog.sports) {
      if (entry.sport.trim().length > SPORT_FIELD_WIDTH) {
        expect(() => padSportField(entry.sport)).toThrow(/holds 20/);
      } else {
        expect(padSportField(entry.sport)).toHaveLength(SPORT_FIELD_WIDTH);
      }
    }
  });
});

describe("the CPS call (sport performance)", () => {
  const cpsFields = (() => {
    const entry = observed as {
      sportPerformanceFields?: Record<string, string>;
    };
    if (entry.sportPerformanceFields === undefined) {
      throw new Error("fixture has no sportPerformanceFields");
    }
    return entry.sportPerformanceFields;
  })();

  const cps = {
    start: "10/27/2026",
    end: "11/02/2026",
    agentId: agent,
    report: "CPS" as const,
    freePlay: "Y" as const,
    sport: "LIVE",
    subSport: "NCAAF Live",
    period: -1,
    tipo: -1,
  };

  test("reproduces the observed CPS body byte for byte", () => {
    const built = buildAgentPerformanceRequest(cps, { catalog });
    const expected = new URLSearchParams(
      Object.entries(cpsFields) as [string, string][],
    ).toString();

    expect(built.body).toBe(expected);
  });

  test("tipo is sent, not hardcoded", () => {
    // CP sent tipo=0, CPS sent tipo=-1. A constant would have been wrong for one of them.
    expect(
      Object.fromEntries(buildAgentPerformanceRequest(cps, { catalog }).fields)
        .tipo,
    ).toBe("-1");
    expect(
      Object.fromEntries(buildAgentPerformanceRequest(base, { catalog }).fields)
        .tipo,
    ).toBe("0");
    expect(DEFAULT_TIPO).toBe(0);
  });

  test("the LIVE sport and its NCAAF Live sub-sport validate against the catalog", () => {
    // LIVE is a sport in the captured catalog with one period (0 = Game) and 11 sub-sports.
    const built = buildAgentPerformanceRequest(cps, { catalog });
    expect(built.catalogChecked).toBe(true);
    expect(built.sportPadded).toBe("LIVE".padEnd(20, " "));
  });

  test("period 0 means the whole game for LIVE, and both observed values are accepted", () => {
    // The two observations differ only in period: -1 (unfiltered) and 0 (Game).
    for (const period of [-1, 0]) {
      expect(
        buildAgentPerformanceRequest({ ...cps, period }, { catalog })
          .catalogChecked,
      ).toBe(true);
    }
    expect(() =>
      buildAgentPerformanceRequest({ ...cps, period: 2 }, { catalog }),
    ).toThrow(/not in LIVE's period menu/);
  });

  test("tipo must be an integer when given", () => {
    expect(() =>
      buildAgentPerformanceRequest({ ...cps, tipo: 0.5 }, { catalog }),
    ).toThrow(/tipo must be an integer/);
  });
});
