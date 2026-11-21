import { describe, expect, test } from "bun:test";

import { runWithInspectVisibility } from "../lib/inspect_redactor.ts";
import {
  formatPairwiseCrossRefHumanReport,
  SYNDICATE_RINGS_MANIFEST_KEY,
  WAGERS_BY_STATE_MANIFEST_KEY,
  type PairwiseCrossRefR2Payload,
} from "../packages/sportsdesk-ops/src/bin/sportsdesk-fraud-cross-ref.ts";

function reportPayload(
  inferredRoleB: "ORIGIN_LEADER" | "BRIDGE_RELAY" | "COPY_FOLLOWER",
): PairwiseCrossRefR2Payload {
  return {
    success: true,
    schemaVersion: 1,
    command: "cross-ref",
    generatedAt: "2026-11-20T00:00:00.000Z",
    domain: "[Ops & Governance]",
    sink_id: "wagers-by-state",
    r2_bucket: "sportsdesk-ops-reports",
    generation_u32: 1,
    merkle_root_sha256: "ab",
    watermark_cursor: "0",
    data_window_max_epoch_ms: 0,
    r2_published_at_epoch_ms: 0,
    circuit_state: "CLOSED",
    unresolved_gap_cents: "0",
    manifests: {
      wagersByState: {
        key: WAGERS_BY_STATE_MANIFEST_KEY,
        generation_u32: 1,
        merkle_root_sha256: "ab",
        watermark_cursor: "0",
        data_window_max_epoch_ms: 0,
        r2_published_at_epoch_ms: 0,
        chunk_key: "chunk",
        circuit_state: "CLOSED",
      },
      syndicateRings: {
        key: SYNDICATE_RINGS_MANIFEST_KEY,
        domain: "[DOD Spine]",
        generation_u32: 1,
        spine_generation_u32: 1,
        merkle_root_sha256: "ab",
        data_window_max_epoch_ms: 0,
        r2_published_at_epoch_ms: 0,
        poison_bit: 0,
        circuit_state: "CLOSED",
        active_edge_count_u32: 0,
        ring_count_u32: 0,
      },
    },
    hydratedRows: 0,
    analysis: {
      customerA: "A",
      customerB: "B",
      bridgeFilter: "ALL",
      catalogDistinctEvents: 0,
      totalWagersA: 0,
      totalWagersB: 0,
      distinctEventsA: 0,
      distinctEventsB: 0,
      sharedEventsCount: 0,
      sameSideCount: 0,
      oppositeSideCount: 0,
      differentMarketCount: 0,
      suppressedBroadcastSurgeCount: 0,
      liveBotFollowsAtoB: 0,
      liveBotFollowsBtoA: 0,
      pregameApiBotFollowsAtoB: 0,
      pregameApiBotFollowsBtoA: 0,
      pregameFollowsAtoB: 0,
      pregameFollowsBtoA: 0,
      avgSameSideLagMsU32: 0,
      minSameSideLagMsU32: 0,
      customerALeadShareBps: 0,
      bAbsentParticipationBps: 0,
      bPresentParticipationBps: 0,
      liftRatioBps: 0,
      inferredRoleB,
      overlaps: [],
    },
  };
}

describe("pairwise cross-ref human report RBAC", () => {
  test("fail-closed and auditor visibility hide ORIGIN_LEADER and BRIDGE_RELAY", () => {
    const payload = reportPayload("ORIGIN_LEADER");
    expect(formatPairwiseCrossRefHumanReport(payload)).toContain(
      "[REDACTED_ROLE]",
    );
    expect(formatPairwiseCrossRefHumanReport(payload)).not.toContain(
      "ORIGIN_LEADER",
    );
    expect(
      runWithInspectVisibility("AUDITOR_SANITIZED", () =>
        formatPairwiseCrossRefHumanReport(reportPayload("BRIDGE_RELAY")),
      ),
    ).not.toContain("BRIDGE_RELAY");
  });

  test("RISK_MANAGER keeps SOR labels; COPY_FOLLOWER stays visible to auditors", () => {
    expect(
      runWithInspectVisibility("RISK_MANAGER", () =>
        formatPairwiseCrossRefHumanReport(reportPayload("ORIGIN_LEADER")),
      ),
    ).toContain("ORIGIN_LEADER");
    expect(
      formatPairwiseCrossRefHumanReport(reportPayload("COPY_FOLLOWER")),
    ).toContain("COPY_FOLLOWER");
  });
});
