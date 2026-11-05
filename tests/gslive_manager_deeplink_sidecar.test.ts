import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  GSLIVE_BET_HISTORY_STATES,
  addDaysYmd,
  buildGsLiveBetHistorySidecarUrl,
  buildGsLiveDualSurfaceDescriptor,
  buildGsLiveManagerSurfaceUrls,
  buildGsLiveUsersReportDeepLink,
  computeDeskDayLengthSeconds,
  computeDeskDayStartEpochSeconds,
  computeDeskDayToTimeSeconds,
  deskDayBoundaryIso,
  deskWindowIso,
  formatGsLivePlayerToken,
  portalWallClockIso,
  resolveDeskDateYmd,
} from "../lib/gslive_manager_deeplink_sidecar.ts";
import {
  buildGsLiveGetBetReportPayload,
  buildGsLiveManagerUrls,
  toGsLivePlayerId,
} from "../lib/gslive_manager_watchlist.ts";
import {
  formatGsLiveSidecarOsc8Markdown,
  formatGsLiveUsersReportOsc8Markdown,
} from "../lib/canonical_osc8_links.ts";

const FIXED_TICK = 1793469958152;

describe("GSLive Manager 7-Param Deep-Link Builder & Live Bet-History Sidecar", () => {
  test("test_build_users_report_deeplink_matches_exact_7_param_churn_003_contract", () => {
    const url = buildGsLiveUsersReportDeepLink({
      customerLogin: "CHURN_003",
      bot: true,
      eventId: "",
      fromIsoUtc: "2026-10-18T05:00:00.000Z",
      toIsoUtc: "2026-10-26T04:59:59.000Z",
      partnerId: 118,
      searchBy: "player",
    });

    expect(url).toBe(
      "https://plive.sportswidgets.pro/manager-tools/#/reports/users?bot=true&eventId=&from=2026-10-18T05%3A00%3A00.000Z&partnerId=118&searchBy=player&text=player_CHURN_003&to=2026-10-26T04%3A59%3A59.000Z",
    );
  });

  test("test_build_bet_history_sidecar_url_matches_exact_epoch_and_calctime_contract", () => {
    expect(computeDeskDayStartEpochSeconds("2026-10-31")).toBe(1793422800);

    const sidecarUrl = buildGsLiveBetHistorySidecarUrl({
      minVolume: 0,
      maxTimeUntilScore: 0,
      fromEpochSec: 1793422800,
      toEpochSec: 1793422800,
      toTimeSec: 86399,
      dateFilterBy: "calcTime",
      tickEpochMs: FIXED_TICK,
    });

    expect(sidecarUrl).toBe(
      "https://plive.sportswidgets.pro/manager-tools/#/events/bet-history?minVolume=0&maxTimeUntilScore=0&from=1793422800&to=1793422800&toTime=86399&dateFilterBy=calcTime&t=1793469958152",
    );
  });

  test("test_dual_surface_descriptor_generates_both_report_deeplinks_and_live_sidecar_urls", () => {
    expect(formatGsLivePlayerToken(" player_mj102 ")).toBe("player_MJ102");

    const desc = buildGsLiveDualSurfaceDescriptor("CHURN_003", {
      dateYmd: "2026-10-31",
      tickEpochMs: FIXED_TICK,
    });

    expect(desc.gsLivePlayerId).toBe("player_CHURN_003");
    expect(desc.usersReportChurnWindowDeepLink).toContain("bot=true");
    expect(desc.usersReportChurnWindowDeepLink).toContain(
      "text=player_CHURN_003",
    );
    expect(desc.usersReportChurnWindowDeepLink).toContain(
      "to=2026-10-26T04%3A59%3A59.000Z",
    );
    expect(desc.liveBetHistorySidecarCalcTimeUrl).toContain(
      "dateFilterBy=calcTime",
    );
    expect(desc.liveBetHistorySidecarBetTimeUrl).toContain(
      "dateFilterBy=betTime",
    );
    expect(desc.getBetReportObservedPayload.from).toBe(1793422800);
    expect(desc.getBetReportObservedPayload.toTime).toBe(86399);
    expect(desc.getBetReportObservedPayload.partnerUserId).toBe("CHURN_003");
  });

  test("test_build_canceled_bet_history_link_reproduces_the_observed_7_day_window", () => {
    // Observed in the operator console (2026-11-03) for partnerUserId=ccc107 over 7 desk days:
    // #/events/bet-history?partnerUserId=ccc107&state=canceled&…&from=1793163600&to=1793685600&toTime=86399
    expect(computeDeskDayStartEpochSeconds("2026-10-28")).toBe(1793163600);
    expect(computeDeskDayStartEpochSeconds("2026-11-03")).toBe(1793685600);

    const url = buildGsLiveBetHistorySidecarUrl({
      customerLogin: "ccc107",
      state: "canceled",
      fromEpochSec: computeDeskDayStartEpochSeconds("2026-10-28"),
      toEpochSec: computeDeskDayStartEpochSeconds("2026-11-03"),
      toTimeSec: computeDeskDayToTimeSeconds("2026-11-03"),
      dateFilterBy: "calcTime",
      tickEpochMs: FIXED_TICK,
    });

    for (const expected of [
      "#/events/bet-history?",
      "partnerUserId=CCC107",
      "state=canceled",
      "from=1793163600",
      "to=1793685600",
      "toTime=86399",
      `t=${FIXED_TICK}`,
    ]) {
      expect(url).toContain(expected);
    }
    // The observed URL was typed with a lowercase login; links are canonicalised.
    expect(url).not.toContain("partnerUserId=ccc107");
  });

  test("test_build_bet_history_link_serialises_the_spa_filter_vocabulary", () => {
    // Serialisation read from the shipped bundle (assets/index-DB17VVxN.js, 2026-11-03):
    // b/g bet-id prefixes stripped, id lists space-joined, market ids comma-joined, the
    // period's first "-" segment kept, and the sport's "-1" sentinel meaning "all".
    const url = buildGsLiveBetHistorySidecarUrl({
      customerLogin: "ccc107",
      state: "payment-failed",
      fromEpochSec: 1793685600,
      toEpochSec: 1793685600,
      toTimeSec: 86399,
      filters: {
        agent: "AG1",
        betId: "b123, b456 789",
        betGroupId: "g777, 888",
        freeBetId: "FB9",
        kind: "player",
        groupName: "Group A",
        period: "s3-live",
        sportId: 2,
        marketIds: ["m1", "m2", "m1"],
      },
      tickEpochMs: FIXED_TICK,
    });

    for (const expected of [
      "state=payment-failed",
      "agent=AG1",
      "betId=123%20456%20789",
      "betGroupId=777%20888",
      "freeBetId=FB9",
      "kind=player",
      "groupName=Group%20A",
      "period=s3",
      "sId=2",
      "mId=m1%2Cm2",
    ]) {
      expect(url).toContain(expected);
    }

    const allSports = buildGsLiveBetHistorySidecarUrl({
      filters: { sportId: "-1" },
      tickEpochMs: FIXED_TICK,
    });
    expect(allSports).not.toContain("sId=");
  });

  test("test_every_observed_state_is_accepted_and_encodes_its_own_value", () => {
    for (const state of GSLIVE_BET_HISTORY_STATES) {
      const url = buildGsLiveBetHistorySidecarUrl({
        state,
        tickEpochMs: FIXED_TICK,
      });
      if (state === "") expect(url).not.toContain("state=");
      else expect(url).toContain(`state=${state}`);
    }
    expect(GSLIVE_BET_HISTORY_STATES).toContain("canceled");
    expect(GSLIVE_BET_HISTORY_STATES.length).toBe(11);
  });

  test("test_descriptor_exposes_a_windowed_canceled_link_and_leaves_payload_state_unverified", () => {
    const desc = buildGsLiveDualSurfaceDescriptor("ccc107", {
      dateYmd: "2026-11-03",
      windowDays: 7,
      tickEpochMs: FIXED_TICK,
    });

    expect(desc.playerBetHistoryWindowDays).toBe(7);
    expect(desc.playerBetHistoryDeepLinkUrl).toContain("from=1793163600");
    expect(desc.playerBetHistoryDeepLinkUrl).toContain("to=1793685600");
    expect(desc.playerCanceledBetHistoryDeepLinkUrl).toContain(
      "state=canceled",
    );
    expect(desc.playerCanceledBetHistoryDeepLinkUrl).toContain(
      "partnerUserId=CCC107",
    );
    // The hash-route state filter is observed; the getBetReport payload's state is not.
    expect(desc.getBetReportObservedPayload.state).toBe("");
  });

  test("test_default_descriptor_keeps_the_single_day_link_and_sends_no_state", () => {
    const desc = buildGsLiveDualSurfaceDescriptor("MJ102", {
      dateYmd: "2026-11-03",
      tickEpochMs: FIXED_TICK,
    });

    expect(desc.playerBetHistoryWindowDays).toBe(1);
    expect(desc.playerBetHistoryDeepLinkUrl).not.toContain("state=");
    expect(desc.playerBetHistoryDeepLinkUrl).toContain("from=1793685600");
    expect(desc.playerCanceledBetHistoryDeepLinkUrl).toContain(
      "state=canceled",
    );
  });

  test("test_desk_day_windows_roll_and_follow_chicago_calendar", () => {
    expect(resolveDeskDateYmd(new Date("2026-10-31T18:05:58.152Z"))).toBe(
      "2026-10-31",
    );
    // 04:30Z on Nov 1 is still Oct 31 in Chicago (23:30 CDT).
    expect(resolveDeskDateYmd(new Date("2026-11-01T04:30:00.000Z"))).toBe(
      "2026-10-31",
    );
    expect(addDaysYmd("2026-10-31", -6)).toBe("2026-10-25");
    expect(addDaysYmd("2026-11-01", -1)).toBe("2026-10-31");
    expect(deskWindowIso("2026-10-31", 7)).toEqual({
      fromIso: "2026-10-25T05:00:00.000Z",
      toIso: "2026-11-01T04:59:59.000Z",
    });
    expect(deskDayBoundaryIso("2026-10-31", "end")).toBe(
      "2026-11-01T04:59:59.000Z",
    );
  });

  test("test_desk_day_start_is_dst_aware_and_toTime_clamps_to_real_day_length", () => {
    // Oct 31 2026 is CDT (UTC-5): midnight = 05:00Z.
    expect(computeDeskDayStartEpochSeconds("2026-10-31")).toBe(1793422800);
    expect(computeDeskDayLengthSeconds("2026-10-31")).toBe(86400);
    expect(computeDeskDayToTimeSeconds("2026-10-31")).toBe(86399);

    // Nov 1 2026 is the fall-back day: 25 hours, midnight still 05:00Z, end 05:59:59Z next day.
    expect(computeDeskDayStartEpochSeconds("2026-11-01")).toBe(1793509200);
    expect(computeDeskDayLengthSeconds("2026-11-01")).toBe(90000);
    expect(computeDeskDayToTimeSeconds("2026-11-01")).toBe(89999);
    expect(deskDayBoundaryIso("2026-11-01", "end")).toBe(
      "2026-11-02T05:59:59.000Z",
    );

    // Nov 2 2026 is CST (UTC-6): midnight = 06:00Z, not 05:00Z.
    expect(computeDeskDayStartEpochSeconds("2026-11-02")).toBe(1793599200);
    expect(deskDayBoundaryIso("2026-11-02", "start")).toBe(
      "2026-11-02T06:00:00.000Z",
    );
    expect(computeDeskDayToTimeSeconds("2026-11-02")).toBe(86399);

    // Mar 14 2027 is the spring-forward day: 23 hours, 06:00Z start, 04:59:59Z end.
    expect(computeDeskDayStartEpochSeconds("2027-03-14")).toBe(1805004000);
    expect(computeDeskDayLengthSeconds("2027-03-14")).toBe(82800);
    expect(computeDeskDayToTimeSeconds("2027-03-14")).toBe(82799);
    expect(deskDayBoundaryIso("2027-03-14", "end")).toBe(
      "2027-03-15T04:59:59.000Z",
    );

    // The sidecar URL follows the desk day rather than a fixed 86399.
    const fallBack = buildGsLiveBetHistorySidecarUrl({
      dateYmd: "2026-11-01",
      tickEpochMs: FIXED_TICK,
    });
    expect(fallBack).toContain("from=1793509200");
    expect(fallBack).toContain("to=1793509200");
    expect(fallBack).toContain("toTime=89999");

    const springForward = buildGsLiveBetHistorySidecarUrl({
      dateYmd: "2027-03-14",
      tickEpochMs: FIXED_TICK,
    });
    expect(springForward).toContain("toTime=82799");

    // A 2-day window that spans the fall-back day ends at the real day end.
    expect(deskWindowIso("2026-11-01", 2)).toEqual({
      fromIso: "2026-10-31T05:00:00.000Z",
      toIso: "2026-11-02T05:59:59.000Z",
    });
  });

  test("test_bet_history_partner_user_id_is_the_raw_login", () => {
    // Evidence: the live console emits partnerUserId=AF12, not partnerUserId=player_AF12.
    const url = buildGsLiveBetHistorySidecarUrl({
      customerLogin: "player_af12",
      dateYmd: "2026-10-31",
      tickEpochMs: FIXED_TICK,
    });
    expect(url).toContain("partnerUserId=AF12");
    expect(url).not.toContain("partnerUserId=player_");
    expect(
      buildGsLiveGetBetReportPayload({ customerLogin: "AF12" }).partnerUserId,
    ).toBe("AF12");
  });

  test("test_sidecar_cache_buster_defaults_to_now_and_never_freezes", () => {
    const before = Date.now();
    const url = buildGsLiveBetHistorySidecarUrl({ dateYmd: "2026-10-31" });
    const tick = Number(new URLSearchParams(url.split("?")[1]).get("t"));
    expect(tick).toBeGreaterThanOrEqual(before);
    expect(tick).toBeLessThanOrEqual(Date.now() + 1000);
    expect(tick).not.toBe(FIXED_TICK);
  });

  test("test_single_source_of_truth_watchlist_osc8_and_descriptor_agree", () => {
    const surfaces = buildGsLiveManagerSurfaceUrls({
      customerLogin: "MJ102",
      dateYmd: "2026-10-31",
      tickEpochMs: FIXED_TICK,
    });
    const watchlist = buildGsLiveManagerUrls("MJ102", {
      dateYmd: "2026-10-31",
      tickEpochMs: FIXED_TICK,
    });
    const desc = buildGsLiveDualSurfaceDescriptor("MJ102", {
      dateYmd: "2026-10-31",
      tickEpochMs: FIXED_TICK,
    });

    expect(toGsLivePlayerId("player_mj102")).toBe("player_MJ102");
    expect(toGsLivePlayerId("FUNDING_ROOT")).toBe("player_FUNDING_ROOT");
    expect(watchlist.playerReportUrl).toBe(surfaces.playerReportUrl);
    expect(watchlist.gsLivePlayerId).toBe("player_MJ102");
    // The bet-history link must carry the full window, not just partnerUserId.
    for (const param of [
      "from=",
      "to=",
      "toTime=86399",
      "dateFilterBy=calcTime",
      "partnerUserId=MJ102",
    ]) {
      expect(watchlist.betHistoryUrl).toContain(param);
    }
    expect(watchlist.playerReportUrl).toContain("bot=true");
    expect(watchlist.playerReportUrl).toContain(
      "from=2026-10-18T05%3A00%3A00.000Z",
    );
    expect(desc.liveBetHistorySidecarCalcTimeUrl).toContain(`from=1793422800`);

    const window = deskWindowIso("2026-10-31", 14);
    const osc8Users = formatGsLiveUsersReportOsc8Markdown(
      "MJ102",
      window.fromIso,
      window.toIso,
    );
    expect(osc8Users).toContain(surfaces.playerReportUrl);
    const osc8Sidecar = formatGsLiveSidecarOsc8Markdown(
      "betTime",
      "MJ102",
      1793422800,
      FIXED_TICK,
    );
    expect(osc8Sidecar).toContain("dateFilterBy=betTime");
    expect(osc8Sidecar).toContain("partnerUserId=MJ102");
  });

  test("test_committed_live_feed_exposes_gslive_sidecar_for_every_tracked_wallet", () => {
    const feedPath = path.join(
      import.meta.dirname,
      "..",
      "docs",
      "graph-live-feed.json",
    );
    expect(fs.existsSync(feedPath)).toBe(true);

    const feed = JSON.parse(fs.readFileSync(feedPath, "utf8")) as {
      gsLiveSidecar?: {
        liveBetHistorySidecarCalcTimeUrl?: string;
        liveBetHistorySidecarBetTimeUrl?: string;
      };
      walletProfiles?: Array<{
        f402CustomerId?: string;
        gsLivePlayerId?: string;
        gsLivePlayerReportUrl?: string;
        gsLivePlayerReport7DayUrl?: string;
        gsLiveBetHistoryUrl?: string;
      }>;
    };

    expect(feed.gsLiveSidecar?.liveBetHistorySidecarCalcTimeUrl).toContain(
      "dateFilterBy=calcTime",
    );
    expect(feed.gsLiveSidecar?.liveBetHistorySidecarBetTimeUrl).toContain(
      "dateFilterBy=betTime",
    );
    expect(feed.walletProfiles?.length).toBe(39);

    for (const wallet of feed.walletProfiles ?? []) {
      expect(wallet.gsLivePlayerId).toBe(`player_${wallet.f402CustomerId}`);
      expect(wallet.gsLivePlayerReportUrl).toContain("bot=true");
      expect(wallet.gsLivePlayerReportUrl).toContain(
        `text=player_${wallet.f402CustomerId}`,
      );
      expect(wallet.gsLivePlayerReport7DayUrl).toContain("bot=true");
      expect(wallet.gsLivePlayerReport7DayUrl).toContain(
        `text=player_${wallet.f402CustomerId}`,
      );
      expect(wallet.gsLiveBetHistoryUrl).toContain("dateFilterBy=calcTime");
      expect(wallet.gsLiveBetHistoryUrl).toContain("toTime=");
      expect(wallet.gsLiveBetHistoryUrl).toContain(
        `partnerUserId=${wallet.f402CustomerId}`,
      );
    }
  });

  test("test_portal_wall_clock_reads_as_desk_time_and_is_dst_aware", () => {
    // Oct 31 17:15 is CDT (UTC-5); Nov 1 17:15 is CST (UTC-6) after the fall-back.
    expect(portalWallClockIso("2026-10-31 17:15:02.770")).toBe(
      "2026-10-31T22:15:02.770Z",
    );
    expect(portalWallClockIso("2026-11-01 17:15:02.770")).toBe(
      "2026-11-01T23:15:02.770Z",
    );
    // An explicit zone is already an instant and must pass through unchanged.
    expect(portalWallClockIso("2026-11-03T18:00:00.000Z")).toBe(
      "2026-11-03T18:00:00.000Z",
    );
    expect(portalWallClockIso("2026-11-03T12:00:00-06:00")).toBe(
      "2026-11-03T18:00:00.000Z",
    );
    expect(portalWallClockIso("")).toBeNull();
    expect(portalWallClockIso("not a timestamp")).toBeNull();
    expect(portalWallClockIso(1793469958152)).toBeNull();
  });
});
