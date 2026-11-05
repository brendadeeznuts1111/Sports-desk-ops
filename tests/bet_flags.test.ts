import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { BET_CONTEXT_FIELDS, enrichIncomingBets } from "../lib/bet_context.ts";
import {
  BET_FLAG_FIELDS,
  BET_FLAG_OPS,
  FLAG_SEVERITIES,
  dedupeKeyFor,
  evaluateBetFlagRules,
  loadBetFlagRules,
  parseBetFlagRules,
  widenPendingRow,
  widenTickerRow,
  widenWagerRow,
} from "../lib/bet_flags.ts";
import type {
  BetFlagRule,
  IncomingBetRecord,
  RuleLoadResult,
} from "../lib/bet_flags.ts";

/**
 * Rules-engine tests, crafted inputs only: no network, no keychain, no wall clock (every
 * evaluation passes `now`, every widening passes `observedAt`) and no tracked data artifact.
 */

const ROOT = join(import.meta.dir, "..");
const CONFIG_PATH = join(ROOT, "config", "bet-flags.yml");
const OBSERVED_AT = "2026-11-05T02:40:00.004Z";
const NOW = new Date("2026-11-05T02:40:00.000Z");

// The captured `getBetTicker` row shape (`data/live-wagers.json` LIST row; the same 13 fields).
const WIRE_SHORT_DESC =
  "P.G320195744\r\nBasketball - Phoenix Suns vs Portland Trail Blazers / Game / Winner (2 way) / Phoenix Suns -132&#x0D;\n" +
  "Basketball - Denver Nuggets vs Toronto Raptors / Game / Total / Over 244.5 -114&#x0D;\n";

function tickerRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    WagerNumber: 767463594,
    AgentID: "SPEN",
    CustomerID: "BCC1413   ",
    Login: "BCC1413",
    WagerType: "P",
    AmountWagered: 10700,
    InsertDateTime: "2026-11-04 21:38:55.683",
    ToWinAmount: 24547,
    TicketWriter: "GSLIVE                                            ",
    VolumeAmount: 10700,
    ShortDesc: WIRE_SHORT_DESC,
    VIP: "0         ",
    AgentLogin: "SPEN",
    ...overrides,
  };
}

// A `data/live-bets.json` games row (`Report/Pending`) from the captured shape.
function pendingRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ticketNumber: "767461552",
    wagerNumber: "1",
    ticketKey: "767461552-1",
    agent: { key: "BASEBALL7", id: "BASEBALL7", level: null, agentType: null },
    customerID: "JD18959",
    status: "P",
    sport: "Football",
    subSport: "Winner (2 way)",
    period: "Game",
    wagerType: "M",
    picks: 1,
    description:
      "Football - Massachusetts vs Ball State / Game / Winner (2 way) / Massachusetts +136",
    chosenTeam: "Massachusetts +136",
    wagered: 15000,
    toWin: 20400,
    gameDateTime: "2026-11-04 21:18:58.397",
    acceptedAt: "2026-11-04 21:18:58.397",
    team1: {
      name: "Massachusetts",
      shortName: "Massachusetts",
      score: 0,
      logo: null,
      logoUrl: null,
      rotationNumber: 320190802,
    },
    team2: {
      name: "Ball State",
      shortName: "Ball State",
      score: 0,
      logo: null,
      logoUrl: null,
      rotationNumber: 320190803,
    },
    ...overrides,
  };
}

