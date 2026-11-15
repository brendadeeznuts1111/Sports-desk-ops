import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";

import {
  F402_CORE_VENDOR_UTIL_SHA256,
  F402_CORE_VENDOR_VERSION,
  F402_BET_SUB_TYPE,
  F402_BET_TYPE,
  F402_COMMISSION_TYPE_ACCOUNTING,
  F402_CONCAT,
  F402_CURRENCY,
  F402_DOMAIN_TICKET_WRITER,
  F402_FIXED_PRICE,
  F402_OFFICES,
  F402_SKINS,
  F402_SKINS_AGENTS,
  F402_STATUS,
  F402_SYSTEMS,
  F402_TIMEZONE,
  F402_TRANS,
  F402_TYPE_AGENT,
  calculateVendorToRiskAmount,
  calculateVendorToWinAmount,
  formatVendorOdds,
  formatVendorPoints,
  formatVendorSpread,
  formatVendorTotal,
  formatVendorTotalPart,
  getVendorLineTypeDisplay,
  getVendorTotalOU,
  getVendorWagerStatus,
  getVendorWagerTypeInfo,
  isVendorAsianLine,
} from "../lib/f402_core_vendor.ts";

const PINNED_UTIL_PATH = join(
  import.meta.dir,
  "../verification/manager-boot-oracle/pinned/util.js",
);

interface VendorEvaluated {
  version: string;
  BET: {
    TYPE: Record<string, { char: string; val: string }>;
    SUB_TYPE: Record<string, { val: string; text: string }>;
  };
  status: Record<string, string | number>;
  trans: Record<string, unknown>;
  skins: Record<string, string>;
  skinsAgents: Record<string, string>;
  concat: Record<string, string>;
  dsiOffice: string;
  basOffice: string;
  gatOffice: string;
  gatOfficeName: string;
  xtkOffice: string;
  cashierManagerOffice: string[];
  system: Record<string, string>;
  virtualLiveID: string;
  commisionTypeAccounting: Record<string, string>;
  currency: Record<string, string>;
  timeZone: Record<string, { SHORT: string; FULL: string }>;
  typeAgent: Record<string, string>;
  fixedPrice: {
    price: number;
    minPrice: number;
    maxPrice: number;
    office: string[];
  };
  domainTicketWriter: Record<string, string>;
  getTypeInfo: (ctx: Record<string, unknown>) => string;
  formatPoints: (val: unknown) => string;
  formatOdds: (val: unknown) => string | undefined;
  formatTotal: (points: unknown, odds: unknown, ou: unknown) => string;
  formatTotalPart: (val: unknown) => string;
  formatSpread: (
    isAsian: unknown,
    points: unknown,
    odds: unknown,
    teamId: unknown,
    fav: unknown,
  ) => string;
  isAsianLine: (opts: { type: string; line: number | string }) => boolean;
  getTotalOU: (opts: { OU: string }) => string;
}

function loadEvaluatedVendorUtil(): VendorEvaluated {
  const code = fs.readFileSync(PINNED_UTIL_PATH, "utf8");
  const mockStorage: Record<string, string> = {
    skin: "",
    AgentSkinOverride: "",
    language: "EN US",
  };

  let definedResult: Record<string, unknown> = {};

  const defineFn = (
    _deps: string[],
    factory: (mockE: {
      extend: (obj: Record<string, unknown>) => Record<string, unknown>;
    }) => Record<string, unknown>,
  ) => {
    const mockE = { extend: (obj: Record<string, unknown>) => obj };
    definedResult = factory(mockE);
  };

  const runner = new Function(
    "define",
    "sessionStorage",
    "localStorage",
    "window",
    "$",
    "jQuery",
    code,
  );

  runner(
    defineFn,
    mockStorage,
    mockStorage,
    globalThis,
    () => ({ attr: () => "0", removeClass: () => {}, addClass: () => {} }),
    {
      inArray: (val: unknown, arr: unknown[]) => (arr ? arr.indexOf(val) : -1),
    },
  );

  return definedResult as unknown as VendorEvaluated;
}

