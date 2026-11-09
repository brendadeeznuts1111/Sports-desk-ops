import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildAlertPerformance,
  loadOutcomeFile,
  outcomesFromCustomerBook,
  parseOutcomeRows,
} from "../lib/alert_performance.ts";
import type { TelegramAlertAuditRow } from "../lib/telegram_alert_audit.ts";

const BASE: TelegramAlertAuditRow = {
  schemaVersion: 1,
  atIso: "2026-11-05T07:00:00.000Z",
  source: "flag-alert",
  chatId: "8013171035",
  chatLabel: "deskbotops",
  status: "sent",
  ruleId: "stake_over_10k",
  severity: "high",
};

function alert(
  overrides: Partial<TelegramAlertAuditRow> = {},
): TelegramAlertAuditRow {
  return {
    ...BASE,
    customerId: "ALPHA",
    wagerNumber: "1",
    sport: "Football",
    subSport: "Total",
    period: "Game",
    wagerType: "M",
    ...overrides,
  };
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function outcomesFile(text: string): string {
  const root = mkdtempSync(join(tmpdir(), "alert-outcomes-"));
  roots.push(root);
  const path = join(root, "outcomes.json");
  writeFileSync(path, text);
  return path;
}

const OUTCOMES = outcomesFromCustomerBook([
  {
    customer_id: "ALPHA",
    recent_tickets: [
      { wager_number: 1, result: "WIN", net_usd: 250 },
      { wager_number: 2, result: "LOSS", net_usd: -100 },
    ],
  },
  {
    customer_id: "BETA",
    recent_tickets: [{ wager_number: 3, result: "LOSS", net_usd: -75 }],
  },
]);

describe("alert performance", () => {
  test("customer-book outcomes require a wager number and a decisive result", () => {
    expect(OUTCOMES).toHaveLength(3);
    expect(
      OUTCOMES.every((outcome) => outcome.source === "customer_book_sample"),
    ).toBe(true);
    expect(
      outcomesFromCustomerBook([
        { customer_id: "X", recent_tickets: [{ result: "WIN" }] },
        {
          customer_id: "Y",
          recent_tickets: [{ wager_number: 9, result: "PENDING" }],
        },
      ]),
    ).toEqual([]);
  });

  test("builds per-dimension winners/losers and leaves unmatched alerts alone", () => {
    const report = buildAlertPerformance(
      [
        alert({ customerId: "ALPHA", wagerNumber: "1" }), // +250
        alert({ customerId: "BETA", wagerNumber: "3" }), // -75
        alert({ customerId: "HISTORICAL" }), // no wager key => unmatched
      ],
      OUTCOMES,
    );
    expect(report.available).toBe(true);
    expect(report.alerts).toBe(3);
    expect(report.matched).toBe(2);
    expect(report.unmatched).toBe(1);
    expect(report.wins).toBe(1);
    expect(report.losses).toBe(1);
    expect(report.netUsd).toBe(175);

    const sport = report.dimensions.find(
      (group) => group.dimension === "sport" && group.key === "Football",
    );
    expect(sport?.matched).toBe(2);
    expect(sport?.topWinner?.customerId).toBe("ALPHA");
    expect(sport?.topWinner?.netUsd).toBe(250);
    expect(sport?.topLoser?.customerId).toBe("BETA");
    expect(sport?.topLoser?.netUsd).toBe(-75);
  });

  test("duplicate sends of the same customer+wager count once", () => {
    const report = buildAlertPerformance(
      [
        alert({ customerId: "ALPHA", wagerNumber: "1", status: "simulated" }),
        alert({ customerId: "ALPHA", wagerNumber: "1", status: "sent" }),
      ],
      OUTCOMES,
    );
    expect(report.alerts).toBe(1);
    expect(report.matched).toBe(1);
  });

  test("alerts without a customer id are counted as unmatched, not dropped", () => {
    const report = buildAlertPerformance(
      [
        alert({ customerId: "ALPHA", wagerNumber: "1" }),
        alert({ customerId: "", wagerNumber: "9", status: "sent" }),
      ],
      OUTCOMES,
    );
    expect(report.alerts).toBe(2);
    expect(report.matched).toBe(1);
    expect(report.unmatched).toBe(1);
    expect(report.metadata?.alertsWithoutCustomerKey).toBe(1);
  });

  test("two sent duplicates count once and sent beats newer simulated peers", () => {
    const sentDuplicates = buildAlertPerformance(
      [
        alert({ customerId: "ALPHA", wagerNumber: "1", status: "sent" }),
        alert({
          customerId: "ALPHA",
          wagerNumber: "1",
          status: "sent",
          atIso: "2026-11-05T08:00:00.000Z",
        }),
      ],
      OUTCOMES,
    );
    expect(sentDuplicates.alerts).toBe(1);
    expect(sentDuplicates.matched).toBe(1);

    const priority = buildAlertPerformance(
      [
        alert({ customerId: "ALPHA", wagerNumber: "1", status: "simulated" }),
        alert({
          customerId: "ALPHA",
          wagerNumber: "1",
          status: "sent",
          atIso: "2026-11-05T06:00:00.000Z",
        }),
      ],
      OUTCOMES,
      { deliveredOnly: false },
    );
    expect(priority.alerts).toBe(1);
    expect(priority.matched).toBe(1);
  });

  test("wager and betKey namespaces cannot collide; keyless alerts stay distinct", () => {
    const namespaced = buildAlertPerformance(
      [
        alert({ customerId: "ALPHA", wagerNumber: "123" }),
        alert({
          customerId: "ALPHA",
          wagerNumber: "",
          betKey: "123",
          atIso: "2026-11-05T07:30:00.000Z",
        }),
      ],
      OUTCOMES,
    );
    expect(namespaced.alerts).toBe(2);

    const keyless = buildAlertPerformance(
      [
        alert({
          customerId: "ALPHA",
          wagerNumber: "",
          atIso: "2026-11-05T07:00:00.000Z",
        }),
        alert({
          customerId: "ALPHA",
          wagerNumber: "",
          atIso: "2026-11-05T07:01:00.000Z",
        }),
      ],
      OUTCOMES,
    );
    expect(keyless.alerts).toBe(2);
  });

  test("delivered-only with only simulated alerts explains the filter", () => {
    const report = buildAlertPerformance(
      [alert({ customerId: "ALPHA", wagerNumber: "1", status: "simulated" })],
      OUTCOMES,
    );
    expect(report.alerts).toBe(0);
    expect(report.reason).toContain("--include-simulated");
  });

  test("deliveredOnly excludes simulated alerts unless explicitly widened", () => {
    const alerts = [
      alert({ customerId: "ALPHA", wagerNumber: "1" }),
      alert({
        customerId: "ALPHA",
        wagerNumber: "2",
        status: "simulated",
      }),
    ];
    expect(buildAlertPerformance(alerts, OUTCOMES).alerts).toBe(1);
    expect(
      buildAlertPerformance(alerts, OUTCOMES, { deliveredOnly: false }).alerts,
    ).toBe(2);
  });

  test("explicit outcomes JSON is parsed; malformed rows are skipped", () => {
    const outcomes = parseOutcomeRows({
      rows: [
        { customerId: "alpha", wagerNumber: 1, outcome: "W", netUsd: 10 },
        { login: "beta", wagerNumber: "2", result: "L" },
        { wagerNumber: 3, outcome: "W" }, // no customer
        { customerId: "gamma", wagerNumber: 4, outcome: "PENDING" }, // unknown outcome
      ],
    });
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]?.customerId).toBe("ALPHA");
    expect(outcomes[1]?.customerId).toBe("BETA");
  });

  test("outcome file loading distinguishes empty, malformed and mixed JSONL", async () => {
    expect(await loadOutcomeFile(outcomesFile("[]"))).toEqual([]);
    expect(await loadOutcomeFile(outcomesFile("not json"))).toBeNull();
    expect(
      await loadOutcomeFile(
        outcomesFile(
          'not json\n{"customerId":"ALPHA","wagerNumber":1,"outcome":"WIN","netUsd":5}\n',
        ),
      ),
    ).toHaveLength(1);
    expect(
      await loadOutcomeFile(
        outcomesFile('{"customerId":"BETA","wagerNumber":2,"outcome":"LOSS"}'),
      ),
    ).toHaveLength(1);
  });

  test("no matches reports unavailable with a reason, never zero-fabricated winners", () => {
    const report = buildAlertPerformance(
      [alert({ wagerNumber: "999" })],
      OUTCOMES,
    );
    expect(report.available).toBe(false);
    expect(report.reason).toContain("no alert row could be joined");
    // Groups may still be listed for diagnostics, but they carry no fabricated winner/loser.
    expect(
      report.dimensions.every(
        (group) => group.matched === 0 && group.topWinner === null,
      ),
    ).toBe(true);
  });
});

