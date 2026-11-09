import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_GROUP_INTEGRITY_POLICY,
  buildGroupIntegrity,
  mergeGroupIntegrity,
  type GroupIntegrityPolicy,
} from "../lib/fraud_integrity.ts";
import { parseFraudCorpus } from "../lib/fraud_logs.ts";

const ROOT = mkdtempSync(join(tmpdir(), "fraud-integrity-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

type Row = Record<string, unknown>;

function row(overrides: Row = {}): Row {
  return {
    betGroupId: "800000",
    userID: "U001",
    partnerUserID: "PR000001",
    state: "2",
    isWin: "1",
    bet: "100",
    betGroupToWin: "200",
    betGroupResult: "-100.000",
    betGroupFinalOdds: "2.00",
    betGroupPremiumAwarded: "0",
    exchangeRate: "1",
    supplementalConfirmation: null,
    ...overrides,
  };
}

describe("group integrity — verified baseline", () => {
  test("two clean groups are verified", () => {
    const summary = buildGroupIntegrity([
      row(),
      row({ betGroupId: "800001", userID: "U002", betGroupResult: "50.000" }),
    ]);
    expect(summary.status).toBe("verified");
    expect(summary.counters.rows).toBe(2);
    expect(summary.counters.groups).toBe(2);
    expect(summary.counters.crossPlayerGroups).toBe(0);
    expect(summary.counters.ticketFieldConflicts).toBe(0);
    expect(summary.violations).toHaveLength(0);
    expect(summary.schemaVersion).toBe(1);
    expect(summary.derivationVersion).toBe("group-integrity@1");
    expect(summary.policyVersion).toBe(
      DEFAULT_GROUP_INTEGRITY_POLICY.policyVersion,
    );
  });

  test("duplicate identical component rows are one group, not a conflict", () => {
    const summary = buildGroupIntegrity([
      row({ isWin: "0" }),
      row({ isWin: "1" }),
    ]);
    expect(summary.status).toBe("verified");
    expect(summary.counters.groups).toBe(1);
    expect(summary.counters.duplicateGroupRows).toBe(1);
    expect(summary.counters.ticketFieldConflicts).toBe(0);
  });

  test("an empty capture is unavailable, not verified", () => {
    const summary = buildGroupIntegrity([]);
    expect(summary.status).toBe("unavailable");
    expect(summary.counters.rows).toBe(0);
    expect(summary.counters.groups).toBe(0);
  });
});

describe("group integrity — lifecycle observations are not violations", () => {
  test("mixed leg states inside one group are allowed and reported", () => {
    const summary = buildGroupIntegrity([
      row({ state: "1", isWin: "0" }),
      row({ state: "2", isWin: "1" }),
    ]);
    expect(summary.status).toBe("verified");
    expect(summary.observations.mixedStateGroups).toBe(1);
    expect(summary.observations.partiallyGradedGroups).toBe(1);
    expect(summary.observations.pendingComponentRows).toBe(1);
    expect(summary.counters.ticketFieldConflicts).toBe(0);
  });

  test("a winning leg inside a losing ticket is not a conflict", () => {
    const summary = buildGroupIntegrity([
      row({ isWin: "-1", betGroupResult: "-100.000" }),
      row({ isWin: "1", betGroupResult: "-100.000" }),
      row({ isWin: "-2", betGroupResult: "-100.000" }),
    ]);
    expect(summary.status).toBe("verified");
    expect(summary.observations.mixedIsWinGroups).toBe(1);
    expect(summary.observations.canceledComponentRows).toBe(1);
  });

  test("supplemental confirmation categories are counted separately", () => {
    const summary = buildGroupIntegrity([
      row({
        supplementalConfirmation:
          '{"state":"ACCEPTED","windowEndTime":1793844056000}',
      }),
      row({
        betGroupId: "800001",
        supplementalConfirmation:
          '{"state":"REJECTED","windowEndTime":1793844056000}',
      }),
      row({ betGroupId: "800002", supplementalConfirmation: "not-json" }),
      row({ betGroupId: "800003", supplementalConfirmation: null }),
    ]);
    expect(summary.observations.supplemental.accepted).toBe(1);
    expect(summary.observations.supplemental.rejected).toBe(1);
    expect(summary.observations.supplemental.unparseable).toBe(1);
    expect(summary.observations.supplemental.absent).toBe(1);
    expect(summary.status).toBe("incomplete");
  });
});

describe("group integrity — ownership violations", () => {
  test("two userIDs under one betGroupId is invalid", () => {
    const summary = buildGroupIntegrity([
      row({ userID: "U001" }),
      row({ userID: "U999" }),
    ]);
    expect(summary.status).toBe("invalid");
    expect(summary.counters.crossPlayerGroups).toBe(1);
    expect(summary.violationCounts["BET_GROUP_MULTIPLE_PLAYERS"]).toBe(1);
    expect(summary.violations[0]?.detail["distinctPlayers"]).toBe(2);
  });

  test("two partnerUserIDs under one betGroupId is invalid", () => {
    const summary = buildGroupIntegrity([
      row({ partnerUserID: "PR000001" }),
      row({ partnerUserID: "PR000002" }),
    ]);
    expect(summary.status).toBe("invalid");
    expect(summary.counters.crossPartnerGroups).toBe(1);
  });

  test("missing betGroupId and missing userID are explicit failures", () => {
    const missingGroup = buildGroupIntegrity([row({ betGroupId: null })]);
    expect(missingGroup.status).toBe("invalid");
    expect(missingGroup.counters.missingGroupIdRows).toBe(1);
    const missingUser = buildGroupIntegrity([row({ userID: "" })]);
    expect(missingUser.status).toBe("invalid");
    expect(missingUser.counters.missingUserRows).toBe(1);
  });
});

describe("group integrity — financial-field conflicts", () => {
  test("conflicting betGroupResult on one group is invalid", () => {
    const summary = buildGroupIntegrity([
      row({ betGroupResult: "-100.000" }),
      row({ betGroupResult: "-50.000" }),
    ]);
    expect(summary.status).toBe("invalid");
    expect(summary.counters.ticketFieldConflicts).toBe(1);
    expect(summary.violationCounts["BET_GROUP_RESULT_CONFLICT"]).toBe(1);
    expect(summary.violations[0]?.detail["fields"]).toEqual(["betGroupResult"]);
  });

  test("null vs populated ticket result is a conflict", () => {
    const summary = buildGroupIntegrity([
      row({ betGroupResult: null }),
      row({ betGroupResult: "-100.000" }),
    ]);
    expect(summary.status).toBe("invalid");
    expect(summary.counters.ticketFieldConflicts).toBe(1);
  });

  test("non-numeric financial values are invalid", () => {
    const summary = buildGroupIntegrity([
      row({ betGroupResult: "not-a-number" }),
    ]);
    expect(summary.status).toBe("invalid");
    expect(summary.counters.invalidFinancialValues).toBe(1);
  });
});

describe("group integrity — enum drift vs policy breach", () => {
  test("an unknown lifecycle state is schema drift (incomplete)", () => {
    const summary = buildGroupIntegrity([row({ state: "9" })]);
    expect(summary.status).toBe("incomplete");
    expect(summary.observations.unknownStates).toEqual([9]);
    expect(summary.violationCounts["BET_GROUP_UNKNOWN_STATE"]).toBe(1);
  });

  test("a known but disallowed state is a policy breach (invalid)", () => {
    const policy: GroupIntegrityPolicy = {
      ...DEFAULT_GROUP_INTEGRITY_POLICY,
      policyVersion: "test-policy",
      allowedStates: [-1, 0, 2, 3],
    };
    const summary = buildGroupIntegrity([row({ state: "1" })], { policy });
    expect(summary.status).toBe("invalid");
    expect(summary.observations.disallowedStates).toEqual([1]);
    expect(summary.policyVersion).toBe("test-policy");
  });

  test("an unknown isWin code is schema drift, not a financial conflict", () => {
    const summary = buildGroupIntegrity([row({ isWin: "7" })]);
    expect(summary.status).toBe("incomplete");
    expect(summary.observations.unknownIsWin).toEqual([7]);
    expect(summary.counters.ticketFieldConflicts).toBe(0);
  });
});

describe("group integrity — merged captures", () => {
  test("an overlapping group is validated once, not double-counted", () => {
    const first = [row({ userID: "U001", betGroupResult: "-100.000" })];
    const second = [row({ userID: "U001", betGroupResult: "-100.000" })];
    expect(buildGroupIntegrity(first).status).toBe("verified");
    expect(buildGroupIntegrity(second).status).toBe("verified");
    const merged = mergeGroupIntegrity([
      { captureId: "capture-a", rows: first },
      { captureId: "capture-b", rows: second },
    ]);
    expect(merged.status).toBe("verified");
    expect(merged.counters.rows).toBe(2);
    expect(merged.counters.groups).toBe(1);
    expect(merged.counters.overlappingGroups).toBe(1);
    expect(merged.counters.duplicateGroupRows).toBe(1);
    expect(merged.counters.ticketFieldConflicts).toBe(0);
  });

  test("a cross-capture ownership conflict is detected", () => {
    const merged = mergeGroupIntegrity([
      { captureId: "capture-a", rows: [row({ userID: "U001" })] },
      { captureId: "capture-b", rows: [row({ userID: "U002" })] },
    ]);
    expect(merged.status).toBe("invalid");
    expect(merged.counters.crossPlayerGroups).toBe(1);
  });
});

describe("group integrity — wired into the corpus loader", () => {
  test("the committed synthetic fixture exposes its 6 cross-player groups", async () => {
    const path = join(import.meta.dir, "fixtures/fraud/betreport-small.json");
    const parsed = await parseFraudCorpus(path);
    expect(parsed.integrity.status).toBe("invalid");
    expect(parsed.integrity.counters.crossPlayerGroups).toBe(6);
    expect(parsed.integrity.counters.groups).toBe(9);
    // Mixed leg state inside a group is an observation even though the fixture is invalid.
    expect(parsed.integrity.observations.mixedStateGroups).toBe(2);
  });

  test("a valid corpus file parses as verified", async () => {
    const path = join(ROOT, "valid-corpus.json");
    const document = {
      r: {
        bets: [
          row(),
          row({ isWin: "0" }),
          row({
            betGroupId: "800001",
            userID: "U002",
            betGroupResult: "50.000",
          }),
        ],
      },
      from: 1793000000,
      to: 1793020000,
    };
    await Bun.write(path, JSON.stringify(document));
    const parsed = await parseFraudCorpus(path);
    expect(parsed.rows).toBe(3);
    expect(parsed.integrity.status).toBe("verified");
    expect(parsed.integrity.counters.groups).toBe(2);
  });
});