describe("f402_core_vendor contracts", () => {
  test("pinned util.js hash and version match exact contract", async () => {
    const bytes = await Bun.file(PINNED_UTIL_PATH).bytes();
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    expect(digest).toBe(F402_CORE_VENDOR_UTIL_SHA256);

    const vendor = loadEvaluatedVendorUtil();
    expect(vendor.version).toBe(F402_CORE_VENDOR_VERSION);
  });

  test("BET.TYPE and BET.SUB_TYPE constants have exact vendor parity", () => {
    const vendor = loadEvaluatedVendorUtil();

    expect(String(F402_BET_TYPE.STRAIGHT.char)).toBe(
      String(vendor.BET.TYPE.STRAIGHT?.char),
    );
    expect(String(F402_BET_TYPE.PARLAY.char)).toBe(
      String(vendor.BET.TYPE.PARLAY?.char),
    );
    expect(String(F402_BET_TYPE.IF_BET.char)).toBe(
      String(vendor.BET.TYPE.IF_BET?.char),
    );
    expect(String(F402_BET_TYPE.TEASER.char)).toBe(
      String(vendor.BET.TYPE.TEASER?.char),
    );
    expect(String(F402_BET_TYPE.REVERSE.char)).toBe(
      String(vendor.BET.TYPE.REVERSE?.char),
    );

    expect(String(F402_BET_SUB_TYPE.TOTAL.val)).toBe(
      String(vendor.BET.SUB_TYPE.TOTAL?.val),
    );
    expect(String(F402_BET_SUB_TYPE.TEAM_TOTAL.val)).toBe(
      String(vendor.BET.SUB_TYPE.TEAM_TOTAL?.val),
    );
    expect(String(F402_BET_SUB_TYPE.SPREAD.val)).toBe(
      String(vendor.BET.SUB_TYPE.SPREAD?.val),
    );
    expect(String(F402_BET_SUB_TYPE.MONEY.val)).toBe(
      String(vendor.BET.SUB_TYPE.MONEY?.val),
    );
    expect(String(F402_BET_SUB_TYPE.LIVE_BETTING.val)).toBe(
      String(vendor.BET.SUB_TYPE.LIVE_BETTING?.val),
    );
  });

  test("status and trans dictionaries mirror vendor accounting", () => {
    const vendor = loadEvaluatedVendorUtil();

    expect(String(F402_STATUS.OPEN)).toBe(String(vendor.status.OPEN));
    expect(String(F402_STATUS.PENDING)).toBe(String(vendor.status.PENDING));
    expect(String(F402_STATUS.WIN)).toBe(String(vendor.status.WIN));
    expect(String(F402_STATUS.LOSS)).toBe(String(vendor.status.LOSS));
    expect(String(F402_STATUS.CANCEL)).toBe(String(vendor.status.CANCEL));
    expect(String(F402_STATUS.DEPOSIT)).toBe(String(vendor.status.DEPOSIT));
    expect(String(F402_STATUS.CIRCLE)).toBe(String(vendor.status.CIRCLE));
    expect(String(F402_STATUS.PAY)).toBe(String(vendor.status.PAY));
    expect(String(F402_STATUS.ZERO_BALANCE)).toBe(
      String(vendor.status.ZERO_BALANCE),
    );

    expect(F402_TRANS.CUSTOMER_DEPOSIT).toEqual(
      vendor.trans.CUSTOMER_DEPOSIT as { type: "E"; code: "C" },
    );
    expect(F402_TRANS.CUSTOMER_WITHDRAWAL).toEqual(
      vendor.trans.CUSTOMER_WITHDRAWAL as { type: "I"; code: "D" },
    );
    expect(F402_TRANS.RISK_REFUND).toEqual(
      vendor.trans.RISK_REFUND as { type: "R"; code: "C" },
    );
  });

  test("skins and agent skins dictionaries match vendor lists", () => {
    const vendor = loadEvaluatedVendorUtil();

    expect(String(F402_SKINS.VISOR_GOTHAM)).toBe(
      String(vendor.skins.VISOR_GOTHAM),
    );
    expect(String(F402_SKINS.VISOR_LATAM)).toBe(
      String(vendor.skins.VISOR_LATAM),
    );
    expect(String(F402_SKINS.VISOR_EZ_CLASSIC)).toBe(
      String(vendor.skins.VISOR_EZ_CLASSIC),
    );
    expect(String(F402_SKINS.VISOR_BET_MELON)).toBe(
      String(vendor.skins.VISOR_BET_MELON),
    );

    expect(String(F402_SKINS_AGENTS.NEWCLASSIC)).toBe(
      String(vendor.skinsAgents.NEWCLASSIC),
    );
    expect(String(F402_SKINS_AGENTS.GOTHAM)).toBe(
      String(vendor.skinsAgents.GOTHAM),
    );
    expect(String(F402_SKINS_AGENTS.TORONTO)).toBe(
      String(vendor.skinsAgents.TORONTO),
    );
  });

  test("concat delimiters match vendor exactly", () => {
    const vendor = loadEvaluatedVendorUtil();
    expect(String(F402_CONCAT.PICK)).toBe(String(vendor.concat.PICK));
    expect(String(F402_CONCAT.DECIMAL)).toBe(String(vendor.concat.DECIMAL));
    expect(String(F402_CONCAT.HALF_POINT)).toBe(
      String(vendor.concat.HALF_POINT),
    );
    expect(String(F402_CONCAT.PARAM)).toBe(String(vendor.concat.PARAM));
    expect(String(F402_CONCAT.PIPE)).toBe(String(vendor.concat.PIPE));
  });

  test("getTypeInfo maps all wager types identical to vendor getTypeInfo", () => {
    const vendor = loadEvaluatedVendorUtil();

    const testCases: Array<{
      input: Record<string, unknown>;
      expected: string;
    }> = [
      { input: { wagerType: "A" }, expected: "Manual Play" },
      { input: { wagerType: "M" }, expected: "Moneyline" },
      { input: { wagerType: "C" }, expected: "Future/Props" },
      { input: { wagerType: "S" }, expected: "Spread" },
      { input: { wagerType: "T" }, expected: "Teaser" },
      { input: { wagerType: "L" }, expected: "Total" },
      { input: { wagerType: "E" }, expected: "Team Total" },
      { input: { wagerType: "P" }, expected: "Parlay" },
      { input: { wagerType: "I" }, expected: "If-Bet" },
      {
        input: { wagerType: "I", birdCage: "1" },
        expected: "Action Reverse Box/Birdcage Item  ",
      },
      {
        input: { wagerType: "I", ARLink: "456" },
        expected: "Action Reverse Item",
      },
      {
        input: { wagerType: "G", PlacedOn: "EZL - INTERNET" },
        expected: "Live Betting",
      },
      {
        input: { wagerType: "G", PlacedOn: "GSLIVE" },
        expected: "",
      },
      {
        input: { wagerType: "G", PlacedOn: "OTHER_DESK" },
        expected: "Racebook",
      },
      {
        input: { wagerType: "S", roundRobin: 3 },
        expected: "Round Robin",
      },
    ];

    for (const { input, expected } of testCases) {
      const vendorResult = vendor.getTypeInfo(input);
      const ourResult = getVendorWagerTypeInfo(input as { wagerType: string });
      expect(ourResult).toBe(expected);
      expect(ourResult).toBe(vendorResult);
    }
  });

  test("getLineTypeDisplay and getWagerStatus match vendor mappings", () => {
    expect(getVendorLineTypeDisplay("L")).toBe("Total");
    expect(getVendorLineTypeDisplay("E")).toBe("Team Total");
    expect(getVendorLineTypeDisplay("S")).toBe("Spread");
    expect(getVendorLineTypeDisplay("M")).toBe("MoneyLine");
    expect(getVendorLineTypeDisplay("UNKNOWN")).toBe("");

    expect(getVendorWagerStatus("W")).toBe("Won");
    expect(getVendorWagerStatus("X")).toBe("Cancelled/Pushed ");
    expect(getVendorWagerStatus("L")).toBe("Lost");
    expect(getVendorWagerStatus("P")).toBe("Pending");
  });

  test("formatVendorPoints renders half points and PK identical to vendor", () => {
    const vendor = loadEvaluatedVendorUtil();

    const values = [0, 0.5, -0.5, 3.5, -3.5, 4, -4, 0.25, -0.25];
    for (const v of values) {
      expect(formatVendorPoints(v)).toBe(vendor.formatPoints(v));
    }
    expect(formatVendorPoints(null)).toBe("");
  });

  test("formatVendorOdds formats integers with plus/minus sign", () => {
    expect(formatVendorOdds(150)).toBe("+150");
    expect(formatVendorOdds(-110)).toBe("-110");
    expect(formatVendorOdds(0)).toBe(undefined);
    expect(formatVendorOdds(null)).toBe("");
  });

  test("calculateVendorToWinAmount and calculateVendorToRiskAmount math", () => {
    const toWinAmerican = calculateVendorToWinAmount({
      riskAmt: 110,
      priceType: "A",
      americanPrice: -110,
    });
    expect(toWinAmerican).toBeCloseTo(100, 2);

    const toWinPlus = calculateVendorToWinAmount({
      riskAmt: 100,
      priceType: "A",
      americanPrice: 150,
    });
    expect(toWinPlus).toBeCloseTo(150, 2);

    const toWinDecimal = calculateVendorToWinAmount({
      riskAmt: 100,
      priceType: "D",
      decimalPrice: 2.5,
    });
    expect(toWinDecimal).toBeCloseTo(150, 2);

    const toRiskAmerican = calculateVendorToRiskAmount({
      riskAmt: 100,
      priceType: "A",
      americanPrice: -110,
    });
    expect(toRiskAmerican).toBeCloseTo(110, 2);
  });

  test("offices, systems, and accounting commission mirror vendor constants", () => {
    const vendor = loadEvaluatedVendorUtil();

    expect(String(F402_OFFICES.DSI)).toBe(vendor.dsiOffice);
    expect(String(F402_OFFICES.BAS)).toBe(vendor.basOffice);
    expect(String(F402_OFFICES.GAT)).toBe(vendor.gatOffice);
    expect(String(F402_OFFICES.GAT_NAME)).toBe(vendor.gatOfficeName);
    expect(String(F402_OFFICES.XTK)).toBe(vendor.xtkOffice);
    expect(Array.from(F402_OFFICES.CASHIER_MANAGER) as string[]).toEqual(
      vendor.cashierManagerOffice,
    );

    expect(String(F402_SYSTEMS.ONE)).toBe(String(vendor.system.ONE));
    expect(String(F402_SYSTEMS.TWO)).toBe(String(vendor.system.TWO));
    expect(String(F402_SYSTEMS.TEST)).toBe(String(vendor.system.TEST));
    expect(String(F402_SYSTEMS.VIRTUAL_LIVE_ID)).toBe(vendor.virtualLiveID);

    expect(F402_COMMISSION_TYPE_ACCOUNTING).toEqual(
      vendor.commisionTypeAccounting as typeof F402_COMMISSION_TYPE_ACCOUNTING,
    );
  });

  test("formatVendorTotalPart and formatVendorTotal exact vendor parity", () => {
    const vendor = loadEvaluatedVendorUtil();

    const parts = [0, 0.5, 1, 1.5, 2, 2.25, 2.5, 2.75, 3];
    for (const p of parts) {
      expect(formatVendorTotalPart(p)).toBe(vendor.formatTotalPart(p));
    }

    const testTotals = [
      { points: 2.25, odds: -110, ou: "O" },
      { points: 2.5, odds: -110, ou: "U" },
      { points: 2.75, odds: 105, ou: "O" },
      { points: 3, odds: -115, ou: "U" },
    ];
    for (const { points, odds, ou } of testTotals) {
      const vendorRes = vendor.formatTotal(points, odds, ou);
      const ourRes = formatVendorTotal(points, odds, ou);
      expect(ourRes).toBe(vendorRes);
    }
  });

  test("formatVendorSpread exact vendor parity across Asian quarter lines and standard lines", () => {
    const vendor = loadEvaluatedVendorUtil();

    const testSpreads = [
      { isAsian: true, points: -1.25, odds: -110, team: "LAL", fav: "LAL" },
      { isAsian: true, points: 1.25, odds: -110, team: "BOS", fav: "LAL" },
      { isAsian: true, points: -0.25, odds: -110, team: "LAL", fav: "LAL" },
      { isAsian: true, points: 0.25, odds: -110, team: "BOS", fav: "LAL" },
      { isAsian: true, points: -0.75, odds: -110, team: "LAL", fav: "LAL" },
      { isAsian: true, points: 0.75, odds: -110, team: "BOS", fav: "LAL" },
      { isAsian: false, points: -3.5, odds: -110, team: "LAL", fav: "LAL" },
      { isAsian: false, points: 3.5, odds: 100, team: "BOS", fav: "LAL" },
    ];

    for (const s of testSpreads) {
      const vendorRes = vendor.formatSpread(
        s.isAsian,
        s.points,
        s.odds,
        s.team,
        s.fav,
      );
      const ourRes = formatVendorSpread(
        s.isAsian,
        s.points,
        s.odds,
        s.team,
        s.fav,
      );
      expect(ourRes).toBe(vendorRes);
    }
  });

  test("currency, timeZone, typeAgent, fixedPrice, and domainTicketWriter mirror vendor", () => {
    const vendor = loadEvaluatedVendorUtil();

    expect(F402_CURRENCY).toEqual(vendor.currency as typeof F402_CURRENCY);
    expect(F402_TIMEZONE).toEqual(
      vendor.timeZone as unknown as typeof F402_TIMEZONE,
    );
    expect(F402_TYPE_AGENT).toEqual(vendor.typeAgent as typeof F402_TYPE_AGENT);
    expect({
      price: Number(F402_FIXED_PRICE.price),
      minPrice: Number(F402_FIXED_PRICE.minPrice),
      maxPrice: Number(F402_FIXED_PRICE.maxPrice),
      office: Array.from(F402_FIXED_PRICE.office) as string[],
    }).toEqual(vendor.fixedPrice);
    expect(F402_DOMAIN_TICKET_WRITER).toEqual(
      vendor.domainTicketWriter as typeof F402_DOMAIN_TICKET_WRITER,
    );
  });

  test("isVendorAsianLine and getVendorTotalOU match vendor predicates", () => {
    const vendor = loadEvaluatedVendorUtil();

    const spreadLines = [0, -0.5, 0.25, -1.25, 2.75, -3.5, 4];
    for (const line of spreadLines) {
      expect(isVendorAsianLine("spread", line)).toBe(
        vendor.isAsianLine({ type: "spread", line }),
      );
    }

    const totalLines = [2, 2.5, 2.25, 2.75, 45.5, 45.25];
    for (const line of totalLines) {
      expect(isVendorAsianLine("total", line)).toBe(
        vendor.isAsianLine({ type: "total", line }),
      );
    }

    expect(getVendorTotalOU("O")).toBe(vendor.getTotalOU({ OU: "O" }));
    expect(getVendorTotalOU("U")).toBe(vendor.getTotalOU({ OU: "U" }));
    expect(getVendorTotalOU("X")).toBe("");
  });
});