// -------------------------------------------------------------------------------------------------

/**
 * Canonical-dimension fixtures. The raw alert fields mix a picker label, the PREGAME phase sentinel,
 * an opaque wager code and blank strings; the report must group them by the registry vocabulary.
 */
const CANON_ALERTS: TelegramAlertAuditRow[] = [
  // Joins to ALPHA|1 (win +250); PREGAME motion + blank period.
  alert({
    customerId: "ALPHA",
    wagerNumber: "1",
    subSport: "PREGAME",
    sport: " Football ",
    period: "",
    wagerType: "M",
    atIso: "2026-11-05T07:00:03.000Z",
  }),
  // Joins to BETA|3 (loss -75); book picker label.
  alert({
    customerId: "BETA",
    wagerNumber: "3",
    subSport: "Point spread",
    sport: "Football",
    period: "Game",
    wagerType: "M",
    atIso: "2026-11-05T07:00:01.000Z",
  }),
  // No wager key: unmatched, but still participates and canonicalizes blanks to `unknown`.
  // Built from BASE because `wagerNumber: undefined` is not assignable under exactOptionalPropertyTypes.
  {
    ...BASE,
    customerId: "GAMMA",
    subSport: "",
    sport: "",
    period: " Game ",
    wagerType: "?",
    atIso: "2026-11-05T07:00:02.000Z",
  },
];

