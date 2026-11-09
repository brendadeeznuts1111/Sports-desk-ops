import { describe, expect, test } from "bun:test";
import {
  AUTH_ADJACENT_PROFILE_PATHS,
  AUTHZ_MATRIX_SIX_OPERATIONS,
  auditAuthAdjacentProfileScrub,
  countRenderedDataPassAttributes,
  detectPendingCountWrongAnswers,
  evaluateBearerAndLedgerDecisionGate,
  type ProbeRun,
  planRetention,
  planScratchPiiRetention,
  SCRATCH_PII_ARTIFACT_POLICIES,
  verifyCustomerAccountBalanceInvariant,
  verifyScratchPiiDeletion,
} from "../lib/probe_retention.ts";

function run(
  id: string,
  operations: Array<{ operation: string; status: number }>,
): ProbeRun {
  return { id, operations };
}

describe("probe retention", () => {
  test("keeps the newest n runs", () => {
    const runs = [
      run("2026-11-01T01", []),
      run("2026-11-01T02", []),
      run("2026-11-01T03", []),
    ];
    const plan = planRetention(runs, { keep: 2 });
    expect(plan.keep).toEqual(["2026-11-01T02", "2026-11-01T03"]);
    expect(plan.remove).toEqual(["2026-11-01T01"]);
  });

  test("keeps the newest success per operation even when it is older than keep", () => {
    const runs = [
      run("2026-11-01T01", [{ operation: "Pending", status: 200 }]),
      run("2026-11-01T02", [{ operation: "Pending", status: 500 }]),
      run("2026-11-01T03", [{ operation: "Pending", status: 500 }]),
    ];
    const plan = planRetention(runs, { keep: 1 });
    expect(plan.keep).toContain("2026-11-01T01");
    expect(plan.keep).toContain("2026-11-01T03");
    expect(plan.remove).toEqual(["2026-11-01T02"]);
  });

  test("a run that only ever failed is not made permanent by retention", () => {
    const runs = [
      run("2026-11-01T01", [{ operation: "getGrading", status: 500 }]),
      run("2026-11-01T02", [{ operation: "getGrading", status: 500 }]),
      run("2026-11-01T03", [{ operation: "getGrading", status: 200 }]),
    ];
    const plan = planRetention(runs, { keep: 1 });
    expect(plan.keep).toEqual(["2026-11-01T03"]);
    expect(plan.remove).toEqual(["2026-11-01T01", "2026-11-01T02"]);
  });

  test("keep 0 still preserves successes", () => {
    const runs = [
      run("2026-11-01T01", [{ operation: "Pending", status: 200 }]),
      run("2026-11-01T02", [{ operation: "Pending", status: 500 }]),
    ];
    const plan = planRetention(runs, { keep: 0 });
    expect(plan.keep).toEqual(["2026-11-01T01"]);
  });
});

describe("Scratch PII retention & deletion verification (#19)", () => {
  test("classifies every #19 artifact into deletion path + backup exclusion and purges zero-retention dumps", () => {
    expect(SCRATCH_PII_ARTIFACT_POLICIES).toHaveLength(6);
    const nowMs = Date.parse("2026-11-09T12:00:00.000Z");
    const dayMs = 86_400_000;
    const plan = planScratchPiiRetention(
      [
        {
          path: "Scratch/enriched_customers_full.json.bak",
          mtimeMs: nowMs - 1000,
        },
        {
          path: "Scratch/f402-har-and-getListAgenstByAgent-unformatted.txt.rtf",
          mtimeMs: nowMs - 1000,
        },
        {
          path: "Scratch/pastes/analysis-cp-baseball.json",
          mtimeMs: nowMs - 2 * dayMs,
        },
        {
          path: "Scratch/docs-audit/gs-manager-cli/index.md",
          mtimeMs: nowMs - 3 * dayMs,
        },
      ],
      nowMs,
    );
    expect(plan.gdprDeleteVerifiable).toBe(true);
    expect(plan.deleteNow).toEqual([
      "Scratch/enriched_customers_full.json.bak",
      "Scratch/f402-har-and-getListAgenstByAgent-unformatted.txt.rtf",
    ]);
    expect(plan.retainWithinWindow).toEqual([
      "Scratch/docs-audit/gs-manager-cli/index.md",
      "Scratch/pastes/analysis-cp-baseball.json",
    ]);

    const cleanCheck = verifyScratchPiiDeletion(() => false);
    expect(cleanCheck.clean).toBe(true);
    expect(cleanCheck.survivingZeroRetentionPaths).toEqual([]);
  });
});

