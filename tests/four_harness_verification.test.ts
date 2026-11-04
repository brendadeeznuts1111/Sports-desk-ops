import { describe, expect, test } from "bun:test";
import {
  OpaqueSecret,
  activeWriteLockCount,
  buildMinimalSpawnEnv,
  classifyUpstreamFault,
  crc32IsoHdlc,
  enqueueSerializedVaultWrite,
  formatAsciiChar11Id,
  scrubAllSecretEncodings,
} from "../lib/onepassword_session_bridge.ts";
import {
  BIT_CLINCHED_AT_PLACEMENT,
  BIT_CLINCHED_LOST_AT_PLACEMENT,
  BIT_CLINCHED_WON_AT_PLACEMENT,
  BIT_POST_BET_30S_RACE,
  BIT_PRE_BET_SCORE_LATENCY,
  detectAccountPredicates,
  encodeSurv01PredicatesToBitSet32,
  evaluateEventLogPredicates,
  readActiveClampLimits,
  routeEnforcementEffect,
  transitionAccountState,
  type EventTick,
} from "../lib/gslive_surveillance_governor.ts";

describe("Four-Harness Verification Suite (AUTH, SEC, DOD, SURV)", () => {
  test("GATE-AUTH-00 & GATE-AUTH-05: Upstream fault classification & serialized write mutex", async () => {
    expect(
      classifyUpstreamFault(
        401,
        "application/json",
        '{"error":"unauthenticated"}',
      ),
    ).toBe("CREDENTIAL_REJECTED");
    expect(
      classifyUpstreamFault(
        200,
        "text/html",
        '<form><input name="password"></form>',
      ),
    ).toBe("CREDENTIAL_REJECTED");
    expect(
      classifyUpstreamFault(
        403,
        "application/json",
        '{"error":"insufficient_role"}',
      ),
    ).toBe("REQUEST_REFUSED_FORBIDDEN");
    expect(
      classifyUpstreamFault(
        200,
        "text/html",
        '<div class="cf-chl-widget">turnstile</div>',
      ),
    ).toBe("INTERACTIVE_CHALLENGE_REQUIRED");
    expect(
      classifyUpstreamFault(
        500,
        "text/html",
        "<html>500 Internal Server Error</html>",
      ),
    ).toBe("UPSTREAM_TRANSIENT_UNAVAILABLE");

    const order: string[] = [];
    const p1 = enqueueSerializedVaultWrite("itemX", async () => {
      order.push("W1:start");
      await Bun.sleep(10);
      order.push("W1:fail");
      throw new Error("W1 failed");
    });
    const p2 = enqueueSerializedVaultWrite("itemX", async () => {
      order.push("W2:start");
      await Bun.sleep(5);
      order.push("W2:ok");
      return "ok";
    });
    await expect(p1).rejects.toThrow("W1 failed");
    expect(await p2).toBe("ok");
    expect(order).toEqual(["W1:start", "W1:fail", "W2:start", "W2:ok"]);
    expect(activeWriteLockCount()).toBe(0);
  });

  test("GATE-SEC-01..03 & GATE-DOD-01: Spawn env allowlist, secret scrubbing, CHAR(11), and IEEE CRC-32", () => {
    // The spawn allowlist is explicit: it must ignore the parent process environment.
    const env = buildMinimalSpawnEnv();
    expect(env["GSLIVE_COOKIE"]).toBeUndefined();
    expect(env["PATH"]).toBeDefined();

    expect(formatAsciiChar11Id("bilibob")).toBe("BILIBOB    ");
    for (const bad of [
      "BRODY ADMIN",
      "BRODY\x00",
      "brödy",
      "TOO_LONG_LOGIN_ID_999",
    ]) {
      try {
        formatAsciiChar11Id(bad);
        expect.unreachable();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        expect(message).not.toContain(bad);
      }
    }

    const poisoned = new OpaqueSecret("PHPSESSID=bad\r\nHeader: 1");
    expect(() => poisoned.exposeForHeaderOnly()).toThrow(RangeError);

    const rawSec = "PHPSESSID=9876543210abcdef0123456789";
    const scrubbed = scrubAllSecretEncodings(
      `Err: ${rawSec} | ${encodeURIComponent(rawSec)} | ${Buffer.from(rawSec).toBase64()}`,
      [rawSec],
    );
    expect(scrubbed).not.toContain("9876543210");

    expect(crc32IsoHdlc("123456789")).toBe(0xcbf43926);
  });

  test("GATE-SURV-01 & GATE-SURV-01-ENC: Named predicates, OVER/UNDER clinch, tauSkewSec > 0, ties & encoding", () => {
    const ticks: EventTick[] = [
      { deltaSec: 35, relevantScore: 4, isDanger: 0 },
      { deltaSec: -90, relevantScore: 4, isDanger: 0 },
      { deltaSec: -95, relevantScore: 5, isDanger: 0 },
    ];
    const pOver = evaluateEventLogPredicates(ticks, 350, "OVER", 0);
    expect(pOver).toEqual({
      PRE_BET_SCORE_LATENCY: true,
      POST_BET_30S_RACE: true,
      CLINCHED_AT_PLACEMENT: true,
      CLINCHED_WON_AT_PLACEMENT: true,
      CLINCHED_LOST_AT_PLACEMENT: false,
      DANGER_STATE_AT_PLACEMENT: false,
    });

    const pUnder = evaluateEventLogPredicates(ticks, 350, "UNDER", 0);
    expect(pUnder).toEqual({
      PRE_BET_SCORE_LATENCY: true,
      POST_BET_30S_RACE: true,
      CLINCHED_AT_PLACEMENT: true,
      CLINCHED_WON_AT_PLACEMENT: false,
      CLINCHED_LOST_AT_PLACEMENT: true,
      DANGER_STATE_AT_PLACEMENT: false,
    });

    expect(encodeSurv01PredicatesToBitSet32(pOver)).toBe(
      BIT_PRE_BET_SCORE_LATENCY |
        BIT_POST_BET_30S_RACE |
        BIT_CLINCHED_AT_PLACEMENT |
        BIT_CLINCHED_WON_AT_PLACEMENT,
    );
    expect(encodeSurv01PredicatesToBitSet32(pUnder)).toBe(
      BIT_PRE_BET_SCORE_LATENCY |
        BIT_POST_BET_30S_RACE |
        BIT_CLINCHED_AT_PLACEMENT |
        BIT_CLINCHED_LOST_AT_PLACEMENT,
    );
  });

  test("GATE-SURV-02: Tagged union, donor boundary ($10/12s vs $500/10s), state machine & 16-row truth table", () => {
    const cleanSurv01 = evaluateEventLogPredicates(
      [{ deltaSec: -120, relevantScore: 1, isDanger: 0 }],
      350,
      "OVER",
      0,
    );
    const clinchedSurv01 = evaluateEventLogPredicates(
      [{ deltaSec: -33, relevantScore: 4, isDanger: 0 }],
      350,
      "OVER",
      0,
    );

    // Donor boundary: +$49,999.99 (4_999_999) -> $10 / 12s probation vs +$50,000.00 (5_000_000) -> $500 / 10s donor
    const eff49999 = routeEnforcementEffect(
      detectAccountPredicates(
        -1_203_764,
        341_262,
        2_296,
        4_999_999,
        cleanSurv01,
        [140_000],
      ),
    );
    expect(readActiveClampLimits(eff49999)).toEqual([1_000, 12]);

    const eff50000 = routeEnforcementEffect(
      detectAccountPredicates(
        -1_203_764,
        341_262,
        2_296,
        5_000_000,
        cleanSurv01,
        [140_000],
      ),
    );
    expect(readActiveClampLimits(eff50000)).toEqual([50_000, 10]);

    const effClosed = routeEnforcementEffect(
      detectAccountPredicates(0, 0, 0, 0, clinchedSurv01, [23_770]),
    );
    expect(() => readActiveClampLimits(effClosed)).toThrow(TypeError);

    const effUnclamped = routeEnforcementEffect(
      detectAccountPredicates(0, 0, 0, 0, cleanSurv01, [140_000]),
    );
    expect(() => readActiveClampLimits(effUnclamped)).toThrow(TypeError);

    // State machine transitions
    expect(transitionAccountState(effClosed, effUnclamped)).toEqual({
      nextState: effClosed,
      transitionCode: "TERMINAL_ABSORBING_NO_OP",
    });
    expect(transitionAccountState(eff49999, effUnclamped, null, 24)).toEqual({
      nextState: eff49999,
      transitionCode: "P1_SLA_BREACH_HOLD_CLAMP",
    });
    expect(
      transitionAccountState(eff49999, effUnclamped, {
        actor: "RISK_DESK_ANALYST",
        signedAuditTicketId: "AUD-2026-1102-01",
        verdict: "EXONERATE_FEED_DRIFT",
      }),
    ).toEqual({
      nextState: effUnclamped,
      transitionCode: "REVIEW_EXONERATED_TO_UNCLAMPED",
    });

    // 16-row generated truth table
    for (let mask = 0; mask < 16; mask++) {
      const fFraud = Boolean(mask & 8);
      const fBypass = Boolean(mask & 4);
      const fTrojan = Boolean(mask & 2);
      const fDonor = Boolean(mask & 1);

      const s01 = fFraud ? clinchedSurv01 : cleanSurv01;
      const settleList = fBypass ? [29_999, 30_000] : [30_001, 30_001];
      const [bNet, sNet, sRoi] = fTrojan
        ? [-1, 100_000, 1_500]
        : [0, 99_999, 1_499];
      const dNet = fDonor ? 5_000_000 : 4_999_999;

      const pred = detectAccountPredicates(
        bNet,
        sNet,
        sRoi,
        dNet,
        s01,
        settleList,
      );
      expect(pred).toEqual({
        PRE_BET_CLINCHED_FRAUD: fFraud,
        CONFIRM_WINDOW_BYPASS_WIN: fBypass,
        TROJAN_ASYMMETRY: fTrojan,
        DONOR_VALUE_QUALIFIED: fDonor,
      });

      const eff = routeEnforcementEffect(pred);
      if (fFraud) {
        expect(eff.baseSportsEnabled).toBe(false);
        expect(eff.derivativeLiveEnabled).toBe(false);
        expect(() => readActiveClampLimits(eff)).toThrow(TypeError);
      } else if ((fTrojan || fBypass) && !fDonor) {
        expect(readActiveClampLimits(eff)).toEqual([1_000, 12]);
      } else if ((fTrojan || fBypass) && fDonor) {
        expect(readActiveClampLimits(eff)).toEqual([50_000, 10]);
      } else {
        expect(eff.baseSportsEnabled).toBe(true);
        expect(eff.derivativeLiveEnabled).toBe(true);
        expect(() => readActiveClampLimits(eff)).toThrow(TypeError);
      }
    }
  });
});