const CANON_REPORT = buildAlertPerformance(CANON_ALERTS, OUTCOMES);

function groupsFor(
  report: typeof CANON_REPORT,
  dimension: "sport" | "subSport" | "period" | "wagerType",
) {
  return report.dimensions.filter((group) => group.dimension === dimension);
}

describe("canonical dimensions", () => {
  test("PREGAME is a phase sentinel and never its own market group", () => {
    const keys = groupsFor(CANON_REPORT, "subSport").map((group) => group.key);
    expect(keys).not.toContain("PREGAME");
    const unknown = groupsFor(CANON_REPORT, "subSport").find(
      (group) => group.key === "unknown",
    );
    // PREGAME + blank collapse into one honest unknown bucket, not two invented markets.
    expect(unknown?.alerts).toBe(2);
    expect(unknown?.rawKeys).toEqual(["PREGAME"]);
  });

  test('"Point spread" groups under the canonical "spread" key with its raw label kept', () => {
    const spread = groupsFor(CANON_REPORT, "subSport").find(
      (group) => group.key === "spread",
    );
    expect(spread?.alerts).toBe(1);
    expect(spread?.rawKeys).toEqual(["Point spread"]);
    // The raw label is gone from the group key, so CLI output shows one clean stratum.
    expect(
      groupsFor(CANON_REPORT, "subSport").map((group) => group.key),
    ).toEqual(["spread", "unknown"]);
  });

  test("the wager type code M becomes a readable Moneyline label", () => {
    const keys = groupsFor(CANON_REPORT, "wagerType").map((group) => group.key);
    expect(keys).toContain("M Moneyline");
    expect(keys).not.toContain("M");
    const moneyline = groupsFor(CANON_REPORT, "wagerType").find(
      (group) => group.key === "M Moneyline",
    );
    expect(moneyline?.alerts).toBe(2);
    expect(moneyline?.rawKeys).toEqual(["M"]);
    // An unknown code never leaks the code as a dimension key.
    expect(keys).toContain("unknown");
    expect(
      groupsFor(CANON_REPORT, "wagerType").find(
        (group) => group.key === "unknown",
      )?.rawKeys,
    ).toEqual(["?"]);
  });

  test("sport and period are trimmed and empty values become unknown", () => {
    const sport = groupsFor(CANON_REPORT, "sport");
    expect(sport.map((group) => group.key)).toEqual(["Football", "unknown"]);
    expect(sport.find((group) => group.key === "Football")?.alerts).toBe(2);
    expect(sport.find((group) => group.key === "unknown")?.alerts).toBe(1);

    const period = groupsFor(CANON_REPORT, "period");
    // " Game " and "Game" are the same stratum; the blank period is unknown.
    expect(period.map((group) => group.key)).toEqual(["Game", "unknown"]);
    expect(period.find((group) => group.key === "Game")?.alerts).toBe(2);
    expect(period.find((group) => group.key === "unknown")?.alerts).toBe(1);
  });

  test("customer dimension summaries use the canonical values", () => {
    const alpha = CANON_REPORT.customers.find(
      (customer) => customer.customerId === "ALPHA",
    );
    expect(alpha?.dimensions.subSport).toEqual(["unknown"]);
    expect(alpha?.dimensions.wagerType).toEqual(["M Moneyline"]);
    const beta = CANON_REPORT.customers.find(
      (customer) => customer.customerId === "BETA",
    );
    expect(beta?.dimensions.subSport).toEqual(["spread"]);
  });
});

