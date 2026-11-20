import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  formatWebLogDateForMode,
  buildPerOfficeIpMatcherPayload,
  buildPlayerIpMatcherPayload,
  normalizeWebLogLoginId,
  lookupIpTrackerMatchForBetTicker,
  PER_OFFICE_IP_TRACKER_CLUSTERS,
} from "../lib/bet_ticker_ip_tracker_bridge.ts";

describe("bet_ticker_ip_tracker_bridge (ip-tracker.js & bet-ticker.js)", () => {
  test("Mode B Per-Office IP Matcher passes officeAgentId in customerID and MM/DD/YYYY dates", () => {
    const perOffice = buildPerOfficeIpMatcherPayload({
      masterAgentId: "BILLY666",
      officeAgentId: "MJ2026",
      startDateMdy: "10/31/2026",
      endDateMdy: "10/31/2026",
    });
    assert.equal(perOffice.type, "B");
    assert.equal(perOffice.agentID, "BILLY666");
    assert.equal(perOffice.customerID, "MJ2026");
    assert.equal(perOffice.start, "10/31/2026");
    assert.equal(perOffice.operation, "getWebLog");

    const globalMaster = buildPerOfficeIpMatcherPayload({
      masterAgentId: "BILLY666",
      officeAgentId: null,
    });
    assert.equal(globalMaster.customerID, "0");
  });

  test("Mode C Player IP Matcher converts MM/DD/YYYY to YYYY-MM-DD per ip-tracker.js line 77", () => {
    assert.equal(formatWebLogDateForMode("10/31/2026", "C"), "2026-10-31");
    assert.equal(formatWebLogDateForMode("2026-10-31", "B"), "10/31/2026");

    const modeC = buildPlayerIpMatcherPayload({
      masterAgentId: "BILLY666",
      agentOwner: "BILLY666v",
      customerLogin: "CB112_1",
      startDate: "2026-11-06",
      endDate: "2026-11-20",
    });
    assert.equal(modeC.type, "C");
    assert.equal(modeC.agentID, "BILLY666");
    assert.equal(modeC.agentOwner, "BILLY666v");
    assert.equal(modeC.customerID, "CB112_1");
    assert.equal(modeC.ip, "cb112_1");
    assert.equal(modeC.start, "2026-11-06");
    assert.equal(modeC.end, "2026-11-20");
    assert.deepEqual(Object.keys(modeC), [
      "agentID",
      "customerID",
      "start",
      "end",
      "type",
      "actions",
      "ip",
      "operation",
      "RRO",
      "agentOwner",
    ]);
    assert.equal(
      new URLSearchParams(
        modeC as unknown as Record<string, string>,
      ).toString(),
      "agentID=BILLY666&customerID=CB112_1&start=2026-11-06&end=2026-11-20&type=C&actions=ALL&ip=cb112_1&operation=getWebLog&RRO=1&agentOwner=BILLY666v",
    );
  });

  test("normalizes LoginID strings and resolves Per-Office & Cross-Office IP matches for Bet-Ticker rows", () => {
    assert.equal(normalizeWebLogLoginId(" .mj102. "), "MJ102");
    assert.equal(PER_OFFICE_IP_TRACKER_CLUSTERS.length, 13);

    const mjMatch = lookupIpTrackerMatchForBetTicker("EJ8834");
    assert.ok(mjMatch);
    assert.equal(mjMatch.officeAgentId, "MJ2026");
    assert.equal(mjMatch.matchClassification, "PER_OFFICE_IP_MATCH");
    assert.equal(mjMatch.matchedLoginsInOffice.includes("MJ102"), true);
    assert.equal(mjMatch.matchedLoginsInOffice.includes("MJ103"), true);
    assert.equal(mjMatch.mfcsCompositeScore, 98);

    const cubMatch = lookupIpTrackerMatchForBetTicker("CB112_2");
    assert.equal(
      cubMatch?.matchClassification,
      "BOTH_PER_OFFICE_AND_CROSS_OFFICE",
    );
    assert.equal(
      cubMatch?.crossOfficeLogins.some((x) => x.officeAgentId === "MAX92"),
      true,
    );
  });
});