describe("Auth-adjacent Chrome profile / Web Data scrub sequencing (#18)", () => {
  test("ignores vendor JS data-pass template while catching rendered credentials and sequencing bugs", () => {
    expect(AUTH_ADJACENT_PROFILE_PATHS).toContain(
      "Scratch/webview-profile/Default/Web Data",
    );
    expect(
      countRenderedDataPassAttributes(`'<li data-pass="'+r+'"></li>'`),
    ).toBe(0);
    expect(
      countRenderedDataPassAttributes(
        `'<li data-pass="'+r+'"></li><li data-pass="renderedValue"></li>'`,
      ),
    ).toBe(1);

    const outOfOrder = auditAuthAdjacentProfileScrub({
      scrubbedBeforeItem2Session: false,
      item2SessionExecuted: true,
      postSessionGrepped: false,
      cacheSampleText: `data-pass="'+r+'"`,
      liveAgentIdInWebData: true,
      permissionsRestricted0600: false,
      excludedFromBackups: false,
    });
    expect(outOfOrder.sequencingValid).toBe(false);
    expect(outOfOrder.readyToCloseIssue18).toBe(false);

    const verifiedClean = auditAuthAdjacentProfileScrub({
      scrubbedBeforeItem2Session: true,
      item2SessionExecuted: true,
      postSessionGrepped: true,
      cacheSampleText: `data-pass="'+r+'"`,
      liveAgentIdInWebData: false,
      permissionsRestricted0600: true,
      excludedFromBackups: true,
    });
    expect(verifiedClean.sequencingValid).toBe(true);
    expect(verifiedClean.renderedDataPassCount).toBe(0);
    expect(verifiedClean.readyToCloseIssue18).toBe(true);
  });
});

describe("Pending-customer 14-case wrong-answer detector & balance invariant (#23)", () => {
  test("verifies BB55103 balance formula and flags all 14 wrong-answer negative cases", () => {
    expect(
      verifyCustomerAccountBalanceInvariant({
        currentBalanceCents: -25_000,
        pendingWagerBalanceCents: 10_000,
        creditLimitCents: 100_000,
        availableBalanceCents: 65_000,
      }),
    ).toBe(true);

    const bad = detectPendingCountWrongAnswers({
      sourceKind: "display-capture-har",
      captureAgeSeconds: 7200,
      hasNegativeBalanceOrRisk: true,
      placedMinusSettledVoidedMatchesPending: false,
      unknownCustomerIds: 1,
      frozenAgentsIncludedWithoutRule: 1,
      invalidSettlementTimestamps: 1,
      missingPlacementTimestamps: 1,
      ambiguousBarePRows: 1,
      duplicateTicketKeys: 1,
      canceledRowsInPending: 1,
      keylessLedgerRowsCounted: 1,
      nonWagerRowsIncluded: 1,
      undedupedSameTimestampAmountRows: 1,
    });
    expect(bad.quotable).toBe(false);
    expect(bad.triggered).toHaveLength(14);
  });
});

describe("Bearer verdict & financial ledger 3-decision expiry gate (#17)", () => {
  test("rejects server-team-only approval, enforces 2026-12-03 expiry, and verifies the 6-request matrix", () => {
    expect(AUTHZ_MATRIX_SIX_OPERATIONS).toHaveLength(6);

    const expiredUnfunded = evaluateBearerAndLedgerDecisionGate({
      nowIso: "2026-12-03T00:00:00.000Z",
      lowPrivilegeTestAccountProvisioned: false,
      writtenComplianceAndOperatorTamperAuth: true,
      serverTeamOnlyApproval: true,
      mutationAuthorizedForUpdateDistribution: false,
      verifiedOperations: [],
    });
    expect(expiredUnfunded.pauseExpired).toBe(true);
    expect(expiredUnfunded.authorizationValid).toBe(false);
    expect(expiredUnfunded.reopenAcceptanceDeliberately).toBe(true);
    expect(expiredUnfunded.readyToCloseIssue17).toBe(false);

    const completeReadOnly = evaluateBearerAndLedgerDecisionGate({
      nowIso: "2026-11-09T22:00:00.000Z",
      lowPrivilegeTestAccountProvisioned: true,
      writtenComplianceAndOperatorTamperAuth: true,
      serverTeamOnlyApproval: false,
      mutationAuthorizedForUpdateDistribution: false,
      verifiedOperations: [
        "getMasterSheet",
        "getListAgenstByAgent",
        "searchCustomerAdmin",
        "getTransactions",
        "getAuthorizations",
      ],
    });
    expect(completeReadOnly.pauseExpired).toBe(false);
    expect(completeReadOnly.readyToCloseIssue17).toBe(true);
    expect(completeReadOnly.missingOperations).toEqual([]);
  });
});