describe("report metadata", () => {
  test("carries the alert window, outcome sources and join coverage", () => {
    const metadata = CANON_REPORT.metadata;
    expect(metadata).toBeDefined();
    expect(metadata?.alertWindow).toEqual({
      firstAtIso: "2026-11-05T07:00:01.000Z",
      lastAtIso: "2026-11-05T07:00:03.000Z",
    });
    expect(metadata?.outcomeSources).toEqual(["customer_book_sample"]);
    expect(metadata?.outcomeCoverage).toBe("matched 2 of 3 alerts (66.7%)");
    expect(metadata?.participatingAlerts).toBe(3);
    expect(metadata?.outcomeRows).toBe(3);
    expect(metadata?.alertsWithoutWagerKey).toBe(1);
  });

  test("reports no outcome source and 0% coverage without outcomes, never a fake window", () => {
    const report = buildAlertPerformance(CANON_ALERTS, []);
    expect(report.metadata?.outcomeSources).toEqual([]);
    expect(report.metadata?.outcomeCoverage).toBe("matched 0 of 3 alerts (0%)");
    expect(report.metadata?.outcomeRows).toBe(0);
    expect(report.available).toBe(false);
    // The alert window is a property of the alerts, so it is still known.
    expect(report.metadata?.alertWindow.firstAtIso).toBe(
      "2026-11-05T07:00:01.000Z",
    );
  });

  test("an empty participant set reads 0 of 0 with empty window bounds", () => {
    const report = buildAlertPerformance(
      [alert({ status: "simulated" })],
      OUTCOMES,
    );
    expect(report.metadata?.participatingAlerts).toBe(0);
    expect(report.metadata?.outcomeCoverage).toBe("matched 0 of 0 alerts (0%)");
    expect(report.metadata?.alertWindow).toEqual({
      firstAtIso: null,
      lastAtIso: null,
    });
  });

  test("metadata covers only the participating (deduped) alerts", () => {
    const report = buildAlertPerformance(
      [
        alert({
          customerId: "ALPHA",
          wagerNumber: "1",
          status: "simulated",
          atIso: "2026-11-05T07:00:00.000Z",
        }),
        alert({
          customerId: "ALPHA",
          wagerNumber: "1",
          status: "sent",
          atIso: "2026-11-05T07:00:05.000Z",
        }),
      ],
      OUTCOMES,
    );
    expect(report.metadata?.participatingAlerts).toBe(1);
    expect(report.metadata?.alertWindow).toEqual({
      firstAtIso: "2026-11-05T07:00:05.000Z",
      lastAtIso: "2026-11-05T07:00:05.000Z",
    });
    expect(report.metadata?.outcomeCoverage).toBe(
      "matched 1 of 1 alerts (100%)",
    );
  });

  test("the canonical groups keep the fields the CLI renders", () => {
    const sport = groupsFor(CANON_REPORT, "sport").find(
      (group) => group.key === "Football",
    );
    // Existing CLI-consumed fields remain: dimension/key/matched/netUsd/topWinner/topLoser.
    expect(sport?.dimension).toBe("sport");
    expect(sport?.key).toBe("Football");
    expect(sport?.matched).toBe(2);
    expect(sport?.netUsd).toBe(175);
    expect(sport?.topWinner?.customerId).toBe("ALPHA");
    expect(sport?.topLoser?.customerId).toBe("BETA");
  });
});