function bet(overrides: Partial<IncomingBetRecord> = {}): IncomingBetRecord {
  const base: IncomingBetRecord = {
    schemaVersion: 1,
    betKey: "T-1",
    ticketNumber: "1",
    wagerNumber: "1",
    customerId: "CUST1",
    agentId: "AG1",
    agentLogin: "AG1",
    agentLevel: null,
    channel: "GSLIVE",
    wagerType: "S",
    wagerKind: "straight",
    sport: "Basketball",
    league: "",
    subSport: "Winner (2 way)",
    period: "Game",
    rotationNumber: null,
    selection: "Lakers -110",
    description: "Lakers -110",
    shortDescription: "Lakers -110",
    americanOdds: -110,
    impliedProb: 0.5238,
    line: null,
    stakeUsd: 250,
    toWinUsd: 227,
    volumeUsd: 250,
    riskUsd: 250,
    // v3 derived numeric fields for the fixture amounts (one leg, -110).
    stakeToWinRatio: 250 / 227,
    stakePerLeg: 250,
    oddsFromEven: 210,
    isLive: false,
    isVip: false,
    acceptedAt: "2026-11-05T02:30:00.000Z",
    observedAt: OBSERVED_AT,
    ageSeconds: 600,
    source: "live-ticker",
    raw: {},
    eventLabel: "",
    eventKey: "",
    marketKey: "",
    marketType: "other",
    periodLabel: "",
    side: null,
    playerName: null,
    isPlayerProp: false,
    isAltLine: false,
    context: null,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      (base as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return base;
}

function rulePack(ruleYaml: string, path = "<inline>"): RuleLoadResult {
  return parseBetFlagRules(`schemaVersion: 1\nrules:\n${ruleYaml}`, { path });
}

function requireRule(result: RuleLoadResult): BetFlagRule {
  if (!result.ok)
    throw new Error(`rule fixture was refused: ${result.message}`);
  const first = result.ruleSet.rules[0];
  if (first === undefined) throw new Error("rule fixture parsed no rule");
  return first;
}

function parseOneRule(ruleYaml: string): BetFlagRule {
  return requireRule(rulePack(ruleYaml));
}

function refusal(result: RuleLoadResult): string[] {
  if (result.ok) throw new Error("expected the rule pack to be refused");
  expect(result.code).toBe("rules_invalid");
  return [...result.errors];
}

function probePack(whenYaml: string): RuleLoadResult {
  return rulePack(
    [
      "  - id: probe",
      "    title: Probe",
      "    severity: medium",
      "    enabled: true",
      `    when: ${whenYaml}`,
    ].join("\n"),
  );
}

function recordRule(whenYaml: string): BetFlagRule {
  return requireRule(probePack(whenYaml));
}

function aggregatePack(aggregateYaml: string): RuleLoadResult {
  return rulePack(
    [
      "  - id: agg",
      "    title: Agg",
      "    severity: high",
      "    enabled: true",
      "    when: { field: isLive, op: eq, value: true }",
      `    aggregate: ${aggregateYaml}`,
    ].join("\n"),
  );
}

function aggregateRule(aggregateYaml: string): BetFlagRule {
  return requireRule(aggregatePack(aggregateYaml));
}

/**
 * Like {@link aggregateRule} but with a `when` that every fixture satisfies (a stake exists), for
 * the v2 tests that exercise market grouping rather than the shared isLive velocity predicate.
 */
function marketAggregateRule(aggregateYaml: string): BetFlagRule {
  return requireRule(
    rulePack(
      [
        "  - id: agg",
        "    title: Agg",
        "    severity: high",
        "    enabled: true",
        "    when: { field: stakeUsd, op: exists, value: true }",
        `    aggregate: ${aggregateYaml}`,
      ].join("\n"),
    ),
  );
}

function matches(
  whenYaml: string,
  overrides: Partial<IncomingBetRecord> = {},
): boolean {
  const rule = recordRule(whenYaml);
  const { findings } = evaluateBetFlagRules([bet(overrides)], [rule], {
    now: NOW,
  });
  return findings.length === 1;
}

const STAKE_RULE = parseOneRule(
  [
    "  - id: stake_over_100",
    "    title: Stake over 100",
    "    severity: high",
    "    enabled: true",
    "    when: { field: stakeUsd, op: gte, value: 100 }",
  ].join("\n"),
);

function liveBet(
  index: number,
  acceptedAt: string,
  overrides: Partial<IncomingBetRecord> = {},
): IncomingBetRecord {
  return bet({
    betKey: `LIVE-${index}`,
    customerId: "CUST1",
    agentId: "AG1",
    agentLogin: "AG1",
    isLive: true,
    acceptedAt,
    ...overrides,
  });
}

// -------------------------------------------------------------------------------------------------

describe("closed vocabulary", () => {
  test("FLAG_SEVERITIES is ascending", () => {
    expect(FLAG_SEVERITIES).toEqual([
      "info",
      "low",
      "medium",
      "high",
      "critical",
    ]);
  });

  test("BET_FLAG_OPS keeps the v1 operator list and appends between (v2)", () => {
    // The v1 eleven stay first and in order; v2 only appends, so a v1 rule pack means the same.
    expect(BET_FLAG_OPS.slice(0, 11)).toEqual([
      "eq",
      "neq",
      "gt",
      "gte",
      "lt",
      "lte",
      "in",
      "not_in",
      "contains",
      "matches",
      "exists",
    ]);
    expect(BET_FLAG_OPS.slice(11)).toEqual(["between"]);
  });

  test("BET_FLAG_FIELDS exposes the wide shape and not the wire row", () => {
    expect(BET_FLAG_FIELDS).toContain("stakeUsd");
    expect(BET_FLAG_FIELDS).toContain("isLive");
    expect(BET_FLAG_FIELDS).toContain("channel");
    expect(BET_FLAG_FIELDS).toContain("americanOdds");
    expect(BET_FLAG_FIELDS).not.toContain("raw");
    expect(BET_FLAG_FIELDS).not.toContain("schemaVersion");
  });

  test("BET_FLAG_FIELDS adds the v2 depth fields and every context.* field", () => {
    for (const field of [
      "eventLabel",
      "eventKey",
      "marketKey",
      "marketType",
      "periodLabel",
      "side",
      "playerName",
      "isPlayerProp",
      "isAltLine",
    ]) {
      expect(BET_FLAG_FIELDS).toContain(field);
    }
    for (const contextField of BET_CONTEXT_FIELDS) {
      expect(BET_FLAG_FIELDS).toContain(`context.${contextField}`);
    }
    // The object itself is not a comparable field.
    expect(BET_FLAG_FIELDS).not.toContain("context");
  });
});

// -------------------------------------------------------------------------------------------------

describe("widenTickerRow", () => {
  test("widens the captured wire row", () => {
    const record = widenTickerRow(tickerRow(), { observedAt: OBSERVED_AT });
    if (record === null) throw new Error("expected the wire row to widen");
    expect(record.schemaVersion).toBe(1);
    expect(record.betKey).toBe("767463594");
    expect(record.ticketNumber).toBe("");
    expect(record.wagerNumber).toBe("767463594");
    expect(record.customerId).toBe("BCC1413");
    expect(record.agentId).toBe("SPEN");
    expect(record.agentLogin).toBe("SPEN");
    expect(record.agentLevel).toBeNull();
    expect(record.channel).toBe("GSLIVE");
    expect(record.wagerType).toBe("P");
    expect(record.wagerKind).toBe("parlay");
    expect(record.sport).toBe("Basketball");
    expect(record.period).toBe("Game");
    expect(record.subSport).toBe("Winner (2 way)");
    expect(record.rotationNumber).toBeNull();
    expect(record.selection).toBe("Phoenix Suns -132");
    expect(record.shortDescription).toBe("Phoenix Suns -132");
    expect(record.description).toContain("Phoenix Suns -132");
    expect(record.americanOdds).toBe(-132);
    expect(record.impliedProb).toBeCloseTo(0.569, 3);
    expect(record.line).toBeNull();
    expect(record.stakeUsd).toBe(10700);
    expect(record.toWinUsd).toBe(24547);
    expect(record.volumeUsd).toBe(10700);
    expect(record.riskUsd).toBe(10700);
    expect(record.isLive).toBe(false);
    expect(record.isVip).toBe(false);
    expect(record.source).toBe("live-ticker");
    expect(record.raw.WagerNumber).toBe(767463594);
  });

  test("converts the portal wall clock to an ISO instant and derives the age", () => {
    const record = widenTickerRow(tickerRow(), { observedAt: OBSERVED_AT });
    if (record === null) throw new Error("expected the wire row to widen");
    // 2026-11-04 21:38:55.683 is the portal's America/New_York clock (EST, UTC-5 in November).
    expect(record.acceptedAt).toBe("2026-11-05T02:38:55.683Z");
    expect(record.observedAt).toBe(OBSERVED_AT);
    expect(record.ageSeconds).toBe(64);
  });

  test("accepts the normalized F402TickerRow camel shape", () => {
    const record = widenTickerRow(
      {
        login: "W99",
        customerId: "W99",
        agentId: "AG9",
        agentLogin: "AG9",
        ticketWriter: "Internet",
        wagerNumber: "9001",
        ticketNumber: "",
        wagerType: "S",
        shortDesc: "S:Basketball #540 Warriors -2 -110 - For Game",
        insertedAt: "2026-11-04 21:00:00.000",
        vip: "0",
        amountWagered: 250,
        toWinAmount: 227,
        volumeAmount: 250,
      },
      { observedAt: OBSERVED_AT },
    );
    if (record === null)
      throw new Error("expected the normalized row to widen");
    expect(record.customerId).toBe("W99");
    expect(record.channel).toBe("INTERNET");
    expect(record.wagerKind).toBe("straight");
    expect(record.sport).toBe("Basketball");
    expect(record.period).toBe("Game");
    expect(record.selection).toBe("Warriors -2 -110");
    expect(record.americanOdds).toBe(-110);
    expect(record.line).toBe(-2);
    expect(record.acceptedAt).toBe("2026-11-05T02:00:00.000Z");
    // `raw` keeps the row as handed in.
    expect(record.raw.login).toBe("W99");
  });

  test("pins ALERT sentinel money to zero so a mirror cannot double a stake", () => {
    const record = widenTickerRow(
      tickerRow({ TicketWriter: "ALERT", VolumeAmount: 0 }),
      { observedAt: OBSERVED_AT },
    );
    if (record === null) throw new Error("expected the ALERT row to widen");
    expect(record.channel).toBe("ALERT");
    expect(record.stakeUsd).toBe(0);
    expect(record.toWinUsd).toBe(0);
    expect(record.volumeUsd).toBe(0);
    expect(record.riskUsd).toBe(0);
  });

  test("maps an unknown or sentinel TicketWriter to OTHER", () => {
    const blocked = widenTickerRow(
      tickerRow({ TicketWriter: "BLOCKED", VolumeAmount: 0 }),
      { observedAt: OBSERVED_AT },
    );
    if (blocked === null) throw new Error("expected the BLOCKED row to widen");
    expect(blocked.channel).toBe("OTHER");
    expect(blocked.stakeUsd).toBe(0);
    const unknown = widenTickerRow(
      tickerRow({ TicketWriter: "CARRIER-PIGEON" }),
      {
        observedAt: OBSERVED_AT,
      },
    );
    if (unknown === null) throw new Error("expected the unknown row to widen");
    expect(unknown.channel).toBe("OTHER");
    expect(unknown.stakeUsd).toBe(10700);
  });

  test("reads the VIP wire flag", () => {
    const vip = widenTickerRow(tickerRow({ VIP: "1" }), {
      observedAt: OBSERVED_AT,
    });
    expect(vip?.isVip).toBe(true);
    const plain = widenTickerRow(tickerRow(), { observedAt: OBSERVED_AT });
    expect(plain?.isVip).toBe(false);
  });

  test("keeps an undocumented wager type as other on a single leg", () => {
    const record = widenTickerRow(
      tickerRow({
        WagerType: "M",
        ShortDesc:
          "Basketball - Lakers vs Celtics / Game / Winner (2 way) / Lakers -110",
      }),
      { observedAt: OBSERVED_AT },
    );
    if (record === null) throw new Error("expected the row to widen");
    expect(record.wagerKind).toBe("other");
  });

  test("honors the source override", () => {
    const record = widenTickerRow(tickerRow(), {
      observedAt: OBSERVED_AT,
      source: "capture-wagers",
    });
    expect(record?.source).toBe("capture-wagers");
  });

  test("returns null for rows with no identity", () => {
    expect(widenTickerRow(null, { observedAt: OBSERVED_AT })).toBeNull();
    expect(widenTickerRow("row", { observedAt: OBSERVED_AT })).toBeNull();
    expect(widenTickerRow([], { observedAt: OBSERVED_AT })).toBeNull();
    expect(widenTickerRow({}, { observedAt: OBSERVED_AT })).toBeNull();
    expect(
      widenTickerRow(
        { CustomerID: "   ", Login: "" },
        { observedAt: OBSERVED_AT },
      ),
    ).toBeNull();
  });
});

// -------------------------------------------------------------------------------------------------

describe("widenWagerRow", () => {
  test("widens a live-wagers LIST row with its file observation instant", () => {
    const record = widenWagerRow(
      tickerRow({
        WagerType: "S",
        ShortDesc:
          "Football - Rams vs Chargers / Game / Point spread / Rams -10 -145",
        AmountWagered: 5000,
        ToWinAmount: 3448,
        VolumeAmount: 5000,
      }),
      { observedAt: OBSERVED_AT },
    );
    if (record === null) throw new Error("expected the wager row to widen");
    expect(record.source).toBe("capture-wagers");
    expect(record.selection).toBe("Rams -10 -145");
    expect(record.americanOdds).toBe(-145);
    expect(record.line).toBe(-10);
    expect(record.wagerKind).toBe("straight");
    expect(record.stakeUsd).toBe(5000);
    expect(record.observedAt).toBe(OBSERVED_AT);
  });

  test("returns null for a non-row", () => {
    expect(widenWagerRow(undefined, { observedAt: OBSERVED_AT })).toBeNull();
    expect(
      widenWagerRow({ Login: "" }, { observedAt: OBSERVED_AT }),
    ).toBeNull();
  });
});

// -------------------------------------------------------------------------------------------------

describe("widenPendingRow", () => {
  test("widens a Report/Pending games row", () => {
    const record = widenPendingRow(pendingRow(), { observedAt: OBSERVED_AT });
    if (record === null) throw new Error("expected the pending row to widen");
    expect(record.source).toBe("capture-bets");
    expect(record.betKey).toBe("767461552-1");
    expect(record.ticketNumber).toBe("767461552");
    expect(record.wagerNumber).toBe("1");
    expect(record.customerId).toBe("JD18959");
    expect(record.agentId).toBe("BASEBALL7");
    expect(record.agentLogin).toBe("BASEBALL7");
    expect(record.agentLevel).toBeNull();
    expect(record.channel).toBe("OTHER");
    expect(record.wagerType).toBe("M");
    expect(record.wagerKind).toBe("straight");
    expect(record.sport).toBe("Football");
    expect(record.subSport).toBe("Winner (2 way)");
    expect(record.period).toBe("Game");
    expect(record.rotationNumber).toBe(320190802);
    expect(record.selection).toBe("Massachusetts +136");
    expect(record.shortDescription).toBe("Massachusetts +136");
    expect(record.description).toContain("Massachusetts");
    expect(record.americanOdds).toBe(136);
    expect(record.impliedProb).toBeCloseTo(0.4237, 3);
    expect(record.line).toBeNull();
    expect(record.stakeUsd).toBe(15000);
    expect(record.toWinUsd).toBe(20400);
    // The report carries no volume field; absent is not zero.
    expect(record.volumeUsd).toBeNull();
    expect(record.riskUsd).toBe(15000);
    expect(record.isLive).toBe(false);
    expect(record.isVip).toBe(false);
    expect(record.acceptedAt).toBe("2026-11-05T02:18:58.397Z");
    expect(record.ageSeconds).toBe(1261);
    expect(record.raw.ticketNumber).toBe("767461552");
  });

  test("derives the ticket-leg key when the row has no ticketKey", () => {
    const record = widenPendingRow(pendingRow({ ticketKey: undefined }), {
      observedAt: OBSERVED_AT,
    });
    expect(record?.betKey).toBe("767461552-1");
  });

  test("reads the agent level and multi-pick parlay", () => {
    const record = widenPendingRow(
      pendingRow({
        agent: { key: "BIGDAD", id: "BIGDAD", level: 8, agentType: "A" },
        picks: 3,
      }),
      { observedAt: OBSERVED_AT },
    );
    if (record === null) throw new Error("expected the pending row to widen");
    expect(record.agentId).toBe("BIGDAD");
    expect(record.agentLevel).toBe(8);
    expect(record.wagerKind).toBe("parlay");
  });

  test("returns null for rows with no customer identity", () => {
    expect(widenPendingRow(null, { observedAt: OBSERVED_AT })).toBeNull();
    expect(
      widenPendingRow({ ticketNumber: "1" }, { observedAt: OBSERVED_AT }),
    ).toBeNull();
  });
});

// -------------------------------------------------------------------------------------------------

describe("parseBetFlagRules", () => {
  test("parses a valid pack with tags and description", () => {
    const result = parseBetFlagRules(
      [
        "schemaVersion: 1",
        "rules:",
        "  - id: example_rule",
        "    title: Example rule",
        "    severity: medium",
        "    enabled: true",
        "    description: A rule.",
        "    tags: [stake, live]",
        "    when:",
        "      all:",
        "        - { field: stakeUsd, op: gte, value: 100 }",
        "        - { field: isLive, op: eq, value: true }",
      ].join("\n"),
      { path: "pack.yml" },
    );
    const rule = requireRule(result);
    if (!result.ok) throw new Error("unreachable");
    expect(result.ruleSet.path).toBe("pack.yml");
    expect(result.ruleSet.schemaVersion).toBe(1);
    expect(rule.id).toBe("example_rule");
    expect(rule.severity).toBe("medium");
    expect(rule.enabled).toBe(true);
    expect(rule.description).toBe("A rule.");
    expect(rule.tags).toEqual(["stake", "live"]);
    expect(rule.when).toEqual({
      all: [
        { field: "stakeUsd", op: "gte", value: 100 },
        { field: "isLive", op: "eq", value: true },
      ],
    });
    expect(rule.aggregate).toBeUndefined();
  });

  test("defaults the path when omitted", () => {
    const rule = parseOneRule(
      [
        "  - id: probe",
        "    title: Probe",
        "    severity: low",
        "    enabled: false",
        "    when: { field: isLive, op: eq, value: true }",
      ].join("\n"),
    );
    expect(rule.id).toBe("probe");
    const inline = parseBetFlagRules(
      "schemaVersion: 1\nrules:\n  - id: p\n    title: P\n    severity: low\n    enabled: false\n    when: { field: isLive, op: eq, value: true }",
    );
    if (!inline.ok) throw new Error(inline.message);
    expect(inline.ruleSet.path).toBe("<inline>");
  });

  test("refuses an empty document", () => {
    const errors = refusal(parseBetFlagRules("", { path: "empty.yml" }));
    expect(errors[0]).toContain("empty.yml");
    expect(errors[0]).toContain("empty");
  });

  test("refuses invalid YAML with the path in the message", () => {
    const errors = refusal(
      parseBetFlagRules("rules: [unclosed\n", { path: "broken.yml" }),
    );
    expect(errors[0]).toContain("broken.yml");
    expect(errors[0]).toContain("invalid YAML");
  });

  test("refuses a non-mapping top level", () => {
    const errors = refusal(
      parseBetFlagRules("- one\n- two\n", { path: "p.yml" }),
    );
    expect(errors[0]).toContain("top level must be a mapping");
  });

  test("refuses an unknown top-level key", () => {
    const errors = refusal(
      parseBetFlagRules("schemaVersion: 1\nrulse: []\nrules: []\n", {
        path: "p.yml",
      }),
    );
    const joined = errors.join("\n");
    expect(joined).toContain('unknown key "rulse"');
  });

  test("refuses the wrong schemaVersion", () => {
    const errors = refusal(
      parseBetFlagRules("schemaVersion: 2\nrules: []\n", { path: "p.yml" }),
    );
    expect(errors.join("\n")).toContain("schemaVersion: must be 1");
  });

  test("refuses a missing or empty rules list", () => {
    const missing = refusal(
      parseBetFlagRules("schemaVersion: 1\n", { path: "p.yml" }),
    );
    expect(missing.join("\n")).toContain("rules: must be a list");
    const empty = refusal(
      parseBetFlagRules("schemaVersion: 1\nrules: []\n", { path: "p.yml" }),
    );
    expect(empty.join("\n")).toContain("at least one rule");
  });

  test("refuses an unknown rule key", () => {
    const errors = refusal(
      rulePack(
        [
          "  - id: probe",
          "    title: Probe",
          "    severity: low",
          "    enabled: true",
          "    enable: true",
          "    when: { field: isLive, op: eq, value: true }",
        ].join("\n"),
      ),
    );
    expect(errors.join("\n")).toContain('unknown rule key "enable"');
  });

  test("refuses an unknown severity", () => {
    const errors = refusal(
      rulePack(
        [
          "  - id: probe",
          "    title: Probe",
          "    severity: severe",
          "    enabled: true",
          "    when: { field: isLive, op: eq, value: true }",
        ].join("\n"),
      ),
    );
    expect(errors.join("\n")).toContain('unknown severity "severe"');
  });

  test("refuses a duplicate rule id", () => {
    const errors = refusal(
      rulePack(
        [
          "  - id: probe",
          "    title: One",
          "    severity: low",
          "    enabled: true",
          "    when: { field: isLive, op: eq, value: true }",
          "  - id: probe",
          "    title: Two",
          "    severity: high",
          "    enabled: false",
          "    when: { field: isLive, op: eq, value: false }",
        ].join("\n"),
      ),
    );
    expect(errors.join("\n")).toContain('duplicate rule id "probe"');
  });

  test("refuses an unknown field", () => {
    const errors = refusal(probePack("{ field: stake, op: gte, value: 100 }"));
    expect(errors.join("\n")).toContain('unknown field "stake"');
  });

  test("refuses an unknown operator", () => {
    const errors = refusal(
      probePack("{ field: stakeUsd, op: approximately, value: 100 }"),
    );
    expect(errors.join("\n")).toContain('unknown op "approximately"');
  });

  test("refuses an empty all and an empty any", () => {
    const all = refusal(
      rulePack(
        "  - id: probe\n    title: P\n    severity: low\n    enabled: true\n    when:\n      all: []",
      ),
    );
    expect(all.join("\n")).toContain("must not be empty");
    const any = refusal(
      rulePack(
        "  - id: probe\n    title: P\n    severity: low\n    enabled: true\n    when:\n      any: []",
      ),
    );
    expect(any.join("\n")).toContain("must not be empty");
  });

  test("refuses a predicate that mixes a branch and a leaf", () => {
    const errors = refusal(
      rulePack(
        [
          "  - id: probe",
          "    title: P",
          "    severity: low",
          "    enabled: true",
          "    when:",
          "      all: [{ field: isLive, op: eq, value: true }]",
          "      field: isLive",
        ].join("\n"),
      ),
    );
    expect(errors.join("\n")).toContain("not both");
  });

  test("refuses an invalid regex", () => {
    const errors = refusal(
      probePack('{ field: period, op: matches, value: "([unclosed" }'),
    );
    expect(errors.join("\n")).toContain("invalid regular expression");
  });

  test("refuses a PCRE-style inline flag regex (JavaScript has no (?i))", () => {
    // This is the mistake that shipped once in config/bet-flags.yml; the shipped-pack test below
    // is the regression guard, and the message must name the pattern so the fix is obvious.
    const errors = refusal(
      probePack('{ field: period, op: matches, value: "(?i)^1st half$" }'),
    );
    const joined = errors.join("\n");
    expect(joined).toContain("invalid regular expression");
    expect(joined).toContain("(?i)");
  });

  test("refuses a range operator without a numeric value", () => {
    const errors = refusal(
      probePack('{ field: stakeUsd, op: gte, value: "10000" }'),
    );
    expect(errors.join("\n")).toContain("needs a finite number");
  });

  test("refuses a missing value for a value-taking operator", () => {
    const errors = refusal(probePack("{ field: stakeUsd, op: gte }"));
    expect(errors.join("\n")).toContain("needs a value");
  });

  test("refuses contains with a non-string and in with an empty list", () => {
    const contains = refusal(
      probePack("{ field: description, op: contains, value: 5 }"),
    );
    expect(contains.join("\n")).toContain("non-empty string");
    const empty = refusal(probePack("{ field: channel, op: in, value: [] }"));
    expect(empty.join("\n")).toContain("non-empty list");
  });

  test("refuses a mapping value that is not a field reference", () => {
    // v3: a mapping value on a comparison op is read as `{ fieldRef }`, so a plain object is
    // refused with the field-reference errors rather than "takes a scalar".
    const errors = refusal(
      rulePack(
        [
          "  - id: probe",
          "    title: P",
          "    severity: low",
          "    enabled: true",
          "    when: { field: channel, op: eq, value: { a: 1 } }",
        ].join("\n"),
      ),
    );
    expect(errors.join("\n")).toContain("in a field reference");
    expect(errors.join("\n")).toContain(
      "must be a non-empty numeric field name",
    );
  });

  test("accepts exists without a value and with a boolean", () => {
    const noValue = recordRule("{ field: americanOdds, op: exists }");
    expect(noValue.when).toEqual({ field: "americanOdds", op: "exists" });
    const explicit = recordRule(
      "{ field: americanOdds, op: exists, value: false }",
    );
    expect(explicit.when).toEqual({
      field: "americanOdds",
      op: "exists",
      value: false,
    });
  });

  test("refuses an aggregate with no condition", () => {
    const errors = refusal(
      aggregatePack("{ groupBy: customerId, windowSeconds: 60 }"),
    );
    expect(errors.join("\n")).toContain("needs countAtLeast or sumAtLeast");
  });

  test("refuses sumField without sumAtLeast and the reverse", () => {
    const onlyField = refusal(
      aggregatePack(
        "{ groupBy: customerId, windowSeconds: 60, countAtLeast: 2, sumField: stakeUsd }",
      ),
    );
    expect(onlyField.join("\n")).toContain("sumField needs sumAtLeast");
    const onlyThreshold = refusal(
      aggregatePack(
        "{ groupBy: customerId, windowSeconds: 60, sumAtLeast: 1000 }",
      ),
    );
    expect(onlyThreshold.join("\n")).toContain("sumAtLeast needs sumField");
  });

  test("refuses an unknown aggregate key, groupBy and window", () => {
    const unknownKey = refusal(
      aggregatePack(
        "{ groupBy: customerId, windowSeconds: 60, countAtLeast: 2, minCount: 3 }",
      ),
    );
    expect(unknownKey.join("\n")).toContain('unknown aggregate key "minCount"');
    const groupBy = refusal(
      aggregatePack("{ groupBy: login, windowSeconds: 60, countAtLeast: 2 }"),
    );
    expect(groupBy.join("\n")).toContain("groupBy: must be one of");
    const window = refusal(
      aggregatePack(
        "{ groupBy: customerId, windowSeconds: 0, countAtLeast: 2 }",
      ),
    );
    expect(window.join("\n")).toContain("windowSeconds: must be an integer");
  });

  test("refuses an invalid aggregate where predicate", () => {
    const errors = refusal(
      aggregatePack(
        "{ groupBy: customerId, windowSeconds: 60, countAtLeast: 2, where: { field: nope, op: eq, value: 1 } }",
      ),
    );
    expect(errors.join("\n")).toContain('unknown field "nope"');
  });

  test("collects every error instead of stopping at the first", () => {
    const errors = refusal(
      rulePack(
        [
          "  - id: probe",
          "    title: P",
          "    severity: severe",
          "    enabled: true",
          "    when: { field: nope, op: eq, value: 1 }",
        ].join("\n"),
      ),
    );
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });
});

// -------------------------------------------------------------------------------------------------

describe("loadBetFlagRules", () => {
  test("reports a missing file as rules_missing, not as empty rules", async () => {
    const result = await loadBetFlagRules(
      join(ROOT, "config", "bet-flags-does-not-exist.yml"),
    );
    if (result.ok) throw new Error("expected a missing-file refusal");
    expect(result.code).toBe("rules_missing");
    expect(result.errors).toEqual([]);
    expect(result.path).toContain("bet-flags-does-not-exist.yml");
  });

  test("reports an unreadable path (a directory) as rules_unreadable", async () => {
    const result = await loadBetFlagRules(join(ROOT, "config"));
    if (result.ok) throw new Error("expected an unreadable refusal");
    expect(result.code).toBe("rules_unreadable");
  });

  test("the shipped config/bet-flags.yml is valid and mixes examples with templates", async () => {
    const result = await loadBetFlagRules(CONFIG_PATH);
    if (!result.ok)
      throw new Error(`shipped rule pack is invalid: ${result.message}`);
    const { rules } = result.ruleSet;
    expect(result.ruleSet.schemaVersion).toBe(1);
    expect(result.ruleSet.path).toBe(CONFIG_PATH);
    expect(rules.length).toBeGreaterThanOrEqual(6);
    const enabled = rules.filter((rule) => rule.enabled);
    const disabled = rules.filter((rule) => !rule.enabled);
    expect(enabled.length).toBeGreaterThanOrEqual(2);
    expect(disabled.length).toBeGreaterThanOrEqual(4);
    expect(new Set(rules.map((rule) => rule.id)).size).toBe(rules.length);
    const stake = rules.find((rule) => rule.id === "stake_over_10k");
    expect(stake?.enabled).toBe(true);
    expect(stake?.severity).toBe("high");
    expect(stake?.aggregate).toBeUndefined();
    const rapid = rules.find((rule) => rule.id === "rapid_fire_5_in_60s");
    expect(rapid?.enabled).toBe(false);
    expect(rapid?.aggregate?.groupBy).toBe("customerId");
    expect(rapid?.aggregate?.countAtLeast).toBe(5);
    const sum = rules.find((rule) => rule.id === "agent_stake_100k_in_5m");
    expect(sum?.aggregate?.sumField).toBe("stakeUsd");
    expect(sum?.aggregate?.sumAtLeast).toBe(100000);
  });
});

// -------------------------------------------------------------------------------------------------

describe("evaluateBetFlagRules record rules", () => {
  test("emits one finding with evidence and a per-ticket dedupe key", () => {
    const both = [
      bet({ betKey: "T-1", stakeUsd: 250 }),
      bet({ betKey: "T-2", stakeUsd: 5 }),
    ];
    const { findings, evaluated, skippedDisabled } = evaluateBetFlagRules(
      both,
      [STAKE_RULE],
      { now: NOW },
    );
    expect(evaluated).toBe(1);
    expect(skippedDisabled).toBe(0);
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    if (finding === undefined) throw new Error("expected one finding");
    expect(finding.ruleId).toBe("stake_over_100");
    expect(finding.ruleTitle).toBe("Stake over 100");
    expect(finding.severity).toBe("high");
    expect(finding.bet.betKey).toBe("T-1");
    expect(finding.matchedAt).toBe(NOW.toISOString());
    expect(finding.dedupeKey).toBe("stake_over_100:T-1");
    expect(finding.evidence).toEqual({
      kind: "record",
      fields: { stakeUsd: 250 },
    });
  });

  test("counts disabled templates as skipped and evaluates none of them", () => {
    const disabled = parseOneRule(
      [
        "  - id: off",
        "    title: Off",
        "    severity: high",
        "    enabled: false",
        "    when: { field: stakeUsd, op: gte, value: 1 }",
      ].join("\n"),
    );
    const result = evaluateBetFlagRules([bet()], [STAKE_RULE, disabled], {
      now: NOW,
    });
    expect(result.evaluated).toBe(1);
    expect(result.skippedDisabled).toBe(1);
    expect(result.findings).toHaveLength(1);
  });

  test("evaluates rules in file order", () => {
    const second = parseOneRule(
      [
        "  - id: second",
        "    title: Second",
        "    severity: low",
        "    enabled: true",
        "    when: { field: stakeUsd, op: gte, value: 100 }",
      ].join("\n"),
    );
    const { findings } = evaluateBetFlagRules([bet()], [STAKE_RULE, second], {
      now: NOW,
    });
    expect(findings.map((finding) => finding.ruleId)).toEqual([
      "stake_over_100",
      "second",
    ]);
  });

  test("all/any/not compose predicates", () => {
    const all = parseOneRule(
      [
        "  - id: all_rule",
        "    title: All",
        "    severity: high",
        "    enabled: true",
        "    when:",
        "      all:",
        "        - { field: isLive, op: eq, value: true }",
        "        - { field: stakeUsd, op: gte, value: 100 }",
      ].join("\n"),
    );
    expect(
      evaluateBetFlagRules([bet({ isLive: true })], [all], { now: NOW })
        .findings,
    ).toHaveLength(1);
    expect(
      evaluateBetFlagRules([bet({ isLive: false })], [all], { now: NOW })
        .findings,
    ).toHaveLength(0);

    const any = parseOneRule(
      [
        "  - id: any_rule",
        "    title: Any",
        "    severity: high",
        "    enabled: true",
        "    when:",
        "      any:",
        "        - { field: channel, op: eq, value: ALERT }",
        "        - { field: channel, op: eq, value: GSLIVE }",
      ].join("\n"),
    );
    expect(
      evaluateBetFlagRules([bet({ channel: "GSLIVE" })], [any], { now: NOW })
        .findings,
    ).toHaveLength(1);
    expect(
      evaluateBetFlagRules([bet({ channel: "INTERNET" })], [any], { now: NOW })
        .findings,
    ).toHaveLength(0);

    const not = parseOneRule(
      [
        "  - id: not_rule",
        "    title: Not",
        "    severity: high",
        "    enabled: true",
        "    when:",
        "      not: { field: channel, op: eq, value: ALERT }",
      ].join("\n"),
    );
    expect(
      evaluateBetFlagRules([bet({ channel: "GSLIVE" })], [not], { now: NOW })
        .findings,
    ).toHaveLength(1);
    expect(
      evaluateBetFlagRules([bet({ channel: "ALERT" })], [not], { now: NOW })
        .findings,
    ).toHaveLength(0);
  });

  const OP_CASES: readonly {
    when: string;
    overrides?: Partial<IncomingBetRecord>;
    expected: boolean;
  }[] = [
    { when: "{ field: stakeUsd, op: eq, value: 250 }", expected: true },
    // Strict equality: a numeric string is not the number.
    { when: '{ field: stakeUsd, op: eq, value: "250" }', expected: false },
    { when: "{ field: channel, op: neq, value: ALERT }", expected: true },
    { when: "{ field: stakeUsd, op: gt, value: 249 }", expected: true },
    { when: "{ field: stakeUsd, op: gt, value: 250 }", expected: false },
    { when: "{ field: stakeUsd, op: gte, value: 250 }", expected: true },
    { when: "{ field: stakeUsd, op: lt, value: 251 }", expected: true },
    { when: "{ field: stakeUsd, op: lte, value: 250 }", expected: true },
    {
      when: "{ field: channel, op: in, value: [GSLIVE, INTERNET] }",
      expected: true,
    },
    { when: "{ field: channel, op: in, value: [ALERT] }", expected: false },
    {
      when: "{ field: channel, op: not_in, value: [ALERT, OTHER] }",
      expected: true,
    },
    {
      when: '{ field: description, op: contains, value: "LAKERS" }',
      expected: true,
    },
    {
      // JavaScript RegExp has no inline "(?i)" flag; case variance is spelled explicitly.
      when: '{ field: period, op: matches, value: "^[Gg]ame$" }',
      expected: true,
    },
    {
      when: '{ field: period, op: matches, value: "^1st" }',
      expected: false,
    },
    {
      when: "{ field: americanOdds, op: exists, value: true }",
      expected: true,
    },
    {
      when: "{ field: americanOdds, op: exists }",
      overrides: { americanOdds: null },
      expected: false,
    },
    {
      when: "{ field: americanOdds, op: exists, value: false }",
      overrides: { americanOdds: null, impliedProb: null },
      expected: true,
    },
    {
      when: "{ field: americanOdds, op: gte, value: 0 }",
      overrides: { americanOdds: null, impliedProb: null },
      expected: false,
    },
    {
      when: "{ field: league, op: exists, value: false }",
      expected: true,
    },
  ];
  for (const scenario of OP_CASES) {
    test(`operator case ${scenario.when}`, () => {
      expect(matches(scenario.when, scenario.overrides ?? {})).toBe(
        scenario.expected,
      );
    });
  }

  test("returns no findings when nothing matches", () => {
    const result = evaluateBetFlagRules([], [STAKE_RULE], { now: NOW });
    expect(result.findings).toEqual([]);
    expect(result.evaluated).toBe(1);
  });

  test("evaluates one bet per betKey, preferring the non-ALERT row", () => {
    const alert = bet({
      betKey: "T-9",
      channel: "ALERT",
      stakeUsd: 0,
      toWinUsd: 0,
      volumeUsd: 0,
      riskUsd: 0,
    });
    const real = bet({ betKey: "T-9", channel: "GSLIVE", stakeUsd: 15000 });
    const { findings } = evaluateBetFlagRules([alert, real], [STAKE_RULE], {
      now: NOW,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.bet.channel).toBe("GSLIVE");
    expect(findings[0]?.bet.stakeUsd).toBe(15000);
  });
});

// -------------------------------------------------------------------------------------------------

describe("evaluateBetFlagRules aggregate rules", () => {
  const COUNT_RULE = aggregateRule(
    "{ groupBy: customerId, windowSeconds: 60, countAtLeast: 3 }",
  );

  test("counts live bets in the window and flags the group", () => {
    const records = [
      liveBet(1, "2026-11-05T02:39:10.000Z"),
      liveBet(2, "2026-11-05T02:39:20.000Z"),
      liveBet(3, "2026-11-05T02:39:30.000Z"),
    ];
    const { findings } = evaluateBetFlagRules(records, [COUNT_RULE], {
      now: NOW,
    });
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    if (finding === undefined) throw new Error("expected a finding");
    expect(finding.ruleId).toBe("agg");
    expect(finding.bet.betKey).toBe("LIVE-3");
    expect(finding.evidence).toEqual({
      kind: "aggregate",
      groupBy: "customerId",
      groupValue: "CUST1",
      windowSeconds: 60,
      windowStart: "2026-11-05T02:39:00.000Z",
      windowEnd: "2026-11-05T02:40:00.000Z",
      bucketStart: "2026-11-05T02:40:00.000Z",
      count: 3,
      memberBetKeys: ["LIVE-3", "LIVE-2", "LIVE-1"],
    });
    expect(finding.dedupeKey).toBe(
      "agg:aggregate:CUST1:2026-11-05T02:40:00.000Z",
    );
  });

  test("excludes bets older than the window and non-matching bets", () => {
    const records = [
      liveBet(1, "2026-11-05T02:39:10.000Z"),
      liveBet(2, "2026-11-05T02:39:20.000Z"),
      liveBet(3, "2026-11-05T02:38:00.000Z"),
      // Not live: fails the rule-level `when`.
      bet({
        betKey: "PREGAME",
        isLive: false,
        acceptedAt: "2026-11-05T02:39:30.000Z",
      }),
    ];
    const { findings } = evaluateBetFlagRules(records, [COUNT_RULE], {
      now: NOW,
    });
    expect(findings).toEqual([]);
  });

  test("sums a money field over the window", () => {
    const recordSum = aggregateRule(
      "{ groupBy: customerId, windowSeconds: 60, sumField: stakeUsd, sumAtLeast: 10000 }",
    );
    const records = [
      liveBet(1, "2026-11-05T02:39:10.000Z", { stakeUsd: 4000 }),
      liveBet(2, "2026-11-05T02:39:20.000Z", { stakeUsd: 4000 }),
      liveBet(3, "2026-11-05T02:39:30.000Z", { stakeUsd: 4000 }),
    ];
    const { findings } = evaluateBetFlagRules(records, [recordSum], {
      now: NOW,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidence["sum"]).toBe(12000);
    expect(findings[0]?.evidence["sumField"]).toBe("stakeUsd");

    const below = evaluateBetFlagRules(
      records.map((record) => ({ ...record, stakeUsd: 3000 })),
      [recordSum],
      { now: NOW },
    );
    expect(below.findings).toEqual([]);
  });

  test("requires every configured condition, not either", () => {
    const both = aggregateRule(
      "{ groupBy: customerId, windowSeconds: 60, countAtLeast: 3, sumField: stakeUsd, sumAtLeast: 20000 }",
    );
    const records = [
      liveBet(1, "2026-11-05T02:39:10.000Z", { stakeUsd: 4000 }),
      liveBet(2, "2026-11-05T02:39:20.000Z", { stakeUsd: 4000 }),
      liveBet(3, "2026-11-05T02:39:30.000Z", { stakeUsd: 4000 }),
    ];
    expect(
      evaluateBetFlagRules(records, [both], { now: NOW }).findings,
    ).toEqual([]);
    const enough = records.map((record) => ({ ...record, stakeUsd: 8000 }));
    expect(
      evaluateBetFlagRules(enough, [both], { now: NOW }).findings,
    ).toHaveLength(1);
  });

  test("groups by agentId, agentLogin and channel as well as customerId", () => {
    const byAgent = aggregateRule(
      "{ groupBy: agentId, windowSeconds: 60, countAtLeast: 3 }",
    );
    const sameAgent = [
      liveBet(1, "2026-11-05T02:39:10.000Z", { customerId: "C1" }),
      liveBet(2, "2026-11-05T02:39:20.000Z", { customerId: "C2" }),
      liveBet(3, "2026-11-05T02:39:30.000Z", { customerId: "C3" }),
    ];
    const agentFindings = evaluateBetFlagRules(sameAgent, [byAgent], {
      now: NOW,
    }).findings;
    expect(agentFindings).toHaveLength(1);
    expect(agentFindings[0]?.evidence["groupValue"]).toBe("AG1");

    const byLogin = aggregateRule(
      "{ groupBy: agentLogin, windowSeconds: 60, countAtLeast: 3 }",
    );
    expect(
      evaluateBetFlagRules(sameAgent, [byLogin], { now: NOW }).findings,
    ).toHaveLength(1);

    const byChannel = aggregateRule(
      "{ groupBy: channel, windowSeconds: 60, countAtLeast: 2 }",
    );
    const channels = [
      liveBet(1, "2026-11-05T02:39:10.000Z", { channel: "GSLIVE" }),
      liveBet(2, "2026-11-05T02:39:20.000Z", { channel: "GSLIVE" }),
      liveBet(3, "2026-11-05T02:39:30.000Z", { channel: "INTERNET" }),
    ];
    const channelFindings = evaluateBetFlagRules(channels, [byChannel], {
      now: NOW,
    }).findings;
    expect(channelFindings).toHaveLength(1);
    expect(channelFindings[0]?.evidence["groupValue"]).toBe("GSLIVE");
  });

  test("applies the aggregate where filter on top of the rule when", () => {
    const filtered = aggregateRule(
      "{ groupBy: customerId, windowSeconds: 60, countAtLeast: 3, where: { field: channel, op: neq, value: ALERT } }",
    );
    const records = [
      liveBet(1, "2026-11-05T02:39:10.000Z", { channel: "GSLIVE" }),
      liveBet(2, "2026-11-05T02:39:20.000Z", { channel: "GSLIVE" }),
      liveBet(3, "2026-11-05T02:39:30.000Z", { channel: "ALERT" }),
    ];
    expect(
      evaluateBetFlagRules(records, [filtered], { now: NOW }).findings,
    ).toEqual([]);
  });

  test("alerts at most once per window bucket per group", () => {
    const records = [
      liveBet(1, "2026-11-05T02:40:05.000Z"),
      liveBet(2, "2026-11-05T02:40:15.000Z"),
      liveBet(3, "2026-11-05T02:40:25.000Z"),
    ];
    const first = evaluateBetFlagRules(records, [COUNT_RULE], {
      now: new Date("2026-11-05T02:40:30.000Z"),
    }).findings;
    const sameBucket = evaluateBetFlagRules(records, [COUNT_RULE], {
      now: new Date("2026-11-05T02:40:45.000Z"),
    }).findings;
    const nextBucket = evaluateBetFlagRules(records, [COUNT_RULE], {
      now: new Date("2026-11-05T02:41:00.000Z"),
    }).findings;
    expect(first[0]?.dedupeKey).toBe(sameBucket[0]?.dedupeKey);
    expect(first[0]?.dedupeKey).not.toBe(nextBucket[0]?.dedupeKey);
  });

  test("counts an ALERT twin once, not twice, in the velocity aggregate", () => {
    const records = [
      liveBet(1, "2026-11-05T02:39:10.000Z", {
        betKey: "T-1",
        channel: "GSLIVE",
      }),
      liveBet(2, "2026-11-05T02:39:20.000Z", {
        betKey: "T-2",
        channel: "GSLIVE",
      }),
      liveBet(3, "2026-11-05T02:39:30.000Z", {
        betKey: "T-3",
        channel: "GSLIVE",
      }),
      // Three ALERT mirrors of the same three tickets.
      liveBet(4, "2026-11-05T02:39:10.000Z", {
        betKey: "T-1",
        channel: "ALERT",
      }),
      liveBet(5, "2026-11-05T02:39:20.000Z", {
        betKey: "T-2",
        channel: "ALERT",
      }),
      liveBet(6, "2026-11-05T02:39:30.000Z", {
        betKey: "T-3",
        channel: "ALERT",
      }),
    ];
    const fourInWindow = aggregateRule(
      "{ groupBy: customerId, windowSeconds: 60, countAtLeast: 4 }",
    );
    expect(
      evaluateBetFlagRules(records, [fourInWindow], { now: NOW }).findings,
    ).toEqual([]);
  });

  test("returns no aggregate finding when the group is empty", () => {
    const { findings } = evaluateBetFlagRules([], [COUNT_RULE], { now: NOW });
    expect(findings).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------------

describe("dedupeKeyFor", () => {
  test("keys a record rule once per rule and ticket", () => {
    expect(dedupeKeyFor(STAKE_RULE, bet({ betKey: "T-42" }))).toBe(
      "stake_over_100:T-42",
    );
  });

  test("keys an aggregate rule per group and window bucket", () => {
    const rule = aggregateRule(
      "{ groupBy: customerId, windowSeconds: 60, countAtLeast: 2 }",
    );
    expect(
      dedupeKeyFor(rule, bet(), {
        groupValue: "CUST1",
        bucketStart: "2026-11-05T02:40:00.000Z",
      }),
    ).toBe("agg:aggregate:CUST1:2026-11-05T02:40:00.000Z");
    // Without bucket evidence the aggregate falls back to the ticket key rather than throwing.
    expect(dedupeKeyFor(rule, bet({ betKey: "T-7" }))).toBe("agg:T-7");
  });
});

// -------------------------------------------------------------------------------------------------

describe("v2 between operator", () => {
  const BETWEEN_CASES: readonly {
    when: string;
    overrides?: Partial<IncomingBetRecord>;
    expected: boolean;
  }[] = [
    // Inclusive on both bounds.
    {
      when: "{ field: stakeUsd, op: between, value: [250, 250] }",
      expected: true,
    },
    {
      when: "{ field: stakeUsd, op: between, value: [100, 300] }",
      expected: true,
    },
    {
      when: "{ field: stakeUsd, op: between, value: [251, 400] }",
      expected: false,
    },
    {
      when: "{ field: stakeUsd, op: between, value: [0, 249.99] }",
      expected: false,
    },
    {
      when: "{ field: americanOdds, op: between, value: [100, 200] }",
      overrides: { americanOdds: 136, impliedProb: 0.4237 },
      expected: true,
    },
    // A non-numeric field can never be inside a numeric range.
    { when: "{ field: channel, op: between, value: [1, 2] }", expected: false },
    // A null numeric field fails closed.
    {
      when: "{ field: stakeUsd, op: between, value: [0, 1000000] }",
      overrides: { stakeUsd: null },
      expected: false,
    },
  ];
  for (const scenario of BETWEEN_CASES) {
    test(`between case ${scenario.when}`, () => {
      expect(matches(scenario.when, scenario.overrides ?? {})).toBe(
        scenario.expected,
      );
    });
  }

  test("validation refuses a malformed range", () => {
    const oneItem = refusal(
      probePack("{ field: stakeUsd, op: between, value: [1] }"),
    );
    expect(oneItem.join("\n")).toContain("exactly two numbers");
    const nonNumeric = refusal(
      probePack('{ field: stakeUsd, op: between, value: ["1", 2] }'),
    );
    expect(nonNumeric.join("\n")).toContain("two finite numbers");
    const reversed = refusal(
      probePack("{ field: stakeUsd, op: between, value: [5, 1] }"),
    );
    expect(reversed.join("\n")).toContain("lo <= hi");
  });
});

// -------------------------------------------------------------------------------------------------

describe("v2 record depth fields in rules", () => {
  test("rules can target the structured market fields", () => {
    const prop = recordRule("{ field: isPlayerProp, op: eq, value: true }");
    expect(
      evaluateBetFlagRules([bet({ isPlayerProp: true })], [prop], { now: NOW })
        .findings,
    ).toHaveLength(1);
    expect(
      evaluateBetFlagRules([bet({ isPlayerProp: false })], [prop], { now: NOW })
        .findings,
    ).toEqual([]);

    const market = recordRule(
      "{ field: marketType, op: in, value: [spread, total] }",
    );
    expect(
      evaluateBetFlagRules([bet({ marketType: "spread" })], [market], {
        now: NOW,
      }).findings,
    ).toHaveLength(1);
    expect(
      evaluateBetFlagRules([bet({ marketType: "moneyline" })], [market], {
        now: NOW,
      }).findings,
    ).toEqual([]);

    const altLine = recordRule("{ field: isAltLine, op: eq, value: true }");
    expect(
      evaluateBetFlagRules([bet({ isAltLine: true })], [altLine], {
        now: NOW,
      }).findings,
    ).toHaveLength(1);

    const player = recordRule(
      '{ field: playerName, op: contains, value: "celebrini" }',
    );
    expect(
      evaluateBetFlagRules(
        [bet({ playerName: "Macklin Celebrini" })],
        [player],
        {
          now: NOW,
        },
      ).findings,
    ).toHaveLength(1);
  });
});

// -------------------------------------------------------------------------------------------------

describe("v2 context predicates", () => {
  const ESCALATION_RULE = parseOneRule(
    [
      "  - id: escalation",
      "    title: Escalation",
      "    severity: high",
      "    enabled: true",
      "    when:",
      "      all:",
      "        - { field: context.customerPriorBets, op: gte, value: 1 }",
      "        - { field: context.stakeVsPriorMedian, op: gte, value: 2 }",
    ].join("\n"),
  );

  function escalationBet(
    betKey: string,
    stakeUsd: number,
    acceptedAt: string,
  ): IncomingBetRecord {
    return bet({ betKey, customerId: "CUST1", stakeUsd, acceptedAt });
  }

  const ESCALATION_BETS = [
    escalationBet("T-1", 100, "2026-11-05T02:39:00.000Z"),
    escalationBet("T-2", 500, "2026-11-05T02:39:30.000Z"),
  ];

  test("a context rule fires on the enriched record only", () => {
    const enriched = enrichIncomingBets(ESCALATION_BETS, { now: NOW });
    const found = evaluateBetFlagRules(enriched, [ESCALATION_RULE], {
      now: NOW,
    }).findings;
    expect(found.map((finding) => finding.bet.betKey)).toEqual(["T-2"]);
    expect(found[0]?.bet.context?.stakeVsPriorMedian).toBe(5);
  });

  test("an unenriched record has context null and fails closed", () => {
    expect(
      evaluateBetFlagRules(ESCALATION_BETS, [ESCALATION_RULE], { now: NOW })
        .findings,
    ).toEqual([]);
  });

  test("exists distinguishes enriched from unenriched", () => {
    const exists = recordRule(
      "{ field: context.customerBetsWindow, op: exists }",
    );
    expect(
      evaluateBetFlagRules(
        enrichIncomingBets(ESCALATION_BETS, { now: NOW }),
        [exists],
        { now: NOW },
      ).findings,
    ).toHaveLength(2);
    expect(
      evaluateBetFlagRules(ESCALATION_BETS, [exists], { now: NOW }).findings,
    ).toEqual([]);
  });

  test("context.marketCrowdBets counts the enriched crowd", () => {
    const crowd = recordRule(
      "{ field: context.marketCrowdBets, op: gte, value: 2 }",
    );
    const records = [
      bet({
        betKey: "T-1",
        customerId: "C1",
        marketKey: "MKT-A",
        acceptedAt: "2026-11-05T02:39:00.000Z",
      }),
      bet({
        betKey: "T-2",
        customerId: "C2",
        marketKey: "MKT-A",
        acceptedAt: "2026-11-05T02:39:10.000Z",
      }),
    ];
    expect(
      evaluateBetFlagRules(enrichIncomingBets(records, { now: NOW }), [crowd], {
        now: NOW,
      }).findings,
    ).toHaveLength(2);
  });

  test("between works on a context field", () => {
    const between = recordRule(
      "{ field: context.stakeVsPriorMedian, op: between, value: [2, 10] }",
    );
    const found = evaluateBetFlagRules(
      enrichIncomingBets(ESCALATION_BETS, { now: NOW }),
      [between],
      { now: NOW },
    ).findings;
    expect(found.map((finding) => finding.bet.betKey)).toEqual(["T-2"]);
  });

  test("unknown context fields and arbitrary dotted paths are refused", () => {
    const contextField = refusal(
      probePack("{ field: context.nope, op: eq, value: 1 }"),
    );
    expect(contextField.join("\n")).toContain('unknown field "context.nope"');
    const dotted = refusal(
      probePack("{ field: raw.WagerNumber, op: eq, value: 1 }"),
    );
    expect(dotted.join("\n")).toContain('unknown field "raw.WagerNumber"');
  });

  test("context.windowSeconds reports the enrichment window", () => {
    const window = recordRule(
      "{ field: context.windowSeconds, op: eq, value: 120 }",
    );
    const enriched = enrichIncomingBets(ESCALATION_BETS, {
      windowSeconds: 120,
      now: NOW,
    });
    expect(
      evaluateBetFlagRules(enriched, [window], { now: NOW }).findings,
    ).toHaveLength(2);
  });
});

// -------------------------------------------------------------------------------------------------

describe("v2 aggregate market grouping", () => {
  // The shared aggregateRule helper filters on isLive; these fixtures exercise market grouping,
  // so shadow it with the every-fixture `when` variant.
  const aggregateRule = marketAggregateRule;
  const RECENT = "2026-11-05T02:39:10.000Z";
  const RECENT_2 = "2026-11-05T02:39:20.000Z";

  test("groups by marketKey", () => {
    const rule = aggregateRule(
      "{ groupBy: marketKey, windowSeconds: 300, countAtLeast: 2 }",
    );
    const findings = evaluateBetFlagRules(
      [
        bet({ betKey: "T-1", marketKey: "MKT-A", acceptedAt: RECENT }),
        bet({ betKey: "T-2", marketKey: "MKT-A", acceptedAt: RECENT_2 }),
        bet({ betKey: "T-3", marketKey: "MKT-B", acceptedAt: RECENT_2 }),
      ],
      [rule],
      { now: NOW },
    ).findings;
    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidence["groupValue"]).toBe("MKT-A");
  });

  test("groups by eventKey, periodLabel and sport", () => {
    const byEvent = aggregateRule(
      "{ groupBy: eventKey, windowSeconds: 300, countAtLeast: 2 }",
    );
    expect(
      evaluateBetFlagRules(
        [
          bet({ betKey: "T-1", eventKey: "E-1", acceptedAt: RECENT }),
          bet({ betKey: "T-2", eventKey: "E-1", acceptedAt: RECENT_2 }),
        ],
        [byEvent],
        { now: NOW },
      ).findings,
    ).toHaveLength(1);

    const byPeriod = aggregateRule(
      "{ groupBy: periodLabel, windowSeconds: 300, countAtLeast: 2 }",
    );
    const periodFindings = evaluateBetFlagRules(
      [
        bet({ betKey: "T-1", periodLabel: "1st Half", acceptedAt: RECENT }),
        bet({ betKey: "T-2", periodLabel: "1st Half", acceptedAt: RECENT_2 }),
        bet({ betKey: "T-3", periodLabel: "Game", acceptedAt: RECENT_2 }),
      ],
      [byPeriod],
      { now: NOW },
    ).findings;
    expect(periodFindings).toHaveLength(1);
    expect(periodFindings[0]?.evidence["groupValue"]).toBe("1st Half");

    const bySport = aggregateRule(
      "{ groupBy: sport, windowSeconds: 300, countAtLeast: 3 }",
    );
    expect(
      evaluateBetFlagRules(
        [
          bet({ betKey: "T-1", sport: "Basketball", acceptedAt: RECENT }),
          bet({ betKey: "T-2", sport: "Basketball", acceptedAt: RECENT }),
          bet({ betKey: "T-3", sport: "Football", acceptedAt: RECENT_2 }),
        ],
        [bySport],
        { now: NOW },
      ).findings,
    ).toEqual([]);
  });

  test("validates the new groupBy values", () => {
    const rule = aggregateRule(
      "{ groupBy: marketKey, windowSeconds: 300, countAtLeast: 2 }",
    );
    expect(rule.aggregate?.groupBy).toBe("marketKey");
    const bad = refusal(
      aggregatePack("{ groupBy: market, windowSeconds: 300, countAtLeast: 2 }"),
    );
    expect(bad.join("\n")).toContain("groupBy: must be one of");
  });
});

describe("v2 aggregate distinct counts", () => {
  // Market-grouping fixtures, not velocity: use the every-fixture `when` variant.
  const aggregateRule = marketAggregateRule;
  const RECENT = "2026-11-05T02:39:10.000Z";
  function customerBet(
    betKey: string,
    customerId: string,
    marketKey = "MKT-A",
  ): IncomingBetRecord {
    return bet({ betKey, customerId, marketKey, acceptedAt: RECENT });
  }
  const CROWD_RULE = aggregateRule(
    "{ groupBy: marketKey, windowSeconds: 300, distinctField: customerId, distinctAtLeast: 3 }",
  );

  test("counts distinct customers on one market and flags the crowd", () => {
    const findings = evaluateBetFlagRules(
      [
        customerBet("T-1", "C1"),
        customerBet("T-2", "C2"),
        customerBet("T-3", "C3"),
      ],
      [CROWD_RULE],
      { now: NOW },
    ).findings;
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    if (finding === undefined) throw new Error("expected a crowd finding");
    expect(finding.evidence["distinctField"]).toBe("customerId");
    expect(finding.evidence["distinct"]).toBe(3);
    expect(finding.evidence["count"]).toBe(3);
  });

  test("does not flag one customer betting three times", () => {
    expect(
      evaluateBetFlagRules(
        [
          customerBet("T-1", "C1"),
          customerBet("T-2", "C1"),
          customerBet("T-3", "C1"),
        ],
        [CROWD_RULE],
        { now: NOW },
      ).findings,
    ).toEqual([]);
  });

  test("an empty identity never counts as a distinct customer", () => {
    expect(
      evaluateBetFlagRules(
        [
          customerBet("T-1", "C1"),
          customerBet("T-2", "C2"),
          customerBet("T-3", ""),
        ],
        [CROWD_RULE],
        { now: NOW },
      ).findings,
    ).toEqual([]);
  });

  test("distinct agentId and marketKey are supported", () => {
    const byAgent = aggregateRule(
      "{ groupBy: marketKey, windowSeconds: 300, distinctField: agentId, distinctAtLeast: 3 }",
    );
    const agentFindings = evaluateBetFlagRules(
      [
        bet({
          betKey: "T-1",
          agentId: "AG1",
          marketKey: "MKT-A",
          acceptedAt: RECENT,
        }),
        bet({
          betKey: "T-2",
          agentId: "AG2",
          marketKey: "MKT-A",
          acceptedAt: RECENT,
        }),
        bet({
          betKey: "T-3",
          agentId: "AG3",
          marketKey: "MKT-A",
          acceptedAt: RECENT,
        }),
      ],
      [byAgent],
      { now: NOW },
    ).findings;
    expect(agentFindings).toHaveLength(1);
    expect(agentFindings[0]?.evidence["distinct"]).toBe(3);

    const byMarket = aggregateRule(
      "{ groupBy: sport, windowSeconds: 300, distinctField: marketKey, distinctAtLeast: 3 }",
    );
    const marketFindings = evaluateBetFlagRules(
      [
        bet({
          betKey: "T-1",
          sport: "Basketball",
          marketKey: "M1",
          acceptedAt: RECENT,
        }),
        bet({
          betKey: "T-2",
          sport: "Basketball",
          marketKey: "M2",
          acceptedAt: RECENT,
        }),
        bet({
          betKey: "T-3",
          sport: "Basketball",
          marketKey: "M3",
          acceptedAt: RECENT,
        }),
      ],
      [byMarket],
      { now: NOW },
    ).findings;
    expect(marketFindings).toHaveLength(1);
    expect(marketFindings[0]?.evidence["distinct"]).toBe(3);
  });

  test("distinct and count conditions must both hold", () => {
    const both = aggregateRule(
      "{ groupBy: marketKey, windowSeconds: 300, countAtLeast: 3, distinctField: customerId, distinctAtLeast: 3 }",
    );
    expect(
      evaluateBetFlagRules(
        [
          customerBet("T-1", "C1"),
          customerBet("T-2", "C1"),
          customerBet("T-3", "C2"),
        ],
        [both],
        { now: NOW },
      ).findings,
    ).toEqual([]);
    expect(
      evaluateBetFlagRules(
        [
          customerBet("T-1", "C1"),
          customerBet("T-2", "C2"),
          customerBet("T-3", "C3"),
        ],
        [both],
        { now: NOW },
      ).findings,
    ).toHaveLength(1);
  });

  test("validates distinctField/distinctAtLeast pairing", () => {
    const noAtLeast = refusal(
      aggregatePack(
        "{ groupBy: marketKey, windowSeconds: 300, distinctField: customerId }",
      ),
    );
    expect(noAtLeast.join("\n")).toContain(
      "distinctField needs distinctAtLeast",
    );
    const noField = refusal(
      aggregatePack(
        "{ groupBy: marketKey, windowSeconds: 300, distinctAtLeast: 3 }",
      ),
    );
    expect(noField.join("\n")).toContain("distinctAtLeast needs distinctField");
    const badField = refusal(
      aggregatePack(
        "{ groupBy: marketKey, windowSeconds: 300, distinctField: login, distinctAtLeast: 2 }",
      ),
    );
    expect(badField.join("\n")).toContain("distinctField: must be one of");
    const badThreshold = refusal(
      aggregatePack(
        "{ groupBy: marketKey, windowSeconds: 300, distinctField: customerId, distinctAtLeast: 0 }",
      ),
    );
    expect(badThreshold.join("\n")).toContain(
      "distinctAtLeast: must be an integer",
    );
  });
});

// -------------------------------------------------------------------------------------------------

describe("v2 default pack", () => {
  test("keeps the two enabled examples and adds five disabled v2 templates", async () => {
    const result = await loadBetFlagRules(CONFIG_PATH);
    if (!result.ok)
      throw new Error(`shipped rule pack is invalid: ${result.message}`);
    const rules = result.ruleSet.rules;
    const byId = new Map(rules.map((rule) => [rule.id, rule]));
    expect(
      rules
        .filter((rule) => rule.enabled)
        .map((rule) => rule.id)
        .sort(),
    ).toEqual(["live_american_odds_400_plus", "stake_over_10k"]);
    // 2 enabled examples + 12 disabled templates (5 v1 + 5 v2 + 2 v3).
    expect(rules).toHaveLength(14);
    for (const id of [
      "market_crowding_3_customers",
      "stake_escalation_3x",
      "period_focus_5_bets",
      "player_prop_spike",
      "alt_line_live",
    ]) {
      expect(byId.get(id)?.enabled).toBe(false);
    }
    expect(byId.get("market_crowding_3_customers")?.aggregate).toMatchObject({
      groupBy: "marketKey",
      distinctField: "customerId",
      distinctAtLeast: 3,
    });
    expect(byId.get("stake_escalation_3x")?.when).toMatchObject({
      all: expect.arrayContaining([
        { field: "context.stakeVsPriorMedian", op: "gte", value: 3 },
      ]),
    });
    expect(byId.get("player_prop_spike")?.when).toMatchObject({
      all: expect.arrayContaining([
        { field: "americanOdds", op: "between", value: [150, 600] },
      ]),
    });
  });
});

// -------------------------------------------------------------------------------------------------

describe("v2 record depth from the market parser", () => {
  test("populates the market fields for a captured ticker moneyline row", () => {
    const record = widenTickerRow(tickerRow(), { observedAt: OBSERVED_AT });
    if (record === null) throw new Error("expected the wire row to widen");
    expect(record.marketType).toBe("moneyline");
    expect(record.periodLabel).toBe("Game");
    expect(record.eventLabel).not.toBe("");
    expect(record.eventKey).not.toBe("");
    expect(record.marketKey).not.toBe("");
    expect(record.side).not.toBeNull();
    expect(record.isPlayerProp).toBe(false);
    expect(record.playerName).toBeNull();
    expect(record.isAltLine).toBe(false);
    // v2 context starts null; inplay enrichment is a separate step.
    expect(record.context).toBeNull();
  });

  test("populates spread and player-prop depth", () => {
    const spread = widenTickerRow(
      tickerRow({
        WagerType: "M",
        ShortDesc:
          "M.G320197818\r\nFootball - Massachusetts vs Ball State / Game / Point spread / Massachusetts -4.5 +146",
      }),
      { observedAt: OBSERVED_AT },
    );
    if (spread === null) throw new Error("expected the spread row to widen");
    expect(spread.marketType).toBe("spread");
    expect(spread.periodLabel).toBe("Game");

    const prop = widenTickerRow(
      tickerRow({
        WagerType: "M",
        ShortDesc:
          "M.G14748239\r\nHockey - San Jose Sharks vs Los Angeles Kings / Match (Including OT) / Player Total Shots on Goal / Macklin Celebrini Over 3.5 +115",
      }),
      { observedAt: OBSERVED_AT },
    );
    if (prop === null) throw new Error("expected the prop row to widen");
    expect(prop.marketType).toBe("player_prop");
    expect(prop.playerName).toContain("Celebrini");
    expect(prop.isPlayerProp).toBe(true);
  });

  test("populates the market fields for a Report/Pending row via hints", () => {
    const record = widenPendingRow(pendingRow(), { observedAt: OBSERVED_AT });
    if (record === null) throw new Error("expected the pending row to widen");
    expect(record.marketType).toBe("moneyline");
    expect(record.periodLabel).toBe("Game");
    expect(record.eventLabel).toContain("Massachusetts");
    expect(record.side).toContain("Massachusetts");
    expect(record.isPlayerProp).toBe(false);
    expect(record.context).toBeNull();
  });

  test("a garbage description widens without throwing", () => {
    const record = widenTickerRow(
      tickerRow({ ShortDesc: "??? :: not a market" }),
      { observedAt: OBSERVED_AT },
    );
    if (record === null) throw new Error("expected the row to widen");
    expect(record.marketType).toBe("other");
    expect(record.marketKey).not.toBeUndefined();
  });
});

// -------------------------------------------------------------------------------------------------

describe("v2 line and rotation from the parser (regression)", () => {
  test("a ticker total keeps the parser line and the #rotation", () => {
    const record = widenTickerRow(
      tickerRow({
        WagerType: "L",
        ShortDesc:
          "L.Basketball #511 Cavaliers/Thunder O 60.5 -110 - For 2nd Half",
      }),
      { observedAt: OBSERVED_AT },
    );
    if (record === null) throw new Error("expected the ticker row to widen");
    expect(record.line).toBe(60.5);
    expect(record.rotationNumber).toBe(511);
    expect(record.marketType).toBe("total");
    expect(record.periodLabel).toBe("2nd Half");
    // The market key carries the same line the record does, so a crowding rule groups by it.
    expect(record.marketKey.endsWith("|60.5")).toBe(true);
    expect(record.marketKey).toContain("2nd half");
  });

  test("a pending unicode-half total widens with the numeric line", () => {
    const description =
      "Basketball - Cavaliers vs Thunder / Game / Total / Over 115½ -110";
    const record = widenPendingRow(
      pendingRow({
        sport: "Basketball",
        subSport: "Total",
        period: "Game",
        description,
        chosenTeam: "Over 115½ -110",
        team1: {
          name: "Cavaliers",
          shortName: "Cavaliers",
          rotationNumber: 511,
        },
        team2: { name: "Thunder", shortName: "Thunder", rotationNumber: 512 },
      }),
      { observedAt: OBSERVED_AT },
    );
    if (record === null) throw new Error("expected the pending row to widen");
    expect(record.line).toBe(115.5);
    expect(record.marketType).toBe("total");
    expect(record.marketKey.endsWith("|115.5")).toBe(true);
    // The game rotation still comes from the pending row's teams (the parser reads none here).
    expect(record.rotationNumber).toBe(511);
  });
});

// -------------------------------------------------------------------------------------------------

describe("v3 derived numeric fields", () => {
  test("a ticker parlay row splits the stake per leg and derives the ratio", () => {
    const record = widenTickerRow(tickerRow(), { observedAt: OBSERVED_AT });
    if (record === null) throw new Error("expected the wire row to widen");
    expect(record.stakeUsd).toBe(10700);
    expect(record.toWinUsd).toBe(24547);
    expect(record.stakeToWinRatio).toBeCloseTo(10700 / 24547, 9);
    // The captured ShortDesc has two legs.
    expect(record.stakePerLeg).toBe(5350);
    // -132 -> |−132 − 100| = 232.
    expect(record.oddsFromEven).toBe(232);
  });

  test("a wager row and a single-leg pending row keep the whole stake per leg", () => {
    const wager = widenWagerRow(
      tickerRow({
        WagerType: "S",
        ShortDesc:
          "Football - Rams vs Chargers / Game / Point spread / Rams -10 -145",
        AmountWagered: 5000,
        ToWinAmount: 3448,
        VolumeAmount: 5000,
      }),
      { observedAt: OBSERVED_AT },
    );
    if (wager === null) throw new Error("expected the wager row to widen");
    expect(wager.stakePerLeg).toBe(5000);
    expect(wager.stakeToWinRatio).toBeCloseTo(5000 / 3448, 9);
    expect(wager.oddsFromEven).toBe(245);

    const pending = widenPendingRow(pendingRow(), { observedAt: OBSERVED_AT });
    if (pending === null) throw new Error("expected the pending row to widen");
    expect(pending.stakeUsd).toBe(15000);
    expect(pending.toWinUsd).toBe(20400);
    expect(pending.stakeToWinRatio).toBeCloseTo(15000 / 20400, 9);
    expect(pending.stakePerLeg).toBe(15000);
    // +136 -> 36 (even money is +100).
    expect(pending.oddsFromEven).toBe(36);
  });

  test("a pending multi-pick row splits the stake across its picks", () => {
    const record = widenPendingRow(pendingRow({ picks: 3 }), {
      observedAt: OBSERVED_AT,
    });
    if (record === null) throw new Error("expected the pending row to widen");
    expect(record.stakePerLeg).toBe(5000);
  });

  test("flat prices give 0 oddsFromEven and a sentinel row stays zero, not null", () => {
    const even = widenTickerRow(
      tickerRow({
        ShortDesc:
          "Basketball - Lakers vs Celtics / Game / Winner (2 way) / Lakers +100",
      }),
      { observedAt: OBSERVED_AT },
    );
    if (even === null) throw new Error("expected the even-money row to widen");
    expect(even.oddsFromEven).toBe(0);

    const alert = widenTickerRow(
      tickerRow({ TicketWriter: "ALERT", VolumeAmount: 0 }),
      { observedAt: OBSERVED_AT },
    );
    if (alert === null) throw new Error("expected the ALERT row to widen");
    expect(alert.stakeUsd).toBe(0);
    expect(alert.stakePerLeg).toBe(0);
    // Sentinel money is pinned to zero, so there is no positive to-win and no ratio.
    expect(alert.stakeToWinRatio).toBeNull();
  });

  test("missing amounts and odds stay null rather than zero", () => {
    const noToWin = widenTickerRow(tickerRow({ ToWinAmount: 0 }), {
      observedAt: OBSERVED_AT,
    });
    if (noToWin === null) throw new Error("expected the row to widen");
    expect(noToWin.stakeToWinRatio).toBeNull();
    // The captured ShortDesc is a two-leg ticket, so the per-leg stake is half the amount wagered.
    expect(noToWin.stakePerLeg).toBe(5350);

    const noOdds = widenTickerRow(
      tickerRow({ ShortDesc: "??? :: not a market" }),
      { observedAt: OBSERVED_AT },
    );
    if (noOdds === null) throw new Error("expected the row to widen");
    expect(noOdds.americanOdds).toBeNull();
    expect(noOdds.oddsFromEven).toBeNull();

    const noStake = widenTickerRow(tickerRow({ AmountWagered: null }), {
      observedAt: OBSERVED_AT,
    });
    if (noStake === null) throw new Error("expected the row to widen");
    expect(noStake.stakeUsd).toBeNull();
    expect(noStake.stakePerLeg).toBeNull();
    expect(noStake.stakeToWinRatio).toBeNull();
  });
});

// -------------------------------------------------------------------------------------------------

describe("v3 field references", () => {
  test("compares the leaf field against another numeric field on the same record", () => {
    const stakeOverWin = recordRule(
      "{ field: stakeUsd, op: gt, value: { fieldRef: toWinUsd } }",
    );
    const shortPriced = bet({ betKey: "T-1", stakeUsd: 500, toWinUsd: 200 });
    const normal = bet({ betKey: "T-2", stakeUsd: 100, toWinUsd: 200 });
    expect(
      evaluateBetFlagRules([shortPriced, normal], [stakeOverWin], {
        now: NOW,
      }).findings.map((finding) => finding.bet.betKey),
    ).toEqual(["T-1"]);

    const equalStake = recordRule(
      "{ field: stakeUsd, op: eq, value: { fieldRef: riskUsd } }",
    );
    expect(
      evaluateBetFlagRules(
        [bet({ stakeUsd: 250, riskUsd: 250 })],
        [equalStake],
        { now: NOW },
      ).findings,
    ).toHaveLength(1);
    expect(
      evaluateBetFlagRules(
        [bet({ stakeUsd: 250, riskUsd: 100 })],
        [equalStake],
        { now: NOW },
      ).findings,
    ).toEqual([]);

    const perLegBelowStake = recordRule(
      "{ field: stakePerLeg, op: lt, value: { fieldRef: stakeUsd } }",
    );
    expect(
      evaluateBetFlagRules(
        [bet({ stakePerLeg: 50, stakeUsd: 100 })],
        [perLegBelowStake],
        { now: NOW },
      ).findings,
    ).toHaveLength(1);
    expect(
      evaluateBetFlagRules(
        [bet({ stakePerLeg: 100, stakeUsd: 100 })],
        [perLegBelowStake],
        { now: NOW },
      ).findings,
    ).toEqual([]);
  });

  test("an unknown value on either side fails closed, never matches through null", () => {
    const stakeOverWin = recordRule(
      "{ field: stakeUsd, op: gt, value: { fieldRef: toWinUsd } }",
    );
    expect(
      evaluateBetFlagRules(
        [bet({ stakeUsd: 500, toWinUsd: null })],
        [stakeOverWin],
        { now: NOW },
      ).findings,
    ).toEqual([]);
    expect(
      evaluateBetFlagRules(
        [bet({ stakeUsd: null, toWinUsd: 200 })],
        [stakeOverWin],
        { now: NOW },
      ).findings,
    ).toEqual([]);
    // eq/neq also refuse two unknowns instead of treating null === null as a match.
    const oddsEqLine = recordRule(
      "{ field: americanOdds, op: eq, value: { fieldRef: line } }",
    );
    expect(
      evaluateBetFlagRules(
        [bet({ americanOdds: null, line: null })],
        [oddsEqLine],
        { now: NOW },
      ).findings,
    ).toEqual([]);
  });

  test("the finding evidence names both sides of the comparison", () => {
    const rule = recordRule(
      "{ field: stakeUsd, op: gt, value: { fieldRef: toWinUsd } }",
    );
    const { findings } = evaluateBetFlagRules(
      [bet({ stakeUsd: 500, toWinUsd: 200 })],
      [rule],
      { now: NOW },
    );
    expect(findings[0]?.evidence).toEqual({
      kind: "record",
      fields: { stakeUsd: 500, toWinUsd: 200 },
    });
  });

  test("the fieldRef vocabulary is a closed NUMERIC set", () => {
    // String and context fields are refused: a cross-field compare against them is meaningless.
    const stringField = refusal(
      probePack("{ field: stakeUsd, op: gt, value: { fieldRef: sport } }"),
    );
    expect(stringField.join("\n")).toContain('unknown numeric field "sport"');
    const contextField = refusal(
      probePack(
        "{ field: stakeUsd, op: gt, value: { fieldRef: context.stakeVsPriorMedian } }",
      ),
    );
    expect(contextField.join("\n")).toContain(
      'unknown numeric field "context.stakeVsPriorMedian"',
    );
    // Every numeric field is an accepted reference target (the leaf is a context field here so
    // no case is a self-reference).
    for (const numeric of [
      "americanOdds",
      "impliedProb",
      "line",
      "stakeUsd",
      "toWinUsd",
      "volumeUsd",
      "riskUsd",
      "stakeToWinRatio",
      "stakePerLeg",
      "oddsFromEven",
      "agentLevel",
      "rotationNumber",
      "ageSeconds",
    ]) {
      expect(
        recordRule(
          `{ field: context.customerPriorStakeUsd, op: gt, value: { fieldRef: ${numeric} } }`,
        ).when,
      ).toEqual({
        field: "context.customerPriorStakeUsd",
        op: "gt",
        value: { fieldRef: numeric },
      });
    }
  });

  test("validation refuses an unknown, self, nested or malformed reference", () => {
    const unknownRef = refusal(
      probePack("{ field: stakeUsd, op: gt, value: { fieldRef: stake } }"),
    );
    expect(unknownRef.join("\n")).toContain(
      '<inline>: rules[0].when.value.fieldRef: unknown numeric field "stake"',
    );

    const selfRef = refusal(
      probePack("{ field: stakeUsd, op: gt, value: { fieldRef: stakeUsd } }"),
    );
    expect(selfRef.join("\n")).toContain(
      'a rule cannot compare "stakeUsd" with itself',
    );

    const nested = refusal(
      probePack(
        "{ field: stakeUsd, op: gt, value: { fieldRef: { fieldRef: toWinUsd } } }",
      ),
    );
    expect(nested.join("\n")).toContain("nesting is not allowed");

    const extraKey = refusal(
      probePack(
        "{ field: stakeUsd, op: gt, value: { fieldRef: toWinUsd, extra: 1 } }",
      ),
    );
    expect(extraKey.join("\n")).toContain(
      'unknown key "extra" in a field reference',
    );

    const nonString = refusal(
      probePack("{ field: stakeUsd, op: gt, value: { fieldRef: 5 } }"),
    );
    expect(nonString.join("\n")).toContain(
      "must be a non-empty numeric field name",
    );

    const wrongOp = refusal(
      probePack(
        "{ field: stakeUsd, op: contains, value: { fieldRef: toWinUsd } }",
      ),
    );
    expect(wrongOp.join("\n")).toContain(
      'op "contains" does not take a fieldRef',
    );

    // The error carries the JSON path to the offending node.
    expect(unknownRef[0]).toContain("rules[0].when");
  });
});

// -------------------------------------------------------------------------------------------------

describe("v3 default pack templates", () => {
  test("ships the fieldRef and oddsFromEven templates disabled", async () => {
    const result = await loadBetFlagRules(CONFIG_PATH);
    if (!result.ok)
      throw new Error(`shipped rule pack is invalid: ${result.message}`);
    const byId = new Map(result.ruleSet.rules.map((rule) => [rule.id, rule]));
    expect(byId.get("stake_exceeds_to_win")?.enabled).toBe(false);
    expect(byId.get("stake_exceeds_to_win")?.when).toEqual({
      all: [
        {
          field: "stakeUsd",
          op: "gt",
          value: { fieldRef: "toWinUsd" },
        },
      ],
    });
    expect(byId.get("longshot_even_or_worse")?.enabled).toBe(false);
    expect(byId.get("longshot_even_or_worse")?.when).toEqual({
      all: [
        { field: "americanOdds", op: "gt", value: 0 },
        { field: "oddsFromEven", op: "gte", value: 300 },
      ],
    });
  });
});
